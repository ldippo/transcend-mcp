/** MAP layer data model. Persisted shapes are versioned via schemaVersion. */
import type { Lang } from "../types.js";

export type NodeKind =
  | "file"
  | "module"
  | "class"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "variable"
  | "type_alias"
  | "property";

export type EdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "extends"
  | "implements"
  | "references";

/** 0-based, LSP-compatible. Converted to 1-based at the MCP surface. */
export interface Loc {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface GraphNode {
  id: string; // stable: <lang>:<relpath>[#qualifiedName[~ordinal]] — never positional
  kind: NodeKind;
  lang: Lang;
  name: string;
  qualifiedName: string; // dotted path within the file; "" for the file node itself
  file: string; // posix relpath
  loc: Loc; // mutable metadata, refreshed on re-extraction
  signature?: string;
  doc?: string; // first line of docstring/JSDoc
  exported: boolean;
  // derived, recomputed on (re)clustering — absent in persisted per-file records
  cluster?: number;
  score?: number;
}

export type EdgeConfidence = "exact" | "import" | "name";

export interface GraphEdge {
  from: string;
  kind: EdgeKind;
  resolved: boolean;
  to?: string; // present iff resolved
  toName: string; // raw name as written
  candidates?: string[]; // when unresolved: up to 5 plausible IDs
  loc?: Loc; // site of the call/import in `from`'s file
  confidence: EdgeConfidence;
}

export interface RawImport {
  source: string; // "./utils", "pkg.mod", "react"
  names: { imported: string; local: string }[]; // imported "*" = namespace/star
  loc: Loc;
}

export type RawRefKind = "calls" | "extends" | "implements" | "references";

export interface RawRef {
  fromQName: string; // enclosing symbol's qualifiedName; "" = module level
  kind: RawRefKind;
  /** Name as written; dotted for attribute/member access ("repo.save"). */
  name: string;
  loc: Loc;
}

/** One extractor run over one file. Self-contained, cacheable, shard-persisted. */
export interface FileExtraction {
  schemaVersion: 1;
  file: string;
  lang: Lang;
  contentHash: string; // sha1 of file bytes — incremental cache key
  extractedAt: string;
  nodes: GraphNode[]; // includes the file node; no cluster/score
  rawImports: RawImport[];
  rawRefs: RawRef[];
}

export interface FileEntry {
  contentHash: string;
  shard: string; // relative path under the index dir
  stale: boolean; // change observed, re-extraction pending
}

export interface IndexManifest {
  schemaVersion: 1;
  builtAt: string;
  root: string; // informational
  files: Record<string, FileEntry>;
  derived: {
    fresh: boolean; // clusters/scores match current extractions
    clusteredAt?: string;
    /** Cached cluster assignment per node id, so warm starts skip Louvain. */
    clusters?: Record<string, number>;
    clusterLabels?: Record<string, string>;
  };
}
