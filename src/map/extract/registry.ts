/** Extension -> extractor registry plus the language-agnostic single-file
 * extraction pipeline (parse -> run queries -> extract). */
import { createHash } from "node:crypto";
import path from "node:path";
import type { Lang } from "../../types.js";
import type { FileExtraction } from "../types.js";
import type { LanguageExtractor } from "./extractor.js";
import { pythonExtractor } from "./python/extractor.js";
import { typescriptExtractor } from "./typescript/extractor.js";
import { loadQuery, parse, queryDir } from "./treesitter.js";

export const EXTRACTORS: LanguageExtractor[] = [pythonExtractor, typescriptExtractor];

const byExtension = new Map<string, LanguageExtractor>();
for (const ex of EXTRACTORS) for (const ext of ex.extensions) byExtension.set(ext, ex);

export function extractorForFile(file: string): LanguageExtractor | undefined {
  return byExtension.get(path.posix.extname(file));
}

export function extractorForLang(lang: Lang): LanguageExtractor | undefined {
  return EXTRACTORS.find((e) => e.lang === lang);
}

export function supportedExtensions(): string[] {
  return [...byExtension.keys()];
}

export function hashContent(source: string | Buffer): string {
  return createHash("sha1").update(source).digest("hex");
}

export async function extractFile(file: string, source: string): Promise<FileExtraction> {
  const extractor = extractorForFile(file);
  if (!extractor) throw new Error(`no extractor for ${file}`);
  const grammar = extractor.grammarFor(file);
  const tree = await parse(grammar, source);
  const dir = queryDir(extractor.queryLanguage);
  const queries = {
    symbols: await loadQuery(grammar, path.join(dir, "symbols.scm")),
    imports: await loadQuery(grammar, path.join(dir, "imports.scm")),
    refs: await loadQuery(grammar, path.join(dir, "refs.scm")),
  };
  try {
    return extractor.extract({ file, source, contentHash: hashContent(source), tree, queries });
  } finally {
    tree.delete();
  }
}
