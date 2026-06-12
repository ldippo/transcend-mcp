/** documentSymbol tree utilities for the bridge: qualified-name matching in
 * both directions (chain walk and position containment). */
import { DocumentSymbolRequest, type DocumentSymbol } from "vscode-languageserver-protocol";
import type { LspClient } from "../live/client.js";

export async function fetchSymbolTree(client: LspClient, uri: string): Promise<DocumentSymbol[]> {
  const result = await client.request(DocumentSymbolRequest.type, { textDocument: { uri } });
  if (!result?.length) return [];
  // hierarchicalDocumentSymbolSupport is declared; both servers honor it
  return "range" in result[0]! ? (result as DocumentSymbol[]) : [];
}

/** Normalized symbol name: pyright may suffix overload info; strip noise. */
function norm(name: string): string {
  return name.replace(/\(.*\)$/, "").trim();
}

/** Walk the tree following qualifiedName segments ("Outer.Inner.method"). */
export function findByQualifiedName(tree: DocumentSymbol[], qualifiedName: string): DocumentSymbol | null {
  const segments = qualifiedName.split(".");
  let level = tree;
  let found: DocumentSymbol | null = null;
  for (const seg of segments) {
    found = level.find((s) => norm(s.name) === seg) ?? null;
    if (!found) return null;
    level = found.children ?? [];
  }
  return found;
}

/** All symbols matching a bare name anywhere in the tree (for name-anchored
 * re-resolution when the full chain no longer matches). */
export function findByName(tree: DocumentSymbol[], name: string): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  const visit = (list: DocumentSymbol[]) => {
    for (const s of list) {
      if (norm(s.name) === name) out.push(s);
      if (s.children?.length) visit(s.children);
    }
  };
  visit(tree);
  return out;
}

/** Deepest chain of symbols whose range contains a 0-based position. */
export function chainAtPosition(tree: DocumentSymbol[], line: number, character: number): DocumentSymbol[] {
  const chain: DocumentSymbol[] = [];
  let level: DocumentSymbol[] | undefined = tree;
  while (level?.length) {
    const hit: DocumentSymbol | undefined = level.find((s) => contains(s, line, character));
    if (!hit) break;
    chain.push(hit);
    level = hit.children;
  }
  return chain;
}

function contains(s: DocumentSymbol, line: number, character: number): boolean {
  const { start, end } = s.range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}

/** Flat list of top-level symbol names — used for SYMBOL_NOT_FOUND hints. */
export function topLevelNames(tree: DocumentSymbol[], limit = 10): string[] {
  return tree.slice(0, limit).map((s) => norm(s.name));
}
