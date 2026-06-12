import { MapService } from "./map/service.js";
import type { AppContext } from "./tools/context.js";

/** Wires concrete services into the context. Grows as layers land:
 * map service (done) -> live pool (phase 5) -> bridge (phase 6). */
export async function initServices(ctx: AppContext): Promise<void> {
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

  if (ctx.config.watch) {
    const { startWatcher } = await import("./map/watch.js");
    startWatcher(ctx.config, map);
  }
}
