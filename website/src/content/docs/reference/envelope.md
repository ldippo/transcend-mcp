---
title: Response Envelope
description: The uniform budgeted envelope every tool returns — token accounting, truncation notes, warnings, and stable error codes.
---

Every tool — all fifteen — returns through one envelope. An agent learns the shape once:

```jsonc
{
  "ok": true,
  "data": { /* tool-specific payload, file:line anchors throughout */ },
  "tokenBudget": {"requested": 800, "used": 412, "max": 10000},
  "truncated": true,
  "dropped": {
    "kind": "references",
    "count": 20,
    "note": "Dropped 20 references to fit tokenBudget=800. Pass fileFilter:'src/' to scope results, or raise tokenBudget."
  },
  "warnings": ["3 file(s) changed since the last index; their nodes carry stale:true."]
}
```

## Token budgets

- Every tool accepts `tokenBudget` — default **2000**, clamped to **[100, 10000]**.
- Estimation is `chars / 4` over the serialized envelope: coarse on purpose (budgeting, not billing), accurate to roughly ±20%.
- `used ≤ requested` is enforced by construction: declared list fields are ranked (references grouped by file, neighbors by hub score), then binary-searched for the largest prefix that fits, leaving headroom for the truncation note. As a last resort, `snippet` fields are elided.

## Truncation is never silent

A response that omits anything sets `truncated: true` and a `dropped` note stating **what** was cut and **how to get it back** — usually a narrowing parameter (`fileFilter`, `edgeKinds`, `focus`, a longer query) rather than a bigger budget. An agent should treat the note as the next-step instruction it is.

## Warnings

Non-fatal context rides along in `warnings`: stale-file counts, index age nudges ("confirm hot paths with nav_references before editing"), capability fallbacks ("call hierarchy derived via fallback-map — treat as approximate").

## Errors are envelopes too

Domain failures never surface as MCP protocol errors. They come back as `ok: false` with a stable code, a human message, and an actionable `hint`:

```jsonc
{
  "ok": false,
  "error": {
    "code": "LSP_UNAVAILABLE",
    "message": "pyright-langserver not found on PATH.",
    "language": "py",
    "hint": "Install it: npm install -g pyright. Static structure is still available via map_* tools."
  },
  "tokenBudget": {"requested": 2000, "used": 61, "max": 10000},
  "truncated": false,
  "warnings": []
}
```

### Error code reference

| Code | Meaning | Recovery |
|---|---|---|
| `MAP_NOT_BUILT` | Static index absent (first run still building, or no map support) | `map_rebuild`; nav tools work regardless |
| `NODE_NOT_FOUND` | Node ID not in the map | IDs come from `map_search` / `map_overview`; map may be stale |
| `BAD_NODE_ID` | ID doesn't parse | Grammar: `<lang>:<relpath>[#qualifiedName]` |
| `FILE_DELETED` | File vanished from disk | `map_search` for the symbol's new location |
| `SYMBOL_NOT_FOUND` | Live lookup found no such symbol | Carries same-file hints; `map_rebuild` |
| `LSP_UNAVAILABLE` | Server binary not on PATH | Install hint included; map-only mode continues |
| `LSP_FAILED` | Server crashed repeatedly and was disabled | stderr tail in `map_status` |
| `LSP_TIMEOUT` | No answer within the deadline (15s; 30s for slow ops) | Retry or fall back to the map |
| `BAD_ARGS` | Invalid argument combination | Message names the expected shape |
| `INTERNAL` | Unexpected failure | Report it — this is a bug |

## Positions

Everything on the MCP surface is **1-based** `line`/`col`, with `col` counting UTF-16 code units (the LSP convention). Anchors share one shape everywhere: `{file, line, col, endLine?, snippet?}` with `file` repo-relative, posix separators.
