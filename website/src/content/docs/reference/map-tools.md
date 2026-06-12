---
title: Map Tools
description: The six map_* tools — budgeted queries over the static structural index.
---

All map tools read the pre-built index: no language-server cost, millisecond latency. Every tool accepts `tokenBudget` (default 2000, max 10000) and returns the [standard envelope](/transcend-mcp/reference/envelope/). Node IDs look like `ts:src/store.ts#SessionStore.refresh` — see [Node IDs](/transcend-mcp/internals/node-ids/).

## map_overview

Start here on any unfamiliar codebase. Clusters of related files with their top hub symbols.

| Param | Type | Default | Notes |
|---|---|---|---|
| `focus` | string | — | Restrict to a subtree, e.g. `"src/auth"` |
| `hubsPerCluster` | int 1–20 | 5 | |
| `tokenBudget` | int 100–10000 | 2000 | |

Returns `{builtAt, files, symbols, staleFiles, clusters: [{id, label, files, hubs}]}` where each hub carries `id`, `kind`, `signature`, `doc`, and hub `score`.

## map_search

Fuzzy symbol lookup — the cheap way to turn a name into node IDs.

| Param | Type | Default |
|---|---|---|
| `query` | string, min 2 chars | — |
| `kind` | `function` \| `class` \| `method` \| `interface` \| `variable` \| `file` \| `any` | `any` |
| `limit` | int ≤ 100 | 20 |

Exact name matches rank first, then prefix, substring, qualified-name, and file-path hits — all weighted by hub score. Name-based and possibly stale; `nav_workspaceSymbols` is the live equivalent.

## map_neighbors

The relationship graph around one node: callers/callees, imports, inheritance, containment.

| Param | Type | Default |
|---|---|---|
| `nodeId` | node ID | — |
| `direction` | `in` \| `out` \| `both` | `both` |
| `edgeKinds` | subset of `contains` `imports` `exports` `calls` `extends` `implements` `references` | all |
| `depth` | int 1–3 | 1 |
| `maxNodes` | int ≤ 200 | 50 |

Expansion is best-first — shallow depth first, hub score within a depth — with a per-node neighbor cap of 20, so the budget keeps the valuable part. Unresolved edges appear once (flagged `resolved: false`, `confidence: "candidate"`) and are not expanded.

**Example:**

```jsonc
// request
{"nodeId": "py:app/store.py#SessionStore.refresh", "direction": "in",
 "edgeKinds": ["calls"], "tokenBudget": 800}

// response (envelope.data)
{
  "node": {"id": "py:app/store.py#SessionStore.refresh", "kind": "method",
           "file": "app/store.py", "line": 21, "score": 0.37},
  "neighbors": [
    {"id": "py:app/api.py#authenticate", "kind": "function",
     "file": "app/api.py", "line": 15,
     "edge": "calls", "direction": "in", "resolved": true,
     "confidence": "name", "depth": 1}
  ],
  "omitted": 0,
  "mapBuiltAt": "2026-06-12T14:38:18Z",
  "staleFiles": []
}
```

## map_path

Shortest structural path between two symbols — bidirectional BFS over resolved `imports`/`exports`/`calls`/`extends`/`implements`/`contains` edges (the noisy `references` kind is opt-in via `includeReferences: true`). `maxLen` defaults to 6 hops. Returns the node sequence with each connecting edge's kind and direction, or `{found: false}`.

## map_rebuild

Incremental rebuild: only changed files re-parse (content-hash diff), then cross-file edges re-resolve in full. Optional `scope` limits the sweep to a subtree. Never needed for `nav_*` correctness — those are always live. Returns `{filesScanned, filesExtracted, filesDeleted, durationMs, cold}`.

## map_status

Health of both layers in one call: index age, file/symbol/edge counts, the stale-file list, watcher state, and per-language LSP client state (including a stderr tail for crashed servers). Cheap — call it whenever results look off.
