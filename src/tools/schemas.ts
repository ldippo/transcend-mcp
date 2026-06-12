import { z } from "zod";
import { DEFAULT_BUDGET, MAX_BUDGET, MIN_BUDGET } from "../types.js";

export const tokenBudget = z
  .number()
  .int()
  .min(MIN_BUDGET)
  .max(MAX_BUDGET)
  .default(DEFAULT_BUDGET)
  .describe(
    "Max tokens for the response. Lists are truncated to fit, with a note saying what was dropped and how to get it back.",
  );

export const nodeId = z
  .string()
  .regex(/^(py|ts):[^#]+(#.+)?$/, "expected <lang>:<relpath>[#qualifiedName]")
  .describe('Map node ID, e.g. "py:src/auth/session.py#SessionStore.refresh" or "ts:src/index.ts" (file node)');

export const position = {
  file: z.string().describe("Repo-relative path, posix separators"),
  line: z.number().int().min(1).describe("1-based line"),
  col: z.number().int().min(1).default(1).describe("1-based column (UTF-16 units)"),
};

export const edgeKinds = z
  .array(z.enum(["contains", "imports", "exports", "calls", "extends", "implements", "references"]))
  .optional()
  .describe("Restrict to these edge kinds; omit for all");
