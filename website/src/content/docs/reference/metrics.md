---
title: Token Savings
description: How transcend measures the tokens it saves — the metrics_report tool, the report CLI, and cumulative .transcend/metrics.json accounting.
---

<!-- adapted from README.md and src/metrics.ts -->

transcend's whole point is answering in cheap, budgeted, `file:line`-anchored
responses instead of raw file dumps. It quantifies that payoff: every successful
tool response is compared to the naive alternative, and the delta is accumulated.

```
saved = baseline (full reads of referenced files) − actual (emitted tokens)
```

- **actual** — the real emitted output tokens of the response, measured at the
  serialization boundary.
- **baseline** — the naive counterfactual: the token cost of reading in full
  every file the response points into (the files an agent would `grep` and open
  to get the same answer without transcend). Referenced files are collected
  generically — `file` anchors plus decoded map node IDs — so every tool is
  covered. Baseline is an **upper bound**: an agent might not read whole files.

Metrics are cumulative across runs, persisted atomically to
`.transcend/metrics.json` (a sibling of the map index).

## `metrics_report` tool

Call it any time to see savings so far — both this session and cumulative —
per tool and in total, with derived saved-tokens and percentage:

```jsonc
metrics_report {}
//  -> {
//       "session":    { "totals": {"calls": 2, "actualTokens": 3802,
//                                   "baselineTokens": 21412, "savedTokens": 17610,
//                                   "savedPct": 0.82}, "perTool": { ... } },
//       "cumulative": { "totals": { ... }, "perTool": { ... } },
//       "since": "2026-07-01T18:12:36.962Z"
//     }
```

It accepts `tokenBudget` and returns the standard [envelope](/transcend-mcp/reference/envelope/).
It does not count itself, so reporting never pollutes the numbers.

## `report` CLI

The same numbers as a table, without starting the server:

```sh
node dist/src/index.js report --root /path/to/repo          # per-tool table + total
node dist/src/index.js report --root /path/to/repo --json   # raw JSON
```

```
TOOL          CALLS  ACTUAL  BASELINE  SAVED    %
------------  -----  ------  --------  -----  ---
map_overview      2    5.1k     38.4k  33.3k  87%
map_search        2    2.5k      4.4k   1.9k  43%
------------  -----  ------  --------  -----  ---
TOTAL             4    7.6k     42.8k  35.2k  82%
```

## Shutdown summary

When the server stops (client disconnect or `SIGINT`/`SIGTERM`) it flushes and
prints a one-line summary to stderr:

```
[transcend] session saved ~35.2k tokens across 4 calls (82%)
```
