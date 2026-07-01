import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { ToolError } from "./errors.js";
import { baselineTokens, referencedFiles } from "./metrics.js";
import { respondError, toToolResult } from "./respond.js";
import { estimateTokens, type Envelope } from "./types.js";
import type { AppContext } from "./tools/context.js";
import { registerMapTools } from "./tools/mapTools.js";
import { registerMetricsTools } from "./tools/metricsTools.js";
import { registerNavTools } from "./tools/navTools.js";
import { registerResolveTool } from "./tools/resolveTool.js";

export const SERVER_NAME = "transcend";
export const SERVER_VERSION = "0.1.0";

/** Record token savings for a successful response. Never throws into the
 * response path — metrics must not break a tool call. */
function recordMetrics(ctx: AppContext, name: string, env: Envelope, wireText: string): void {
  // The metrics tool reports savings; counting it would pollute its own numbers.
  if (!ctx.metrics || !env.ok || name.startsWith("metrics_")) return;
  try {
    const actualTokens = estimateTokens(wireText);
    const baseline = baselineTokens(ctx.config.root, referencedFiles(env.data));
    ctx.metrics.record({ tool: name, actualTokens, baselineTokens: baseline });
  } catch (err) {
    console.error("[transcend] metrics record failed:", err);
  }
}

/** Wraps every handler: domain failures become ok:false envelopes, never
 * MCP protocol errors; every success is measured for token savings. */
function wrap(name: string, ctx: AppContext, handler: (args: any) => Promise<Envelope>) {
  return async (args: any) => {
    try {
      const env = await handler(args ?? {});
      const result = toToolResult(env);
      recordMetrics(ctx, name, env, result.content[0]!.text);
      return result;
    } catch (err) {
      if (err instanceof ToolError) {
        return toToolResult(respondError(err.code, err.message, err.extras, { budget: args?.tokenBudget }));
      }
      const message = err instanceof Error ? err.message : String(err);
      return toToolResult(respondError("INTERNAL", message, {}, { budget: args?.tokenBudget }));
    }
  };
}

export function buildServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const register = (
    name: string,
    description: string,
    inputShape: z.ZodRawShape,
    handler: (args: any) => Promise<Envelope>,
  ) => {
    server.registerTool(name, { description, inputSchema: inputShape }, wrap(name, ctx, handler));
  };

  registerMapTools(register, ctx);
  registerNavTools(register, ctx);
  registerResolveTool(register, ctx);
  registerMetricsTools(register, ctx);

  return server;
}
