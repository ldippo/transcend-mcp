/** web-tree-sitter runtime: init, grammar loading, compiled-query caching.
 * Grammar wasm files are looked up in dist/wasm (built) or node_modules (dev). */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query } from "web-tree-sitter";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let initialized: Promise<void> | null = null;
const languages = new Map<string, Promise<Language>>();
const queries = new Map<string, Query>();

function wasmPath(grammarFile: string): string {
  // dist/src/map/extract -> dist/wasm
  const built = path.resolve(here, "..", "..", "..", "wasm", grammarFile);
  if (existsSync(built)) return built;
  const pkg = path.dirname(require.resolve("tree-sitter-wasms/package.json"));
  const fromPkg = path.join(pkg, "out", grammarFile);
  if (existsSync(fromPkg)) return fromPkg;
  throw new Error(`grammar wasm not found: ${grammarFile} (looked in ${built} and tree-sitter-wasms)`);
}

async function ensureInit(): Promise<void> {
  initialized ??= Parser.init();
  await initialized;
}

export async function loadLanguage(grammarFile: string): Promise<Language> {
  await ensureInit();
  let p = languages.get(grammarFile);
  if (!p) {
    p = Language.load(wasmPath(grammarFile));
    languages.set(grammarFile, p);
  }
  return p;
}

export async function parse(grammarFile: string, source: string) {
  const lang = await loadLanguage(grammarFile);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) throw new Error("tree-sitter returned no tree");
  return tree;
}

/** Compile (and cache) a query for a grammar from a .scm file on disk. */
export async function loadQuery(grammarFile: string, scmPath: string): Promise<Query> {
  const key = `${grammarFile}\0${scmPath}`;
  const cached = queries.get(key);
  if (cached) return cached;
  const lang = await loadLanguage(grammarFile);
  const sourceText = await readFile(scmPath, "utf8");
  const q = new Query(lang, sourceText);
  queries.set(key, q);
  return q;
}

/** Directory holding a layer's .scm files, resolving dev (src) and built (dist) layouts. */
export function queryDir(language: "python" | "typescript"): string {
  const candidates = [
    path.resolve(here, language, "queries"), // dist/src/map/extract/<lang>/queries (copied) or src/...
    path.resolve(here, "..", "..", "..", "..", "src", "map", "extract", language, "queries"), // dist -> src fallback
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`query dir not found for ${language}; looked in: ${candidates.join(", ")}`);
}
