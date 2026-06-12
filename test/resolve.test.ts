import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile } from "../src/map/extract/registry.js";
import { computeDerived } from "../src/map/graph.js";
import { resolveGraph, type ResolvedGraph } from "../src/map/resolve.js";
import type { FileExtraction } from "../src/map/types.js";

async function extractFixture(root: string, files: string[]): Promise<FileExtraction[]> {
  return Promise.all(files.map(async (rel) => extractFile(rel, await readFile(path.join(root, rel), "utf8"))));
}

const PY_FILES = ["app/__init__.py", "app/api.py", "app/base.py", "app/models.py", "app/store.py"];
const TS_FILES = ["src/api.ts", "src/base.ts", "src/index.ts", "src/models.ts", "src/store.ts"];

let py: ResolvedGraph;
let ts: ResolvedGraph;

beforeAll(async () => {
  py = resolveGraph(await extractFixture(path.resolve("test/fixtures/py-mini"), PY_FILES));
  ts = resolveGraph(await extractFixture(path.resolve("test/fixtures/ts-mini"), TS_FILES));
});

const edge = (g: ResolvedGraph, from: string, kind: string, to: string) =>
  g.edges.find((e) => e.from === from && e.kind === kind && e.to === to);

describe("python edge resolution", () => {
  it("resolves self.* calls within the class (exact)", () => {
    const e = edge(py, "py:app/store.py#SessionStore.refresh", "calls", "py:app/store.py#SessionStore.put");
    expect(e).toBeDefined();
    expect(e!.confidence).toBe("exact");
  });

  it("resolves extends through a relative import (import)", () => {
    const e = edge(py, "py:app/store.py#SessionStore", "extends", "py:app/base.py#BaseStore");
    expect(e).toBeDefined();
    expect(e!.confidence).toBe("import");
  });

  it("resolves method calls on typed values by unique global name (name)", () => {
    const e = edge(py, "py:app/store.py#SessionStore.refresh", "calls", "py:app/models.py#Session.is_expired");
    expect(e).toBeDefined();
    expect(e!.confidence).toBe("name");
  });

  it("links the api layer to the store across modules", () => {
    expect(edge(py, "py:app/api.py#authenticate", "calls", "py:app/store.py#SessionStore.refresh")).toBeDefined();
    expect(edge(py, "py:app/api.py#whoami", "calls", "py:app/api.py#authenticate")?.confidence).toBe("exact");
  });

  it("creates external module nodes for stdlib imports", () => {
    expect(py.nodes.get("py:ext:typing")).toBeDefined();
    expect(edge(py, "py:app/store.py", "imports", "py:ext:typing")).toBeDefined();
  });

  it("python package __init__ re-exports resolve to original symbols", () => {
    const e = edge(py, "py:app/__init__.py", "exports", "py:app/store.py#SessionStore");
    expect(e).toBeDefined();
  });

  it("emits contains edges file->class->method", () => {
    expect(edge(py, "py:app/store.py", "contains", "py:app/store.py#SessionStore")).toBeDefined();
    expect(edge(py, "py:app/store.py#SessionStore", "contains", "py:app/store.py#SessionStore.refresh")).toBeDefined();
  });
});

describe("typescript edge resolution", () => {
  it("resolves extends/implements through imports", () => {
    expect(edge(ts, "ts:src/store.ts#SessionStore", "extends", "ts:src/base.ts#AbstractStore")?.confidence).toBe("import");
    expect(edge(ts, "ts:src/base.ts#AbstractStore", "implements", "ts:src/base.ts#BaseStore")?.confidence).toBe("exact");
  });

  it("resolves cross-file function calls via import bindings", () => {
    const e = edge(ts, "ts:src/store.ts#SessionStore.refresh", "calls", "ts:src/models.ts#isExpired");
    expect(e).toBeDefined();
    expect(e!.confidence).toBe("import");
  });

  it("barrel re-exports produce exports edges to the original symbol", () => {
    expect(edge(ts, "ts:src/index.ts", "exports", "ts:src/store.ts#SessionStore")).toBeDefined();
    expect(edge(ts, "ts:src/index.ts", "exports", "ts:src/api.ts#login")).toBeDefined();
  });

  it("type annotations become references edges", () => {
    const refs = ts.edges.filter(
      (e) => e.kind === "references" && e.to === "ts:src/models.ts#Session" && e.resolved,
    );
    expect(refs.length).toBeGreaterThan(0);
  });

  it("ambiguous names become unresolved edges with ranked candidates", () => {
    // `get` exists on BaseStore, AbstractStore and SessionStore -> this.get
    // resolves exact, but a bare ambiguous name would carry candidates.
    const unresolved = ts.edges.filter((e) => !e.resolved);
    for (const e of unresolved) {
      expect(e.candidates!.length).toBeGreaterThan(0);
      expect(e.candidates!.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("derived state (clusters + hubs)", () => {
  it("is deterministic across repeated runs", () => {
    const runs = Array.from({ length: 5 }, () => computeDerived(py.nodes, py.edges));
    for (const r of runs.slice(1)) {
      expect([...r.clusterOf.entries()].sort()).toEqual([...runs[0]!.clusterOf.entries()].sort());
    }
  });

  it("assigns every file a cluster and symbols inherit it", () => {
    const d = computeDerived(py.nodes, py.edges);
    expect(d.clusterOf.get("py:app/store.py")).toBeDefined();
    expect(d.clusterOf.get("py:app/store.py#SessionStore.refresh")).toBe(d.clusterOf.get("py:app/store.py"));
  });

  it("ranks central models as hubs", () => {
    const d = computeDerived(py.nodes, py.edges);
    const session = d.scoreOf.get("py:app/models.py#Session") ?? 0;
    const median = [...d.scoreOf.values()].sort((a, b) => a - b)[Math.floor(d.scoreOf.size / 2)] ?? 0;
    expect(session).toBeGreaterThan(median);
  });
});
