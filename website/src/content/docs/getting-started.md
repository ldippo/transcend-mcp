---
title: Getting Started
description: Install transcend-mcp, wire it into your agent harness, and index your first repository.
---

<!-- adapted from README.md -->

transcend-mcp is a single MCP server over stdio. It serves one repository per process, indexes it in the background on first run, and keeps the index fresh with a file watcher.

## Install

```sh
git clone https://github.com/ldippo/transcend-mcp
cd transcend-mcp
npm install
npm run build
```

Language servers are optional but recommended — without them the server runs in map-only mode and `nav_*` tools return a structured `LSP_UNAVAILABLE` error with this exact install hint:

```sh
npm install -g pyright typescript-language-server typescript
```

## Run

```sh
node dist/src/index.js --root /path/to/repo            # stdio MCP server, watcher on
node dist/src/index.js --root /path/to/repo --no-watch # disable the file watcher
```

On first run the server builds the static map in the background (≈0.5s per 1k files) and persists it under `<repo>/.transcend/` — add that directory to your `.gitignore`. Subsequent runs warm-start from disk and refresh incrementally.

## Wire into a harness

Claude Code:

```sh
claude mcp add transcend -- node /path/to/transcend-mcp/dist/src/index.js --root /path/to/repo
```

Generic MCP configuration:

```json
{
  "mcpServers": {
    "transcend": {
      "command": "node",
      "args": ["/path/to/transcend-mcp/dist/src/index.js", "--root", "/path/to/repo"]
    }
  }
}
```

The orchestration policy — orient with the map, confirm with the language server — is embedded in the tool descriptions the agent reads, so it works out of the box. For a deeper briefing you can hand your agent, see [Orchestration](/transcend-mcp/concepts/orchestration/).

## First queries

```jsonc
map_status {}                          // index health, LSP availability
map_overview {"tokenBudget": 1500}     // clusters + hub symbols
map_search {"query": "refresh"}        // fuzzy lookup -> node IDs
resolve {"nodeId": "ts:src/store.ts#SessionStore.refresh"}  // -> live file:line:col
nav_references {"file": "src/store.ts", "line": 17, "col": 3}
```

## Try it interactively

```sh
npx @modelcontextprotocol/inspector node dist/src/index.js --root test/fixtures/ts-mini
```

## Languages

Python (`.py`, `.pyi` via pyright) and TypeScript/JavaScript (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx` via typescript-language-server) ship today. Adding more is a [small, contained exercise](/transcend-mcp/guides/add-a-language/).
