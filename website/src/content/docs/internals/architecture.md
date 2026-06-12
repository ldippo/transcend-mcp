---
title: Architecture
description: One MCP server, two layers, one bridge — the components and the load-bearing design decisions.
---

<!-- adapted from docs/ARCHITECTURE.md -->

```
            ┌─────────────────────────────────────────────────┐
            │ MCP server (14 tools, uniform budgeted envelope) │
            └──────┬──────────────────┬───────────────┬───────┘
                   │ map_*            │ nav_*         │ resolve
            ┌──────▼──────┐    ┌──────▼──────┐  ┌─────▼─────┐
            │ MAP (static)│    │ LIVE (LSP)  │  │  BRIDGE   │
            │ tree-sitter │    │ pyright /   │  │ id <-> pos│
            │ graph index │    │ tsserver    │  │           │
            └─────────────┘    └─────────────┘  └───────────┘
```

## MAP pipeline

**Extraction** uses web-tree-sitter (WASM — zero native modules, immune to Node ABI churn) with per-language `.scm` queries. A 1,500-file repo cold-indexes in ≈0.7s sequentially; the worker-pool design from the original plan was dropped once measured numbers made it dead weight.

**Edge resolution** runs over all extractions on every rebuild, in decreasing confidence: same-file scope (`exact`) → import bindings with transitive re-export tables (`import`) → unique global name match (`name`). Ambiguity yields `resolved: false` edges with ≤5 ranked candidates; zero matches (stdlib, third-party) are dropped, with external packages kept as synthetic nodes (`ts:ext:react`) so dependency structure stays visible. Cross-file edges are **never cached** — a barrel-file edit re-routes distant edges, and full re-resolution is sub-second, so caching would trade a correctness bug for nothing.

**Derived state**: Louvain communities on a weighted file-level projection (`imports`/`extends` weight 3, `calls` 2, `references` 1), seeded RNG for deterministic cluster IDs, renumbered by size. Hub score = `0.5·degree + 0.5·PageRank` on the symbol graph. Reclustering is lazy (≥25 files or ≥2% changed); small edits inherit prior clusters so IDs don't churn under the agent.

**Persistence** (`.transcend/index/`): a manifest of content hashes + stale flags, plus one JSON shard per file — incremental saves are O(changed), every write is tmp+rename atomic, and a `kill -9` mid-build leaves the previous index intact.

## LIVE layer

One LSP client per language (`src/live/client.ts`), lazily spawned — `map_*` tools never touch the pool. The state machine runs unspawned → starting → warming → ready, with crash → exponential-backoff restart (0.5s→8s, max 5 per 2-minute window → terminal `failed`) and open-document replay on recovery.

Three behaviors carry the correctness load:

1. **Sync-everything freshness** (`src/live/documents.ts`) — every query stats the queried file *and re-syncs all open documents* against disk (full-text `didChange` on hash mismatch). An edited file open with stale content would otherwise poison results about other files.
2. **Semantic readiness** — tsserver and pyright load projects asynchronously and answer early semantic queries with empty results, not errors. Until a client's first non-empty semantic answer flips `semanticReady`, empty results retry against an 8s deadline.
3. **Hard deadlines** — requests race a timer (`Promise.race`), not just LSP cancellation, because servers may answer a cancelled request anyway. Timeouts surface as `LSP_TIMEOUT`, never hangs.

## Bridge

MAP→LSP walks the live document-symbol tree by qualified name, with name-anchored re-resolution when containers changed (`relocated: true`). LSP→MAP builds the qualified name from the enclosing-symbol chain and walks it up to the nearest indexed container. Live positions always win; disagreement is reported via `mapStale` + `mapRange`, never silently corrected. Details: [The resolve Tool](/transcend-mcp/reference/resolve/).

## Cross-cutting

- **One envelope** (`src/respond.ts`): rank → binary-search the largest fitting prefix → annotate what was dropped. Domain failures are `ok: false` envelopes with stable codes — never MCP protocol errors.
- **One watcher** (`src/map/watch.ts`): chokidar feeds both the map (stale flags on event arrival, debounced single-flight incremental rebuild — 300ms quiet / 2s max-wait) and the LIVE layer (didClose on unlink).
- **Positions**: 1-based on the MCP surface, 0-based internally; conversion only at layer boundaries.
- **Local-only**: no telemetry, no network calls, no LLM calls in the indexing path.

Source: [github.com/ldippo/transcend-mcp](https://github.com/ldippo/transcend-mcp) — `src/map/`, `src/live/`, `src/bridge/`, `src/tools/`.
