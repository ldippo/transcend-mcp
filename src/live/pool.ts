/** Lazy per-language client pool. map_* tools never touch this — the LSP cost
 * is only paid when a nav or resolve call needs ground truth. */
import type { Config } from "../config.js";
import { langForFile } from "../config.js";
import { ToolError } from "../errors.js";
import type { Lang } from "../types.js";
import { LspClient } from "./client.js";

export class LspPool {
  private clients = new Map<Lang, LspClient>();

  constructor(private readonly config: Config) {}

  clientForFile(file: string): LspClient {
    const lang = langForFile(file);
    if (!lang) {
      throw new ToolError("BAD_ARGS", `No language registered for '${file}'.`, {
        hint: "Supported extensions: .py .pyi .ts .tsx .mts .cts .js .jsx",
      });
    }
    return this.client(lang);
  }

  client(lang: Lang): LspClient {
    let c = this.clients.get(lang);
    if (!c) {
      c = new LspClient(
        lang,
        this.config.lsp[lang],
        this.config.root,
        this.config.requestTimeoutMs,
        this.config.maxOpenDocs,
      );
      this.clients.set(lang, c);
    }
    return c;
  }

  /** Clients that have been spawned (for status / broadcast operations). */
  active(): LspClient[] {
    return [...this.clients.values()];
  }

  status(): Record<string, { state: string; detail?: string }> {
    const out: Record<string, { state: string; detail?: string }> = {};
    for (const lang of Object.keys(this.config.lsp) as Lang[]) {
      const c = this.clients.get(lang);
      if (!c) {
        out[lang] = { state: "unspawned" };
        continue;
      }
      const tail = c.stderrTail();
      out[lang] = {
        state: c.state,
        ...(c.stateDetail || tail.length
          ? { detail: [c.stateDetail, ...tail.slice(-3)].filter(Boolean).join(" | ") }
          : {}),
      };
    }
    return out;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.active().map((c) => c.shutdown()));
  }
}
