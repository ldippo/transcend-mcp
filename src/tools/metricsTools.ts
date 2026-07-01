import { z } from "zod";
import type { Envelope } from "../types.js";
import { respond } from "../respond.js";
import type { AppContext } from "./context.js";
import { tokenBudget } from "./schemas.js";

export function registerMetricsTools(register: RegisterFnMetrics, ctx: AppContext): void {
  register(
    "metrics_report",
    "Report the token savings transcend has produced: for each tool, the actual emitted tokens vs the naive-baseline " +
      "cost of reading in full every file the responses pointed into, plus the tokens saved and the percentage. Returns " +
      "both this session and cumulative-across-runs figures. Baseline is an upper bound (assumes full file reads).",
    { tokenBudget },
    async (args): Promise<Envelope> => {
      const snapshot = ctx.metrics
        ? ctx.metrics.snapshot()
        : { since: null, updatedAt: null, cumulative: null, session: null, note: "metrics unavailable" };
      return respond(snapshot, { budget: args.tokenBudget });
    },
  );
}

export type RegisterFnMetrics = (
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  handler: (args: any) => Promise<Envelope>,
) => void;
