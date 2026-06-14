// AST → graph edges via tree-sitter. Spec 02.
//
// Loads each language's native binding directly by file extension.
// Supported languages: JavaScript, TypeScript, Python, Rust, Go, Java, C, C++.
//
// Spec 02 §9 "Tree-sitter grammar source" resolved to use the native
// bindings already pinned in source/package.json — no .wasm, no
// web-tree-sitter bundling.

import Parser from "tree-sitter";
import Js from "tree-sitter-javascript";
import Ts from "tree-sitter-typescript";
import Py from "tree-sitter-python";
import Rust from "tree-sitter-rust";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import Php from "tree-sitter-php";

import type { EdgeType } from "../storage/graph.js";


/** Edge triple produced by the parser (module-name, not row id). */
export interface ParsedEdge {
  from: string; // file-relative module path
  to: string; // file-relative module path of the import target
  edge_type: EdgeType;
}

/** Per-file parse result. */
export interface ParsedFile {
  module: string; // path relative to the indexed root
  path: string; // absolute path on disk
  entry_point: 0 | 1;
  edges: ParsedEdge[];
}

/** File extensions → language grammar, in priority order. */
const EXT_TO_LANG: Record<string, () => unknown> = {
  ".ts": () => Ts.typescript,
  ".tsx": () => Ts.tsx,
  ".js": () => Js,
  ".jsx": () => Js,
  ".mjs": () => Js,
  ".cjs": () => Js,
  ".py": () => Py,
  ".rs": () => Rust,
  ".go": () => Go,
  ".java": () => Java,
  ".c": () => C,
  ".h": () => C,
  ".cpp": () => Cpp,
  ".cc": () => Cpp,
  ".cxx": () => Cpp,
  ".hpp": () => Cpp,
  ".hh": () => Cpp,
  ".php": () => Php.php,
};

/** Return the language-factory for `ext`, or `null` if unsupported. */
export function getLanguageForExtension(
  ext: string
): (() => unknown) | null {
  const norm = ext.toLowerCase();
  return EXT_TO_LANG[norm] ?? null;
}

/** File extensions this parser knows how to handle. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXT_TO_LANG);

/**
 * Per Spec 02 §9 (resolved gap): a file is an entry point if its path
 * (relative to the indexed root, forward-slash-separated) has a basename
 * equal to `index.<ext>`, `main.<ext>`, or `cli.<ext>`.
 */
export function isEntryPointPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  const leaf = norm.split("/").pop() ?? "";
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (
      leaf === `index${ext}` ||
      leaf === `main${ext}` ||
      leaf === `cli${ext}`
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a file's source and return its edges. The caller (the indexer
 * orchestrator) provides the file's `relPath` (used as `from`/`from-module`)
 * and a `resolvers` map: "the import specifier in this file" →
 * "the relative module path of the import target". The indexer builds
 * `resolvers` by walking the file tree first; the parser just consumes
 * it. If a specifier is not in the map, the import is silently dropped.
 */
export function parseFileEdges(
  relPath: string,
  source: string,
  ext: string,
  resolvers: Map<string, string>
): ParsedEdge[] {
  const langFactory = getLanguageForExtension(ext);
  if (!langFactory) return [];

  const parser = new Parser();
  parser.setLanguage(langFactory());
  const tree = parser.parse(source);
  if (!tree) return [];

  const edges: ParsedEdge[] = [];
  collectEdges(tree.rootNode, relPath, ext, resolvers, edges);
  return dedupeEdges(edges);
}

function collectEdges(
  root: Parser.SyntaxNode,
  fromModule: string,
  ext: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    walkJsTs(root, fromModule, resolvers, out);
  } else if (ext === ".py") {
    walkPython(root, fromModule, resolvers, out);
  } else if (ext === ".rs") {
    walkRust(root, fromModule, resolvers, out);
  } else if (ext === ".go") {
    walkGo(root, fromModule, resolvers, out);
  } else if (ext === ".java") {
    walkJava(root, fromModule, resolvers, out);
  } else if (ext === ".c" || ext === ".h") {
    walkIncludeDirective(root, fromModule, resolvers, out);
  } else if (
    ext === ".cpp" ||
    ext === ".cc" ||
    ext === ".cxx" ||
    ext === ".hpp" ||
    ext === ".hh"
  ) {
    walkIncludeDirective(root, fromModule, resolvers, out);
  } else if (ext === ".php") {
    walkPhp(root, fromModule, resolvers, out);
  }
}

/** Look up the import target's module path. */
function resolveTarget(
  spec: string,
  resolvers: Map<string, string>
): string | null {
  // Specifiers are looked up verbatim, as they appear in source. The
  // indexer that builds `resolvers` is responsible for using the same
  // form the source uses (e.g. the file-tree scan produces both the
  // module path AND a list of possible specifier forms for it; here we
  // only support exact-string match).
  return resolvers.get(spec) ?? null;
}

function emitEdge(
  fromModule: string,
  toModule: string,
  kind: "depends" | "calls",
  out: ParsedEdge[]
): void {
  if (fromModule === toModule) return;
  out.push({ from: fromModule, to: toModule, edge_type: kind });
}

/** Dedup edges — same `from`/`to`/`type` triple only emitted once. */
function dedupeEdges(edges: ParsedEdge[]): ParsedEdge[] {
  const seen = new Set<string>();
  const out: ParsedEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.edge_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-language edge collection
// ---------------------------------------------------------------------------

/** Generic recursive tree visitor that calls `onNode` for every node. */
function visitAll(
  root: Parser.SyntaxNode,
  onNode: (node: Parser.SyntaxNode) => void
): void {
  const visited = new Set<number>();
  function visit(node: Parser.SyntaxNode): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    onNode(node);
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }
  visit(root);
}

// ---------- JavaScript / TypeScript ----------
//
// We collect:
//   - `import_statement` / `export ... from "x"` → "depends" edge
//   - `call_expression` whose callee is an identifier whose text matches
//     a basename in `resolvers` → "calls" edge (conservative)
function walkJsTs(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "import_statement") {
      const src = node.childForFieldName("source");
      if (src && src.type === "string") {
        const spec = stripQuotes(src.text);
        const target = resolveTarget(spec, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      }
    } else if (node.type === "export_statement") {
      const src = node.childForFieldName("source");
      if (src && src.type === "string") {
        const spec = stripQuotes(src.text);
        const target = resolveTarget(spec, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      }
    } else if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn && fn.type === "identifier") {
        const target = resolvers.get(fn.text) ?? null;
        if (target && target !== fromModule) {
          emitEdge(fromModule, target, "calls", out);
        }
      }
    }
  });
}

// ---------- Python ----------
function walkPython(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      const mod = node.childForFieldName("module_name");
      if (mod) {
        const spec = mod.text;
        const target = resolveTarget(spec, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      } else {
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i);
          if (c && c.type === "dotted_name") {
            const target = resolveTarget(c.text, resolvers);
            if (target) emitEdge(fromModule, target, "depends", out);
            break;
          }
        }
      }
    }
  });
}

// ---------- Rust ----------
function walkRust(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      const spec = arg
        ? arg.text
        : node.text.replace(/^use\s+/, "").replace(/;$/, "");
      // Strip leading `crate::` / `self::` / `super::` — same crate.
      const cleaned = spec.replace(/^(crate|self|super)::/, "");
      const target = resolveTarget(cleaned, resolvers);
      if (target) emitEdge(fromModule, target, "depends", out);
    }
  });
}

// ---------- Go ----------
function walkGo(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "import_spec") {
      const path = node.childForFieldName("path");
      if (path) {
        const spec = stripQuotes(path.text);
        const target = resolveTarget(spec, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      }
    }
  });
}

// ---------- Java ----------
function walkJava(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "import_declaration") {
      let spec = node.text
        .replace(/^import\s+/, "")
        .replace(/;$/, "")
        .trim();
      if (spec.startsWith("static ")) spec = spec.slice("static ".length);
      const target = resolveTarget(spec, resolvers);
      if (target) emitEdge(fromModule, target, "depends", out);
    }
  });
}

// ---------- C / C++ ----------
function walkIncludeDirective(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "preproc_include" || node.type === "preproc_include_next") {
      const path = node.childForFieldName("path");
      if (path) {
        const spec = stripQuotes(path.text).replace(/^[<]|[>]$/g, "");
        const target = resolveTarget(spec, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      }
    }
  });
}

// ---------- PHP ----------
function walkPhp(
  root: Parser.SyntaxNode,
  fromModule: string,
  resolvers: Map<string, string>,
  out: ParsedEdge[]
): void {
  visitAll(root, (node) => {
    if (node.type === "namespace_use_declaration") {
      // Find prefix for grouped use: a namespace_name or qualified_name
      // that appears before the namespace_use_group.
      let prefix = "";
      for (const child of node.children) {
        if (child.type === "namespace_name" || child.type === "qualified_name") {
          prefix = child.text;
          break;
        }
        if (child.type === "namespace_use_group") break;
      }
      for (const group of node.children) {
        if (group.type !== "namespace_use_group") continue;
        for (const clause of group.children) {
          if (clause.type !== "namespace_use_clause") continue;
          const qn = clause.children.find((c) => c.type === "qualified_name");
          if (!qn) continue;
          const fqcn = prefix ? `${prefix}\\${qn.text}` : qn.text;
          const target = resolveTarget(fqcn, resolvers);
          if (target) emitEdge(fromModule, target, "depends", out);
        }
      }
      // Also handle non-grouped use declarations (direct namespace_use_clause children)
      for (const clause of node.children) {
        if (clause.type !== "namespace_use_clause") continue;
        const qn = clause.children.find((c) => c.type === "qualified_name");
        if (!qn) continue;
        const fqcn = prefix ? `${prefix}\\${qn.text}` : qn.text;
        const target = resolveTarget(fqcn, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      }
    } else if (
      node.type === "require_expression" ||
      node.type === "require_once_expression" ||
      node.type === "include_expression" ||
      node.type === "include_once_expression"
    ) {
      const stringChild = node.children.find(
        (c) => c.type === "string" || c.type === "encapsed_string"
      );
      if (stringChild) {
        const spec = stripQuotes(stringChild.text);
        const target = resolveTarget(spec, resolvers);
        if (target) emitEdge(fromModule, target, "depends", out);
      }
    }
  });
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}
