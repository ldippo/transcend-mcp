import { describe, expect, it } from "vitest";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { chainAtPosition, findByName, findByQualifiedName, topLevelNames } from "../src/bridge/symbols.js";

const sym = (name: string, startLine: number, endLine: number, children: DocumentSymbol[] = []): DocumentSymbol => ({
  name,
  kind: 5,
  range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 80 } },
  selectionRange: { start: { line: startLine, character: 6 }, end: { line: startLine, character: 20 } },
  children,
});

const tree: DocumentSymbol[] = [
  sym("Outer", 0, 30, [sym("Inner", 2, 20, [sym("method", 4, 8)]), sym("other", 22, 25)]),
  sym("standalone", 32, 40),
];

describe("bridge symbol walking", () => {
  it("follows qualified name chains", () => {
    expect(findByQualifiedName(tree, "Outer.Inner.method")?.range.start.line).toBe(4);
    expect(findByQualifiedName(tree, "Outer.other")?.range.start.line).toBe(22);
    expect(findByQualifiedName(tree, "Outer.missing")).toBeNull();
    expect(findByQualifiedName(tree, "standalone")?.range.start.line).toBe(32);
  });

  it("normalizes pyright-style suffixed names", () => {
    const noisy = [sym("method(self, x)", 1, 3)];
    expect(findByQualifiedName(noisy, "method")).not.toBeNull();
  });

  it("finds symbols by bare name anywhere (re-resolution anchor)", () => {
    expect(findByName(tree, "method")).toHaveLength(1);
    expect(findByName(tree, "Inner")).toHaveLength(1);
    expect(findByName(tree, "nope")).toHaveLength(0);
  });

  it("builds the enclosing chain at a position", () => {
    const chain = chainAtPosition(tree, 5, 10);
    expect(chain.map((s) => s.name)).toEqual(["Outer", "Inner", "method"]);
    expect(chainAtPosition(tree, 23, 0).map((s) => s.name)).toEqual(["Outer", "other"]);
    expect(chainAtPosition(tree, 50, 0)).toHaveLength(0);
  });

  it("lists top-level names for hints", () => {
    expect(topLevelNames(tree)).toEqual(["Outer", "standalone"]);
  });
});
