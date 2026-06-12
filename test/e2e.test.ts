/** End-to-end acceptance: "where is X defined and who calls it?" answered by
 * orienting on the MAP, crossing the bridge, and confirming with the LSP —
 * all over real MCP stdio, all within declared token budgets. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary } from "../src/live/spawn.js";

const hasTs = !!findBinary("typescript-language-server");

describe.skipIf(!hasTs)("E2E: orient on map, drill down with LSP", () => {
  let root: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const env = JSON.parse(res.content.find((c: any) => c.type === "text").text);
    // every response respects its declared budget
    if (env.tokenBudget.requested >= 100) {
      expect(env.tokenBudget.used).toBeLessThanOrEqual(env.tokenBudget.requested);
    }
    return env;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "transcend-e2e-"));
    await cp(path.resolve("test/fixtures/ts-mini"), root, { recursive: true });
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", path.resolve("src/index.ts"), "--root", root, "--no-watch"],
        cwd: path.resolve("."),
      }),
    );
    // wait for the background map build
    for (let i = 0; i < 60; i++) {
      const s = await call("map_status");
      if (s.data?.built) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("map did not build");
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it("answers 'where is refresh defined and who calls it?' in bounded tokens", async () => {
    // 1. ORIENT: cheap symbol lookup on the static map
    const search = await call("map_search", { query: "refresh", tokenBudget: 600 });
    expect(search.ok).toBe(true);
    const hit = search.data.results.find((r: any) => r.id === "ts:src/store.ts#SessionStore.refresh");
    expect(hit).toBeDefined();

    // 2. ORIENT: who points at it, structurally (still no LSP cost)
    const neighbors = await call("map_neighbors", {
      nodeId: hit.id,
      direction: "in",
      edgeKinds: ["calls"],
      tokenBudget: 800,
    });
    expect(neighbors.ok).toBe(true);
    expect(neighbors.data.neighbors.length).toBeGreaterThanOrEqual(1);

    // 3. BRIDGE: map node -> verified live position
    const resolved = await call("resolve", { nodeId: hit.id, tokenBudget: 600 });
    expect(resolved.ok).toBe(true);
    expect(resolved.data.verified).toBe(true);
    expect(resolved.data.mapStale).toBe(false);
    const { file, line, col } = resolved.data.location;

    // 4. DRILL: authoritative definition + callers from the language server
    const def = await call("nav_definition", { file, line, col, tokenBudget: 600 });
    expect(def.ok).toBe(true);
    expect(def.data.locations[0].file).toBe("src/store.ts");

    const refs = await call("nav_references", { file, line, col, tokenBudget: 1000 });
    expect(refs.ok).toBe(true);
    expect(refs.data.total).toBeGreaterThanOrEqual(1);
    // the structural candidates from step 2 are confirmed by ground truth
    const refFiles = refs.data.locations.map((l: any) => l.file);
    const mapCallerFiles = neighbors.data.neighbors.map((n: any) => n.file);
    expect(mapCallerFiles.some((f: string) => refFiles.includes(f))).toBe(true);
  }, 60_000);

  it("truncates oversized map responses with an actionable note", async () => {
    const tiny = await call("map_overview", { tokenBudget: 150 });
    expect(tiny.ok).toBe(true);
    expect(tiny.truncated).toBe(true);
    expect(tiny.dropped.note.length).toBeGreaterThan(10);
  });
});
