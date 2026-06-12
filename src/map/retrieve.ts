/** MAP retrieval: overview, search, budget-shaped neighborhood expansion,
 * shortest structural path. Pure functions over MapState. */
import type {
  MapNodeView,
  NeighborsData,
  NeighborView,
  OverviewData,
  PathData,
} from "../tools/context.js";
import { ToolError } from "../errors.js";
import { isExternalId, parseNodeId } from "./ids.js";
import type { MapState } from "./service.js";
import type { EdgeKind, GraphEdge, GraphNode } from "./types.js";

export function toView(n: GraphNode, state: MapState): MapNodeView {
  const v: MapNodeView = {
    id: n.id,
    kind: n.kind,
    name: n.name,
    file: n.file,
    line: n.loc.startLine + 1,
  };
  if (n.signature) v.signature = n.signature;
  if (n.doc) v.doc = n.doc;
  if (n.cluster !== undefined) v.cluster = n.cluster;
  if (n.score !== undefined) v.score = n.score;
  if (n.file && state.staleSet.has(n.file)) v.stale = true;
  return v;
}

// ---------------------------------------------------------------- overview

export function overviewQuery(
  state: MapState,
  opts: { focus?: string; hubsPerCluster?: number },
): OverviewData {
  const hubsPer = opts.hubsPerCluster ?? 5;
  const focus = opts.focus?.replace(/\/+$/, "");
  const inFocus = (n: GraphNode) => !focus || n.file === focus || n.file.startsWith(`${focus}/`);

  const clusterMembers = new Map<number, { files: Set<string>; symbols: GraphNode[] }>();
  let files = 0;
  let symbols = 0;
  for (const n of state.nodes.values()) {
    if (isExternalId(n.id) || !inFocus(n)) continue;
    if (n.kind === "file") files++;
    else symbols++;
    const c = n.cluster ?? -1;
    let m = clusterMembers.get(c);
    if (!m) clusterMembers.set(c, (m = { files: new Set(), symbols: [] }));
    if (n.kind === "file") m.files.add(n.file);
    else m.symbols.push(n);
  }

  const clusters = [...clusterMembers.entries()]
    .sort((a, b) => b[1].files.size - a[1].files.size)
    .map(([id, m]) => ({
      id,
      label: state.derived?.clusterLabels.get(id) ?? "(unclustered)",
      files: m.files.size,
      hubs: m.symbols
        .filter((n) => n.exported)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, hubsPer)
        .map((n) => toView(n, state)),
    }));

  return {
    builtAt: state.builtAt ?? "",
    files,
    symbols,
    staleFiles: state.staleSet.size,
    clusters,
  };
}

// ---------------------------------------------------------------- search

export function searchQuery(
  state: MapState,
  opts: { query: string; kind: string; limit: number },
): { results: MapNodeView[]; total: number } {
  const q = opts.query.toLowerCase();
  const scored: { n: GraphNode; s: number }[] = [];
  for (const n of state.nodes.values()) {
    if (isExternalId(n.id)) continue;
    if (opts.kind !== "any" && n.kind !== opts.kind) continue;
    const name = n.name.toLowerCase();
    const qname = n.qualifiedName.toLowerCase();
    const file = n.file.toLowerCase();
    let s = 0;
    if (name === q) s = 100;
    else if (name.startsWith(q)) s = 60;
    else if (name.includes(q)) s = 40;
    else if (qname.includes(q)) s = 30;
    else if (file.includes(q)) s = n.kind === "file" ? 25 : 10;
    if (s === 0) continue;
    scored.push({ n, s: s + (n.score ?? 0) * 10 + (n.exported ? 1 : 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  return {
    results: scored.slice(0, opts.limit).map(({ n }) => toView(n, state)),
    total: scored.length,
  };
}

// ---------------------------------------------------------------- neighbors

const PER_NODE_NEIGHBOR_CAP = 20;

export function neighborsQuery(
  state: MapState,
  opts: { nodeId: string; direction: "in" | "out" | "both"; edgeKinds?: string[]; depth: number; maxNodes: number },
): NeighborsData {
  const seed = state.nodes.get(opts.nodeId);
  if (!seed) {
    throw new ToolError("NODE_NOT_FOUND", `No map node '${opts.nodeId}'.`, {
      hint: "IDs come from map_search/map_overview. The map may be stale — try map_search or map_rebuild.",
    });
  }
  const kindFilter = opts.edgeKinds ? new Set(opts.edgeKinds as EdgeKind[]) : null;
  const visited = new Set<string>([seed.id]);
  const result: NeighborView[] = [];
  let omitted = 0;

  let frontier: { node: GraphNode; depth: number }[] = [{ node: seed, depth: 0 }];
  for (let depth = 1; depth <= opts.depth && frontier.length; depth++) {
    const next: { node: GraphNode; depth: number }[] = [];
    // expand high-score nodes first so the cap keeps the valuable part
    frontier.sort((a, b) => (b.node.score ?? 0) - (a.node.score ?? 0));
    for (const { node } of frontier) {
      const candidates: { target: GraphNode; edge: GraphEdge; direction: "in" | "out" }[] = [];
      if (opts.direction !== "in") {
        for (const e of state.out.get(node.id) ?? []) {
          if (kindFilter && !kindFilter.has(e.kind)) continue;
          const targets = e.resolved && e.to ? [e.to] : (e.candidates ?? []);
          for (const t of targets) {
            const tn = state.nodes.get(t);
            if (tn) candidates.push({ target: tn, edge: e, direction: "out" });
            if (!e.resolved) break; // one candidate entry is enough to flag it
          }
        }
      }
      if (opts.direction !== "out") {
        for (const e of state.inc.get(node.id) ?? []) {
          if (kindFilter && !kindFilter.has(e.kind)) continue;
          const fn = state.nodes.get(e.from);
          if (fn) candidates.push({ target: fn, edge: e, direction: "in" });
        }
      }
      candidates.sort((a, b) => (b.target.score ?? 0) - (a.target.score ?? 0));
      let taken = 0;
      for (const c of candidates) {
        if (visited.has(c.target.id)) continue;
        if (taken >= PER_NODE_NEIGHBOR_CAP || result.length >= opts.maxNodes) {
          omitted++;
          continue;
        }
        visited.add(c.target.id);
        taken++;
        const view: NeighborView = {
          ...toView(c.target, state),
          edge: c.edge.kind,
          direction: c.direction,
          resolved: c.edge.resolved,
          depth,
        };
        if (!c.edge.resolved) view.confidence = "candidate";
        else if (c.edge.confidence !== "exact") view.confidence = c.edge.confidence;
        result.push(view);
        if (c.edge.resolved) next.push({ node: c.target, depth });
      }
    }
    frontier = next;
  }

  const staleFiles = [...new Set(result.map((r) => r.file).filter((f) => state.staleSet.has(f)))];
  return {
    node: toView(seed, state),
    neighbors: result,
    omitted,
    mapBuiltAt: state.builtAt ?? "",
    staleFiles,
  };
}

// ---------------------------------------------------------------- path

const PATH_KINDS: ReadonlySet<EdgeKind> = new Set(["imports", "exports", "calls", "extends", "implements", "contains"]);

export function pathQuery(
  state: MapState,
  opts: { from: string; to: string; maxLen: number; includeReferences: boolean },
): PathData {
  for (const id of [opts.from, opts.to]) {
    if (!state.nodes.has(id)) {
      throw new ToolError("NODE_NOT_FOUND", `No map node '${id}'.`, { hint: "Use IDs from map_search." });
    }
  }
  const allowed = new Set(PATH_KINDS);
  if (opts.includeReferences) allowed.add("references");

  // plain BFS over the undirected resolved-edge view
  type Step = { id: string; prev: Step | null; via: GraphEdge | null; forward: boolean };
  const visited = new Set([opts.from]);
  let frontier: Step[] = [{ id: opts.from, prev: null, via: null, forward: true }];
  let found: Step | null = opts.from === opts.to ? frontier[0]! : null;

  for (let depth = 0; depth < opts.maxLen && frontier.length && !found; depth++) {
    const next: Step[] = [];
    for (const step of frontier) {
      const tryEdge = (e: GraphEdge, neighbor: string | undefined, forward: boolean) => {
        if (!neighbor || !allowed.has(e.kind) || !e.resolved || visited.has(neighbor)) return;
        visited.add(neighbor);
        const s: Step = { id: neighbor, prev: step, via: e, forward };
        if (neighbor === opts.to) found = s;
        next.push(s);
      };
      for (const e of state.out.get(step.id) ?? []) tryEdge(e, e.to, true);
      for (const e of state.inc.get(step.id) ?? []) tryEdge(e, e.from, false);
      if (found) break;
    }
    frontier = next;
  }

  const staleFiles: string[] = [];
  if (!found) return { found: false, staleFiles };

  const chain: Step[] = [];
  for (let s: Step | null = found; s; s = s.prev) chain.unshift(s);
  const pathOut = chain.map((s, i) => {
    const nodeView = toView(state.nodes.get(s.id)!, state);
    if (nodeView.stale) staleFiles.push(nodeView.file);
    const nextStep = chain[i + 1];
    return nextStep
      ? {
          node: nodeView,
          edgeToNext: {
            kind: nextStep.via!.kind,
            direction: (nextStep.forward ? "forward" : "back") as "forward" | "back",
            resolved: nextStep.via!.resolved,
          },
        }
      : { node: nodeView };
  });
  return { found: true, path: pathOut, staleFiles: [...new Set(staleFiles)] };
}
