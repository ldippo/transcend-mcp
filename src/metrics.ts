/** Token-savings accounting. Every successful tool response is compared to the
 * naive alternative — reading in full every file the response points into — and
 * the delta is accumulated and persisted cumulatively to `.transcend/metrics.json`.
 *
 * savings = baseline (full reads of referenced files) − actual (emitted tokens).
 * The baseline is an upper bound: an agent might not read whole files. */
import { statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isExternalId, parseNodeId } from "./map/ids.js";
import { estimateTokens } from "./types.js";

const SCHEMA_VERSION = 1;
/** Flush to disk after this many un-flushed records, regardless of the timer. */
const FLUSH_EVERY = 10;
/** Debounce window for the trickle flush. */
const FLUSH_DEBOUNCE_MS = 2_000;

export interface ToolCounts {
  calls: number;
  actualTokens: number;
  baselineTokens: number;
}

export interface MetricsFile {
  schemaVersion: number;
  since: string; // ISO, first run
  updatedAt: string; // ISO, last flush
  totals: ToolCounts;
  perTool: Record<string, ToolCounts>;
}

/** A ToolCounts plus derived savings, as surfaced in reports. */
export interface DerivedCounts extends ToolCounts {
  savedTokens: number;
  savedPct: number; // 0..1
}

export interface DerivedGroup {
  totals: DerivedCounts;
  perTool: Record<string, DerivedCounts>;
}

export interface MetricsSnapshot {
  since: string;
  updatedAt: string;
  cumulative: DerivedGroup;
  session: DerivedGroup;
}

// ---------------------------------------------------------------- pure helpers

function emptyCounts(): ToolCounts {
  return { calls: 0, actualTokens: 0, baselineTokens: 0 };
}

function emptyFile(nowIso: string): MetricsFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    since: nowIso,
    updatedAt: nowIso,
    totals: emptyCounts(),
    perTool: {},
  };
}

function addInto(dst: ToolCounts, src: ToolCounts): void {
  dst.calls += src.calls;
  dst.actualTokens += src.actualTokens;
  dst.baselineTokens += src.baselineTokens;
}

/** dst += src (deep: totals + every per-tool bucket). */
function mergeFile(dst: MetricsFile, src: MetricsFile): void {
  addInto(dst.totals, src.totals);
  for (const [tool, counts] of Object.entries(src.perTool)) {
    dst.perTool[tool] ??= emptyCounts();
    addInto(dst.perTool[tool], counts);
  }
}

function derive(c: ToolCounts): DerivedCounts {
  const savedTokens = c.baselineTokens - c.actualTokens;
  const savedPct = c.baselineTokens > 0 ? savedTokens / c.baselineTokens : 0;
  return { ...c, savedTokens, savedPct };
}

function deriveGroup(g: { totals: ToolCounts; perTool: Record<string, ToolCounts> }): DerivedGroup {
  const perTool: Record<string, DerivedCounts> = {};
  for (const [tool, counts] of Object.entries(g.perTool)) perTool[tool] = derive(counts);
  return { totals: derive(g.totals), perTool };
}

/**
 * The unique set of repo-relative files a response points into — the files an
 * agent would `grep` + open to get the same answer without transcend. Collects
 * `file` fields (nav/resolve Anchors) and decodes map node IDs (`nodeId`/`id`/
 * `from`/`to`) to their file, skipping external-dependency nodes. Generic, so it
 * covers every tool without per-tool coupling.
 */
export function referencedFiles(data: unknown): Set<string> {
  const files = new Set<string>();
  const NODE_KEYS = new Set(["nodeId", "id", "from", "to"]);
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (k === "file" && typeof val === "string") {
          files.add(val);
        } else if (NODE_KEYS.has(k) && typeof val === "string" && !isExternalId(val)) {
          const parsed = parseNodeId(val);
          if (parsed) files.add(parsed.file);
        }
        visit(val);
      }
    }
  };
  visit(data);
  return files;
}

/** relpath → cached token cost, invalidated by mtime. Keyed by absolute path. */
const fileTokenCache = new Map<string, { mtimeMs: number; tokens: number }>();

/** Token cost of a single file's full contents (0 if missing/deleted). */
function fileTokens(root: string, rel: string): number {
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  try {
    const st = statSync(abs);
    const hit = fileTokenCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.tokens;
    // byte size ≈ char count for source; mirrors estimateTokens (~4 chars/token).
    const tokens = estimateTokens("x".repeat(st.size));
    fileTokenCache.set(abs, { mtimeMs: st.mtimeMs, tokens });
    return tokens;
  } catch {
    return 0;
  }
}

/** Naive-baseline token cost: sum of full reads of every referenced file. */
export function baselineTokens(root: string, files: Iterable<string>): number {
  let total = 0;
  for (const rel of files) total += fileTokens(root, rel);
  return total;
}

// ---------------------------------------------------------------- recorder

/**
 * Accumulates per-tool token savings in memory and persists them cumulatively.
 * Flushing re-reads the file and adds only the un-flushed delta, so concurrent
 * servers on one repo don't clobber each other's counts.
 */
export class MetricsRecorder {
  /** On-disk state as of the last load/flush (best-effort cumulative base). */
  private base: MetricsFile;
  /** Everything recorded this process (never reset) — for snapshot + summary. */
  private session: MetricsFile;
  /** Delta not yet written to disk; grabbed and reset on each flush. */
  private unflushed: MetricsFile;
  private pending = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes flushes so re-read/write pairs never interleave. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    const now = new Date().toISOString();
    this.base = emptyFile(now);
    this.session = emptyFile(now);
    this.unflushed = emptyFile(now);
  }

  /** Load the persisted cumulative base. Absent/corrupt/old-schema → fresh. */
  async load(): Promise<void> {
    const loaded = await loadMetricsFile(this.filePath);
    if (loaded) this.base = loaded;
  }

  record(entry: { tool: string; actualTokens: number; baselineTokens: number }): void {
    const one: MetricsFile = {
      schemaVersion: SCHEMA_VERSION,
      since: this.session.since,
      updatedAt: this.session.since,
      totals: { calls: 1, actualTokens: entry.actualTokens, baselineTokens: entry.baselineTokens },
      perTool: { [entry.tool]: { calls: 1, actualTokens: entry.actualTokens, baselineTokens: entry.baselineTokens } },
    };
    mergeFile(this.session, one);
    mergeFile(this.unflushed, one);
    this.pending++;
    if (this.pending >= FLUSH_EVERY) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DEBOUNCE_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Persist the un-flushed delta atomically. Safe to call repeatedly. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush());
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.unflushed.totals.calls === 0) return;

    const delta = this.unflushed;
    this.unflushed = emptyFile(this.session.since);
    this.pending = 0;

    try {
      const now = new Date().toISOString();
      const disk = (await loadMetricsFile(this.filePath)) ?? emptyFile(delta.since);
      mergeFile(disk, delta);
      disk.updatedAt = now;
      await writeMetricsFile(this.filePath, disk);
      this.base = disk;
    } catch (err) {
      // Writing failed: fold the delta back in so the next flush retries it.
      mergeFile(this.unflushed, delta);
      console.error("[transcend] metrics flush failed:", err);
    }
  }

  /** Derived cumulative (loaded base + this session) and session-only views. */
  snapshot(): MetricsSnapshot {
    const cumulative = emptyFile(this.base.since);
    mergeFile(cumulative, this.base);
    mergeFile(cumulative, this.session);
    return {
      since: cumulative.since,
      updatedAt: new Date().toISOString(),
      cumulative: deriveGroup(cumulative),
      session: deriveGroup(this.session),
    };
  }
}

// ---------------------------------------------------------------- store IO

/** Read + validate the metrics file. Absent/corrupt/wrong-schema → null. */
export async function loadMetricsFile(filePath: string): Promise<MetricsFile | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as MetricsFile;
    return raw.schemaVersion === SCHEMA_VERSION ? raw : null;
  } catch {
    return null;
  }
}

/** Atomic write: tmp + rename, mirroring IndexStore. */
async function writeMetricsFile(filePath: string, file: MetricsFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------- reporting

/** Compact human count: 1234 → "1.2k", 1_200_000 → "1.2M". */
function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** One-line session summary for the shutdown message. */
export function summaryLine(g: DerivedGroup): string {
  const t = g.totals;
  if (t.calls === 0) return "no tool calls recorded";
  return `saved ~${fmt(t.savedTokens)} tokens across ${t.calls} calls (${pct(t.savedPct)})`;
}

/** Pretty per-tool table + grand total for the CLI `report` subcommand. */
export function formatReportTable(file: MetricsFile): string {
  const rows = Object.entries(file.perTool)
    .map(([tool, c]) => ({ tool, ...derive(c) }))
    .sort((a, b) => b.savedTokens - a.savedTokens);
  const total = derive(file.totals);

  const header = ["TOOL", "CALLS", "ACTUAL", "BASELINE", "SAVED", "%"];
  const body = rows.map((r) => [r.tool, String(r.calls), fmt(r.actualTokens), fmt(r.baselineTokens), fmt(r.savedTokens), pct(r.savedPct)]);
  const totalRow = ["TOTAL", String(total.calls), fmt(total.actualTokens), fmt(total.baselineTokens), fmt(total.savedTokens), pct(total.savedPct)];

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length), totalRow[i]!.length));
  const pad = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  const rule = widths.map((w) => "-".repeat(w)).join("  ");

  return [
    `transcend token savings — since ${file.since} (updated ${file.updatedAt})`,
    "baseline = full reads of every referenced file (naive alternative; upper bound)",
    "",
    pad(header),
    rule,
    ...(body.length ? body.map(pad) : ["(no tool calls recorded yet)"]),
    rule,
    pad(totalRow),
  ].join("\n");
}
