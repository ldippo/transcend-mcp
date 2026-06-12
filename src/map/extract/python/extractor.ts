import path from "node:path";
import type { Node } from "web-tree-sitter";
import { makeNodeId, OrdinalCounter } from "../../ids.js";
import type { FileExtraction, GraphNode, NodeKind, RawImport, RawRef, RawRefKind } from "../../types.js";
import { ExtractInput, firstLine, LanguageExtractor, locOf, scopeChain } from "../extractor.js";

const DEF_TYPES = new Set(["class_definition", "function_definition"]);

function defName(def: Node): string | null {
  return def.childForFieldName("name")?.text ?? null;
}

function qualify(node: Node): string[] {
  return scopeChain(node, DEF_TYPES, defName);
}

function docstringOf(def: Node): string | undefined {
  const body = def.childForFieldName("body");
  const first = body?.namedChildren[0];
  const expr = first?.type === "expression_statement" ? first.namedChildren[0] : null;
  if (expr?.type === "string") {
    return firstLine(expr.text.replace(/^[rbuf]*['"]{1,3}/i, "").replace(/['"]{1,3}$/, ""));
  }
  return undefined;
}

function signatureOf(def: Node, kind: NodeKind): string | undefined {
  if (kind === "function" || kind === "method") {
    const name = defName(def) ?? "";
    const params = def.childForFieldName("parameters")?.text ?? "()";
    const ret = def.childForFieldName("return_type")?.text;
    return `def ${name}${params}${ret ? ` -> ${ret}` : ""}`.slice(0, 200);
  }
  if (kind === "class") {
    const name = defName(def) ?? "";
    const sup = def.childForFieldName("superclasses")?.text ?? "";
    return `class ${name}${sup}`.slice(0, 200);
  }
  return undefined;
}

/** Last identifier of a possibly-dotted name; "repo.save" -> "save". */
function lastSegment(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? name : name.slice(i + 1);
}

export const pythonExtractor: LanguageExtractor = {
  lang: "py",
  extensions: [".py", ".pyi"],
  queryLanguage: "python",
  grammarFor: () => "tree-sitter-python.wasm",

  extract({ file, source, contentHash, tree, queries }: ExtractInput): FileExtraction {
    const nodes: GraphNode[] = [];
    const rawImports: RawImport[] = [];
    const rawRefs: RawRef[] = [];
    const ordinals = new OrdinalCounter();

    const fileNode: GraphNode = {
      id: makeNodeId("py", file),
      kind: "file",
      lang: "py",
      name: path.posix.basename(file),
      qualifiedName: "",
      file,
      loc: locOf(tree.rootNode),
      exported: true,
    };
    const firstStmt = tree.rootNode.namedChildren[0];
    const firstExpr = firstStmt?.type === "expression_statement" ? firstStmt.namedChildren[0] : null;
    if (firstExpr?.type === "string") {
      fileNode.doc = firstLine(firstExpr.text.replace(/^[rbuf]*['"]{1,3}/i, "").replace(/['"]{1,3}$/, ""));
    }
    nodes.push(fileNode);

    // ---- symbols
    for (const m of queries.symbols.matches(tree.rootNode)) {
      const def = m.captures.find((c) => c.name.endsWith(".def"))?.node;
      const nameNode = m.captures.find((c) => c.name.endsWith(".name"))?.node;
      if (!def || !nameNode) continue;
      const baseKind = m.captures.find((c) => c.name.endsWith(".def"))!.name.split(".")[0] as NodeKind;
      const chain = qualify(def);

      // Variables: module level only (assignments inside functions are noise).
      if (baseKind === "variable" && chain.length > 0) continue;

      const insideClass = def.parent?.parent?.type === "class_definition" || def.parent?.type === "class_definition";
      const kind: NodeKind = baseKind === "function" && (insideClass || chain.length > 0) && isMethod(def) ? "method" : baseKind;
      const name = nameNode.text;
      const qualifiedName = [...chain, name].join(".");
      const ordinal = ordinals.next(qualifiedName);

      const node: GraphNode = {
        id: makeNodeId("py", file, qualifiedName, ordinal),
        kind,
        lang: "py",
        name,
        qualifiedName,
        file,
        loc: locOf(def),
        exported: !name.startsWith("_") || name === "__init__",
        signature: signatureOf(def, kind),
      };
      const doc = DEF_TYPES.has(def.type) ? docstringOf(def) : undefined;
      if (doc) node.doc = doc;
      nodes.push(node);
    }

    // ---- imports
    for (const m of queries.imports.matches(tree.rootNode)) {
      const stmt = m.captures[0]?.node;
      if (!stmt) continue;
      rawImports.push(...unpackImport(stmt));
    }

    // ---- refs
    for (const m of queries.refs.matches(tree.rootNode)) {
      const cap = m.captures[0];
      if (!cap) continue;
      const kind = cap.name.split(".")[0] as string;
      const refKind: RawRefKind = kind === "call" ? "calls" : kind === "extends" ? "extends" : "references";
      const node = cap.node;
      const name = node.text;
      // Skip self/cls attribute heads in qualification — keep full dotted text;
      // resolution interprets `self.x` / dotted heads.
      rawRefs.push({
        fromQName: qualify(node).join("."),
        kind: refKind,
        name,
        loc: locOf(node),
      });
    }

    return {
      schemaVersion: 1,
      file,
      lang: "py",
      contentHash,
      extractedAt: new Date().toISOString(),
      nodes,
      rawImports,
      rawRefs,
    };
  },

  resolveImportSource(source: string, fromFile: string, fileSet: ReadonlySet<string>): string[] {
    const tryPaths = (base: string): string[] => {
      const candidates = [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`];
      return candidates.filter((c) => fileSet.has(c));
    };

    if (source.startsWith(".")) {
      const dots = /^\.+/.exec(source)![0].length;
      const rest = source.slice(dots);
      let dir = path.posix.dirname(fromFile);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      if (!rest) {
        // `from . import x` — the package itself
        const init = path.posix.join(dir, "__init__.py");
        return fileSet.has(init) ? [init] : [];
      }
      return tryPaths(path.posix.join(dir, ...rest.split(".")));
    }
    // Absolute: resolve from repo root; also try one level up for src-layout packages.
    const parts = source.split(".");
    const direct = tryPaths(path.posix.join(...parts));
    if (direct.length) return direct;
    return tryPaths(path.posix.join("src", ...parts));
  },
};

/** A function_definition directly inside a class body is a method. */
function isMethod(def: Node): boolean {
  // class_definition > block > function_definition (possibly via decorated_definition)
  let p = def.parent;
  if (p?.type === "decorated_definition") p = p.parent;
  return p?.type === "block" && p.parent?.type === "class_definition";
}

function unpackImport(stmt: Node): RawImport[] {
  const loc = locOf(stmt);
  if (stmt.type === "import_statement") {
    // import a.b, c as d
    const out: RawImport[] = [];
    for (const child of stmt.namedChildren) {
      if (!child) continue;
      if (child.type === "dotted_name") {
        out.push({ source: child.text, names: [{ imported: "*", local: child.text.split(".")[0]! }], loc });
      } else if (child.type === "aliased_import") {
        const name = child.childForFieldName("name")?.text ?? child.text;
        const alias = child.childForFieldName("alias")?.text ?? name;
        out.push({ source: name, names: [{ imported: "*", local: alias }], loc });
      }
    }
    return out;
  }
  // import_from_statement: from X import a, b as c | *
  const moduleNode = stmt.childForFieldName("module_name");
  const source = moduleNode?.text ?? "";
  const names: RawImport["names"] = [];
  for (const child of stmt.namedChildren) {
    if (!child || child.id === moduleNode?.id) continue;
    if (child.type === "dotted_name" || child.type === "identifier") {
      names.push({ imported: child.text, local: child.text });
    } else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name")?.text ?? child.text;
      const alias = child.childForFieldName("alias")?.text ?? name;
      names.push({ imported: name, local: alias });
    } else if (child.type === "wildcard_import") {
      names.push({ imported: "*", local: "*" });
    }
  }
  return source ? [{ source, names, loc }] : [];
}
