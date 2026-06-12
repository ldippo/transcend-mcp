import { z } from "zod";
import { ToolError } from "../errors.js";
import { respond } from "../respond.js";
import type { Envelope } from "../types.js";
import type { AppContext } from "./context.js";
import { nodeId, tokenBudget } from "./schemas.js";

export function registerResolveTool(register: RegisterFnResolve, ctx: AppContext): void {
  register(
    "resolve",
    "The bridge between the static map and the live language server — call it whenever you switch layers. Given a map " +
      "nodeId, returns the verified current file:line:col plus live symbol info, with mapStale:true if the indexed " +
      "location has drifted (the live location is authoritative). Given a file:line:col, returns the enclosing symbol " +
      "chain and the matching map nodeId (inMap:false with the nearest container if the map hasn't caught up). Use " +
      "before nav_* calls that need exact positions, and after nav_* results to re-enter the map graph.",
    {
      nodeId: nodeId.optional(),
      file: z.string().optional().describe("Repo-relative path (use with line/col instead of nodeId)"),
      line: z.number().int().min(1).optional(),
      col: z.number().int().min(1).default(1).optional(),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const byNode = args.nodeId !== undefined;
      const byPos = args.file !== undefined && args.line !== undefined;
      if (byNode === byPos) {
        throw new ToolError("BAD_ARGS", "Pass exactly one of: nodeId, or file+line(+col).", {
          hint: 'e.g. {"nodeId":"py:src/a.py#Foo.bar"} or {"file":"src/a.py","line":42,"col":5}',
        });
      }
      if (!ctx.bridge) {
        throw new ToolError("LSP_UNAVAILABLE", "Bridge unavailable: no language servers and no map loaded.", {
          hint: "map_* tools may still work; check map_status.",
        });
      }
      const data = byNode
        ? await ctx.bridge.fromNode(args.nodeId!)
        : await ctx.bridge.fromPosition({ file: args.file!, line: args.line!, col: args.col ?? 1 });
      return respond(data, { budget: args.tokenBudget });
    },
  );
}

export type RegisterFnResolve = (
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  handler: (args: any) => Promise<Envelope>,
) => void;
