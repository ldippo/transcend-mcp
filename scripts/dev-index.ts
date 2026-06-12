/** Dev smoke: cold-build the index for a repo and dump a summary.
 * usage: npx tsx scripts/dev-index.ts <root> [seedNodeId] */
import { makeConfig } from "../src/config.js";
import { MapService } from "../src/map/service.js";

const [root, seed] = process.argv.slice(2);
if (!root) {
  console.error("usage: tsx scripts/dev-index.ts <root> [seedNodeId]");
  process.exit(1);
}
const config = makeConfig(root);
const svc = new MapService(config);
const result = await svc.rebuild();
console.log("rebuild:", result);
console.log("status:", JSON.stringify(svc.status(), null, 1));
console.log("\noverview:", JSON.stringify(svc.overview({ hubsPerCluster: 3 }), null, 1));
if (seed) {
  console.log("\nneighbors of", seed, ":");
  console.log(JSON.stringify(svc.neighbors({ nodeId: seed, direction: "both", depth: 1, maxNodes: 30 }), null, 1));
}
