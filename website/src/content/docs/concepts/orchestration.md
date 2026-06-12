---
title: Orchestration Policy
description: The three-step policy an agent follows — orient with the map, drill down with the language server, cross layers with resolve.
---

<!-- adapted from docs/AGENT_GUIDE.md -->

The policy is short enough to memorize and is also embedded in every tool description the agent reads, so it survives context compaction:

1. **Orient with the MAP.** `map_overview` for the lay of the land, `map_search` to find candidate symbols, `map_neighbors` for fan-in/fan-out, `map_path` for "how do A and B connect?". Instant, token-budgeted, possibly stale.
2. **Drill down with NAV.** `nav_definition`, `nav_references`, `nav_type`, `nav_callHierarchy` — the language server's ground truth, always current. Confirm impact here **before** editing a symbol.
3. **Cross with `resolve`.** Map node ID → verified live `file:line:col` (staleness flagged), or position → enclosing symbol chain + map node ID.

Prefer the cheapest call that answers the question. If the map answers it, stop; verify with nav only when about to rely on the answer.

## Worked example

*"Where is `refresh` defined and who calls it?"*

```jsonc
// 1. ORIENT — cheap symbol lookup
map_search {"query": "refresh"}
// -> ts:src/store.ts#SessionStore.refresh  [method, hub 0.41]

// 2. ORIENT — structural callers, still no LSP cost
map_neighbors {"nodeId": "ts:src/store.ts#SessionStore.refresh",
               "direction": "in", "edgeKinds": ["calls"]}
// -> api.ts#authenticate (calls, confidence "name")

// 3. CROSS — verified live position
resolve {"nodeId": "ts:src/store.ts#SessionStore.refresh"}
// -> {location: {file: "src/store.ts", line: 17, col: 3},
//     mapStale: false, verified: true}

// 4. DRILL — authoritative answer before acting
nav_references {"file": "src/store.ts", "line": 17, "col": 3}
// -> 2 references with snippets; this is the caller list you can trust
```

Four calls, every one bounded by a token budget, and the expensive layer was touched exactly twice — with exact coordinates in hand.

## Signals that switch you between layers

| You see | You do |
|---|---|
| `resolved: false` edge with candidates | The map is guessing — confirm with `nav_references` or `nav_definition` at the edge's `loc` |
| `stale: true` on a node, or a staleness `warning` | Positions are approximate — `resolve` the node before using line numbers |
| `LSP_UNAVAILABLE` error | Stay on the map; the error carries the install command |
| `truncated: true` with a `dropped` note | Follow the note — usually a filter parameter, not a bigger budget |
| Map answer is enough (exploring, summarizing) | Stop. Don't pay LSP latency to confirm what you won't act on |

## Sizing budgets

Every tool accepts `tokenBudget` (default 2000, max 10000). Orientation calls work well at 500–800; keep `nav_references` at 1000+ when you expect many hits and scope with `fileFilter` rather than raising the budget. The [envelope](/transcend-mcp/reference/envelope/) always reports `used` vs `requested`, so an agent can tune as it goes.
