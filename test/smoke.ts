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

  // 2. Every tool returns the envelope shape (ok may be false while layers are stubs)
  const status = await call(client, "map_status");
  assert.strictEqual(typeof status.ok, "boolean");
  assert.strictEqual(typeof status.tokenBudget?.used, "number");
  console.log(`✓ map_status envelope: ok=${status.ok} built=${status.data?.built}`);

  const overview = await call(client, "map_overview", { tokenBudget: 500 });
  assert.strictEqual(typeof overview.ok, "boolean");
  if (!overview.ok) {
    assert.strictEqual(overview.error.code, "MAP_NOT_BUILT");
    console.log("✓ map_overview returns MAP_NOT_BUILT (map layer not wired yet)");
  } else {
    assert(overview.data.clusters.length >= 1, "expected at least one cluster");
    console.log(`✓ map_overview: ${overview.data.symbols} symbols in ${overview.data.clusters.length} cluster(s)`);
  }

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
