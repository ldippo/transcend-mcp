/** Open-document registry: disk is the source of truth. Every query stats the
 * file first and pushes a full-text didChange if the content hash moved, so
 * LSP results always reflect current on-disk state — no watcher races.
 * LRU-capped so pyright's openFilesOnly analysis set stays bounded. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { URI } from "vscode-uri";
import { ToolError } from "../errors.js";

export interface OpenDoc {
  uri: string;
  languageId: string;
  version: number;
  mtimeMs: number;
  size: number;
  hash: string;
  lastUsed: number;
}

export interface SyncTarget {
  didOpen(uri: string, languageId: string, version: number, text: string): void;
  didChange(uri: string, version: number, text: string): void;
  didClose(uri: string): void;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export class DocumentRegistry {
  private docs = new Map<string, OpenDoc>();
  private chains = new Map<string, Promise<void>>(); // per-URI mutation ordering

  constructor(
    private readonly maxOpen: number,
    private readonly languageIdFor: (absPath: string) => string,
  ) {}

  /** Serialize per-URI mutations; reads await the latest sync. */
  private chain<T>(uri: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(uri) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      uri,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Returns the doc's current version after syncing disk state to the server. */
  ensureOpen(target: SyncTarget, absPath: string): Promise<number> {
    const uri = URI.file(absPath).toString();
    return this.chain(uri, async () => {
      let st;
      try {
        st = await stat(absPath);
      } catch {
        this.evict(target, uri, true);
        throw new ToolError("FILE_DELETED", `File not found on disk: ${absPath}`, {
          hint: "The map may reference a deleted/moved file. Try map_search for the symbol name.",
        });
      }
      const doc = this.docs.get(uri);
      if (!doc) {
        const text = await readFile(absPath, "utf8");
        const fresh: OpenDoc = {
          uri,
          languageId: this.languageIdFor(absPath),
          version: 1,
          mtimeMs: st.mtimeMs,
          size: st.size,
          hash: sha1(text),
          lastUsed: Date.now(),
        };
        this.evictOverflow(target);
        this.docs.set(uri, fresh);
        target.didOpen(uri, fresh.languageId, fresh.version, text);
        return fresh.version;
      }
      doc.lastUsed = Date.now();
      if (st.mtimeMs !== doc.mtimeMs || st.size !== doc.size) {
        const text = await readFile(absPath, "utf8");
        const h = sha1(text);
        doc.mtimeMs = st.mtimeMs;
        doc.size = st.size;
        if (h !== doc.hash) {
          doc.hash = h;
          doc.version += 1;
          target.didChange(uri, doc.version, text);
        }
      }
      return doc.version;
    });
  }

  /** Re-sync every open document against disk. Results of any LSP query
   * depend on all open buffers, not just the queried file — an edited file
   * that is open with stale content would silently poison results. */
  async syncAll(target: SyncTarget): Promise<void> {
    const uris = [...this.docs.keys()];
    await Promise.all(
      uris.map(async (uri) => {
        const absPath = URI.parse(uri).fsPath;
        try {
          await this.ensureOpen(target, absPath);
        } catch {
          // deleted underneath us: ensureOpen already evicted it
        }
      }),
    );
  }

  /** Watcher hint: file deleted -> close it server-side. */
  close(target: SyncTarget, absPath: string): void {
    const uri = URI.file(absPath).toString();
    void this.chain(uri, async () => this.evict(target, uri, true));
  }

  /** Crash recovery: re-open everything in the new server process. */
  async replayAll(target: SyncTarget): Promise<void> {
    for (const doc of this.docs.values()) {
      try {
        const text = await readFile(URI.parse(doc.uri).fsPath, "utf8");
        doc.version = 1;
        doc.hash = sha1(text);
        target.didOpen(doc.uri, doc.languageId, doc.version, text);
      } catch {
        this.docs.delete(doc.uri);
      }
    }
  }

  openCount(): number {
    return this.docs.size;
  }

  private evict(target: SyncTarget, uri: string, notify: boolean): void {
    if (this.docs.delete(uri) && notify) target.didClose(uri);
  }

  private evictOverflow(target: SyncTarget): void {
    while (this.docs.size >= this.maxOpen) {
      let oldest: OpenDoc | null = null;
      for (const d of this.docs.values()) if (!oldest || d.lastUsed < oldest.lastUsed) oldest = d;
      if (!oldest) return;
      this.evict(target, oldest.uri, true);
    }
  }
}
