/** Stable node IDs: `<lang>:<posix-relpath>[#qualifiedName[~ordinal]]`.
 * Identity never includes position, so line drift doesn't change IDs. */
import type { Lang } from "../types.js";

export interface ParsedNodeId {
  lang: Lang;
  file: string;
  qualifiedName: string; // "" for file nodes
  ordinal: number; // 1 = first/only definition; ~N suffix only when N > 1
}

export function makeNodeId(lang: Lang, file: string, qualifiedName = "", ordinal = 1): string {
  const base = `${lang}:${file}`;
  if (!qualifiedName) return base;
  return ordinal > 1 ? `${base}#${qualifiedName}~${ordinal}` : `${base}#${qualifiedName}`;
}

/** External dependency node, e.g. `ts:ext:react`, `py:ext:numpy`. */
export function makeExternalId(lang: Lang, packageName: string): string {
  return `${lang}:ext:${packageName}`;
}

export function isExternalId(id: string): boolean {
  return /^(py|ts):ext:/.test(id);
}

export function parseNodeId(id: string): ParsedNodeId | null {
  const m = /^(py|ts):([^#]+?)(?:#(.+?)(?:~(\d+))?)?$/.exec(id);
  if (!m) return null;
  return {
    lang: m[1] as Lang,
    file: m[2]!,
    qualifiedName: m[3] ?? "",
    ordinal: m[4] ? Number(m[4]) : 1,
  };
}

/** Assigns ordinals to same-file duplicate qualified names, in source order. */
export class OrdinalCounter {
  private seen = new Map<string, number>();

  next(qualifiedName: string): number {
    const n = (this.seen.get(qualifiedName) ?? 0) + 1;
    this.seen.set(qualifiedName, n);
    return n;
  }
}
