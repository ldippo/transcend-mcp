import path from "node:path";
import type { Node } from "web-tree-sitter";
import { makeNodeId, OrdinalCounter } from "../../ids.js";
import type { FileExtraction, GraphNode, NodeKind, RawImport, RawRef } from "../../types.js";
import { ExtractInput, firstLine, LanguageExtractor, locOf, scopeChain } from "../extractor.js";

const DEF_TYPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "enum_declaration",
  "function_declaration",
  "method_definition",
  "method_signature",
  "abstract_method_signature",
]);

function defName(def: Node): string | null {
  return def.childForFieldName("name")?.text ?? null;
}

function qualify(node: Node): string[] {
  // Include named variable scopes: const f = () => { ... } — the declarator names the scope.
  const chain = scopeChain(node, DEF_TYPES, defName);
  return chain;
}

function jsdocOf(def: Node): string | undefined {
  // export_statement wraps declarations; the comment precedes the wrapper.
  const anchor = def.parent?.type === "export_statement" ? def.parent : def;
  const prev = anchor.previousNamedSibling;
  if (prev?.type === "comment" && prev.text.startsWith("/**")) {
    return firstLine(prev.text.replace(/^\/\*\*+/, "").replace(/\*+\/$/, "").replace(/^\s*\* ?/gm, ""));
  }
  return undefined;
}

function isExported(def: Node): boolean {
  let cur: Node | null = def;
  while (cur) {
    if (cur.type === "export_statement") return true;
    if (cur.type === "program") return false;
    cur = cur.parent;
  }
  return false;
}

function signatureOf(def: Node, kind: NodeKind, name: string): string | undefined {
  if (kind === "function" || kind === "method") {
    const params = def.childForFieldName("parameters")?.text ?? "()";
    const ret = def.childForFieldName("return_type")?.text ?? "";
    return `${name}${params}${ret}`.slice(0, 200);
  }
  if (kind === "class" || kind === "interface") {
    const heritage = def.namedChildren.find((c) => c?.type === "class_heritage" || c?.type === "extends_type_clause");
    return `${def.type === "interface_declaration" ? "interface" : "class"} ${name}${heritage ? ` ${heritage.text}` : ""}`.slice(0, 200);
  }
  return undefined;
}

/** Collect type_identifier descendants (annotation refs), shallow. */
function typeIdentifiers(node: Node, out: Node[] = [], depth = 0): Node[] {
  if (depth > 4) return out;
  if (node.type === "type_identifier") out.push(node);
  for (const c of node.namedChildren) if (c) typeIdentifiers(c, out, depth + 1);
  return out;
}

export const typescriptExtractor: LanguageExtractor = {
  lang: "ts",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"],
  queryLanguage: "typescript",
  grammarFor: (file) =>
    file.endsWith(".tsx") || file.endsWith(".jsx") ? "tree-sitter-tsx.wasm" : "tree-sitter-typescript.wasm",

  extract({ file, contentHash, tree, queries }: ExtractInput): FileExtraction {
    const nodes: GraphNode[] = [];
    const rawImports: RawImport[] = [];
    const rawRefs: RawRef[] = [];
    const ordinals = new OrdinalCounter();
    const seenMethodSig = new Set<string>(); // overload collapse: keep first per qualifiedName

    nodes.push({
      id: makeNodeId("ts", file),
      kind: "file",
      lang: "ts",
      name: path.posix.basename(file),
      qualifiedName: "",
      file,
      loc: locOf(tree.rootNode),
      exported: true,
    });

    // ---- symbols
    for (const m of queries.symbols.matches(tree.rootNode)) {
      const defCap = m.captures.find((c) => c.name.endsWith(".def"));
      const nameNode = m.captures.find((c) => c.name.endsWith(".name"))?.node;
      if (!defCap || !nameNode) continue;
      const def = defCap.node;
      let kind = defCap.name.split(".")[0] as NodeKind;
      const chain = qualify(def);
      const name = nameNode.text;

      if (kind === "variable") {
        if (chain.length > 0) continue; // module-level only
        const value = def.childForFieldName("value");
        if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
          kind = "function";
        }
      }
      // TS overload declarations: same qualifiedName function/method signatures collapse.
      const qualifiedName = [...chain, name].join(".");
      if ((kind === "function" || kind === "method") && def.type !== "method_definition") {
        if (seenMethodSig.has(qualifiedName)) continue;
        seenMethodSig.add(qualifiedName);
      }

      const node: GraphNode = {
        id: makeNodeId("ts", file, qualifiedName, ordinals.next(qualifiedName)),
        kind,
        lang: "ts",
        name,
        qualifiedName,
        file,
        loc: locOf(def.parent?.type === "export_statement" ? def : def),
        exported: isExported(def) || chain.length > 0, // members inherit reachability
        signature: signatureOf(def, kind, name),
      };
      const doc = jsdocOf(def);
      if (doc) node.doc = doc;
      nodes.push(node);
    }

    // ---- imports / re-exports
    for (const m of queries.imports.matches(tree.rootNode)) {
      const stmt = m.captures[0]?.node;
      if (!stmt) continue;
      const unpacked = stmt.type === "import_statement" ? unpackImport(stmt) : unpackExport(stmt);
      rawImports.push(...unpacked.imports);
      rawRefs.push(...unpacked.refs);
    }

    // ---- refs
    for (const m of queries.refs.matches(tree.rootNode)) {
      const cap = m.captures[0];
      if (!cap) continue;
      const node = cap.node;
      const fromQName = qualify(node).join(".");

      if (cap.name === "heritage.clause") {
        // class_heritage: extends_clause (expressions) + implements_clause (types)
        for (const clause of node.namedChildren) {
          if (!clause) continue;
          const kind = clause.type === "implements_clause" ? "implements" : "extends";
          for (const t of clause.namedChildren) {
            if (!t) continue;
            const name = t.type === "generic_type" ? (t.childForFieldName("name")?.text ?? t.text) : t.text;
            if (/^[A-Za-z_$][\w$.]*$/.test(name)) {
              rawRefs.push({ fromQName, kind, name, loc: locOf(t) });
            }
          }
        }
        continue;
      }
      if (cap.name === "reference.annotation") {
        for (const t of typeIdentifiers(node)) {
          rawRefs.push({ fromQName, kind: "references", name: t.text, loc: locOf(t) });
        }
        continue;
      }
      if (cap.name === "extends.name") {
        rawRefs.push({ fromQName, kind: "extends", name: node.text, loc: locOf(node) });
        continue;
      }
      // call.callee
      rawRefs.push({ fromQName, kind: "calls", name: node.text, loc: locOf(node) });
    }

    return {
      schemaVersion: 1,
      file,
      lang: "ts",
      contentHash,
      extractedAt: new Date().toISOString(),
      nodes,
      rawImports,
      rawRefs,
    };
  },

  resolveImportSource(source: string, fromFile: string, fileSet: ReadonlySet<string>): string[] {
    if (!source.startsWith(".")) return []; // bare specifier = external (no tsconfig paths support)
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), source));
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      base.replace(/\.js$/, ".ts"), // ESM-style ./x.js -> x.ts
    ];
    return [...new Set(candidates)].filter((c) => fileSet.has(c));
  },
};

function unpackImport(stmt: Node): { imports: RawImport[]; refs: RawRef[] } {
  const sourceNode = stmt.childForFieldName("source");
  if (!sourceNode) return { imports: [], refs: [] };
  const source = stripQuotes(sourceNode.text);
  const loc = locOf(stmt);
  const names: RawImport["names"] = [];
  const clause = stmt.namedChildren.find((c) => c?.type === "import_clause");
  for (const child of clause?.namedChildren ?? []) {
    if (!child) continue;
    if (child.type === "identifier") {
      names.push({ imported: "default", local: child.text });
    } else if (child.type === "namespace_import") {
      const local = child.namedChildren.find((c) => c?.type === "identifier")?.text ?? "*";
      names.push({ imported: "*", local });
    } else if (child.type === "named_imports") {
      for (const spec of child.namedChildren) {
        if (spec?.type !== "import_specifier") continue;
        const imported = spec.childForFieldName("name")?.text ?? "";
        const alias = spec.childForFieldName("alias")?.text ?? imported;
        if (imported) names.push({ imported, local: alias });
      }
    }
  }
  // `import "./side-effect"` — no clause
  return { imports: [{ source, names, loc }], refs: [] };
}

/** export_statement: re-exports become imports records (marked by local "=>"
 * prefix convention is avoided — resolution treats them via the export table). */
function unpackExport(stmt: Node): { imports: RawImport[]; refs: RawRef[] } {
  const sourceNode = stmt.childForFieldName("source");
  if (!sourceNode) return { imports: [], refs: [] }; // plain `export {x}` / `export const ...` — symbols handle it
  const source = stripQuotes(sourceNode.text);
  const loc = locOf(stmt);
  const names: RawImport["names"] = [];
  for (const child of stmt.namedChildren) {
    if (child?.type === "export_clause") {
      for (const spec of child.namedChildren) {
        if (spec?.type !== "export_specifier") continue;
        const name = spec.childForFieldName("name")?.text ?? "";
        const alias = spec.childForFieldName("alias")?.text ?? name;
        if (name) names.push({ imported: name, local: `export:${alias}` });
      }
    } else if (child?.type === "namespace_export" || stmt.text.startsWith("export *")) {
      names.push({ imported: "*", local: "export:*" });
    }
  }
  if (!names.length) names.push({ imported: "*", local: "export:*" }); // `export * from "./x"`
  return { imports: [{ source, names, loc }], refs: [] };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]/, "").replace(/['"`]$/, "");
}
