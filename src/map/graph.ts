/** Derived graph state: community clusters (file-level Louvain, seeded for
 * determinism) and hub scores (degree + PageRank blend). Symbols inherit
 * their file's cluster. */
import { DirectedGraph, UndirectedGraph } from "graphology";
import louvainModule from "graphology-communities-louvain";
import pagerankModule from "graphology-metrics/centrality/pagerank.js";

// CJS packages under NodeNext: runtime gives the function directly, the types
// see a namespace whose .default member is the callable.
const louvain: typeof louvainModule.default = (louvainModule as any).default ?? louvainModule;
const pagerank: typeof pagerankModule.default = (pagerankModule as any).default ?? pagerankModule;
import path from "node:path";
import type { GraphEdge, GraphNode } from "./types.js";

const EDGE_WEIGHTS: Record<string, number> = {
  imports: 3,
  exports: 3,
  extends: 3,
  implements: 3,
  calls: 2,
  references: 1,
};

/** Deterministic PRNG so cluster IDs are stable across rebuilds. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DerivedState {
  clusterOf: Map<string, number>; // node id -> cluster
  scoreOf: Map<string, number>; // node id -> hub score [0,1]
  clusterLabels: Map<number, string>;
}

export function computeDerived(nodes: Map<string, GraphNode>, edges: GraphEdge[]): DerivedState {
  const fileOf = new Map<string, string>(); // node id -> file node id
  const fileIds: string[] = [];
  for (const n of nodes.values()) {
    if (n.kind === "file") {
      fileIds.push(n.id);
      fileOf.set(n.id, n.id);
    }
  }
  for (const n of nodes.values()) {
    if (n.kind !== "file" && n.file) fileOf.set(n.id, `${n.lang}:${n.file}`);
  }

  // ---- file-level undirected weighted projection for clustering
  const fileGraph = new UndirectedGraph();
  for (const id of fileIds) fileGraph.addNode(id);
  for (const e of edges) {
    if (!e.resolved || !e.to || e.kind === "contains") continue;
    const fa = fileOf.get(e.from);
    const fb = fileOf.get(e.to);
    if (!fa || !fb || fa === fb) continue;
    if (!fileGraph.hasNode(fa) || !fileGraph.hasNode(fb)) continue;
    const w = EDGE_WEIGHTS[e.kind] ?? 1;
    if (fileGraph.hasEdge(fa, fb)) {
      fileGraph.updateEdgeAttribute(fa, fb, "weight", (x: number = 0) => x + w);
    } else {
      fileGraph.addEdge(fa, fb, { weight: w });
    }
  }

  const clusterOf = new Map<string, number>();
  if (fileGraph.order > 0) {
    const communities = louvain(fileGraph, {
      getEdgeWeight: "weight",
      rng: mulberry32(42),
    });
    // Renumber communities by size (largest = 0) for stable, meaningful ids.
    const sizes = new Map<number, number>();
    for (const c of Object.values(communities)) sizes.set(c as number, (sizes.get(c as number) ?? 0) + 1);
    const renumber = new Map<number, number>();
    [...sizes.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([orig], i) => renumber.set(orig, i));
    for (const [fileId, c] of Object.entries(communities)) {
      clusterOf.set(fileId, renumber.get(c as number)!);
    }
  }
  // symbols inherit their file's cluster
  for (const n of nodes.values()) {
    if (n.kind === "file" || !n.file) continue;
    const c = clusterOf.get(fileOf.get(n.id)!);
    if (c !== undefined) clusterOf.set(n.id, c);
  }

  // ---- hub scores on the directed symbol graph (resolved, non-contains edges)
  const symGraph = new DirectedGraph();
  for (const n of nodes.values()) symGraph.addNode(n.id);
  for (const e of edges) {
    if (!e.resolved || !e.to || e.kind === "contains") continue;
    if (e.from === e.to) continue;
    if (!symGraph.hasEdge(e.from, e.to)) symGraph.addEdge(e.from, e.to);
  }
  const scoreOf = new Map<string, number>();
  if (symGraph.order > 0 && symGraph.size > 0) {
    const pr = pagerank(symGraph, { getEdgeWeight: null });
    let maxDeg = 1;
    let maxPr = Number.MIN_VALUE;
    for (const id of symGraph.nodes()) {
      maxDeg = Math.max(maxDeg, symGraph.degree(id));
      maxPr = Math.max(maxPr, pr[id] ?? 0);
    }
    for (const id of symGraph.nodes()) {
      const deg = symGraph.degree(id) / maxDeg;
      const p = (pr[id] ?? 0) / maxPr;
      scoreOf.set(id, Number((0.5 * deg + 0.5 * p).toFixed(4)));
    }
  }

  // ---- cluster labels: dominant path prefix + top hub names
  const clusterFiles = new Map<number, string[]>();
  for (const id of fileIds) {
    const c = clusterOf.get(id);
    if (c === undefined) continue;
    const file = id.slice(id.indexOf(":") + 1);
    (clusterFiles.get(c) ?? clusterFiles.set(c, []).get(c)!).push(file);
  }
  const clusterLabels = new Map<number, string>();
  for (const [c, files] of clusterFiles) {
    const dirCount = new Map<string, number>();
    for (const f of files) {
      const dir = path.posix.dirname(f);
      dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
    }
    const topDir = [...dirCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ".";
    clusterLabels.set(c, topDir === "." ? "(root)" : topDir);
  }

  return { clusterOf, scoreOf, clusterLabels };
}
