import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractFile } from "../src/map/extract/registry.js";
import type { FileExtraction } from "../src/map/types.js";

const PY = path.resolve("test/fixtures/py-mini");
const TS = path.resolve("test/fixtures/ts-mini");

async function extract(root: string, rel: string): Promise<FileExtraction> {
  return extractFile(rel, await readFile(path.join(root, rel), "utf8"));
}

const qnames = (fx: FileExtraction) => fx.nodes.map((n) => `${n.kind}:${n.qualifiedName}`);

describe("python extractor", () => {
  it("extracts classes, methods and the file node from store.py", async () => {
    const fx = await extract(PY, "app/store.py");
    expect(qnames(fx)).toEqual(
      expect.arrayContaining([
        "file:",
        "class:SessionStore",
        "method:SessionStore.refresh",
        "method:SessionStore.create",
      ]),
    );
    const cls = fx.nodes.find((n) => n.qualifiedName === "SessionStore")!;
    expect(cls.id).toBe("py:app/store.py#SessionStore");
    expect(cls.doc).toContain("Keeps sessions");
    expect(cls.signature).toBe("class SessionStore(BaseStore)");
  });

  it("captures relative imports and extends/calls refs", async () => {
    const fx = await extract(PY, "app/store.py");
    expect(fx.rawImports.map((i) => i.source)).toEqual(expect.arrayContaining([".base", ".models", "typing"]));
    expect(fx.rawRefs).toContainEqual(
      expect.objectContaining({ kind: "extends", name: "BaseStore", fromQName: "SessionStore" }),
    );
    expect(fx.rawRefs).toContainEqual(
      expect.objectContaining({ kind: "calls", name: "self.put", fromQName: "SessionStore.refresh" }),
    );
  });

  it("resolves relative import sources against the file set", async () => {
    const { pythonExtractor } = await import("../src/map/extract/python/extractor.js");
    const files = new Set(["app/__init__.py", "app/base.py", "app/models.py", "app/store.py"]);
    expect(pythonExtractor.resolveImportSource(".base", "app/store.py", files)).toEqual(["app/base.py"]);
    expect(pythonExtractor.resolveImportSource("app.models", "app/api.py", files)).toEqual(["app/models.py"]);
    expect(pythonExtractor.resolveImportSource("typing", "app/store.py", files)).toEqual([]);
  });
});

describe("typescript extractor", () => {
  it("extracts class members and detects exports", async () => {
    const fx = await extract(TS, "src/store.ts");
    expect(qnames(fx)).toEqual(
      expect.arrayContaining(["class:SessionStore", "method:SessionStore.refresh", "property:SessionStore.sessions"]),
    );
    const cls = fx.nodes.find((n) => n.qualifiedName === "SessionStore")!;
    expect(cls.exported).toBe(true);
  });

  it("extracts interfaces and functions from models.ts", async () => {
    const fx = await extract(TS, "src/models.ts");
    expect(qnames(fx)).toEqual(
      expect.arrayContaining(["interface:User", "interface:Session", "function:displayName", "function:isExpired"]),
    );
  });

  it("captures heritage (extends + implements)", async () => {
    const store = await extract(TS, "src/store.ts");
    expect(store.rawRefs).toContainEqual(
      expect.objectContaining({ kind: "extends", name: "AbstractStore", fromQName: "SessionStore" }),
    );
    const base = await extract(TS, "src/base.ts");
    expect(base.rawRefs).toContainEqual(
      expect.objectContaining({ kind: "implements", name: "BaseStore", fromQName: "AbstractStore" }),
    );
  });

  it("records barrel re-exports with the export: marker", async () => {
    const fx = await extract(TS, "src/index.ts");
    const store = fx.rawImports.find((i) => i.source === "./store")!;
    expect(store.names).toContainEqual({ imported: "SessionStore", local: "export:SessionStore" });
  });

  it("resolves relative import sources", async () => {
    const { typescriptExtractor } = await import("../src/map/extract/typescript/extractor.js");
    const files = new Set(["src/base.ts", "src/models.ts", "src/store.ts"]);
    expect(typescriptExtractor.resolveImportSource("./base", "src/store.ts", files)).toEqual(["src/base.ts"]);
    expect(typescriptExtractor.resolveImportSource("react", "src/store.ts", files)).toEqual([]);
  });
});
