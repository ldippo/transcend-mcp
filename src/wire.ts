import { LiveService } from "./live/api.js";
import { LspPool } from "./live/pool.js";
import { MapService } from "./map/service.js";
import { MetricsRecorder } from "./metrics.js";
import type { AppContext } from "./tools/context.js";

/** Wires concrete services into the context: map, live LSP pool, bridge, metrics. */
export async function initServices(ctx: AppContext): Promise<void> {
  const metrics = new MetricsRecorder(ctx.config.metricsPath);
  await metrics.load();
  ctx.metrics = metrics;

  const map = new MapService(ctx.config);
  const warm = await map.loadPersisted();
  if (!warm) {
    // Cold build in the background: the server answers immediately and
    // map_* tools report MAP_NOT_BUILT until the first build lands.
    void map.rebuild().then(
      (r) => console.error(`[transcend] map built: ${r.filesScanned} files in ${r.durationMs}ms`),
      (err) => console.error("[transcend] map build failed:", err),
    );
  } else {
    // refresh in the background to catch changes since last run
    void map.rebuild().catch((err) => console.error("[transcend] map refresh failed:", err));
  }
  ctx.map = map;

  const pool = new LspPool(ctx.config);
  const live = new LiveService(ctx.config, pool, () => map);
  ctx.live = live;

  const { Bridge } = await import("./bridge/resolve.js");
  ctx.bridge = new Bridge(ctx.config, map, live);

  if (ctx.config.watch) {
    const { startWatcher } = await import("./map/watch.js");
    const watcher = startWatcher(ctx.config, map);
    // keep LSP open-document set in sync with deletions
    watcher.subscribe((event, rel) => {
      if (event !== "unlink") return;
      for (const client of pool.active()) {
        client.docs.close(client, `${ctx.config.root}/${rel}`);
      }
    });
  }
}
