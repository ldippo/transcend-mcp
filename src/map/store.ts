/** Persistence: manifest + sharded per-file FileExtraction blobs.
 * Shards keep incremental saves O(changed files), not O(repo). */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileExtraction, IndexManifest } from "./types.js";

export class IndexStore {
  constructor(private readonly indexDir: string) {}

  private manifestPath(): string {
    return path.join(this.indexDir, "manifest.json");
  }

  shardRel(fileRel: string): string {
    const h = createHash("sha1").update(fileRel).digest("hex");
    return path.posix.join("files", h.slice(0, 2), `${h}.json`);
  }

  async loadManifest(): Promise<IndexManifest | null> {
    try {
      const raw = JSON.parse(await readFile(this.manifestPath(), "utf8")) as IndexManifest;
      return raw.schemaVersion === 1 ? raw : null;
    } catch {
      return null;
    }
  }

  /** Atomic: write tmp + rename, so a kill mid-save never corrupts the index. */
  async saveManifest(manifest: IndexManifest): Promise<void> {
    await mkdir(this.indexDir, { recursive: true });
    const tmp = `${this.manifestPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest), "utf8");
    await rename(tmp, this.manifestPath());
  }

  async saveShard(fx: FileExtraction): Promise<string> {
    const rel = this.shardRel(fx.file);
    const abs = path.join(this.indexDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, JSON.stringify(fx), "utf8");
    await rename(tmp, abs);
    return rel;
  }

  async loadShard(shardRel: string): Promise<FileExtraction | null> {
    try {
      const fx = JSON.parse(await readFile(path.join(this.indexDir, shardRel), "utf8")) as FileExtraction;
      return fx.schemaVersion === 1 ? fx : null;
    } catch {
      return null;
    }
  }

  async deleteShard(shardRel: string): Promise<void> {
    await rm(path.join(this.indexDir, shardRel), { force: true });
  }
}
