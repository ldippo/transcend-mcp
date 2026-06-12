/** Repo scan: registered extensions, .gitignore semantics, content hashes. */
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { hashContent, supportedExtensions } from "./extract/registry.js";

export interface ScannedFile {
  rel: string; // posix relpath
  hash: string;
  source: string;
}

export async function buildIgnore(config: Config): Promise<Ignore> {
  const ig = ignore();
  ig.add(config.ignore);
  try {
    ig.add(await readFile(path.join(config.root, ".gitignore"), "utf8"));
  } catch {
    // no .gitignore — fine
  }
  return ig;
}

/** Relpaths of all indexable files (filtered, sorted, posix). */
export async function scanFiles(config: Config): Promise<string[]> {
  const ig = await buildIgnore(config);
  const patterns = supportedExtensions().map((ext) => `**/*${ext}`);
  const files = await fg(patterns, {
    cwd: config.root,
    dot: false,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  return files.filter((f) => !ig.ignores(f)).sort();
}

export async function readAndHash(config: Config, rel: string): Promise<ScannedFile> {
  const source = await readFile(path.join(config.root, rel), "utf8");
  return { rel, hash: hashContent(source), source };
}
