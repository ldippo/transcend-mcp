---
title: Adding a Language
description: A language is one extractor directory plus an LSP entry — no core changes, by design and by test.
---

<!-- adapted from src/map/extract/extractor.ts and src/map/extract/registry.ts -->

The pipeline — scan → parse → query → extract → resolve → serve — is language-agnostic. Registering a language touches exactly two places, and the acceptance suite enforces that no language names leak anywhere else.

## 1. The extractor (MAP layer)

Create `src/map/extract/<lang>/` with an extractor and three tree-sitter query files:

```
src/map/extract/go/
├── extractor.ts
└── queries/
    ├── symbols.scm    # definitions: classes/functions/methods/types
    ├── imports.scm    # import/export statements (captured whole, unpacked in code)
    └── refs.scm       # call sites, heritage clauses, type annotations
```

The contract (`src/map/extract/extractor.ts`):

```ts
export interface LanguageExtractor {
  lang: Lang;
  extensions: string[];                    // [".go"]
  grammarFor(file: string): string;        // "tree-sitter-go.wasm"
  queryLanguage: string;                   // directory holding the .scm files
  extract(input: ExtractInput): FileExtraction;
  resolveImportSource(
    source: string,                        // "./util", "pkg/mod"
    fromFile: string,
    fileSet: ReadonlySet<string>,
  ): string[];                             // candidate repo paths; [] = external
}
```

`extract()` receives the parsed tree plus the three compiled queries and returns nodes (with [stable IDs](/transcend-mcp/internals/node-ids/)), raw imports, and raw refs. Patterns worth copying from the Python/TypeScript extractors:

- **Capture-name convention** — `.scm` captures like `@class.def` / `@class.name` let one generic loop derive the node kind from the capture prefix.
- **Capture coarse, unpack in code** — import statements have too many shapes to enumerate declaratively; capture the whole statement and walk its children in `extract()`.
- **Qualified names via ancestor walk** — tree-sitter queries can't compute scope; walk up the tree collecting enclosing definition names (`scopeChain()` helper).
- **Don't fake resolution** — emit calls/refs as written (`repo.save`), with the enclosing symbol's qualified name. The shared resolution pass handles the confidence ladder; your extractor never guesses.

Grammar `.wasm` binaries come prebuilt from the `tree-sitter-wasms` package — add the filename to `scripts/copy-wasm.mjs` so the build vendors it into `dist/wasm/`.

Then register it — one line each in `src/map/extract/registry.ts`:

```ts
export const EXTRACTORS: LanguageExtractor[] = [pythonExtractor, typescriptExtractor, goExtractor];
```

## 2. The LSP entry (LIVE layer)

One record in `src/config.ts`:

```ts
lsp: {
  // ...
  go: {
    command: "gopls",
    args: ["serve", "-rpc.trace"],
    installHint: "go install golang.org/x/tools/gopls@latest",
    languageIds: { ".go": "go" },
  },
},
```

…plus the extension mapping in `EXTENSION_LANG`. Everything else — lazy spawn, document sync, crash recovery, capability gating, timeout handling — is inherited. If the server lacks call hierarchy, `nav_callHierarchy` automatically falls back to references and map edges.

## 3. Verify

```sh
npx tsx scripts/dev-extract.ts /path/to/repo some/file.go   # eyeball the FileExtraction
npx tsx scripts/dev-index.ts /path/to/repo                  # cold index + overview
npm test                                                    # fixture-driven extractor tests
```

Add a small fixture repo under `test/fixtures/` with a hand-written expected edge list — the existing `test/extract.test.ts` and `test/resolve.test.ts` show the pattern: assert exact node kinds, qualified names, and edge confidences.

Server quirks (a pyright-style `workspace/configuration` pull, a tsserver-style async project load) are the one place real per-language code may be needed in the LIVE layer — see how `src/live/client.ts` isolates both behind small conditionals.
