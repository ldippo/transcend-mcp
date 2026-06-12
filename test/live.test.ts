/** LIVE-layer integration tests against real language servers. Skipped
 * automatically when the servers are not on PATH (CI matrix runs both modes). */
import { cp, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeConfig, type Config } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { LiveService } from "../src/live/api.js";
import { LspPool } from "../src/live/pool.js";
import { findBinary } from "../src/live/spawn.js";
import { MapService } from "../src/map/service.js";
import { Bridge } from "../src/bridge/resolve.js";

const hasTs = !!findBinary("typescript-language-server");
const hasPy = !!findBinary("pyright-langserver");

describe.skipIf(!hasTs)("LIVE layer (tsserver)", () => {
  let root: string;
  let cfg: Config;
  let live: LiveService;
  let map: MapService;
  let bridge: Bridge;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "transcend-live-"));
    await cp(path.resolve("test/fixtures/ts-mini"), root, { recursive: true });
    cfg = makeConfig(root, { watch: false });
    map = new MapService(cfg);
    await map.rebuild();
    live = new LiveService(cfg, new LspPool(cfg), () => map);
    bridge = new Bridge(cfg, map, live);
  }, 60_000);

  afterAll(async () => {
    await live.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("definition crosses files", async () => {
    // api.ts:8:16 -> store.create
    const d = await live.definition({ file: "src/api.ts", line: 8, col: 16 });
    expect(d.locations.some((l) => l.file === "src/store.ts")).toBe(true);
  });

  it("bridge fromNode -> fromPosition round-trip", async () => {
    const a = await bridge.fromNode("ts:src/store.ts#SessionStore.refresh");
    expect(a.verified).toBe(true);
    expect(a.mapStale).toBe(false);
    const b = await bridge.fromPosition(a.location);
    expect(b.nodeId).toBe("ts:src/store.ts#SessionStore.refresh");
    expect(b.inMap).toBe(true);
  });

  it("bridge reports FILE_DELETED for vanished files", async () => {
    await expect(bridge.fromNode("ts:src/missing.ts#Nope")).rejects.toMatchObject({ code: "FILE_DELETED" });
  });

  it("bridge reports SYMBOL_NOT_FOUND with hints for removed symbols", async () => {
    try {
      await bridge.fromNode("ts:src/store.ts#SessionStore.vanished");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("SYMBOL_NOT_FOUND");
      expect((err as ToolError).extras.mapStale).toBe(true);
    }
  });

  it("rejects malformed node ids", async () => {
    await expect(bridge.fromNode("go:main.go#main")).rejects.toMatchObject({ code: "BAD_NODE_ID" });
  });

  it("references reflect a disk edit immediately", async () => {
    const before = await live.references({ file: "src/store.ts", line: 17, col: 3, includeDeclaration: false });
    const apiPath = path.join(root, "src", "api.ts");
    const original = await readFile(apiPath, "utf8");
    try {
      await writeFile(apiPath, original + "\nexport const extra = (t: string) => store.refresh(t);\n");
      const after = await live.references({ file: "src/store.ts", line: 17, col: 3, includeDeclaration: false });
      expect(after.total).toBeGreaterThan(before.total);
    } finally {
      await writeFile(apiPath, original);
    }
  });

  it("recovers from a server crash and answers again (docs replayed)", async () => {
    const client = live.pool.client("ts");
    const pid = client.pid();
    expect(pid).toBeDefined();
    process.kill(pid!, "SIGKILL");
    // wait for crash detection + 500ms backoff restart
    await new Promise((r) => setTimeout(r, 1500));
    const d = await live.definition({ file: "src/api.ts", line: 8, col: 16 });
    expect(d.locations.some((l) => l.file === "src/store.ts")).toBe(true);
  }, 30_000);

  it("falls back to map call edges when callHierarchy capability is absent", async () => {
    const client = live.pool.client("ts");
    await client.ensureReady();
    const saved = client.capabilities.callHierarchyProvider;
    try {
      client.capabilities.callHierarchyProvider = undefined;
      const h = await live.callHierarchy({ file: "src/store.ts", line: 17, col: 3, direction: "outgoing", depth: 1 });
      expect(h.source).toBe("fallback-map");
      expect(h.root.children!.map((c) => c.name)).toContain("isExpired");
    } finally {
      client.capabilities.callHierarchyProvider = saved;
    }
  });

  it("times out slow requests with LSP_TIMEOUT instead of hanging", async () => {
    const tinyCfg = { ...cfg, requestTimeoutMs: 1 };
    const tinyLive = new LiveService(tinyCfg, new LspPool(tinyCfg));
    try {
      await expect(tinyLive.hover({ file: "src/store.ts", line: 17, col: 3 })).rejects.toMatchObject({
        code: "LSP_TIMEOUT",
      });
    } finally {
      await tinyLive.shutdown();
    }
  }, 30_000);
});

describe.skipIf(!hasPy)("LIVE layer (pyright)", () => {
  let root: string;
  let live: LiveService;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "transcend-livepy-"));
    await cp(path.resolve("test/fixtures/py-mini"), root, { recursive: true });
    const cfg = makeConfig(root, { watch: false });
    live = new LiveService(cfg, new LspPool(cfg));
  }, 60_000);

  afterAll(async () => {
    await live.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("definition works across modules", async () => {
    // api.py:16:22 -> store.refresh
    const d = await live.definition({ file: "app/api.py", line: 16, col: 22 });
    expect(d.locations.some((l) => l.file === "app/store.py")).toBe(true);
  });

  it("call hierarchy (or its fallback) finds callers of refresh", async () => {
    const h = await live.callHierarchy({ file: "app/store.py", line: 20, col: 9, direction: "incoming", depth: 1 });
    expect(h.root.children!.length).toBeGreaterThanOrEqual(1);
    expect(h.root.children!.some((c) => c.file.includes("api.py"))).toBe(true);
  });
});

describe("LIVE layer degradation", () => {
  it("missing binary -> LSP_UNAVAILABLE with install hint", async () => {
    const cfg = makeConfig(path.resolve("test/fixtures/py-mini"), { watch: false });
    cfg.lsp.py = { ...cfg.lsp.py, command: "no-such-langserver-xyz" };
    const live = new LiveService(cfg, new LspPool(cfg));
    try {
      await live.definition({ file: "app/api.py", line: 16, col: 22 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("LSP_UNAVAILABLE");
      expect((err as ToolError).extras.hint).toContain("map_");
    }
  });
});
