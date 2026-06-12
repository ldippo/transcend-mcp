/** The bridge: MAP node <-> live LSP position. The LSP is authoritative when
 * the two disagree; staleness is always reported, never silently corrected. */
import path from "node:path";
import { HoverRequest } from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import { symbolKindName, type LiveService } from "../live/api.js";
import { parseNodeId } from "../map/ids.js";
import type { MapService } from "../map/service.js";
import type { BridgeApi, FilePos, ResolveFromNodeData, ResolveFromPositionData } from "../tools/context.js";
import type { Anchor } from "../types.js";
import { chainAtPosition, fetchSymbolTree, findByName, findByQualifiedName, topLevelNames } from "./symbols.js";

export class Bridge implements BridgeApi {
  constructor(
    private readonly config: Config,
    private readonly map: MapService,
    private readonly live: LiveService,
  ) {}

  // ------------------------------------------------------------ MAP -> LSP

  async fromNode(nodeId: string): Promise<ResolveFromNodeData> {
    const parsed = parseNodeId(nodeId);
    if (!parsed) {
      throw new ToolError("BAD_NODE_ID", `Cannot parse '${nodeId}'.`, {
        hint: 'Expected <lang>:<relpath>[#qualifiedName], e.g. "py:src/a.py#Foo.bar".',
      });
    }
    if (parsed.file.startsWith("ext:")) {
      throw new ToolError("NODE_NOT_FOUND", `'${nodeId}' is an external dependency node; it has no source location in this repo.`);
    }
    const mapNode = this.map.isBuilt() ? this.map.getNode(nodeId) : undefined;
    const inMap = mapNode !== undefined;
    const qualifiedName = parsed.qualifiedName || mapNode?.qualifiedName || "";
    const mapLine0 = mapNode?.loc.startLine;
    const stale = this.map.staleFiles().includes(parsed.file);

    // file node: no symbol walk needed
    if (!qualifiedName) {
      return {
        nodeId,
        location: { file: parsed.file, line: 1, col: 1 },
        verified: true,
        mapStale: stale,
        inMap,
      };
    }

    // live lookup; degrade to map data when the LSP is missing
    let client;
    let uri: string;
    try {
      const opened = await this.openFor(parsed.file);
      client = opened.client;
      uri = opened.uri;
    } catch (err) {
      if (err instanceof ToolError && (err.code === "LSP_UNAVAILABLE" || err.code === "LSP_FAILED")) {
        if (!mapNode) throw err;
        return {
          nodeId,
          location: { file: parsed.file, line: mapNode.loc.startLine + 1, col: mapNode.loc.startCol + 1 },
          verified: false,
          mapStale: stale ? true : "unknown",
          inMap,
          symbol: { name: mapNode.name, kind: mapNode.kind, signature: mapNode.signature },
        };
      }
      throw err; // FILE_DELETED and friends propagate with their own codes
    }

    const tree = await fetchSymbolTree(client, uri);
    let symbol = findByQualifiedName(tree, qualifiedName);
    let relocated = false;
    if (!symbol) {
      // name-anchored re-resolution: the container chain may have changed
      const lastSegment = qualifiedName.split(".").pop()!;
      const hits = findByName(tree, lastSegment);
      if (hits.length === 1) {
        symbol = hits[0]!;
        relocated = true;
      } else {
        throw new ToolError("SYMBOL_NOT_FOUND", `'${qualifiedName}' not found in ${parsed.file} (live).`, {
          mapStale: true,
          hint:
            hits.length > 1
              ? `${hits.length} symbols named '${lastSegment}' exist; use nav_symbols to pick one.`
              : "Symbol was renamed or removed. Run map_rebuild, or map_search for its new home.",
          fileSymbols: topLevelNames(tree),
        });
      }
    }

    const liveLine0 = symbol.selectionRange.start.line;
    const location: Anchor = {
      file: parsed.file,
      line: liveLine0 + 1,
      col: symbol.selectionRange.start.character + 1,
      endLine: symbol.range.end.line + 1,
    };
    const drifted = mapLine0 !== undefined && mapLine0 !== symbol.range.start.line && mapLine0 !== liveLine0;

    const result: ResolveFromNodeData = {
      nodeId,
      location,
      verified: true,
      mapStale: stale || drifted || relocated,
      inMap,
      symbol: { name: symbol.name, kind: symbolKindName(symbol.kind), signature: mapNode?.signature },
    };
    if (relocated) result.relocated = true;
    if (drifted && mapNode) result.mapRange = { line: mapNode.loc.startLine + 1, endLine: mapNode.loc.endLine + 1 };

    // enrich with live type info when cheap
    try {
      const hover = await client.request(HoverRequest.type, {
        textDocument: { uri },
        position: symbol.selectionRange.start,
      });
      if (hover?.contents) {
        const c = hover.contents;
        const text = typeof c === "string" ? c : Array.isArray(c) ? "" : c.value;
        const sig = text
          .replace(/```\w*\n?/g, "")
          .split("\n")
          .find((l) => l.trim());
        if (sig) result.symbol!.signature = sig.trim().slice(0, 200);
      }
    } catch {
      // hover is best-effort enrichment
    }
    return result;
  }

  // ------------------------------------------------------------ LSP -> MAP

  async fromPosition(p: FilePos): Promise<ResolveFromPositionData> {
    const { client, uri } = await this.openFor(p.file);
    const tree = await fetchSymbolTree(client, uri);
    const chain = chainAtPosition(tree, p.line - 1, p.col - 1);
    const enclosingSymbols = chain.map((s) => ({
      name: s.name,
      kind: symbolKindName(s.kind),
      line: s.selectionRange.start.line + 1,
    }));
    const location: Anchor = { file: p.file, line: p.line, col: p.col };

    if (chain.length === 0) {
      // not inside any symbol: map to the file node if we have one
      const lang = this.langOf(p.file);
      const fileId = `${lang}:${p.file}`;
      const fileNode = this.map.isBuilt() ? this.map.getNode(fileId) : undefined;
      return {
        nodeId: fileNode ? fileId : null,
        inMap: !!fileNode,
        enclosingSymbols,
        qualifiedName: null,
        location,
      };
    }

    const qualifiedName = chain.map((s) => s.name.replace(/\(.*\)$/, "").trim()).join(".");
    if (!this.map.isBuilt()) {
      return { nodeId: null, inMap: false, enclosingSymbols, qualifiedName, location };
    }

    // walk the chain upward until a map node matches
    const segments = qualifiedName.split(".");
    for (let take = segments.length; take >= 1; take--) {
      const candidate = segments.slice(0, take).join(".");
      const view = this.map.findByQualifiedName(p.file, candidate);
      if (!view) continue;
      const exact = take === segments.length;
      const liveSym = chain[take - 1]!;
      const mapStale = view.line !== liveSym.selectionRange.start.line + 1;
      return {
        nodeId: exact ? view.id : null,
        inMap: exact,
        ...(exact ? {} : { nearestNodeId: view.id }),
        mapStale,
        enclosingSymbols,
        qualifiedName,
        location,
      };
    }
    return {
      nodeId: null,
      inMap: false,
      nearestNodeId: this.map.getNode(`${this.langOf(p.file)}:${p.file}`)?.id ?? null,
      enclosingSymbols,
      qualifiedName,
      location,
    };
  }

  // ------------------------------------------------------------ helpers

  private async openFor(file: string) {
    const abs = path.resolve(this.config.root, file);
    if (!abs.startsWith(this.config.root)) {
      throw new ToolError("BAD_ARGS", `Path escapes the repo root: ${file}`);
    }
    const client = this.live.pool.clientForFile(file);
    const { uri } = await client.open(abs);
    await client.docs.syncAll(client);
    return { client, uri: uri || URI.file(abs).toString() };
  }

  private langOf(file: string): string {
    return file.endsWith(".py") || file.endsWith(".pyi") ? "py" : "ts";
  }
}
