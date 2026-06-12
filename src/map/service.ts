/** MapService: owns extraction state, the resolved graph, derived clusters,
 * and the persisted index. Cold build and incremental rebuild share one code
 * path: diff content hashes -> re-extract changed -> full edge re-resolution
 * (cheap, and barrel edits invalidate distant edges) -> lazy re-cluster. */
import path from "node:path";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import type {
  MapApi,
  MapNodeView,
  NeighborsData,
  OverviewData,
  PathData,
  RebuildData,
} from "../tools/context.js";
import { extractFile } from "./extract/registry.js";
import { computeDerived, DerivedState } from "./graph.js";
import type { GraphEdge, GraphNode, IndexManifest } from "./types.js";
import type { FileExtraction } from "./types.js";
import { makeNodeId } from "./ids.js";
import { resolveGraph } from "./resolve.js";
import { readAndHash, scanFiles } from "./scanner.js";
import { IndexStore } from "./store.js";
import { neighborsQuery, overviewQuery, pathQuery, searchQuery, toView } from "./retrieve.js";

const RECLUSTER_MIN_FILES = 25;
const RECLUSTER_MIN_FRACTION = 0.02;

export interface MapState {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  out: Map<string, GraphEdge[]>;
  inc: Map<string, GraphEdge[]>;
  derived: DerivedState | null;
  staleSet: Set<string>;
  builtAt: string | null;
}

export class MapService implements MapApi {
  private extractions = new Map<string, FileExtraction>();
  private state: MapState = {
    nodes: new Map(),
    edges: [],
    out: new Map(),
    inc: new Map(),
    derived: null,
    staleSet: new Set(),
    builtAt: null,
  };
  private manifest: IndexManifest;
  private changedSinceCluster = 0;
  private building: Promise<RebuildData> | null = null;
  watching = false;

  constructor(
    private readonly config: Config,
    private readonly store: IndexStore = new IndexStore(config.indexDir),
  ) {
    this.manifest = {
      schemaVersion: 1,
      builtAt: "",
      root: config.root,
      files: {},
      derived: { fresh: false },
    };
  }

  /** Warm start: load manifest + shards if present. Returns true if loaded. */
  async loadPersisted(): Promise<boolean> {
    const manifest = await this.store.loadManifest();
    if (!manifest) return false;
    const extractions: FileExtraction[] = [];
    for (const [file, entry] of Object.entries(manifest.files)) {
      const fx = await this.store.loadShard(entry.shard);
      if (fx && fx.contentHash === entry.contentHash) {
        extractions.push(fx);
      } else {
        entry.stale = true; // shard missing/corrupt — force re-extract on next rebuild
      }
      void file;
    }
    this.manifest = manifest;
    this.extractions = new Map(extractions.map((fx) => [fx.file, fx]));
    this.recomputeGraph();
    this.state.builtAt = manifest.builtAt;
    // restore cached clusters if fresh, else lazy recluster on demand
    if (manifest.derived.fresh && manifest.derived.clusters) {
      const clusterOf = new Map(Object.entries(manifest.derived.clusters));
      const labels = new Map(Object.entries(manifest.derived.clusterLabels ?? {}).map(([k, v]) => [Number(k), v]));
      this.state.derived = {
        clusterOf: new Map([...clusterOf].map(([k, v]) => [k, Number(v)])),
        scoreOf: new Map(),
        clusterLabels: labels,
      };
      this.recluster(); // scores are cheap; recompute rather than persist them
    }
    this.refreshStaleSet();
    return true;
  }

  // ------------------------------------------------------------ build

  async rebuild(scope?: string): Promise<RebuildData> {
    // single-flight: concurrent rebuild requests share one run
    if (this.building) return this.building;
    this.building = this.doRebuild(scope).finally(() => (this.building = null));
    return this.building;
  }

  private async doRebuild(scope?: string): Promise<RebuildData> {
    const t0 = Date.now();
    const cold = this.extractions.size === 0;
    const all = await scanFiles(this.config);
    const files = scope ? all.filter((f) => f.startsWith(scope.replace(/\/+$/, "") + "/") || f === scope) : all;
    const fileSet = new Set(all);

    const added: string[] = [];
    const changed: string[] = [];
    for (const rel of files) {
      const entry = this.manifest.files[rel];
      if (!entry) added.push(rel);
      else if (entry.stale) changed.push(rel);
    }
    // hash-check files not already flagged (mtime prefilter omitted: hashing
    // 5k files is ~1s and runs only on explicit rebuilds or watcher batches)
    const toCheck = files.filter((f) => this.manifest.files[f] && !this.manifest.files[f]!.stale);
    const reads = await Promise.all(toCheck.map((f) => readAndHash(this.config, f).catch(() => null)));
    const sources = new Map<string, string>();
    for (const r of reads) {
      if (!r) continue;
      if (this.manifest.files[r.rel]!.contentHash !== r.hash) {
        changed.push(r.rel);
        sources.set(r.rel, r.source);
      }
    }
    const deleted = scope ? [] : Object.keys(this.manifest.files).filter((f) => !fileSet.has(f));

    // extract added/changed
    let extracted = 0;
    for (const rel of [...added, ...changed]) {
      try {
        const source = sources.get(rel) ?? (await readAndHash(this.config, rel)).source;
        const fx = await extractFile(rel, source);
        this.extractions.set(rel, fx);
        const shard = await this.store.saveShard(fx);
        this.manifest.files[rel] = { contentHash: fx.contentHash, shard, stale: false };
        extracted++;
      } catch (err) {
        // unreadable/unparseable file: drop it from the index rather than abort
        console.error(`[transcend] extract failed for ${rel}:`, err instanceof Error ? err.message : err);
        delete this.manifest.files[rel];
        this.extractions.delete(rel);
      }
    }
    for (const rel of deleted) {
      const entry = this.manifest.files[rel];
      if (entry) await this.store.deleteShard(entry.shard);
      delete this.manifest.files[rel];
      this.extractions.delete(rel);
    }

    this.recomputeGraph();
    this.changedSinceCluster += extracted + deleted.length;
    const needCluster =
      !this.state.derived ||
      this.changedSinceCluster >= RECLUSTER_MIN_FILES ||
      this.changedSinceCluster >= Math.max(1, this.extractions.size) * RECLUSTER_MIN_FRACTION * 100;
    if (cold || needCluster) {
      this.recluster();
    } else {
      this.inheritClusters();
    }

    this.manifest.builtAt = new Date().toISOString();
    this.manifest.derived = {
      fresh: true,
      clusteredAt: new Date().toISOString(),
      clusters: Object.fromEntries(this.state.derived?.clusterOf ?? []),
      clusterLabels: Object.fromEntries([...(this.state.derived?.clusterLabels ?? [])].map(([k, v]) => [String(k), v])),
    };
    await this.store.saveManifest(this.manifest);
    this.state.builtAt = this.manifest.builtAt;
    this.refreshStaleSet();

    return {
      filesScanned: files.length,
      filesExtracted: extracted,
      filesDeleted: deleted.length,
      durationMs: Date.now() - t0,
      cold,
    };
  }

  private recomputeGraph(): void {
    const { nodes, edges } = resolveGraph([...this.extractions.values()]);
    const out = new Map<string, GraphEdge[]>();
    const inc = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
      if (e.to) (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
    }
    this.state.nodes = nodes;
    this.state.edges = edges;
    this.state.out = out;
    this.state.inc = inc;
    this.applyDerivedToNodes();
  }

  private recluster(): void {
    this.state.derived = computeDerived(this.state.nodes, this.state.edges);
    this.changedSinceCluster = 0;
    this.applyDerivedToNodes();
  }

  /** Small change: keep previous clusters; new files take the majority cluster
   * of their resolved import neighbors. Hub scores recomputed (cheap). */
  private inheritClusters(): void {
    const derived = this.state.derived;
    if (!derived) return this.recluster();
    const fresh = computeDerived(this.state.nodes, this.state.edges);
    // keep old cluster ids where known, fill gaps from fresh computation
    for (const [id, c] of fresh.clusterOf) {
      if (!derived.clusterOf.has(id)) derived.clusterOf.set(id, c);
    }
    derived.scoreOf = fresh.scoreOf;
    this.applyDerivedToNodes();
  }

  private applyDerivedToNodes(): void {
    const d = this.state.derived;
    if (!d) return;
    for (const n of this.state.nodes.values()) {
      const c = d.clusterOf.get(n.id);
      const s = d.scoreOf.get(n.id);
      if (c !== undefined) n.cluster = c;
      if (s !== undefined) n.score = s;
    }
  }

  private refreshStaleSet(): void {
    this.state.staleSet = new Set(
      Object.entries(this.manifest.files)
        .filter(([, e]) => e.stale)
        .map(([f]) => f),
    );
  }

  /** Watcher hook: mark a file dirty the moment a change event arrives. */
  markStale(rel: string): void {
    const entry = this.manifest.files[rel];
    if (entry) entry.stale = true;
    this.state.staleSet.add(rel);
  }

  // ------------------------------------------------------------ MapApi

  isBuilt(): boolean {
    return this.extractions.size > 0;
  }

  builtAt(): string | null {
    return this.state.builtAt;
  }

  staleFiles(): string[] {
    return [...this.state.staleSet];
  }

  overview(opts: { focus?: string; hubsPerCluster?: number }): OverviewData {
    return overviewQuery(this.state, opts);
  }

  search(opts: { query: string; kind: string; limit: number }) {
    return searchQuery(this.state, opts);
  }

  neighbors(opts: Parameters<MapApi["neighbors"]>[0]): NeighborsData {
    return neighborsQuery(this.state, opts);
  }

  path(opts: Parameters<MapApi["path"]>[0]): PathData {
    return pathQuery(this.state, opts);
  }

  status() {
    return {
      built: this.isBuilt(),
      builtAt: this.state.builtAt,
      files: this.extractions.size,
      symbols: [...this.state.nodes.values()].filter((n) => n.kind !== "file").length,
      edges: this.state.edges.length,
      staleFiles: this.staleFiles(),
      watching: this.watching,
      languages: [...new Set([...this.extractions.values()].map((fx) => fx.lang))],
    };
  }

  getNodeView(id: string): MapNodeView | undefined {
    const n = this.state.nodes.get(id);
    return n ? toView(n, this.state) : undefined;
  }

  findByQualifiedName(file: string, qualifiedName: string): MapNodeView | undefined {
    const fx = this.extractions.get(file);
    if (!fx) return undefined;
    const n = fx.nodes.find((x) => x.qualifiedName === qualifiedName);
    return n ? toView(this.state.nodes.get(n.id) ?? n, this.state) : undefined;
  }

  /** Raw node access for the bridge (loc is 0-based here). */
  getNode(id: string): GraphNode | undefined {
    return this.state.nodes.get(id);
  }

  /** Innermost symbol node containing a 0-based line in a file, else the file node. */
  nodeAtLine(file: string, line0: number): GraphNode | undefined {
    const fx = this.extractions.get(file);
    if (!fx) return undefined;
    let best: GraphNode | undefined;
    for (const n of fx.nodes) {
      if (n.kind === "file") continue;
      if (n.loc.startLine <= line0 && line0 <= n.loc.endLine) {
        if (!best || n.loc.startLine >= best.loc.startLine) best = this.state.nodes.get(n.id) ?? n;
      }
    }
    return best ?? this.state.nodes.get(makeNodeId(fx.lang, file));
  }

  /** Used by nav_callHierarchy's map fallback. */
  callEdges(id: string, direction: "incoming" | "outgoing"): GraphEdge[] {
    const list = direction === "incoming" ? this.state.inc.get(id) : this.state.out.get(id);
    return (list ?? []).filter((e) => e.kind === "calls");
  }

  requireBuilt(): void {
    if (!this.isBuilt()) {
      throw new ToolError("MAP_NOT_BUILT", "The static map index has not been built yet.", {
        hint: "Run map_rebuild.",
      });
    }
  }

  /** Posix relpath inside the repo for an absolute path, or null. */
  relPath(abs: string): string | null {
    const rel = path.relative(this.config.root, abs);
    return rel.startsWith("..") ? null : rel.split(path.sep).join("/");
  }
}
