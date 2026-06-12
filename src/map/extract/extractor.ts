/** Per-language extraction contract. Registering a language = an extractor
 * (grammar + queries + import resolution) plus an LSP entry in config.ts.
 * The pipeline (scan -> parse -> query -> extract -> persist) is language-agnostic. */
import type { Node, Query, Tree } from "web-tree-sitter";
import type { Lang } from "../../types.js";
import type { FileExtraction, Loc } from "../types.js";

export interface ExtractInput {
  file: string; // repo-relative posix path
  source: string;
  contentHash: string;
  tree: Tree;
  queries: { symbols: Query; imports: Query; refs: Query };
}

export interface LanguageExtractor {
  lang: Lang;
  extensions: string[];
  /** Grammar wasm file for a given source file (tsx needs its own grammar). */
  grammarFor(file: string): string;
  /** Names of the three .scm files' directory; loaded via treesitter.queryDir. */
  queryLanguage: "python" | "typescript";
  extract(input: ExtractInput): FileExtraction;
  /**
   * Map an import source string to candidate repo-relative paths that exist
   * in fileSet. Empty result = external dependency.
   */
  resolveImportSource(source: string, fromFile: string, fileSet: ReadonlySet<string>): string[];
}

export function locOf(node: Node): Loc {
  return {
    startLine: node.startPosition.row,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row,
    endCol: node.endPosition.column,
  };
}

/** Walk ancestors collecting enclosing named definition scopes (innermost last). */
export function scopeChain(node: Node, defTypes: ReadonlySet<string>, nameOf: (def: Node) => string | null): string[] {
  const chain: string[] = [];
  let cur: Node | null = node.parent;
  while (cur) {
    if (defTypes.has(cur.type)) {
      const n = nameOf(cur);
      if (n) chain.unshift(n);
    }
    cur = cur.parent;
  }
  return chain;
}

/** First line of a (doc)string/comment, trimmed and unquoted, for GraphNode.doc. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 200);
}
