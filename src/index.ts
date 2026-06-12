#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeConfig } from "./config.js";
import { buildServer } from "./server.js";
import type { AppContext } from "./tools/context.js";

function parseArgs(argv: string[]): { root: string; watch: boolean } {
  let root = process.cwd();
  let watch = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
    else if (argv[i] === "--no-watch") watch = false;
    else if (argv[i] === "--help") {
      console.error("usage: transcend [--root <repo>] [--no-watch]");
      process.exit(0);
    }
  }
  return { root, watch };
}

async function main(): Promise<void> {
  const { root, watch } = parseArgs(process.argv.slice(2));
  const config = makeConfig(root, { watch });

  const ctx: AppContext = { config, map: null, live: null, bridge: null };

  // Wired in as layers land: map service, LSP pool, bridge.
  const { initServices } = await import("./wire.js");
  await initServices(ctx);

  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    try {
      await ctx.live?.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  // stdio server runs until the transport closes.
  console.error(`[transcend] serving ${config.root} over stdio`);
}

main().catch((err) => {
  console.error("[transcend] fatal:", err);
  process.exit(1);
});
