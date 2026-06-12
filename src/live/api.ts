/** LiveApi implementation: nav_* operations over the LSP pool, with result
 * shaping (1-based positions, repo-relative paths, snippets) and the
 * capability-gated call-hierarchy fallback. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  DefinitionRequest,
  DocumentSymbolRequest,
  HoverRequest,
  ImplementationRequest,
  ReferencesRequest,
  SymbolKind,
  WorkspaceSymbolRequest,
  type CallHierarchyItem,
  type DocumentSymbol,
  type Location,
  type LocationLink,
  type SymbolInformation,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import type { MapService } from "../map/service.js";
import type {
  CallHierarchyItemView,
  FilePos,
  HoverData,
  LiveApi,
  NavLocationsData,
  SymbolNodeView,
} from "../tools/context.js";
import type { Anchor } from "../types.js";
import type { LspClient } from "./client.js";
import { LspPool } from "./pool.js";

const SYMBOL_KIND_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(SymbolKind).map(([name, value]) => [value as number, name.toLowerCase()]),
);

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `kind${kind}`;
}

export class LiveService implements LiveApi {
  constructor(
    private readonly config: Config,
    readonly pool: LspPool,
    private readonly getMap: () => MapService | null = () => null,
  ) {}

  // ------------------------------------------------------------ helpers

  private abs(file: string): string {
    const p = path.resolve(this.config.root, file);
    if (!p.startsWith(this.config.root)) {
      throw new ToolError("BAD_ARGS", `Path escapes the repo root: ${file}`);
    }
    return p;
  }

  private rel(uri: string): string {
    return path.relative(this.config.root, URI.parse(uri).fsPath).split(path.sep).join("/");
  }

  /** 1-based MCP surface -> 0-based LSP. */
  private toLsp(p: FilePos) {
    return { line: p.line - 1, character: p.col - 1 };
  }

  private snippetCache = new Map<string, string[]>();

  private async snippet(file: string, line0: number): Promise<string | undefined> {
    let lines = this.snippetCache.get(file);
    if (!lines) {
      try {
        lines = (await readFile(this.abs(file), "utf8")).split("\n");
      } catch {
        return undefined;
      }
      this.snippetCache.set(file, lines);
      if (this.snippetCache.size > 100) {
        const first = this.snippetCache.keys().next().value!;
        this.snippetCache.delete(first);
      }
    }
    return lines[line0]?.trim().slice(0, 160);
  }

  private async toAnchor(loc: Location): Promise<Anchor> {
    const file = this.rel(loc.uri);
    const a: Anchor = {
      file,
      line: loc.range.start.line + 1,
      col: loc.range.start.character + 1,
      endLine: loc.range.end.line + 1,
    };
    const snip = await this.snippet(file, loc.range.start.line);
    if (snip) a.snippet = snip;
    return a;
  }

  private async openForQuery(p: FilePos): Promise<{ client: LspClient; uri: string; version: number }> {
    const client = this.pool.clientForFile(p.file);
    const { uri, version } = await client.open(this.abs(p.file));
    // freshness invariant: results depend on every open buffer, so re-sync all
    await client.docs.syncAll(client);
    this.snippetCache.clear(); // disk may have moved under any cached snippet
    return { client, uri, version };
  }

  private normalizeLocations(result: Location | Location[] | LocationLink[] | null): Location[] {
    if (!result) return [];
    const arr = Array.isArray(result) ? result : [result];
    return arr.map((l) =>
      "targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l,
    );
  }

  // ------------------------------------------------------------ nav ops

  private async locationsOp(
    p: FilePos,
    run: (client: LspClient, uri: string) => Promise<Location[]>,
    retryOnEmpty = false,
  ): Promise<NavLocationsData> {
    const { client, uri } = await this.openForQuery(p);
    let locs = await run(client, uri);
    // Servers load projects asynchronously and answer early semantic queries
    // with [] — retry against a deadline until the first non-empty answer
    // proves the project is loaded, then only retry when explicitly asked.
    const deadline = Date.now() + (client.semanticReady ? (retryOnEmpty ? 1_200 : 0) : 8_000);
    while (locs.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
      locs = await run(client, uri);
    }
    if (locs.length > 0) client.semanticReady = true;
    return {
      target: p,
      locations: await Promise.all(locs.map((l) => this.toAnchor(l))),
      total: locs.length,
      source: "lsp",
      language: client.lang,
    };
  }

  definition(p: FilePos): Promise<NavLocationsData> {
    return this.locationsOp(p, async (client, uri) =>
      this.normalizeLocations(
        await client.request(DefinitionRequest.type, { textDocument: { uri }, position: this.toLsp(p) }),
      ),
    );
  }

  references(p: FilePos & { includeDeclaration: boolean }): Promise<NavLocationsData> {
    return this.locationsOp(
      p,
      async (client, uri) =>
        (await client.request(
          ReferencesRequest.type,
          {
            textDocument: { uri },
            position: this.toLsp(p),
            context: { includeDeclaration: p.includeDeclaration },
          },
          this.config.slowRequestTimeoutMs,
        )) ?? [],
      true,
    );
  }

  implementations(p: FilePos): Promise<NavLocationsData> {
    return this.locationsOp(p, async (client, uri) => {
      if (!client.capabilities.implementationProvider) {
        throw new ToolError("LSP_FAILED", `${client.lang} server lacks implementation support.`, {
          hint: "Use nav_references or map_neighbors with edgeKinds:['extends','implements'].",
        });
      }
      return this.normalizeLocations(
        await client.request(ImplementationRequest.type, { textDocument: { uri }, position: this.toLsp(p) }),
      );
    });
  }

  async hover(p: FilePos): Promise<HoverData> {
    const { client, uri } = await this.openForQuery(p);
    let hover = await client.request(HoverRequest.type, { textDocument: { uri }, position: this.toLsp(p) });
    const deadline = Date.now() + (client.semanticReady ? 0 : 8_000);
    while (!hover && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
      hover = await client.request(HoverRequest.type, { textDocument: { uri }, position: this.toLsp(p) });
    }
    if (hover) client.semanticReady = true;
    let contents = "";
    if (hover) {
      const c = hover.contents;
      if (typeof c === "string") contents = c;
      else if (Array.isArray(c)) contents = c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
      else contents = c.value;
    }
    if (!contents.trim()) {
      throw new ToolError("SYMBOL_NOT_FOUND", `No type information at ${p.file}:${p.line}:${p.col}.`, {
        hint: "The position must be on a symbol name. Use resolve(nodeId) to get an exact position.",
      });
    }
    return { target: p, contents: contents.slice(0, 4000), language: client.lang };
  }

  async documentSymbols(file: string): Promise<{ file: string; symbols: SymbolNodeView[]; language: string }> {
    const { client, uri } = await this.openForQuery({ file, line: 1, col: 1 });
    const result = await client.request(DocumentSymbolRequest.type, { textDocument: { uri } });
    return { file, symbols: shapeSymbols(result ?? []), language: client.lang };
  }

  async workspaceSymbols(query: string, limit: number) {
    // query every available language server, merge results
    const errors: ToolError[] = [];
    const all: (Anchor & { name: string; kind: string })[] = [];
    for (const lang of ["py", "ts"] as const) {
      const client = this.pool.client(lang);
      try {
        await client.ensureReady();
        const result =
          ((await client.request(
            WorkspaceSymbolRequest.type,
            { query },
            this.config.slowRequestTimeoutMs,
          )) as SymbolInformation[] | null) ?? [];
        for (const s of result.slice(0, limit)) {
          if (!s.location?.range) continue;
          all.push({ ...(await this.toAnchor(s.location)), name: s.name, kind: symbolKindName(s.kind) });
        }
      } catch (err) {
        if (err instanceof ToolError) errors.push(err);
        else throw err;
      }
    }
    if (all.length === 0 && errors.length === 2) throw errors[0]!;
    const exact = all.filter((s) => s.name === query);
    const rest = all.filter((s) => s.name !== query);
    return { symbols: [...exact, ...rest].slice(0, limit), total: all.length };
  }

  async callHierarchy(p: FilePos & { direction: "incoming" | "outgoing"; depth: number }) {
    const { client, uri } = await this.openForQuery(p);
    if (!client.capabilities.callHierarchyProvider) {
      return this.callHierarchyFallback(p);
    }
    let items =
      (await client.request(CallHierarchyPrepareRequest.type, {
        textDocument: { uri },
        position: this.toLsp(p),
      })) ?? [];
    if (items.length === 0) {
      // position may be off the identifier: snap to the enclosing symbol and retry once
      const snapped = await this.snapToSymbol(client, uri, p);
      if (snapped) {
        items =
          (await client.request(CallHierarchyPrepareRequest.type, {
            textDocument: { uri },
            position: snapped,
          })) ?? [];
      }
    }
    const rootItem = items[0];
    if (!rootItem) {
      throw new ToolError("SYMBOL_NOT_FOUND", `No callable symbol at ${p.file}:${p.line}:${p.col}.`, {
        hint: "Position must be on a function/method name; use resolve(nodeId) first.",
      });
    }
    const root = await this.expandHierarchy(client, rootItem, p.direction, p.depth);
    return { root, direction: p.direction, source: "lsp" as const };
  }

  private async snapToSymbol(client: LspClient, uri: string, p: FilePos) {
    const symbols = await client.request(DocumentSymbolRequest.type, { textDocument: { uri } });
    if (!symbols?.length || !("range" in (symbols[0] as DocumentSymbol))) return null;
    const pos = this.toLsp(p);
    let best: DocumentSymbol | null = null;
    const visit = (list: DocumentSymbol[]) => {
      for (const s of list) {
        const r = s.range;
        if (r.start.line <= pos.line && pos.line <= r.end.line) {
          best = s;
          if (s.children?.length) visit(s.children);
        }
      }
    };
    visit(symbols as DocumentSymbol[]);
    return best ? (best as DocumentSymbol).selectionRange.start : null;
  }

  private async expandHierarchy(
    client: LspClient,
    item: CallHierarchyItem,
    direction: "incoming" | "outgoing",
    depth: number,
  ): Promise<CallHierarchyItemView> {
    const view: CallHierarchyItemView = {
      name: item.name,
      kind: symbolKindName(item.kind),
      file: this.rel(item.uri),
      line: item.selectionRange.start.line + 1,
    };
    if (depth <= 0) return view;
    const FAN_OUT_CAP = 10;
    if (direction === "incoming") {
      const calls = (await client.request(CallHierarchyIncomingCallsRequest.type, { item })) ?? [];
      view.children = [];
      for (const c of calls.slice(0, FAN_OUT_CAP)) {
        const child = await this.expandHierarchy(client, c.from, direction, depth - 1);
        child.fromRanges = c.fromRanges.slice(0, 5).map((r) => ({ line: r.start.line + 1, col: r.start.character + 1 }));
        view.children.push(child);
      }
    } else {
      const calls = (await client.request(CallHierarchyOutgoingCallsRequest.type, { item })) ?? [];
      view.children = [];
      for (const c of calls.slice(0, FAN_OUT_CAP)) {
        view.children.push(await this.expandHierarchy(client, c.to, direction, depth - 1));
      }
    }
    return view;
  }

  /** No call-hierarchy capability: incoming via references, outgoing via map call edges. */
  private async callHierarchyFallback(p: FilePos & { direction: "incoming" | "outgoing"; depth: number }) {
    const root: CallHierarchyItemView = { name: `${p.file}:${p.line}`, kind: "function", file: p.file, line: p.line };
    if (p.direction === "incoming") {
      const refs = await this.references({ ...p, includeDeclaration: false });
      root.children = refs.locations.slice(0, 20).map((l) => ({
        name: l.snippet ?? `${l.file}:${l.line}`,
        kind: "reference",
        file: l.file,
        line: l.line,
      }));
      return { root, direction: p.direction, source: "fallback-references" as const };
    }
    const map = this.getMap();
    if (!map || !map.isBuilt()) {
      throw new ToolError("LSP_FAILED", "Server lacks call hierarchy and the map is not built for the fallback.", {
        hint: "Run map_rebuild, or use nav_references.",
      });
    }
    // locate the enclosing map node by position, then walk its outgoing call edges
    const node = map.nodeAtLine(p.file, p.line - 1);
    if (!node) {
      throw new ToolError("NODE_NOT_FOUND", `Map has no node for ${p.file}.`, { hint: "Run map_rebuild." });
    }
    root.name = node.qualifiedName || node.name;
    root.children = map
      .callEdges(node.id, "outgoing")
      .slice(0, 20)
      .map((e) => {
        const target = e.to ? map.getNode(e.to) : undefined;
        return {
          name: target?.name ?? e.toName,
          kind: target?.kind ?? "unresolved",
          file: target?.file ?? "",
          line: (target?.loc.startLine ?? 0) + 1,
        };
      });
    return { root, direction: p.direction, source: "fallback-map" as const };
  }

  status() {
    return this.pool.status();
  }

  shutdown(): Promise<void> {
    return this.pool.shutdown();
  }
}

function shapeSymbols(list: DocumentSymbol[] | SymbolInformation[]): SymbolNodeView[] {
  if (list.length === 0) return [];
  if ("range" in list[0]!) {
    const shape = (s: DocumentSymbol): SymbolNodeView => ({
      name: s.name,
      kind: symbolKindName(s.kind),
      line: s.selectionRange.start.line + 1,
      endLine: s.range.end.line + 1,
      ...(s.children?.length ? { children: s.children.map(shape) } : {}),
    });
    return (list as DocumentSymbol[]).map(shape);
  }
  return (list as SymbolInformation[]).map((s) => ({
    name: s.name,
    kind: symbolKindName(s.kind),
    line: s.location.range.start.line + 1,
    endLine: s.location.range.end.line + 1,
  }));
}
