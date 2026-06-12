import { z } from "zod";
import { ToolError } from "../errors.js";
import { respond } from "../respond.js";
import type { Envelope } from "../types.js";
import type { AppContext, LiveApi } from "./context.js";
import { position, tokenBudget } from "./schemas.js";
import { langForFile } from "../config.js";

function requireLive(ctx: AppContext, file?: string): LiveApi {
  if (!ctx.live) {
    throw new ToolError("LSP_UNAVAILABLE", "No language servers are available.", {
      hint: "Static structure is still available via map_* tools. Install pyright and/or typescript-language-server for live navigation.",
    });
  }
  if (file !== undefined && langForFile(file) === undefined) {
    throw new ToolError("BAD_ARGS", `No language registered for '${file}'.`, {
      hint: "Supported extensions: .py .pyi .ts .tsx .mts .cts .js .jsx",
    });
  }
  return ctx.live;
}

const refRanker = (a: any, b: any) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

export function registerNavTools(register: RegisterFnNav, ctx: AppContext): void {
  register(
    "nav_definition",
    "Ground-truth 'go to definition' from the live language server, always reflecting current on-disk contents. Use " +
      "after orienting with map_search/map_neighbors, or directly when you already have an exact file:line:col " +
      "(resolve(nodeId) gives you one from a map node ID).",
    { ...position, tokenBudget },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx, args.file);
      const data = await live.definition({ file: args.file, line: args.line, col: args.col });
      return respond(data, {
        budget: args.tokenBudget,
        truncatable: [{ path: "locations", kind: "locations" }],
      });
    },
  );

  register(
    "nav_references",
    "Ground-truth 'find all references' from the live language server (pyright/tsserver), always reflecting current " +
      "on-disk file contents. Use this to CONFIRM impact before editing a symbol — it is authoritative where the " +
      "static map is only indicative. Costs real latency on large projects, so narrow first: use map_neighbors to " +
      "identify the area, resolve(nodeId) for an exact file:line:col, then call this. If results are truncated, " +
      "refine with fileFilter rather than raising the budget.",
    {
      ...position,
      includeDeclaration: z.boolean().default(false),
      fileFilter: z.string().optional().describe("Substring/glob to scope result files, e.g. 'src/' or 'tests/'"),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx, args.file);
      const data = await live.references({
        file: args.file,
        line: args.line,
        col: args.col,
        includeDeclaration: args.includeDeclaration,
      });
      if (args.fileFilter) {
        const f = args.fileFilter.replace(/\*+/g, "");
        data.locations = data.locations.filter((l) => l.file.includes(f));
      }
      return respond(data, {
        budget: args.tokenBudget,
        truncatable: [
          {
            path: "locations",
            kind: "references",
            ranker: refRanker,
            recoverHint: "Pass fileFilter:'src/' (or similar) to scope results, or raise tokenBudget.",
          },
        ],
      });
    },
  );

  register(
    "nav_implementations",
    "Live 'go to implementations' for an interface/abstract method (language-server ground truth). Same usage pattern " +
      "as nav_definition: get an exact position first via resolve or map_search + resolve.",
    { ...position, tokenBudget },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx, args.file);
      const data = await live.implementations({ file: args.file, line: args.line, col: args.col });
      return respond(data, {
        budget: args.tokenBudget,
        truncatable: [{ path: "locations", kind: "implementations" }],
      });
    },
  );

  register(
    "nav_type",
    "Live hover: resolved type signature and docs at a position, from the language server's type checker. The " +
      "authoritative answer to 'what type is this?' — the map only stores parse-time signatures.",
    { ...position, tokenBudget },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx, args.file);
      const data = await live.hover({ file: args.file, line: args.line, col: args.col });
      return respond(data, { budget: args.tokenBudget });
    },
  );

  register(
    "nav_symbols",
    "Live outline of one file (document symbols, hierarchical). Always current — prefer this over reading a whole " +
      "file to learn its structure.",
    { file: position.file, tokenBudget },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx, args.file);
      const data = await live.documentSymbols(args.file);
      return respond(data, {
        budget: args.tokenBudget,
        truncatable: [{ path: "symbols", kind: "symbols" }],
      });
    },
  );

  register(
    "nav_workspaceSymbols",
    "Live workspace-wide symbol search from the language server. Authoritative but slower than map_search; use when " +
      "the map is stale or missing, or to confirm a map_search hit. Query must be ≥3 chars to avoid result floods.",
    {
      query: z.string().min(3),
      limit: z.number().int().min(1).max(200).default(50),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx);
      const data = await live.workspaceSymbols(args.query, args.limit);
      return respond(data, {
        budget: args.tokenBudget,
        truncatable: [
          { path: "symbols", kind: "symbols", recoverHint: "Narrow the query string." },
        ],
      });
    },
  );

  register(
    "nav_callHierarchy",
    "Live call hierarchy (incoming callers or outgoing callees) from the language server. Position must be on the " +
      "symbol name — use resolve(nodeId) to get one. Falls back to nav_references / static map call edges when the " +
      "server lacks call-hierarchy support (response carries source:'fallback-*' and a warning).",
    {
      ...position,
      direction: z.enum(["incoming", "outgoing"]),
      depth: z.number().int().min(1).max(3).default(1),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const live = requireLive(ctx, args.file);
      const data = await live.callHierarchy({
        file: args.file,
        line: args.line,
        col: args.col,
        direction: args.direction,
        depth: args.depth,
      });
      const warnings =
        data.source === "lsp"
          ? []
          : [`Language server lacks call hierarchy; results derived via ${data.source}. Treat as approximate.`];
      return respond(data, { budget: args.tokenBudget, warnings });
    },
  );
}

export type RegisterFnNav = (
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  handler: (args: any) => Promise<Envelope>,
) => void;
