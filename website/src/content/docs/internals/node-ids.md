---
title: Node IDs
description: The stable identity scheme that lets map nodes survive edits, rebuilds, and line drift.
---

Everything the bridge does rests on one design decision: **a node's identity never includes its position.**

## The grammar

```
<lang>:<posix-relpath>[#qualifiedName[~ordinal]]

ts:src/db/userRepo.ts                      file node
ts:src/db/userRepo.ts#UserRepo             class
ts:src/db/userRepo.ts#UserRepo.save        method
py:pkg/models.py#User.__init__             method
py:a.py#f~2                                second same-named definition
ts:ext:react                               external dependency (no source location)
```

`lang` ∈ `py | ts`. The qualified name is the dotted path of enclosing named definitions within the file. Positions (`loc`) live on the node record as **mutable metadata**, refreshed on every re-extraction.

## Why position-free identity

Add a comment at the top of a file: every symbol shifts down one line. With positional IDs that edit would invalidate every edge, cluster assignment, and cached reference into the file. With position-free IDs, nothing changes — the node's `loc` updates, and `resolve` maps ID → *current* location at query time, flagging `mapStale` if the index hasn't caught up. Line drift is absorbed instead of amplified.

## Edge cases, decided

| Case | Decision |
|---|---|
| TS function overloads | All declaration signatures + the implementation collapse into **one node** — matching how the LSP and humans think about it |
| Genuine duplicates (`def f` twice via conditionals) | `~2`, `~3` ordinals in source order. Reordering swaps ordinals — accepted: rare, and the LSP is authoritative anyway |
| Anonymous functions / lambdas | **No node.** `const f = () => …` is named via the declarator; truly anonymous callbacks attribute their calls to the nearest named ancestor, keeping the graph navigable instead of littered with `<anon#7>` |
| Re-exports (`export { save } from "./repo"`) | No new node — an `exports` edge from the barrel to the original symbol. One symbol, one ID, however many paths reach it |
| File rename/move | A new ID, by design. Identity-across-renames is a git/LSP concern, not the map's |
| External imports | Synthetic `lang:ext:<package>` nodes so third-party dependency structure stays visible; `resolve` rejects them with a clear message |

## Parsing and stability guarantees

Round-trip helpers live in `src/map/ids.ts` (`makeNodeId` / `parseNodeId` / `OrdinalCounter`, all unit-tested). Collisions across files are impossible (the relpath is in the ID); collisions within a file are exactly the ordinal case. IDs are also deliberately token-cheap — `py:`/`ts:` prefixes, no escaping in the common case — because they appear in every map response an agent reads.
