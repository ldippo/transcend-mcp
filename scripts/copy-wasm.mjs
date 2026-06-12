// Copies tree-sitter grammar wasm files (and the runtime wasm) into dist/
// so the built server is self-contained. Run as part of `npm run build`.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const outDir = path.resolve("dist/wasm");
mkdirSync(outDir, { recursive: true });

const grammars = ["tree-sitter-python.wasm", "tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"];
const wasmsDir = path.dirname(require.resolve("tree-sitter-wasms/package.json"));
for (const g of grammars) {
  copyFileSync(path.join(wasmsDir, "out", g), path.join(outDir, g));
}

// web-tree-sitter's own runtime wasm lives next to its main entry
const wts = path.dirname(require.resolve("web-tree-sitter"));
copyFileSync(path.join(wts, "tree-sitter.wasm"), path.join(outDir, "tree-sitter.wasm"));

// tree-sitter .scm query files (not handled by tsc)
import { cpSync, globSync } from "node:fs";
let scm = 0;
for (const lang of ["python", "typescript"]) {
  const src = path.resolve("src/map/extract", lang, "queries");
  const dst = path.resolve("dist/src/map/extract", lang, "queries");
  cpSync(src, dst, { recursive: true });
  scm += globSync(path.join(src, "*.scm")).length;
}

console.log(`copied ${grammars.length + 1} wasm files -> dist/wasm/, ${scm} .scm query files -> dist/src/`);
