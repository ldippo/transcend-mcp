# transcend

**Docs: [ldippo.github.io/transcend-mcp](https://ldippo.github.io/transcend-mcp/)** · Suite: [transcend-harness](https://ldippo.github.io/transcend-harness/)

A code-intelligence MCP server for coding agents: a cheap static **map** of a
repository (tree-sitter structural graph — clusters, hubs, budgeted subgraphs)
plus precise **live navigation** (real language servers via LSP), bridged by
stable symbol IDs. Every response is structured, token-budgeted, and anchored
to `file:line` — never a raw file dump.

**Languages**: Python (pyright) and TypeScript/JavaScript
(typescript-language-server). Adding a language = a tree-sitter grammar +
`.scm` queries + an LSP command — no core changes.

## Install & run

```sh
npm install
npm run build

# optional but recommended — without them the server runs map-only:
npm install -g pyright typescript-language-server typescript

node dist/src/index.js --root /path/to/repo        # stdio MCP server
node dist/src/index.js --root /path/to/repo --no-watch
```

On first run the server indexes the repo in the background (≈0.5s per 1k
files) and persists the index under `<repo>/.transcend/` (add it to
`.gitignore`). A file watcher keeps the index fresh incrementally.

## Wire into a harness

Any MCP-over-stdio harness works. Claude Code:

```sh
claude mcp add transcend -- node /path/to/transcend/dist/src/index.js --root /path/to/repo
```

Generic MCP config:

```json
{
  "mcpServers": {
    "transcend": {
      "command": "node",
      "args": ["/path/to/transcend/dist/src/index.js", "--root", "/path/to/repo"]
    }
  }
}
```

Give the agent [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — it documents the
orient-with-map / confirm-with-LSP policy that the tool descriptions also
encode.

## Tool surface

| Tool | Layer | Purpose |
|---|---|---|
| `map_overview` | map | clusters + hub symbols; start here |
| `map_search` | map | fuzzy symbol lookup → node IDs |
| `map_neighbors` | map | callers/callees/imports/inheritance around a node |
| `map_path` | map | shortest structural path between two symbols |
| `map_rebuild`, `map_status` | map | index management + both layers' health |
| `nav_definition` / `nav_references` / `nav_implementations` | live | ground truth, always current |
| `nav_type` / `nav_symbols` / `nav_workspaceSymbols` | live | hover, file outline, workspace search |
| `nav_callHierarchy` | live | incoming/outgoing calls (capability-gated, with fallback) |
| `resolve` | bridge | node ID ⇄ verified live `file:line:col`, staleness flagged |

All tools accept `tokenBudget` (default 2000, max 10000) and return a uniform
envelope; see the agent guide.

## Development

```sh
npm test          # unit + integration (LSP tests auto-skip if servers absent)
npm run smoke     # build + scripted MCP client against the TS fixture
npx @modelcontextprotocol/inspector node dist/src/index.js --root test/fixtures/ts-mini
```

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

No telemetry. No network calls. Secrets are never read; configuration is CLI
flags only.
