---
title: The Two Layers
description: Why transcend-mcp splits code intelligence into a cheap static map and a precise live layer, and what each is honest about.
---

<!-- adapted from docs/ARCHITECTURE.md -->

Code questions come in two shapes. *"What's in this repo and how does it hang together?"* needs breadth, tolerates approximation, and gets asked constantly. *"Exactly who calls this function right now?"* needs precision, tolerates no staleness, and gets asked right before an edit. One mechanism can't serve both well — so transcend-mcp ships two, and is explicit about which one you're talking to.

## MAP — static, cheap, cached

The map is a structural graph built locally with tree-sitter: nodes for files and symbols, edges for `imports`, `exports`, `calls`, `extends`, `implements`, `references`, and `contains`. On top of it:

- **Clusters** — Louvain communities over a file-level projection, so `map_overview` can say "this repo has six areas" with stable, deterministic cluster IDs (seeded RNG).
- **Hubs** — each node scores `0.5·degree + 0.5·PageRank`; high scorers surface first in every budgeted response.
- **Budgeted subgraphs** — `map_neighbors` expands best-first (depth, then hub score) and stops at your token budget, reporting what it omitted.

It costs milliseconds, runs with zero network or language-server involvement, and persists under `.transcend/` so restarts warm-start.

### What the map is honest about

Parse-time analysis cannot resolve types. A call like `repo.save(...)` is just "something named `save` on something named `repo`". Instead of pretending, every edge carries a confidence:

| Confidence | Meaning |
|---|---|
| `exact` | Same-file scope, or `self.x` / `this.x` against the enclosing class |
| `import` | Followed an import binding to a unique symbol (re-export chains included) |
| `name` | Unique global name match — right most of the time, but a guess |

Names matching **multiple** symbols become `resolved: false` edges carrying up to five ranked candidates. Those unresolved edges are a feature: they are the explicit signal to hand the question to the live layer.

## LIVE — precise, current, on-demand

`nav_*` tools talk to real language servers — pyright and typescript-language-server — spawned lazily on first use, pooled per language, restarted with backoff on crash. They answer with the type checker's authority: definitions, references, implementations, hover types, document/workspace symbols, call hierarchy.

The guarantee that matters: **results always reflect current disk state.** Before every query the server stats and re-syncs every open document, so an edit made one millisecond ago is already in the answer. There is no "rebuild" step for the live layer — it cannot be stale. (How: [Freshness & Staleness](/transcend-mcp/concepts/freshness/).)

The cost is real latency — tens to hundreds of milliseconds, more on cold project loads — which is exactly why the map exists.

## Why not just one layer?

- **LSP-only** burns seconds and tokens answering "what's here?" — workspace symbol floods, no notion of clusters or hubs, a cold server on every orientation question.
- **Map-only** lies to you near the edges: dynamic dispatch, re-exports, overloads, anything type-dependent. An agent that edits code on a name-match guess writes bugs.

The split gives each question the tool it deserves, and the [bridge](/transcend-mcp/reference/resolve/) makes crossing between them a single call.
