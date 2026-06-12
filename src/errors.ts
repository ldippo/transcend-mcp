import type { ErrorCode } from "./types.js";

/** Domain failure surfaced to the agent as an ok:false envelope, never a
 * protocol-level error. Thrown anywhere below the tool layer; the handler
 * wrapper converts it. */
export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}
