import { z } from "zod";
import { ToolError } from "../errors.js";
import { respond } from "../respond.js";
import type { Envelope } from "../types.js";
import type { AppContext, MapApi } from "./context.js";
import { edgeKinds, nodeId, tokenBudget } from "./schemas.js";

function requireMap(ctx: AppContext): MapApi {
  if (!ctx.map || !ctx.map.isBuilt()) {
    throw new ToolError("MAP_NOT_BUILT", "The static map index has not been built yet.", {
      hint: "Run map_rebuild to build it. nav_* tools work without the map.",
    });
  }
  return ctx.map;
}

/** Standard warning when the map is old or partially stale. */
function mapWarnings(map: MapApi): string[] {
  const warnings: string[] = [];
  const stale = map.staleFiles();
  if (stale.length > 0) {
    warnings.push(
      `${stale.length} file(s) changed since the last index; their nodes carry stale:true. Confirm exact positions with resolve or nav_definition.`,
    );
  }
  const builtAt = map.builtAt();
  if (builtAt && Date.now() - Date.parse(builtAt) > 6 * 3600_000) {
    warnings.push("Map index is over 6 hours old; confirm hot paths with nav_references before editing.");
  }
  return warnings;
}

export function registerMapTools(register: RegisterFn, ctx: AppContext): void {
  register(
    "map_overview",
    "START HERE for any unfamiliar codebase or feature area. Returns a cheap, token-budgeted structural summary " +
      "(clusters of related files, hub symbols with node IDs) from a pre-built static index — no language-server cost, " +
      "milliseconds even on large repos. Use the returned node IDs with map_neighbors to explore relationships and with " +
      "resolve to jump to exact live locations. The index may lag recent edits: before editing or relying on a specific " +
      "line number, confirm with resolve or nav_definition, which query the live language server.",
    {
      tokenBudget,
      focus: z.string().optional().describe("Restrict the overview to a subtree, e.g. 'src/auth'"),
      hubsPerCluster: z.number().int().min(1).max(20).default(5),
    },
    async (args): Promise<Envelope> => {
      const map = requireMap(ctx);
      const data = map.overview({ focus: args.focus, hubsPerCluster: args.hubsPerCluster });
      return respond(data, {
        budget: args.tokenBudget,
        warnings: mapWarnings(map),
        truncatable: [
          { path: "clusters", kind: "clusters", recoverHint: "Pass focus:'<path>' to zoom into one area." },
        ],
      });
    },
  );

  register(
    "map_search",
    "Fuzzy symbol lookup over the static map — the cheap way to find candidate symbols by name when you don't have a " +
      "location yet. Returns node IDs usable with map_neighbors and resolve. Name-based and possibly stale; for " +
      "ground truth use nav_workspaceSymbols, which queries the live language server.",
    {
      query: z.string().min(2).describe("Symbol or file name fragment; case-insensitive substring/fuzzy match"),
      kind: z.enum(["function", "class", "method", "interface", "variable", "file", "any"]).default("any"),
      limit: z.number().int().min(1).max(100).default(20),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const map = requireMap(ctx);
      const data = map.search({ query: args.query, kind: args.kind, limit: args.limit });
      return respond(data, {
        budget: args.tokenBudget,
        warnings: mapWarnings(map),
        truncatable: [
          { path: "results", kind: "results", recoverHint: "Use a longer query fragment or a kind filter." },
        ],
      });
    },
  );

  register(
    "map_neighbors",
    "Explore the static relationship graph around one node: callers/callees, imports, inheritance, containment. Call " +
      "this BEFORE nav_references when you want the shape of the dependency fan-in/out cheaply — it is instant and " +
      "token-budgeted, while nav_references invokes the language server. Edges come from static analysis: " +
      "resolved:false edges are name-match guesses, and any edge can be stale or miss dynamic dispatch. Once you've " +
      "picked the edges that matter, verify with nav_references or nav_callHierarchy at the location from resolve(nodeId).",
    {
      nodeId,
      direction: z.enum(["in", "out", "both"]).default("both"),
      edgeKinds,
      depth: z.number().int().min(1).max(3).default(1),
      maxNodes: z.number().int().min(1).max(200).default(50),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const map = requireMap(ctx);
      const data = map.neighbors({
        nodeId: args.nodeId,
        direction: args.direction,
        edgeKinds: args.edgeKinds,
        depth: args.depth,
        maxNodes: args.maxNodes,
      });
      return respond(data, {
        budget: args.tokenBudget,
        warnings: mapWarnings(map),
        truncatable: [
          {
            path: "neighbors",
            kind: "neighbors",
            ranker: (a, b) => a.depth - b.depth || (b.score ?? 0) - (a.score ?? 0),
            recoverHint: "Re-query with a specific edgeKinds filter, depth:1, or a higher tokenBudget.",
          },
        ],
      });
    },
  );

  register(
    "map_path",
    "Shortest structural path between two symbols in the static map (over imports/calls/inheritance/containment). " +
      "Useful to understand how two areas connect before reading code. Static and possibly stale — confirm the " +
      "load-bearing hops with nav_references.",
    {
      from: nodeId,
      to: nodeId,
      maxLen: z.number().int().min(1).max(10).default(6),
      includeReferences: z.boolean().default(false).describe("Also traverse noisy 'references' edges"),
      tokenBudget,
    },
    async (args): Promise<Envelope> => {
      const map = requireMap(ctx);
      const data = map.path({
        from: args.from,
        to: args.to,
        maxLen: args.maxLen,
        includeReferences: args.includeReferences,
      });
      return respond(data, { budget: args.tokenBudget, warnings: mapWarnings(map) });
    },
  );

  register(
    "map_rebuild",
    "Rebuild the static map index (incremental: only changed files are re-parsed). Long-running on first build of a " +
      "large repo. Not needed for nav_* correctness — those are always live. Use when map responses flag staleness " +
      "or after large refactors.",
    {
      scope: z.string().optional().describe("Subtree to rebuild, e.g. 'src/auth'; omit for the whole repo"),
    },
    async (args): Promise<Envelope> => {
      if (!ctx.map) {
        throw new ToolError("MAP_NOT_BUILT", "Map service unavailable (server started without map support).");
      }
      const data = await ctx.map.rebuild(args.scope);
      return respond(data);
    },
  );

  register(
    "map_status",
    "Health and freshness of both layers: map age, file/symbol/edge counts, stale files, watcher state, and per-language " +
      "LSP availability. Cheap; call when results look off or to check whether a language server is installed.",
    {},
    async (): Promise<Envelope> => {
      const mapStatus = ctx.map
        ? ctx.map.status()
        : { built: false, builtAt: null, files: 0, symbols: 0, edges: 0, staleFiles: [], watching: false, languages: [] };
      const lsp = ctx.live ? ctx.live.status() : {};
      return respond({ ...mapStatus, lsp });
    },
  );
}

export type RegisterFn = (
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  handler: (args: any) => Promise<Envelope>,
) => void;
