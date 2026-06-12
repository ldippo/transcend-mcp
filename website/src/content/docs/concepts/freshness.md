---
title: Freshness & Staleness
description: Disk is the source of truth — nav is always live, the map flags itself stale, and disagreements are always reported.
---

<!-- adapted from docs/ARCHITECTURE.md and docs/AGENT_GUIDE.md -->

A code-intelligence layer that silently serves stale answers is worse than none: the agent edits on bad coordinates and writes bugs with confidence. transcend-mcp's rule is simple — **only the map is cached, the live layer cannot be stale, and staleness is observable everywhere it could matter.**

## The live layer's freshness invariant

Disk is the source of truth. Before every `nav_*` or `resolve` query the server:

1. **Stats the queried file** and pushes a full-text `didChange` to the language server if the content hash moved.
2. **Re-syncs every other open document** the same way — because LSP results depend on all open buffers, an edited file sitting open with stale content would silently poison answers about *other* files.

The effect is mechanical: append a new caller to a file and the very next `nav_references` includes it. No watcher race, no refresh step. (Agents edit via file writes, so unsaved-editor-buffer support is deliberately out of scope; the tool name `nav_updateBuffer` is reserved if that ever changes.)

One nuance: language servers load projects asynchronously and answer early semantic queries with empty results — not errors. Until a client's first non-empty semantic answer, empty results are retried against an 8-second deadline, so a cold start looks slow rather than wrong.

## The map's staleness lifecycle

```
edit lands on disk
  └─ watcher event → file flagged stale IMMEDIATELY
       └─ responses mentioning that file carry stale:true + a warning
            └─ debounced incremental rebuild (300ms quiet, 2s max wait)
                 └─ flag cleared; positions and edges current again
```

The flag is set *before* any rebuild work begins, so there is no window where the map is wrong but claims to be right. Every map response also carries `mapBuiltAt`, and `map_status` reports the full stale-file list plus watcher state.

## When the layers disagree, LSP wins — loudly

`resolve` is where disagreement surfaces. Given a node ID, it looks the symbol up live (hierarchical document symbols), compares against the indexed range, and reports:

| Field | Meaning |
|---|---|
| `mapStale: false` | Indexed and live positions agree |
| `mapStale: true` + `mapRange` | They differ — `location` is the live truth, `mapRange` echoes what the index thought |
| `relocated: true` | The container chain changed; the symbol was re-found by name within the file |
| `verified: false` | LSP unavailable — you're getting the map's stored range, flagged as unverified |

The canonical `location` field is always the authoritative one. Staleness is reported, never silently corrected — the agent should know its map is aging and can run `map_rebuild` when warnings accumulate.

## Cache keys, not timestamps

Incremental rebuilds diff **content hashes** (sha1), with mtime only ever a prefilter. Branch switches, `git checkout`, and editors that rewrite files all resolve correctly. Cross-file edges are *never* cached: a one-line edit to a barrel file can re-route hundreds of distant edges, so every rebuild re-runs full edge resolution — sub-second at 5k files, and immune to that entire class of invalidation bug.
