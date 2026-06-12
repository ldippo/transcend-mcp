/** Scripted MCP stdio smoke test: spawns the built server against a fixture
 * repo and exercises the tool surface. Run via `npm run smoke`. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, "..", "src", "index.js"); // dist/test -> dist/src
const fixtureRoot = process.env.SMOKE_ROOT ?? path.resolve(here, "..", "..", "test", "fixtures", "ts-mini");

const EXPECTED_TOOLS = [
  "map_overview",
  "map_search",
  "map_neighbors",
  "map_path",
  "map_rebuild",
  "map_status",
  "nav_definition",
  "nav_references",
  "nav_implementations",
  "nav_type",
  "nav_symbols",
  "nav_workspaceSymbols",
  "nav_callHierarchy",
  "resolve",
];

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c: any) => c.type === "text")?.text;
  assert(text, `${name}: no text content`);
  return JSON.parse(text);
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [distIndex, "--root", fixtureRoot, "--no-watch"],
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  // 1. Tool surface
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [...EXPECTED_TOOLS].sort(), "tool list mismatch");
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]+$/, `bad tool name: ${n}`);
  console.log(`✓ ${tools.length} tools registered, names valid`);

  // 2. Wait for the background map build, then exercise the map surface
  let status = await call(client, "map_status");
  assert.strictEqual(typeof status.ok, "boolean");
  assert.strictEqual(typeof status.tokenBudget?.used, "number");
  for (let i = 0; i < 40 && !status.data?.built; i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = await call(client, "map_status");
  }
  assert.strictEqual(status.data.built, true, "map did not build within 10s");
  console.log(`✓ map built: ${status.data.files} files, ${status.data.symbols} symbols, ${status.data.edges} edges`);

  const overview = await call(client, "map_overview", { tokenBudget: 1500 });
  assert.strictEqual(overview.ok, true);
  assert(overview.data.clusters.length >= 1, "expected at least one cluster");
  console.log(`✓ map_overview: ${overview.data.symbols} symbols in ${overview.data.clusters.length} cluster(s)`);

  const search = await call(client, "map_search", { query: "refresh" });
  assert.strictEqual(search.ok, true);
  const refresh = search.data.results.find((r: any) => r.id.endsWith("#SessionStore.refresh"));
  assert(refresh, "map_search did not find SessionStore.refresh");
  console.log(`✓ map_search: found ${refresh.id}`);

  const neighbors = await call(client, "map_neighbors", { nodeId: refresh.id, direction: "in", tokenBudget: 800 });
  assert.strictEqual(neighbors.ok, true);
  assert(neighbors.data.neighbors.length >= 1, "expected incoming neighbors for refresh");
  console.log(`✓ map_neighbors: ${neighbors.data.neighbors.length} incoming edge(s)`);

  const pathRes = await call(client, "map_path", {
    from: neighbors.data.neighbors[0].id,
    to: refresh.id,
  });
  assert.strictEqual(pathRes.ok, true);
  assert.strictEqual(pathRes.data.found, true, "expected a structural path");
  console.log(`✓ map_path: ${pathRes.data.path.length} hops`);

  const badResolve = await call(client, "resolve", {});
  assert.strictEqual(badResolve.ok, false);
  assert.match(badResolve.error.code, /BAD_ARGS|LSP_UNAVAILABLE/);
  console.log(`✓ resolve arg validation: ${badResolve.error.code}`);

  // 3. LIVE layer (skipped when language servers are not installed)
  const navDef = await call(client, "nav_definition", { file: "src/api.ts", line: 8, col: 16 });
  if (!navDef.ok && navDef.error.code === "LSP_UNAVAILABLE") {
    console.log("• nav_* skipped: typescript-language-server not installed (map-only mode verified)");
  } else {
    // api.ts:8:16 is `store.create(...)` -> definition in store.ts
    assert.strictEqual(navDef.ok, true, `nav_definition failed: ${JSON.stringify(navDef.error)}`);
    assert(
      navDef.data.locations.some((l: any) => l.file === "src/store.ts"),
      `definition should land in store.ts, got ${JSON.stringify(navDef.data.locations)}`,
    );
    console.log(`✓ nav_definition: ${navDef.data.locations[0].file}:${navDef.data.locations[0].line}`);

    // refresh() is defined at store.ts; find its references
    const refs = await call(client, "nav_references", { file: "src/store.ts", line: 17, col: 3 });
    assert.strictEqual(refs.ok, true, `nav_references failed: ${JSON.stringify(refs.error)}`);
    assert(refs.data.total >= 1, "expected at least one reference to refresh()");
    console.log(`✓ nav_references: ${refs.data.total} reference(s) to refresh`);

    // freshness: append a new caller on disk, re-query, count must grow immediately
    const apiPath = path.join(fixtureRoot, "src", "api.ts");
    const original = await readFile(apiPath, "utf8");
    try {
      await writeFile(apiPath, original + "\nexport function keepAlive(t: string) {\n  return store.refresh(t);\n}\n");
      const refs2 = await call(client, "nav_references", { file: "src/store.ts", line: 17, col: 3 });
      assert.strictEqual(refs2.ok, true);
      assert(
        refs2.data.total > refs.data.total,
        `expected reference count to grow after disk edit (${refs.data.total} -> ${refs2.data.total})`,
      );
      console.log(`✓ freshness: disk edit visible immediately (${refs.data.total} -> ${refs2.data.total} refs)`);
    } finally {
      await writeFile(apiPath, original);
    }

    const hover = await call(client, "nav_type", { file: "src/store.ts", line: 17, col: 3 });
    assert.strictEqual(hover.ok, true);
    assert(hover.data.contents.includes("refresh"), "hover should mention refresh");
    console.log(`✓ nav_type: ${hover.data.contents.split("\n")[0]?.slice(0, 60)}`);

    const symbols = await call(client, "nav_symbols", { file: "src/store.ts" });
    assert.strictEqual(symbols.ok, true);
    const cls = symbols.data.symbols.find((s: any) => s.name === "SessionStore");
    assert(cls?.children?.some((c: any) => c.name === "refresh"), "outline should nest refresh under SessionStore");
    console.log(`✓ nav_symbols: SessionStore with ${cls.children.length} member(s)`);

    const hierarchy = await call(client, "nav_callHierarchy", {
      file: "src/store.ts",
      line: 17,
      col: 3,
      direction: "incoming",
    });
    assert.strictEqual(hierarchy.ok, true);
    assert(hierarchy.data.root.children.length >= 1, "refresh should have incoming callers");
    console.log(`✓ nav_callHierarchy (${hierarchy.data.source}): ${hierarchy.data.root.children.length} caller(s)`);

    // 4. Bridge: nodeId -> live location, fresh map agrees
    const res1 = await call(client, "resolve", { nodeId: "ts:src/store.ts#SessionStore.refresh" });
    assert.strictEqual(res1.ok, true, `resolve failed: ${JSON.stringify(res1.error)}`);
    assert.strictEqual(res1.data.location.file, "src/store.ts");
    assert.strictEqual(res1.data.mapStale, false);
    assert.strictEqual(res1.data.verified, true);
    console.log(`✓ resolve(nodeId): ${res1.data.location.file}:${res1.data.location.line} mapStale=${res1.data.mapStale}`);

    // 5. Bridge inverse: position -> nodeId round-trip
    const res2 = await call(client, "resolve", {
      file: res1.data.location.file,
      line: res1.data.location.line,
      col: res1.data.location.col,
    });
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.data.nodeId, "ts:src/store.ts#SessionStore.refresh", "round-trip should return the original id");
    console.log(`✓ resolve(position) round-trip: ${res2.data.nodeId}`);

    // 6. Staleness: insert lines above the symbol; resolve must flag drift and
    //    return the corrected (live) line while the map still has the old one
    const storePath = path.join(fixtureRoot, "src", "store.ts");
    const storeOriginal = await readFile(storePath, "utf8");
    try {
      await writeFile(storePath, "// drift\n// drift\n// drift\n" + storeOriginal);
      const res3 = await call(client, "resolve", { nodeId: "ts:src/store.ts#SessionStore.refresh" });
      assert.strictEqual(res3.ok, true);
      assert.strictEqual(res3.data.mapStale, true, "expected mapStale after inserting lines");
      assert.strictEqual(res3.data.location.line, res1.data.location.line + 3, "live line should reflect the drift");
      console.log(`✓ resolve staleness: live line ${res3.data.location.line}, mapStale=true, mapRange=${JSON.stringify(res3.data.mapRange)}`);
    } finally {
      await writeFile(storePath, storeOriginal);
    }
  }

  await client.close();
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
