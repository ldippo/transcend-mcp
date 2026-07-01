import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MetricsRecorder,
  baselineTokens,
  formatReportTable,
  loadMetricsFile,
  referencedFiles,
} from "../src/metrics.js";
import { estimateTokens } from "../src/types.js";

describe("referencedFiles", () => {
  it("collects Anchor file fields", () => {
    const data = { locations: [{ file: "src/a.ts", line: 1 }, { file: "src/b.ts", line: 9 }] };
    expect([...referencedFiles(data)].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("decodes map node IDs from nodeId/id/from/to and skips external deps", () => {
    const data = {
      node: { id: "py:src/auth/session.py#SessionStore.refresh" },
      neighbors: [
        { id: "ts:src/index.ts#main" },
        { id: "ts:ext:react" }, // external — must be skipped
      ],
      from: "py:src/x.py",
      to: "ts:src/y.ts#Foo",
    };
    expect([...referencedFiles(data)].sort()).toEqual([
      "src/auth/session.py",
      "src/index.ts",
      "src/x.py",
      "src/y.ts",
    ]);
  });

  it("dedupes files referenced multiple ways", () => {
    const data = { a: { file: "src/a.ts" }, b: { nodeId: "ts:src/a.ts#Foo" } };
    expect([...referencedFiles(data)]).toEqual(["src/a.ts"]);
  });
});

describe("baselineTokens", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "transcend-metrics-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sums estimated tokens over referenced files, missing files count 0", async () => {
    const body = "x".repeat(400); // 400 bytes -> 100 tokens
    await writeFile(path.join(dir, "a.ts"), body);
    const total = baselineTokens(dir, ["a.ts", "missing.ts"]);
    expect(total).toBe(estimateTokens(body));
    expect(total).toBe(100);
  });
});

describe("MetricsRecorder", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "transcend-metrics-"));
    file = path.join(dir, "metrics.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accumulates and derives savings in the snapshot", async () => {
    const rec = new MetricsRecorder(file);
    await rec.load();
    rec.record({ tool: "nav_references", actualTokens: 100, baselineTokens: 1000 });
    rec.record({ tool: "nav_references", actualTokens: 200, baselineTokens: 3000 });
    const snap = rec.snapshot();
    expect(snap.session.totals.calls).toBe(2);
    expect(snap.session.totals.actualTokens).toBe(300);
    expect(snap.session.totals.baselineTokens).toBe(4000);
    expect(snap.session.totals.savedTokens).toBe(3700);
    expect(snap.session.perTool.nav_references!.calls).toBe(2);
  });

  it("flushes and reloads a cumulative roundtrip", async () => {
    const rec = new MetricsRecorder(file);
    await rec.load();
    rec.record({ tool: "map_overview", actualTokens: 50, baselineTokens: 5000 });
    await rec.flush();

    const onDisk = await loadMetricsFile(file);
    expect(onDisk?.totals.calls).toBe(1);
    expect(onDisk?.totals.baselineTokens).toBe(5000);
    expect(onDisk?.perTool.map_overview!.actualTokens).toBe(50);

    // A second recorder loads the persisted base and adds to it.
    const rec2 = new MetricsRecorder(file);
    await rec2.load();
    rec2.record({ tool: "map_overview", actualTokens: 50, baselineTokens: 5000 });
    await rec2.flush();
    const after = await loadMetricsFile(file);
    expect(after?.totals.calls).toBe(2);
    expect(after?.totals.baselineTokens).toBe(10000);
  });

  it("rejects a wrong-schema file and starts fresh", async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 99, totals: { calls: 42 } }));
    expect(await loadMetricsFile(file)).toBeNull();
    const rec = new MetricsRecorder(file);
    await rec.load();
    expect(rec.snapshot().cumulative.totals.calls).toBe(0);
  });
});

describe("formatReportTable", () => {
  it("renders a table with a total row", async () => {
    const table = formatReportTable({
      schemaVersion: 1,
      since: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      totals: { calls: 3, actualTokens: 300, baselineTokens: 6000 },
      perTool: { nav_references: { calls: 3, actualTokens: 300, baselineTokens: 6000 } },
    });
    expect(table).toContain("TOOL");
    expect(table).toContain("nav_references");
    expect(table).toContain("TOTAL");
    expect(table).toContain("95%"); // 5700/6000
  });
});
