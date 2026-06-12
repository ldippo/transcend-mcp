---
title: The resolve Tool
description: The bridge between layers — map node ID to verified live position and back, with staleness always flagged.
---

`resolve` is the one tool to call whenever you switch layers. It takes **exactly one** of two argument shapes:

```jsonc
{"nodeId": "py:src/auth/session.py#SessionStore.refresh"}   // MAP -> LSP
{"file": "src/auth/session.py", "line": 142, "col": 9}      // LSP -> MAP
```

## MAP → LSP: node ID in, verified position out

The server parses the ID, stats the file, fetches the live (hierarchical) symbol outline, and walks the qualified-name chain `SessionStore` → `refresh`. The result:

```jsonc
{
  "nodeId": "py:src/auth/session.py#SessionStore.refresh",
  "location": {"file": "src/auth/session.py", "line": 145, "col": 9},  // LIVE truth
  "verified": true,
  "mapStale": true,                       // index disagreed...
  "mapRange": {"line": 142, "endLine": 150},  // ...this is what it thought
  "inMap": true,
  "symbol": {"name": "refresh", "kind": "method",
             "signature": "def refresh(self, token: str) -> Session | None"}
}
```

The `location` field is **always authoritative** (live wins); `mapStale` plus `mapRange` make the disagreement visible instead of papering over it. The `signature` is enriched from live hover when available.

If the full chain no longer matches — a container was renamed, the symbol moved — resolve falls back to **name-anchored re-resolution**: a unique same-file match on the last segment returns with `relocated: true`. Zero or ambiguous matches produce `SYMBOL_NOT_FOUND` with the file's top-level symbol names as hints.

## LSP → MAP: position in, node ID out

Given `file:line:col`, resolve finds the deepest enclosing symbol chain, builds the qualified name, and looks it up in the map:

```jsonc
{
  "nodeId": "py:src/auth/session.py#SessionStore.refresh",
  "inMap": true,
  "mapStale": false,
  "qualifiedName": "SessionStore.refresh",
  "enclosingSymbols": [
    {"name": "SessionStore", "kind": "class", "line": 12},
    {"name": "refresh", "kind": "method", "line": 145}
  ],
  "location": {"file": "src/auth/session.py", "line": 145, "col": 9}
}
```

If the map hasn't caught up (a brand-new symbol), the chain is walked upward to the nearest container: `inMap: false` plus `nearestNodeId`. With no map at all, you still get `enclosingSymbols` from the live outline — the tool degrades, it doesn't die.

## Failure modes

| Condition | `error.code` | Behavior |
|---|---|---|
| File deleted or moved | `FILE_DELETED` | Suggests `map_search` for the symbol's new home |
| Symbol renamed/removed | `SYMBOL_NOT_FOUND` | Carries `mapStale: true` + same-file symbol hints |
| Symbol moved within file | — (success) | `mapStale: true`, `relocated: true`, live location returned |
| Map not built yet | `MAP_NOT_BUILT` | LSP→MAP direction still returns `enclosingSymbols` |
| Language server missing | `LSP_UNAVAILABLE` | MAP→LSP degrades to the indexed range with `verified: false` |
| Request timeout | `LSP_TIMEOUT` | Retry, or use the map range as approximate |
| Malformed ID | `BAD_NODE_ID` | Error message includes the expected grammar |
| Both/neither arg shapes | `BAD_ARGS` | Pass exactly one of `nodeId` or `file`+`line` |

## When to call it

- Before any `nav_*` call whose position came from the map — line numbers in map responses are approximate the moment a file is edited.
- After any `nav_*` result you want to feed back into `map_neighbors` or `map_path` — anchors become node IDs.
- As a cheap existence-and-freshness check on a symbol you're about to modify.
