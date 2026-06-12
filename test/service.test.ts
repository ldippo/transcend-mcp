import { cp, mkdtemp, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfig } from "../src/config.js";
import { MapService } from "../src/map/service.js";

let root: string;
let svc: MapService;

async function shardFiles(indexDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const filesDir = path.join(indexDir, "files");
  for (const sub of await readdir(filesDir)) {
    for (const f of await readdir(path.join(filesDir, sub))) {
      const { mtimeMs } = await import("node:fs").then((fs) => fs.promises.stat(path.join(filesDir, sub, f)));
      out.set(`${sub}/${f}`, mtimeMs);
    }
  }
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "transcend-test-"));
  await cp(path.resolve("test/fixtures/py-mini"), root, { recursive: true });
  svc = new MapService(makeConfig(root, { watch: false }));
  await svc.rebuild();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("MapService incremental rebuild", () => {
  it("cold build indexes the fixture", () => {
    const s = svc.status();
    expect(s.built).toBe(true);
    expect(s.files).toBe(5);
    expect(s.symbols).toBeGreaterThan(15);
  });

  it("re-extracts only the changed file and rewrites exactly one shard", async () => {
    const before = await shardFiles(path.join(root, ".transcend", "index"));
    await appendFile(path.join(root, "app", "models.py"), "\n\ndef new_helper(x):\n    return x\n");
    const r = await svc.rebuild();
    expect(r.filesExtracted).toBe(1);
    expect(r.cold).toBe(false);
    const after = await shardFiles(path.join(root, ".transcend", "index"));
    const rewritten = [...after].filter(([k, m]) => before.get(k) !== m).map(([k]) => k);
    expect(rewritten).toHaveLength(1);
    expect(svc.getNode("py:app/models.py#new_helper")).toBeDefined();
  });

  it("a barrel-ish edit re-routes edges on rebuild (full re-resolution)", async () => {
    // point api.py at base.BaseStore instead of store.SessionStore
    expect(svc.getNode("py:app/api.py#authenticate")).toBeDefined();
    await writeFile(
      path.join(root, "app", "api.py"),
      "from .models import User\n\n\ndef authenticate(token: str):\n    return None\n",
    );
    await svc.rebuild();
    const inc = svc.callEdges("py:app/store.py#SessionStore.refresh", "incoming");
    expect(inc).toHaveLength(0); // old api->refresh call edge is gone
  });

  it("deleting a file removes its nodes and shard", async () => {
    await rm(path.join(root, "app", "api.py"));
    const r = await svc.rebuild();
    expect(r.filesDeleted).toBe(1);
    expect(svc.getNode("py:app/api.py#authenticate")).toBeUndefined();
  });

  it("markStale is visible immediately and clears after rebuild", async () => {
    svc.markStale("app/store.py");
    expect(svc.staleFiles()).toContain("app/store.py");
    // stale flag propagates into node views
    const view = svc.getNodeView("py:app/store.py#SessionStore")!;
    expect(view.stale).toBe(true);
    await svc.rebuild();
    expect(svc.staleFiles()).toHaveLength(0);
  });

  it("warm start from disk matches the in-memory state", async () => {
    const svc2 = new MapService(makeConfig(root, { watch: false }));
    expect(await svc2.loadPersisted()).toBe(true);
    expect(svc2.status().symbols).toBe(svc.status().symbols);
    expect(svc2.getNode("py:app/store.py#SessionStore.refresh")).toBeDefined();
  });

  it("rename = delete + add: old id dies, new id appears", async () => {
    const oldPath = path.join(root, "app", "models.py");
    const src = await import("node:fs").then((fs) => fs.promises.readFile(oldPath, "utf8"));
    await rm(oldPath);
    await writeFile(path.join(root, "app", "domain.py"), src);
    await svc.rebuild();
    expect(svc.getNode("py:app/models.py#User")).toBeUndefined();
    expect(svc.getNode("py:app/domain.py#User")).toBeDefined();
  });
});

describe("MapService retrieval", () => {
  it("map.path finds the api -> store -> models chain", () => {
    const r = svc.path({
      from: "py:app/api.py#whoami",
      to: "py:app/models.py#User.display_name",
      maxLen: 6,
      includeReferences: false,
    });
    expect(r.found).toBe(true);
    // whoami -> display_name resolves directly by unique name; the chain is short
    expect(r.path!.length).toBeGreaterThanOrEqual(2);
    expect(r.path![0]!.edgeToNext).toBeDefined();
  });

  it("map.path finds a multi-hop chain when direct resolution is impossible", () => {
    const r = svc.path({
      from: "py:app/base.py#BaseStore",
      to: "py:app/api.py#login",
      maxLen: 6,
      includeReferences: false,
    });
    expect(r.found).toBe(true);
    expect(r.path!.length).toBeGreaterThanOrEqual(3);
  });

  it("neighbors respects maxNodes and reports omissions", () => {
    const r = svc.neighbors({
      nodeId: "py:app/store.py#SessionStore",
      direction: "both",
      depth: 2,
      maxNodes: 3,
    });
    expect(r.neighbors.length).toBeLessThanOrEqual(3);
    expect(r.omitted).toBeGreaterThan(0);
  });

  it("search ranks exact name matches first", () => {
    const r = svc.search({ query: "user", kind: "any", limit: 10 });
    expect(r.results[0]!.name.toLowerCase()).toBe("user");
  });
});
