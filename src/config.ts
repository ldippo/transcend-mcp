import path from "node:path";
import type { Lang } from "./types.js";

export interface LspServerConfig {
  /** Binary looked up on PATH. */
  command: string;
  args: string[];
  /** Human install hint surfaced in LSP_UNAVAILABLE errors. */
  installHint: string;
  /** LSP languageId values served, keyed by extension. */
  languageIds: Record<string, string>;
}

export interface Config {
  /** Absolute path to the repository being served. */
  root: string;
  /** Where the persisted map index lives. */
  indexDir: string;
  watch: boolean;
  lsp: Record<Lang, LspServerConfig>;
  /** Default ignore patterns applied on top of .gitignore. */
  ignore: string[];
  requestTimeoutMs: number;
  slowRequestTimeoutMs: number; // references / workspaceSymbols
  maxOpenDocs: number;
  debounceMs: number;
  debounceMaxWaitMs: number;
}

export const EXTENSION_LANG: Record<string, Lang> = {
  ".py": "py",
  ".pyi": "py",
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
};

export function langForFile(file: string): Lang | undefined {
  return EXTENSION_LANG[path.extname(file)];
}

export function makeConfig(root: string, opts: { watch?: boolean } = {}): Config {
  const abs = path.resolve(root);
  return {
    root: abs,
    indexDir: path.join(abs, ".transcend", "index"),
    watch: opts.watch ?? true,
    lsp: {
      py: {
        command: "pyright-langserver",
        args: ["--stdio"],
        installHint: "npm install -g pyright",
        languageIds: { ".py": "python", ".pyi": "python" },
      },
      ts: {
        command: "typescript-language-server",
        args: ["--stdio"],
        installHint: "npm install -g typescript-language-server typescript",
        languageIds: {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".mts": "typescript",
          ".cts": "typescript",
          ".js": "javascript",
          ".jsx": "javascriptreact",
        },
      },
    },
    ignore: [
      "node_modules/",
      ".git/",
      ".transcend/",
      "dist/",
      "build/",
      ".venv/",
      "venv/",
      "__pycache__/",
      "*.min.js",
      ".next/",
      "coverage/",
    ],
    requestTimeoutMs: 15_000,
    slowRequestTimeoutMs: 30_000,
    maxOpenDocs: 64,
    debounceMs: 300,
    debounceMaxWaitMs: 2_000,
  };
}
