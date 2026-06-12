---
title: Nav Tools
description: The seven nav_* tools — ground truth from live language servers, always current with disk.
---

Nav tools query real language servers (pyright for Python, typescript-language-server for TS/JS), spawned lazily on first use. Results always reflect current on-disk content — see [Freshness](/transcend-mcp/concepts/freshness/). All positions are **1-based** line/col; get exact coordinates from [`resolve`](/transcend-mcp/reference/resolve/) rather than guessing.

If a server binary is missing, every nav tool returns a structured `LSP_UNAVAILABLE` error naming the install command — the map keeps working.

## Position-based tools

All take `{file, line, col, tokenBudget}` (`file` repo-relative, `col` defaults to 1):

### nav_definition
Go to definition. Returns `locations` as anchors: `{file, line, col, endLine, snippet}`.

### nav_references
Find all references — **the** call to make before editing a symbol.

| Extra param | Type | Default |
|---|---|---|
| `includeDeclaration` | boolean | `false` |
| `fileFilter` | substring/glob | — |

When results truncate, scope with `fileFilter: "src/"` rather than raising the budget — the truncation note says so too.

### nav_implementations
Implementations of an interface or abstract member. Errors with a hint toward `map_neighbors {edgeKinds: ["extends","implements"]}` if the server lacks the capability.

### nav_type
Hover: the resolved type signature and docs at a position, from the type checker. Authoritative where the map only stores parse-time signatures.

### nav_callHierarchy
Incoming callers or outgoing callees, recursively.

| Extra param | Type | Default |
|---|---|---|
| `direction` | `incoming` \| `outgoing` | — |
| `depth` | int 1–3 | 1 |

Capability-gated with graceful fallback: servers without call-hierarchy support get `source: "fallback-references"` (incoming, via find-references) or `source: "fallback-map"` (outgoing, via the map's call edges) plus a warning — never a hard error. If the position is slightly off the identifier, the server snaps to the enclosing symbol and retries once.

## File and workspace tools

### nav_symbols
`{file}` → the hierarchical outline of one file (always current). Prefer this over reading a whole file to learn its structure.

### nav_workspaceSymbols
`{query (min 3 chars), limit ≤ 200}` → live workspace-wide symbol search across **all** available language servers, exact-name matches first. The authoritative cousin of `map_search`; slower, so use it when the map is stale or missing.

## Operational behavior

- **Timeouts**: 15s per request (30s for references / workspace symbols), surfaced as `LSP_TIMEOUT` with a map-fallback hint — requests never hang.
- **Crash recovery**: servers restart with exponential backoff (0.5s→8s, max 5 per 2-minute window) and re-open their documents; a crash loop parks the client as `failed` with its stderr tail visible in `map_status`.
- **Cold starts**: empty semantic results during async project load are retried for up to 8s, so first queries are slow rather than silently incomplete.
