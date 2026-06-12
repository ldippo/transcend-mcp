import {
  DEFAULT_BUDGET,
  Envelope,
  EnvelopeError,
  ErrorCode,
  estimateTokens,
  MAX_BUDGET,
  MIN_BUDGET,
} from "./types.js";

export interface TruncatableSpec {
  /** Dot-path to an array inside `data`, e.g. "references" or "graph.nodes". */
  path: string;
  /** Label used in the dropped-note, e.g. "references". */
  kind: string;
  /** Higher-priority items first. Applied before cutting. */
  ranker?: (a: any, b: any) => number;
  /** Appended to the dropped note: how to get the rest back. */
  recoverHint?: string;
}

export interface RespondOpts {
  budget?: number;
  truncatable?: TruncatableSpec[];
  warnings?: string[];
}

const NOTE_HEADROOM_TOKENS = 50;

function getAtPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setAtPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (parent != null) parent[last] = value;
}

function clampBudget(requested: number | undefined): { requested: number; effective: number } {
  const req = requested ?? DEFAULT_BUDGET;
  return { requested: req, effective: Math.min(Math.max(req, MIN_BUDGET), MAX_BUDGET) };
}

function measure(env: Envelope): number {
  return estimateTokens(JSON.stringify(env));
}

/** Strip `snippet` fields everywhere as a last resort before failing soft. */
function elideSnippets(value: any): void {
  if (Array.isArray(value)) {
    for (const v of value) elideSnippets(v);
  } else if (value && typeof value === "object") {
    if ("snippet" in value) delete value.snippet;
    for (const k of Object.keys(value)) elideSnippets(value[k]);
  }
}

/**
 * Uniform token-budgeted envelope builder. Every tool handler returns through
 * this. Truncates declared arrays (largest fitting prefix via binary search),
 * always says what was dropped and how to get it back.
 */
export function respond<T>(data: T, opts: RespondOpts = {}): Envelope<T> {
  const { requested, effective } = clampBudget(opts.budget);
  const env: Envelope<T> = {
    ok: true,
    data: structuredClone(data),
    tokenBudget: { requested, used: 0, max: MAX_BUDGET },
    truncated: false,
    warnings: opts.warnings ?? [],
  };

  env.tokenBudget.used = measure(env);
  if (env.tokenBudget.used <= effective) return env;

  let totalDropped = 0;
  const droppedKinds: string[] = [];
  let recoverHint = "";

  for (const spec of opts.truncatable ?? []) {
    const arr = getAtPath(env.data, spec.path);
    if (!Array.isArray(arr) || arr.length === 0) continue;

    const ranked = spec.ranker ? [...arr].sort(spec.ranker) : arr;
    const target = effective - NOTE_HEADROOM_TOKENS;

    // Binary search the largest prefix that fits the budget.
    let lo = 0;
    let hi = ranked.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      setAtPath(env.data, spec.path, ranked.slice(0, mid));
      if (measure(env) <= target) lo = mid;
      else hi = mid - 1;
    }
    setAtPath(env.data, spec.path, ranked.slice(0, lo));

    const dropped = ranked.length - lo;
    if (dropped > 0) {
      totalDropped += dropped;
      droppedKinds.push(`${dropped} ${spec.kind}`);
      if (spec.recoverHint) recoverHint = spec.recoverHint;
    }
    if (measure(env) <= effective) break;
  }

  env.tokenBudget.used = measure(env);
  let elided = false;
  if (env.tokenBudget.used > effective) {
    elideSnippets(env.data);
    elided = true;
    env.tokenBudget.used = measure(env);
  }

  if (totalDropped > 0 || elided || env.tokenBudget.used > effective) {
    env.truncated = true;
    const parts: string[] = [];
    if (droppedKinds.length) parts.push(`Dropped ${droppedKinds.join(", ")} to fit tokenBudget=${requested}.`);
    if (elided) parts.push("Snippets elided.");
    if (!parts.length) parts.push(`Response exceeds tokenBudget=${requested} even after truncation.`);
    env.dropped = {
      kind: droppedKinds.join(", ") || "content",
      count: totalDropped,
      note: `${parts.join(" ")} ${recoverHint || "Raise tokenBudget (max 10000) or narrow the query."}`,
    };
    env.tokenBudget.used = measure(env);
  }

  return env;
}

export function respondError(
  code: ErrorCode,
  message: string,
  extras: Omit<EnvelopeError, "code" | "message"> = {},
  opts: { budget?: number; warnings?: string[] } = {},
): Envelope<never> {
  const { requested } = clampBudget(opts.budget);
  const env: Envelope<never> = {
    ok: false,
    error: { code, message, ...extras },
    tokenBudget: { requested, used: 0, max: MAX_BUDGET },
    truncated: false,
    warnings: opts.warnings ?? [],
  };
  env.tokenBudget.used = measure(env);
  return env;
}

/** MCP CallToolResult shape from an envelope (text JSON + structuredContent). */
export function toToolResult(env: Envelope<any>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(env, null, 1) }],
    structuredContent: env as unknown as Record<string, unknown>,
    isError: !env.ok,
  };
}
