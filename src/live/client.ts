/** One LSP client per language: spawn, handshake, server quirks, typed
 * requests with timeouts, crash/backoff restart with document replay. */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CancellationTokenSource,
  ConfigurationRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type InitializeParams,
  type InitializeResult,
  type ProtocolConnection,
  type ProtocolRequestType,
  ShutdownRequest,
} from "vscode-languageserver-protocol";
import { createProtocolConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";
import type { LspServerConfig } from "../config.js";
import { ToolError } from "../errors.js";
import type { Lang } from "../types.js";
import { DocumentRegistry, type SyncTarget } from "./documents.js";
import { findBinary, spawnServer, type SpawnedServer } from "./spawn.js";

export type ClientState =
  | "unspawned"
  | "starting"
  | "warming"
  | "ready"
  | "crashed"
  | "failed"
  | "unavailable"
  | "shutting-down";

const RESTART_WINDOW_MS = 120_000;
const MAX_RESTARTS = 5;
const BACKOFFS_MS = [500, 1000, 2000, 4000, 8000];
const WARMUP_POLL_MS = 250;
const WARMUP_CAP_MS = 10_000;

export class LspClient implements SyncTarget {
  state: ClientState = "unspawned";
  stateDetail = "";
  readonly docs: DocumentRegistry;
  capabilities: InitializeResult["capabilities"] = {};

  private server: SpawnedServer | null = null;
  private conn: ProtocolConnection | null = null;
  private starting: Promise<void> | null = null;
  private restartTimes: number[] = [];
  private warmedAnchor = false;
  private lastProbe = 0;
  /** Set after the first non-empty semantic answer: tsserver/pyright load
   * projects asynchronously and answer early semantic queries with [] —
   * until this flips, empty results are retried against a longer deadline. */
  semanticReady = false;

  constructor(
    readonly lang: Lang,
    private readonly cfg: LspServerConfig,
    private readonly root: string,
    private readonly defaultTimeoutMs: number,
    maxOpenDocs: number,
  ) {
    this.docs = new DocumentRegistry(maxOpenDocs, (abs) => this.cfg.languageIds[path.extname(abs)] ?? "plaintext");
  }

  stderrTail(): string[] {
    return this.server?.stderrTail() ?? [];
  }

  // ------------------------------------------------------------ lifecycle

  async ensureReady(): Promise<void> {
    if (this.state === "ready" || this.state === "warming") return;
    if (this.state === "unavailable") {
      // re-probe at most once a minute so installing the server mid-session recovers
      if (Date.now() - this.lastProbe < 60_000) this.throwUnavailable();
      this.state = "unspawned";
    }
    if (this.state === "failed") {
      throw new ToolError("LSP_FAILED", `${this.cfg.command} crashed repeatedly and was disabled.`, {
        language: this.lang,
        stderr: this.stderrTail().slice(-5),
        hint: "Use map_* tools; check map_status for the server's stderr tail.",
      });
    }
    this.starting ??= this.start().finally(() => (this.starting = null));
    await this.starting;
  }

  private throwUnavailable(): never {
    throw new ToolError("LSP_UNAVAILABLE", `${this.cfg.command} not found on PATH.`, {
      language: this.lang,
      hint: `Install it: ${this.cfg.installHint}. Static structure is still available via map_* tools.`,
    });
  }

  private async start(): Promise<void> {
    this.lastProbe = Date.now();
    const bin = findBinary(this.cfg.command);
    if (!bin) {
      this.state = "unavailable";
      this.throwUnavailable();
    }
    this.state = "starting";
    const server = spawnServer(bin, this.cfg.args, this.root);
    this.server = server;
    const conn = createProtocolConnection(
      new StreamMessageReader(server.proc.stdout!),
      new StreamMessageWriter(server.proc.stdin!),
    );
    this.conn = conn;
    this.installHandlers(conn);
    conn.listen();

    server.proc.on("exit", (code) => {
      if (this.state === "shutting-down") return;
      this.state = "crashed";
      this.stateDetail = `exit code ${code}`;
      this.conn = null;
      void this.scheduleRestart();
    });

    const init: InitializeParams = {
      processId: process.pid,
      rootUri: URI.file(this.root).toString(),
      workspaceFolders: [{ uri: URI.file(this.root).toString(), name: path.basename(this.root) }],
      capabilities: {
        textDocument: {
          definition: {},
          references: {},
          implementation: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {},
          synchronization: {},
          publishDiagnostics: {},
        },
        workspace: { symbol: {}, configuration: true, workspaceFolders: true },
      },
      initializationOptions: this.initializationOptions(),
    };
    const result = await conn.sendRequest(InitializeRequest.type, init);
    this.capabilities = result.capabilities;
    await conn.sendNotification(InitializedNotification.type, {});
    await conn.sendNotification(DidChangeConfigurationNotification.type, { settings: this.settings() });
    this.state = "warming";
    this.stateDetail = "";
  }

  private installHandlers(conn: ProtocolConnection): void {
    conn.onRequest(ConfigurationRequest.type, (params) =>
      params.items.map((item) => {
        const settings = this.settings() as Record<string, unknown>;
        if (!item.section) return settings;
        return item.section.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), settings) ?? null;
      }),
    );
    conn.onRequest("client/registerCapability", () => null);
    conn.onRequest("client/unregisterCapability", () => null);
    conn.onRequest("window/workDoneProgress/create", () => null);
    conn.onRequest("workspace/workspaceFolders", () => [
      { uri: URI.file(this.root).toString(), name: path.basename(this.root) },
    ]);
    for (const n of ["window/logMessage", "window/showMessage", "telemetry/event", "$/progress", "textDocument/publishDiagnostics"]) {
      conn.onNotification(n, () => {});
    }
    conn.onError(() => {});
    conn.onClose(() => {});
  }

  // server-specific configuration ------------------------------------------------

  private initializationOptions(): unknown {
    if (this.lang === "ts") {
      return {
        preferences: { includeInlayParameterNameHints: "none" },
        maxTsServerMemory: 4096,
      };
    }
    return {};
  }

  private settings(): unknown {
    if (this.lang === "py") {
      return {
        python: {
          pythonPath: this.pythonPath(),
          analysis: {
            autoSearchPaths: true,
            useLibraryCodeForTypes: true,
            diagnosticMode: "openFilesOnly",
          },
        },
      };
    }
    return {};
  }

  private pythonPath(): string {
    for (const venv of [".venv", "venv"]) {
      const p = path.join(this.root, venv, "bin", "python");
      if (existsSync(p)) return p;
    }
    return "python3";
  }

  // ------------------------------------------------------------ restart

  private async scheduleRestart(): Promise<void> {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.state = "failed";
      console.error(`[transcend] ${this.cfg.command} crashed ${MAX_RESTARTS}x in 2min — giving up`);
      return;
    }
    const backoff = BACKOFFS_MS[Math.min(this.restartTimes.length, BACKOFFS_MS.length - 1)]!;
    this.restartTimes.push(now);
    console.error(`[transcend] ${this.cfg.command} crashed (${this.stateDetail}); restarting in ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
    if (this.state !== "crashed") return; // shut down meanwhile
    this.state = "unspawned";
    try {
      await this.ensureReady();
      await this.docs.replayAll(this);
      this.warmedAnchor = false;
    } catch (err) {
      console.error(`[transcend] restart failed:`, err instanceof Error ? err.message : err);
    }
    this.semanticReady = false;
  }

  async shutdown(): Promise<void> {
    if (!this.conn || this.state === "unspawned" || this.state === "unavailable") return;
    this.state = "shutting-down";
    const conn = this.conn;
    const proc = this.server?.proc;
    try {
      await Promise.race([conn.sendRequest(ShutdownRequest.type), new Promise((r) => setTimeout(r, 2000))]);
      await conn.sendNotification(ExitNotification.type);
    } catch {
      // already dead — fine
    }
    setTimeout(() => proc?.kill("SIGKILL"), 1000).unref();
  }

  // ------------------------------------------------------------ requests

  async request<P, R, PR, E, RO>(type: ProtocolRequestType<P, R, PR, E, RO>, params: P, timeoutMs?: number): Promise<R> {
    await this.ensureReady();
    const conn = this.conn;
    if (!conn) throw new ToolError("LSP_FAILED", `${this.cfg.command} connection lost.`, { language: this.lang });
    const source = new CancellationTokenSource();
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => source.cancel(), ms);
    try {
      // the variadic RequestParam<P> overloads don't narrow through a generic
      // wrapper; the (method, param, token) overload is the stable one
      return (await conn.sendRequest(type.method, params, source.token)) as R;
    } catch (err) {
      if (source.token.isCancellationRequested) {
        throw new ToolError("LSP_TIMEOUT", `${this.cfg.command} did not answer within ${ms}ms.`, {
          language: this.lang,
          hint: "Try the static map (map_neighbors) or retry; large projects can be slow on first query.",
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      source.dispose();
    }
  }

  // SyncTarget — used by the DocumentRegistry
  didOpen(uri: string, languageId: string, version: number, text: string): void {
    void this.conn?.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version, text },
    });
  }

  didChange(uri: string, version: number, text: string): void {
    void this.conn?.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(uri: string): void {
    void this.conn?.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
  }

  /** Open a file with disk sync; first open runs the warm-up barrier (tsserver
   * loads projects asynchronously and answers early queries with []). */
  async open(absPath: string): Promise<{ uri: string; version: number }> {
    await this.ensureReady();
    const version = await this.docs.ensureOpen(this, absPath);
    const uri = URI.file(absPath).toString();
    if (!this.warmedAnchor) {
      this.warmedAnchor = true;
      await this.warmup(uri);
      this.state = "ready";
    }
    return { uri, version };
  }

  private async warmup(uri: string): Promise<void> {
    const deadline = Date.now() + WARMUP_CAP_MS;
    while (Date.now() < deadline) {
      try {
        const symbols = await this.request(DocumentSymbolRequest.type, { textDocument: { uri } }, 5_000);
        if (Array.isArray(symbols) && symbols.length > 0) return;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, WARMUP_POLL_MS));
    }
  }
}
