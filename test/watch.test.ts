import { cp, mkdtemp, rm, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeConfig } from "../src/config.js";
import { MapService } from "../src/map/service.js";
import { startWatcher, type Watcher } from "../src/map/watch.js";

let root: string;
let svc: MapService;
let watcher: Watcher;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "transcend-watch-"));
  await cp(path.resolve("test/fixtures/py-mini"), root, { recursive: true });
  svc = new MapService(makeConfig(root));
  await svc.rebuild();
  watcher = startWatcher(makeConfig(root), svc);
  await new Promise((r) => setTimeout(r, 300)); // let chokidar settle
});

afterAll(async () => {
  await watcher.close();
  await rm(root, { recursive: true, force: true });
});

describe("watcher", () => {
  it("marks a file stale immediately, then the debounced rebuild clears it", async () => {
    const events: string[] = [];
    watcher.subscribe((event, rel) => events.push(`${event}:${rel}`));

    await appendFile(path.join(root, "app", "models.py"), "\n\ndef watched_addition(x):\n    return x\n");

    // staleness must be observable before the rebuild lands
    await waitFor(() => svc.staleFiles().includes("app/models.py"), 3_000, "stale flag");
    expect(events).toContain("change:app/models.py");

    // and the incremental rebuild then clears it and indexes the new symbol
    await waitFor(() => svc.staleFiles().length === 0, 5_000, "rebuild clears stale");
    expect(svc.getNode("py:app/models.py#watched_addition")).toBeDefined();
  }, 15_000);
});

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
