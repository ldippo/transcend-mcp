/** Cross-file edge resolution over all FileExtractions. Runs in full on every
 * rebuild (a one-line barrel edit can re-route distant edges; this is sub-second
 * at 5k files, so per-file edge caching would be a correctness trap).
 *
 * Confidence ladder: exact (same-file scope / self.x) > import (followed an
 * import binding, re-exports included) > name (unique global name match).
 * Ambiguous names become resolved:false edges with ranked candidates — those
 * are the MAP->LIVE handoff signal. Zero-match refs are dropped. */
import path from "node:path";
import { extractorForLang } from "./extract/registry.js";
import { makeExternalId } from "./ids.js";
import type { FileExtraction, GraphEdge, GraphNode, RawRef } from "./types.js";

type Binding =
  | { kind: "symbol"; file: string; name: string }
  | { kind: "file"; file: string }
  | { kind: "external"; pkg: string };

interface FileTable {
  fx: FileExtraction;
  byQName: Map<string, GraphNode>;
  fileNode: GraphNode;
  /** name -> re-export targets (resolved source files) and original name. */
  reExports: { name: string; original: string; targets: string[] }[];
  starReExports: string[]; // target files of `export * from` / wildcard
  bindings: Map<string, Binding>;
}

export interface ResolvedGraph {
  nodes: Map<string, GraphNode>; // includes synthetic external nodes
  edges: GraphEdge[];
}

const MAX_CANDIDATES = 5;
const MAX_REEXPORT_DEPTH = 5;

export function resolveGraph(extractions: FileExtraction[]): ResolvedGraph {
  const fileSet = new Set(extractions.map((fx) => fx.file));
  const tables = new Map<string, FileTable>();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // ---- pass 1: per-file tables
  for (const fx of extractions) {
    const byQName = new Map<string, GraphNode>();
    let fileNode: GraphNode | undefined;
    for (const n of fx.nodes) {
      nodes.set(n.id, n);
      if (n.kind === "file") fileNode = n;
      else if (!byQName.has(n.qualifiedName)) byQName.set(n.qualifiedName, n);
    }
    if (!fileNode) continue;
    tables.set(fx.file, {
      fx,
      byQName,
      fileNode,
      reExports: [],
      starReExports: [],
      bindings: new Map(),
    });
  }

  // ---- pass 2: imports -> bindings, re-export tables, import edges
  for (const table of tables.values()) {
    const { fx, fileNode } = table;
    const extractor = extractorForLang(fx.lang)!;
    for (const imp of fx.rawImports) {
      const targets = extractor.resolveImportSource(imp.source, fx.file, fileSet);
      if (targets.length === 0) {
        const pkg = fx.lang === "py" ? imp.source.split(".")[0]! : imp.source;
        if (imp.source.startsWith(".")) continue; // unresolved relative import — broken code, skip
        const extId = makeExternalId(fx.lang, pkg);
        if (!nodes.has(extId)) {
          nodes.set(extId, {
            id: extId,
            kind: "module",
            lang: fx.lang,
            name: pkg,
            qualifiedName: "",
            file: "",
            loc: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
            exported: true,
          });
        }
        edges.push({
          from: fileNode.id,
          kind: "imports",
          resolved: true,
          to: extId,
          toName: imp.source,
          loc: imp.loc,
          confidence: "exact",
        });
        for (const { imported, local } of imp.names) {
          if (!local.startsWith("export:")) table.bindings.set(local, { kind: "external", pkg });
          void imported;
        }
        continue;
      }

      const target = targets[0]!;
      const targetTable = tables.get(target);
      edges.push({
        from: fileNode.id,
        kind: "imports",
        resolved: true,
        to: targetTable?.fileNode.id ?? makeExternalId(fx.lang, target),
        toName: imp.source,
        loc: imp.loc,
        confidence: "exact",
      });

      for (const { imported, local } of imp.names) {
        if (local.startsWith("export:")) {
          const as = local.slice("export:".length);
          if (imported === "*" || as === "*") table.starReExports.push(target);
          else table.reExports.push({ name: as, original: imported, targets: [target] });
        } else if (imported === "*" || imported === "default") {
          table.bindings.set(local, { kind: "file", file: target });
        } else {
          table.bindings.set(local, { kind: "symbol", file: target, name: imported });
          // Python: module-level imports are module attributes => re-exportable.
          if (fx.lang === "py") table.reExports.push({ name: local, original: imported, targets: [target] });
        }
      }
    }
  }

  // ---- export lookup (re-exports followed transitively)
  const exportMemo = new Map<string, GraphNode | null>();
  function lookupExport(file: string, name: string, depth = 0): GraphNode | null {
    if (depth > MAX_REEXPORT_DEPTH) return null;
    const key = `${file}\0${name}\0`;
    if (depth === 0 && exportMemo.has(key)) return exportMemo.get(key)!;
    const table = tables.get(file);
    let result: GraphNode | null = null;
    if (table) {
      const direct = table.byQName.get(name);
      if (direct && direct.exported) result = direct;
      if (!result) {
        const re = table.reExports.find((r) => r.name === name);
        if (re) {
          for (const t of re.targets) {
            result = lookupExport(t, re.original, depth + 1);
            if (result) break;
          }
        }
      }
      if (!result) {
        for (const star of table.starReExports) {
          result = lookupExport(star, name, depth + 1);
          if (result) break;
        }
      }
    }
    if (depth === 0) exportMemo.set(key, result);
    return result;
  }

  // ---- global name index (exported, non-file nodes)
  const globalByName = new Map<string, GraphNode[]>();
  for (const n of nodes.values()) {
    if (n.kind === "file" || !n.exported || !n.file) continue;
    const list = globalByName.get(n.name);
    if (list) list.push(n);
    else globalByName.set(n.name, [n]);
  }

  // ---- contains edges
  for (const table of tables.values()) {
    for (const n of table.fx.nodes) {
      if (n.kind === "file") continue;
      const dot = n.qualifiedName.lastIndexOf(".");
      const parent = dot === -1 ? table.fileNode : (table.byQName.get(n.qualifiedName.slice(0, dot)) ?? table.fileNode);
      edges.push({ from: parent.id, kind: "contains", resolved: true, to: n.id, toName: n.name, confidence: "exact" });
    }
    // exports edges for barrels: file -> original symbol
    for (const re of table.reExports) {
      if (table.fx.lang === "py" && !table.fx.file.endsWith("__init__.py")) continue; // only barrels matter
      for (const t of re.targets) {
        const target = lookupExport(t, re.original);
        if (target) {
          edges.push({
            from: table.fileNode.id,
            kind: "exports",
            resolved: true,
            to: target.id,
            toName: re.name,
            confidence: "import",
          });
        }
      }
    }
  }

  // ---- pass 3: refs
  for (const table of tables.values()) {
    for (const ref of table.fx.rawRefs) {
      const edge = resolveRef(table, ref, tables, lookupExport, globalByName);
      if (edge) edges.push(edge);
    }
  }

  return { nodes, edges: dedupeEdges(edges) };
}

function resolveRef(
  table: FileTable,
  ref: RawRef,
  tables: Map<string, FileTable>,
  lookupExport: (file: string, name: string) => GraphNode | null,
  globalByName: Map<string, GraphNode[]>,
): GraphEdge | null {
  const fromNode = table.byQName.get(ref.fromQName) ?? table.fileNode;
  const parts = ref.name.split(".");
  const last = parts[parts.length - 1]!;

  const make = (target: GraphNode, confidence: GraphEdge["confidence"]): GraphEdge | null => {
    if (target.id === fromNode.id) return null; // self-loop noise
    return {
      from: fromNode.id,
      kind: ref.kind,
      resolved: true,
      to: target.id,
      toName: ref.name,
      loc: ref.loc,
      confidence,
    };
  };

  // self.x / this.x / cls.x -> method/property on the enclosing class
  if ((parts[0] === "self" || parts[0] === "this" || parts[0] === "cls") && parts.length === 2) {
    const enclosingClass = ref.fromQName.includes(".")
      ? ref.fromQName.slice(0, ref.fromQName.lastIndexOf("."))
      : ref.fromQName;
    const hit = table.byQName.get(`${enclosingClass}.${parts[1]}`);
    if (hit) return make(hit, "exact");
    return resolveByName(last);
  }

  if (parts.length === 1) {
    // scope walk: child-of-current, then enclosing scopes, then top level
    const scopes: string[] = [];
    if (ref.fromQName) {
      const segs = ref.fromQName.split(".");
      for (let i = segs.length; i >= 0; i--) scopes.push([...segs.slice(0, i), ref.name].join("."));
    } else {
      scopes.push(ref.name);
    }
    for (const q of scopes) {
      const hit = table.byQName.get(q);
      if (hit) return make(hit, "exact");
    }
    const binding = table.bindings.get(ref.name);
    if (binding) {
      if (binding.kind === "symbol") {
        const target = lookupExport(binding.file, binding.name);
        if (target) return make(target, "import");
      } else if (binding.kind === "file") {
        const t = tables.get(binding.file);
        if (t) return make(t.fileNode, "import");
      } else {
        return null; // external symbol — covered by the file-level import edge
      }
    }
    return resolveByName(ref.name);
  }

  // dotted: follow the head binding one hop
  const head = parts[0]!;
  const binding = table.bindings.get(head);
  if (binding && parts.length === 2) {
    if (binding.kind === "file") {
      const target = lookupExport(binding.file, parts[1]!);
      if (target) return make(target, "import");
    } else if (binding.kind === "symbol") {
      // imported class used as Class.member
      const symbol = lookupExport(binding.file, binding.name);
      if (symbol) {
        const member = tables.get(symbol.file)?.byQName.get(`${symbol.qualifiedName}.${parts[1]!}`);
        if (member) return make(member, "import");
      }
    } else {
      return null; // member of an external package
    }
  }
  // local class used as Class.member in the same file
  if (parts.length === 2) {
    const member = table.byQName.get(ref.name);
    if (member) return make(member, "exact");
  }
  return resolveByName(last);

  function resolveByName(name: string): GraphEdge | null {
    const matches = globalByName.get(name) ?? [];
    if (matches.length === 1) return make(matches[0]!, "name");
    if (matches.length === 0) return null; // stdlib/third-party/dynamic — drop
    const ranked = rankCandidates(matches, table.fx.file);
    return {
      from: fromNode.id,
      kind: ref.kind,
      resolved: false,
      toName: ref.name,
      candidates: ranked.slice(0, MAX_CANDIDATES).map((n) => n.id),
      loc: ref.loc,
      confidence: "name",
    };
  }
}

/** Same file, then same directory, then shared path-prefix length. */
function rankCandidates(matches: GraphNode[], fromFile: string): GraphNode[] {
  const dir = path.posix.dirname(fromFile);
  const score = (n: GraphNode): number => {
    if (n.file === fromFile) return 1_000_000;
    if (path.posix.dirname(n.file) === dir) return 100_000;
    let common = 0;
    while (common < n.file.length && common < fromFile.length && n.file[common] === fromFile[common]) common++;
    return common;
  };
  return [...matches].sort((a, b) => score(b) - score(a));
}

/** Same (from, kind, to/toName, site) edges collapse to one. */
function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}\0${e.kind}\0${e.to ?? e.toName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
