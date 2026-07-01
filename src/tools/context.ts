/** Contracts the tool layer consumes. The map/, live/ and bridge/ modules
 * implement these; tools stay thin and identical from scaffold to finish. */
import type { Config } from "../config.js";
import type { MetricsRecorder } from "../metrics.js";
import type { Anchor } from "../types.js";

// ---------------------------------------------------------------- MAP

export interface MapNodeView {
  id: string;
  kind: string;
  name: string;
  file: string;
  line: number; // 1-based start of the symbol
  signature?: string;
  doc?: string;
  cluster?: number;
  score?: number;
  stale?: boolean; // file changed since last index of this node
}

export interface NeighborView extends MapNodeView {
  edge: string; // edge kind
  direction: "in" | "out";
  resolved: boolean;
  confidence?: string;
  depth: number;
}

export interface OverviewData {
  builtAt: string;
  files: number;
  symbols: number;
  staleFiles: number;
  clusters: {
    id: number;
    label: string;
    files: number;
    hubs: MapNodeView[];
  }[];
}

export interface NeighborsData {
  node: MapNodeView;
  neighbors: NeighborView[];
  /** Count of neighbors beyond the per-node cap / budget, before truncation. */
  omitted: number;
  mapBuiltAt: string;
  staleFiles: string[];
}

export interface PathData {
  found: boolean;
  path?: { node: MapNodeView; edgeToNext?: { kind: string; direction: "forward" | "back"; resolved: boolean } }[];
  staleFiles: string[];
}

export interface MapStatusData {
  built: boolean;
  builtAt: string | null;
  files: number;
  symbols: number;
  edges: number;
  staleFiles: string[];
  watching: boolean;
  languages: string[];
  lsp: Record<string, { state: string; detail?: string }>;
}

export interface RebuildData {
  filesScanned: number;
  filesExtracted: number;
  filesDeleted: number;
  durationMs: number;
  cold: boolean;
}

export interface MapApi {
  isBuilt(): boolean;
  builtAt(): string | null;
  staleFiles(): string[];
  overview(opts: { focus?: string; hubsPerCluster?: number }): OverviewData;
  search(opts: { query: string; kind: string; limit: number }): { results: MapNodeView[]; total: number };
  neighbors(opts: {
    nodeId: string;
    direction: "in" | "out" | "both";
    edgeKinds?: string[];
    depth: number;
    maxNodes: number;
  }): NeighborsData;
  path(opts: { from: string; to: string; maxLen: number; includeReferences: boolean }): PathData;
  rebuild(scope?: string): Promise<RebuildData>;
  status(): Omit<MapStatusData, "lsp">;
  /** Bridge support: raw node lookup. */
  getNodeView(id: string): MapNodeView | undefined;
  /** Bridge support: node lookup by file + qualified name. */
  findByQualifiedName(file: string, qualifiedName: string): MapNodeView | undefined;
}

// ---------------------------------------------------------------- LIVE

export interface FilePos {
  file: string; // repo-relative
  line: number; // 1-based
  col: number; // 1-based
}

export interface NavLocationsData {
  target: FilePos & { symbol?: string };
  locations: Anchor[];
  total: number;
  source: "lsp" | "fallback-references" | "fallback-map";
  language: string;
}

export interface HoverData {
  target: FilePos;
  contents: string; // markdown
  language: string;
}

export interface SymbolNodeView {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  children?: SymbolNodeView[];
}

export interface CallHierarchyItemView {
  name: string;
  kind: string;
  file: string;
  line: number;
  fromRanges?: { line: number; col: number }[];
  children?: CallHierarchyItemView[];
}

export interface LiveApi {
  definition(p: FilePos): Promise<NavLocationsData>;
  references(p: FilePos & { includeDeclaration: boolean }): Promise<NavLocationsData>;
  implementations(p: FilePos): Promise<NavLocationsData>;
  hover(p: FilePos): Promise<HoverData>;
  documentSymbols(file: string): Promise<{ file: string; symbols: SymbolNodeView[]; language: string }>;
  workspaceSymbols(query: string, limit: number): Promise<{ symbols: (MapNodeView | Anchor & { name: string; kind: string })[]; total: number }>;
  callHierarchy(p: FilePos & { direction: "incoming" | "outgoing"; depth: number }): Promise<{
    root: CallHierarchyItemView;
    direction: "incoming" | "outgoing";
    source: "lsp" | "fallback-references" | "fallback-map";
  }>;
  status(): Record<string, { state: string; detail?: string }>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------- BRIDGE

export interface ResolveFromNodeData {
  nodeId: string;
  location: Anchor; // authoritative (LSP when available)
  verified: boolean; // false when LSP unavailable and map range returned as-is
  mapStale: boolean | "unknown";
  relocated?: boolean;
  inMap: boolean;
  mapRange?: { line: number; endLine: number }; // echoed when it disagrees with live
  symbol?: { name: string; kind: string; signature?: string };
}

export interface ResolveFromPositionData {
  nodeId: string | null;
  inMap: boolean;
  nearestNodeId?: string | null;
  mapStale?: boolean;
  enclosingSymbols: { name: string; kind: string; line: number }[];
  qualifiedName: string | null;
  location: Anchor;
}

export interface BridgeApi {
  fromNode(nodeId: string): Promise<ResolveFromNodeData>;
  fromPosition(p: FilePos): Promise<ResolveFromPositionData>;
}

// ---------------------------------------------------------------- CONTEXT

export interface AppContext {
  config: Config;
  map: MapApi | null;
  live: LiveApi | null;
  bridge: BridgeApi | null;
  metrics: MetricsRecorder | null;
}
