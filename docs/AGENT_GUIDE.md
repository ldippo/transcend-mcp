# Transcend — Agent Usage Guide

You have two cooperating code-intelligence layers over this repository. Use the
cheap one to orient, the precise one to confirm. Every response is JSON with
`file:line` anchors and a token budget; truncated responses always say what was
dropped and how to get it back.

## The three-step policy

1. **Orient with the MAP** (`map_overview`, `map_search`, `map_neighbors`,
   `map_path`). These read a pre-built static index: instant, no language-server
   cost, great for "what's here?", "what's related to X?", "how do A and B
   connect?". Node IDs look like `py:src/auth/session.py#SessionStore.refresh`.
   The map can lag recent edits — nodes carry `stale: true` when their file has
   changed since indexing, and edges with `resolved: false` are name-match
   guesses, not facts.

2. **Drill down with NAV** (`nav_definition`, `nav_references`, `nav_type`,
   `nav_callHierarchy`, ...). These query live language servers (pyright /
   tsserver) and always reflect current on-disk content. They are authoritative:
   confirm impact with `nav_references` **before** editing a symbol. They cost
   real latency, so narrow first with the map.

3. **Cross layers with `resolve`.** Map node ID → verified live
   `file:line:col` (with `mapStale: true` if the indexed position drifted — the
   live location wins). Or `file`+`line`+`col` → the enclosing symbol chain and
   its map node ID, so you can re-enter the graph from any nav result.

Prefer the cheapest call that answers the question. If the map answers it,
stop there; verify with nav only when you are about to rely on the answer.

Outside the three steps, one meta tool: **`metrics_report`** reports the token
savings transcend has produced — for each tool, emitted tokens vs the naive cost
of reading in full every file the responses pointed into, this session and
cumulatively. Call it when you want to show the value of using the server.

## Worked example: "Where is `refresh` defined and who calls it?"

```jsonc
// 1. find candidates cheaply
map_search {"query": "refresh"}
//    -> ts:src/store.ts#SessionStore.refresh (method, hub score 0.4)

// 2. structural callers (instant, may be stale/heuristic)
map_neighbors {"nodeId": "ts:src/store.ts#SessionStore.refresh",
               "direction": "in", "edgeKinds": ["calls"]}
//    -> api.ts#authenticate (calls, confidence "name")

// 3. bridge to a verified live position
resolve {"nodeId": "ts:src/store.ts#SessionStore.refresh"}
//    -> {location: {file: "src/store.ts", line: 17, col: 3}, mapStale: false}

// 4. ground truth before acting
nav_references {"file": "src/store.ts", "line": 17, "col": 3}
//    -> 2 references with snippets; this is the authoritative caller list
```

## Reading responses

- `tokenBudget: {requested, used, max}` — every tool accepts `tokenBudget`
  (default 2000, max 10000).
- `truncated: true` + `dropped: {kind, count, note}` — the note tells you the
  recovery move (usually a filter parameter, not a bigger budget).
- `warnings` — staleness nudges ("3 files changed since the last index ...").
- `error.code` — `MAP_NOT_BUILT` (run `map_rebuild`), `LSP_UNAVAILABLE` (map
  still works; the error includes the install command), `LSP_TIMEOUT` (retry or
  fall back to map), `SYMBOL_NOT_FOUND` (map stale — the error carries hints),
  `FILE_DELETED`, `BAD_NODE_ID`, `BAD_ARGS`.

## Freshness rules

- **NAV is always live** — results reflect the file system at query time,
  including edits made moments ago.
- **The MAP is cached** and rebuilt incrementally by a file watcher; between an
  edit and the rebuild, affected files are flagged stale everywhere they
  appear. Staleness is observable, never silent. `map_status` shows index age,
  stale counts, and per-language LSP health.
- When map and LSP disagree, **LSP wins**; `resolve` reports both.
