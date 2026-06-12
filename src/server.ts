import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { ToolError } from "./errors.js";
import { respondError, toToolResult } from "./respond.js";
import type { Envelope } from "./types.js";
import type { AppContext } from "./tools/context.js";
import { registerMapTools } from "./tools/mapTools.js";
import { registerNavTools } from "./tools/navTools.js";
import { registerResolveTool } from "./tools/resolveTool.js";

export const SERVER_NAME = "transcend";
export const SERVER_VERSION = "0.1.0";

/** Wraps every handler: domain failures become ok:false envelopes, never
 * MCP protocol errors. */
function wrap(handler: (args: any) => Promise<Envelope>) {
  return async (args: any) => {
    try {
      return toToolResult(await handler(args ?? {}));
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
    server.registerTool(name, { description, inputSchema: inputShape }, wrap(handler));
  };

  registerMapTools(register, ctx);
  registerNavTools(register, ctx);
  registerResolveTool(register, ctx);

  return server;
}
