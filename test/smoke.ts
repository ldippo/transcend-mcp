/** Scripted MCP stdio smoke test: spawns the built server against a fixture
 * repo and exercises the tool surface. Run via `npm run smoke`. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";
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

  await client.close();
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
