#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeConfig } from "./config.js";
import { formatReportTable, loadMetricsFile } from "./metrics.js";
import { buildServer } from "./server.js";
import type { AppContext } from "./tools/context.js";

interface Args {
  command: "serve" | "report";
  root: string;
  watch: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let command: "serve" | "report" = "serve";
  let root = process.cwd();
  let watch = true;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "report") command = "report";
    else if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
    else if (argv[i] === "--no-watch") watch = false;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--help") {
      console.error("usage: transcend [--root <repo>] [--no-watch]\n       transcend report [--root <repo>] [--json]");
      process.exit(0);
    }
  }
  return { command, root, watch, json };
}

/** `transcend report`: print cumulative token savings, then exit. No server. */
async function runReport(args: Args): Promise<void> {
  const config = makeConfig(args.root, { watch: false });
  const file = await loadMetricsFile(config.metricsPath);
  if (!file) {
    if (args.json) console.log("null");
    else console.error(`[transcend] no metrics recorded yet at ${config.metricsPath}`);
    return;
  }
  console.log(args.json ? JSON.stringify(file, null, 2) : formatReportTable(file));
}

async function runServer(args: Args): Promise<void> {
  const config = makeConfig(args.root, { watch: args.watch });

  const ctx: AppContext = { config, map: null, live: null, bridge: null, metrics: null };

  // Wired in as layers land: map service, LSP pool, bridge, metrics.
  const { initServices } = await import("./wire.js");
  await initServices(ctx);

  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await ctx.metrics?.flush();
      if (ctx.metrics) {
        const { summaryLine } = await import("./metrics.js");
        console.error(`[transcend] session ${summaryLine(ctx.metrics.snapshot().session)}`);
      }
      await ctx.live?.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The client disconnecting closes our stdin — the normal MCP shutdown path.
  // StdioServerTransport doesn't surface this, so watch stdin directly to flush.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  await server.connect(transport);
  // stdio server runs until the transport closes.
  console.error(`[transcend] serving ${config.root} over stdio`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "report") await runReport(args);
  else await runServer(args);
}

main().catch((err) => {
  console.error("[transcend] fatal:", err);
  process.exit(1);
});
