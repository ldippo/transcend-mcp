/** Dev smoke: extract one file and dump the FileExtraction.
 * usage: npx tsx scripts/dev-extract.ts <repo-root> <relpath> */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractFile } from "../src/map/extract/registry.js";

const [root, rel] = process.argv.slice(2);
if (!root || !rel) {
  console.error("usage: tsx scripts/dev-extract.ts <root> <relpath>");
  process.exit(1);
}
const source = await readFile(path.join(root, rel), "utf8");
const fx = await extractFile(rel, source);
console.log(JSON.stringify(fx, null, 2));
