/** File watcher: marks files stale the instant an event arrives (staleness is
 * observable before any rebuild work), then triggers a debounced incremental
 * rebuild — 300ms quiet period with a 2s max-wait cap so long event storms
 * (git checkout) still rebuild promptly. Single watcher instance; the LIVE
 * layer subscribes for didClose/pre-warm. */
import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import type { Config } from "../config.js";
import { supportedExtensions } from "./extract/registry.js";
import type { MapService } from "./service.js";

export type WatchListener = (event: "add" | "change" | "unlink", rel: string) => void;

export interface Watcher {
  close(): Promise<void>;
  subscribe(listener: WatchListener): void;
}

export function startWatcher(config: Config, map: MapService): Watcher {
  const exts = new Set(supportedExtensions());
  const ignoreDirs = config.ignore.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1));
  const listeners: WatchListener[] = [];

  const fsw: FSWatcher = chokidar.watch(config.root, {
    ignoreInitial: true,
    // chokidar v4 has no glob support: filter via function
    ignored: (abs: string) => {
      const rel = path.relative(config.root, abs);
      if (!rel || rel.startsWith("..")) return false;
      return rel.split(path.sep).some((seg) => ignoreDirs.includes(seg) || seg.startsWith("."));
    },
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  let timer: NodeJS.Timeout | null = null;
  let firstEventAt = 0;
  let rerunRequested = false;
  let running = false;

  const runRebuild = async () => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      do {
        rerunRequested = false;
        const r = await map.rebuild();
        console.error(`[transcend] incremental rebuild: ${r.filesExtracted} extracted, ${r.filesDeleted} deleted, ${r.durationMs}ms`);
      } while (rerunRequested);
    } catch (err) {
      console.error("[transcend] watch rebuild failed:", err);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    const now = Date.now();
    if (!timer) firstEventAt = now;
    else clearTimeout(timer);
    const sinceFirst = now - firstEventAt;
    const delay = sinceFirst >= config.debounceMaxWaitMs ? 0 : Math.min(config.debounceMs, config.debounceMaxWaitMs - sinceFirst);
    timer = setTimeout(() => {
      timer = null;
      void runRebuild();
    }, delay);
  };

  const onEvent = (event: "add" | "change" | "unlink") => (abs: string) => {
    if (!exts.has(path.extname(abs))) return;
    const rel = path.relative(config.root, abs).split(path.sep).join("/");
    if (rel.startsWith("..")) return;
    map.markStale(rel); // visible immediately, before the rebuild lands
    for (const l of listeners) l(event, rel);
    schedule();
  };

  fsw.on("add", onEvent("add"));
  fsw.on("change", onEvent("change"));
  fsw.on("unlink", onEvent("unlink"));
  map.watching = true;

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      map.watching = false;
      await fsw.close();
    },
    subscribe: (l) => listeners.push(l),
  };
}
