# Architecture

One MCP server (stdio), two layers, one bridge.

```
            ┌────────────────────────────────────────────────┐
            │ MCP server (14 tools, uniform budgeted envelope)│
            └──────┬──────────────────┬───────────────┬──────┘
                   │ map_*            │ nav_*         │ resolve
            ┌──────▼──────┐    ┌──────▼──────┐  ┌─────▼─────┐
            │ MAP (static)│    │ LIVE (LSP)  │  │  BRIDGE   │
            │ tree-sitter │    │ pyright /   │  │ id <-> pos│
            │ graph index │    │ tsserver    │  │           │
            └─────────────┘    └─────────────┘  └───────────┘
```

## MAP — static, cheap, cached

- **Extraction**: web-tree-sitter (WASM — zero native modules, Node-version
  proof) with per-language `.scm` queries for symbols / imports / refs.
  Adding a language = one extractor directory + an LSP entry in `config.ts`;
  the pipeline is language-agnostic (`src/map/extract/registry.ts`).
- **Node IDs** are `lang:relpath#qualifiedName[~ordinal]` — position is never
  part of identity, so line drift doesn't invalidate IDs, edges, or clusters.
  Overloads collapse to one node; anonymous functions attribute their calls to
  the nearest named ancestor; re-exports are edges, not duplicate nodes.
- **Edge resolution** (`src/map/resolve.ts`) is honest about what parse-time
  analysis can know. Confidence ladder: `exact` (same-file scope, `self.x`) >
  `import` (followed an import binding, re-export tables included) > `name`
  (unique global name match). Ambiguity produces `resolved: false` edges with
  ranked candidates — the explicit MAP→LIVE handoff signal. It re-runs in full
  on every rebuild: a one-line barrel edit can re-route distant edges, and full
  resolution is sub-second at 5k files, so caching cross-file edges would be a
  correctness trap.
- **Derived state**: Louvain communities on a file-level weighted projection
  (seeded RNG — deterministic across rebuilds), hub score = 0.5·degree +
  0.5·PageRank. Reclustered lazily (≥25 files or ≥2% changed); small edits
  inherit prior clusters so cluster IDs stay stable.
- **Persistence**: `.transcend/index/` — a manifest (content hashes + stale
  flags) plus one JSON shard per file, so incremental saves are O(changed),
  and all writes are tmp+rename atomic.
- **Performance**: 1,500-file cold index ≈ 0.7s sequential; incremental
  rebuild ≈ 150ms (hash sweep + one re-extract + full re-resolution). The
  worker-pool design from the original plan was dropped — measured numbers
  made it dead weight.

## LIVE — precise, current, on-demand

- One LSP client per language (`src/live/client.ts`), spawned lazily on the
  first nav/resolve call; `map_*` never touches the pool. Crash → backoff
  restart (0.5s→8s, max 5 per 2min window, then terminal `failed`) with
  open-document replay.
- **Freshness invariant** (`src/live/documents.ts`): disk is the source of
  truth. Every query stats the target file *and re-syncs every open document*
  (an edited file open with stale content would silently poison results across
  the project), pushing full-text `didChange` on content-hash mismatch.
- **Async project loads**: tsserver/pyright answer early semantic queries with
  empty results. Until a client's first non-empty semantic answer flips
  `semanticReady`, empty results are retried against an 8s deadline.
- Requests carry a hard deadline (`Promise.race`, not just LSP cancellation —
  servers may answer a cancelled request anyway) surfaced as `LSP_TIMEOUT`.
- Capability gates: `nav_callHierarchy` falls back to references (incoming) or
  map call edges (outgoing) with `source: "fallback-*"` when the server lacks
  the capability. A missing server binary degrades to map-only with an install
  hint, re-probed at most once a minute.

## BRIDGE — `resolve` (src/bridge/)

- **MAP→LSP**: parse ID → stat file → hierarchical documentSymbol → walk the
  qualifiedName chain. Chain miss triggers name-anchored re-resolution on the
  last segment (unique hit → `relocated: true`). The live location is always
  authoritative; when it differs from the indexed one the response carries
  `mapStale: true` plus the old `mapRange` — staleness is reported, never
  silently corrected. LSP unavailable → the map's stored range with
  `verified: false`.
- **LSP→MAP**: position → enclosing symbol chain → qualifiedName → map lookup,
  walking the chain upward to the nearest container (`inMap: false` +
  `nearestNodeId`) when the map hasn't caught up.

## Cross-cutting

- **Envelope** (`src/respond.ts`): every tool returns
  `{ok, data, error?, tokenBudget, truncated, dropped?, warnings}` through one
  helper. Truncation binary-searches the largest fitting prefix of declared
  arrays (ranked: references by file, neighbors by hub score) and always says
  what was dropped and how to recover it. Domain failures are `ok: false`
  envelopes with stable error codes — never MCP protocol errors.
- **Positions**: 1-based line/col on the MCP surface, 0-based internally and
  in the persisted index; conversion happens at the layer boundaries.
- **Watcher** (`src/map/watch.ts`): one chokidar instance feeds both the map
  (stale flags set on event arrival, debounced incremental rebuild — 300ms
  quiet / 2s max-wait, single-flight) and the LIVE layer (didClose on unlink).
- No telemetry, no network calls; everything runs locally.
