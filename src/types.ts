/** Shared types for the MCP surface. All positions on this surface are 1-based
 * (LSP is 0-based; conversion happens at the LSP boundary). Columns are UTF-16
 * code-unit offsets. */

export type Lang = "py" | "ts";

export const LANGS: readonly Lang[] = ["py", "ts"];

/** A location anchor as returned to the agent. */
export interface Anchor {
  file: string; // repo-relative posix path
  line: number; // 1-based
  col: number; // 1-based
  endLine?: number;
  endCol?: number;
  snippet?: string;
}

export type ErrorCode =
  | "FILE_DELETED"
  | "SYMBOL_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "MAP_NOT_BUILT"
  | "LSP_UNAVAILABLE"
  | "LSP_FAILED"
  | "LSP_TIMEOUT"
  | "BAD_NODE_ID"
  | "BAD_ARGS"
  | "INTERNAL";

export interface EnvelopeError {
  code: ErrorCode;
  message: string;
  /** Actionable next step for the agent, e.g. "run map_rebuild" */
  hint?: string;
  [extra: string]: unknown;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: EnvelopeError;
  tokenBudget: { requested: number; used: number; max: number };
  truncated: boolean;
  dropped?: { kind: string; count: number; note: string };
  warnings: string[];
}

export const DEFAULT_BUDGET = 2_000;
export const MIN_BUDGET = 100;
export const MAX_BUDGET = 10_000;

/** ~4 chars per token. Coarse on purpose: we budget, we don't bill. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
