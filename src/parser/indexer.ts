// File-tree walker + indexer orchestrator. Spec 02.
//
// Walks a directory recursively, identifies supported source files,
// builds a `resolvers` map (specifier → module path) for the whole tree,
// parses each file with parser/treesitter.ts, and writes nodes + edges
// to the graph_* tables via storage/graph.ts.
//
// Lives next to the per-language parser because it is the natural
// orchestrator of the parser; it does not own any tables itself (the
// `storage/graph.ts` adapter does).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

import type { Database as DatabaseType } from "better-sqlite3";

import {
  clearGraph,
  clearOutgoingEdges,
  insertEdge,
  listAllNodes,
  listAllEdgesModuleNames,
  recordIndexRun,
  upsertNode,
  type GraphNodeRow,
  type ModuleEdge,
} from "../storage/graph.js";
import {
  getLanguageForExtension,
  isEntryPointPath,
  parseFileEdges,
  SUPPORTED_EXTENSIONS,
} from "./treesitter.js";


const IGNORED_DIRS = new Set([
  "node_modules",
  "vendor",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target", // rust
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

export interface IndexResult {
  node_count: number;
  edge_count: number;
  duration_ms: number;
  commit_hash: string;
}

/** Read the current git HEAD hash, or `"unknown"` if not a git repo. */
export function readCurrentCommitHash(cwd: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Walk `root` recursively and return a list of file paths that have a
 * supported source-file extension. `IGNORED_DIRS` are skipped.
 */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        const ext = extname(name);
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Build a `resolvers` map: for every source file in the tree, register
 * its (relative) module path under all the specifier forms a parser
 * might encounter. The indexer is the source of truth for what
 * specifier forms are accepted — the parser does verbatim lookups.
 *
 * Common forms registered:
 *   - `rel/path/file.ts` (bare relative)
 *   - `./rel/path/file.ts` (TS/JS-style prefix)
 *   - the basename without extension (matches `<basename>(...)` calls)
 *
 * On conflict (e.g. two files with the same basename), the FIRST one
 * registered wins.
 */
export function buildResolvers(
  root: string,
  files: string[]
): Map<string, string> {
  const resolvers = new Map<string, string>();
  for (const abs of files) {
    const rel = toForwardSlash(relative(root, abs));
    // Primary form.
    if (!resolvers.has(rel)) resolvers.set(rel, rel);
    // `./rel` form for TS/JS sources.
    const dotted = `./${rel}`;
    if (!resolvers.has(dotted)) resolvers.set(dotted, rel);
    // Bare basename for `calls` heuristic (e.g. `foo()` → `foo.ts`).
    const baseNoExt = stripExt(basename(rel));
    if (baseNoExt && !resolvers.has(baseNoExt)) {
      resolvers.set(baseNoExt, rel);
    }
  }
  return resolvers;
}

/**
 * Read composer.json at `root` and build a map of FQCN → relPath for all
 * PHP files under PSR-4 mapped directories.  If composer.json is missing,
 * malformed, or has no psr-4 key, returns an empty map.
 */
export function buildPsr4Resolvers(root: string, files: string[]): Map<string, string> {
  const resolvers = new Map<string, string>();
  let composer: unknown;
  try {
    const raw = readFileSync(join(root, "composer.json"), "utf8");
    composer = JSON.parse(raw);
  } catch {
    return resolvers;
  }
  if (!composer || typeof composer !== "object") return resolvers;
  const autoload = (composer as Record<string, unknown>).autoload;
  if (!autoload || typeof autoload !== "object") return resolvers;
  const psr4 = (autoload as Record<string, unknown>)["psr-4"];
  if (!psr4 || typeof psr4 !== "object") return resolvers;

  const mappings: { dirPrefix: string; nsPrefix: string }[] = [];
  for (const [nsPrefix, dir] of Object.entries(psr4)) {
    if (typeof dir !== "string") continue;
    const normNs = nsPrefix.replace(/\\$/, "");
    const normDir = toForwardSlash(dir).replace(/\/$/, "");
    const absDir = toForwardSlash(join(root, normDir));
    mappings.push({ dirPrefix: absDir, nsPrefix: normNs });
  }

  const rootFwd = toForwardSlash(root);

  for (const abs of files) {
    if (!abs.endsWith(".php")) continue;
    const absFwd = toForwardSlash(abs);
    let bestDirPrefix = "";
    let bestNsPrefix = "";
    for (const { dirPrefix, nsPrefix } of mappings) {
      if (absFwd === dirPrefix || absFwd.startsWith(dirPrefix + "/")) {
        if (dirPrefix.length > bestDirPrefix.length) {
          bestDirPrefix = dirPrefix;
          bestNsPrefix = nsPrefix;
        }
      }
    }
    if (!bestDirPrefix) continue;

    const relToDir = absFwd.slice(bestDirPrefix.length + 1);
    const classPath = relToDir.replace(/\//g, "\\").replace(/\.php$/, "");
    const fqcn = bestNsPrefix ? `${bestNsPrefix}\\${classPath}` : classPath;
    const relPath = absFwd.slice(rootFwd.length + 1);
    resolvers.set(fqcn, relPath);
  }

  return resolvers;
}

/**
 * Compute a per-file resolver that maps the specifier forms a single
 * file might write to the target's relative module path.
 *
 * Walk every file and produce, for each, a per-file resolver that
 * covers that file's plausible import forms. The orchestrator calls
 * this once and then asks for each file's resolver during parsing.
 *
 * Implementation: for every `(sourceFile, targetFile)` pair where the
 * target is reachable from the source via a relative specifier, register
 * the specifier under the target's module path. This is O(n^2) but n
 * is the number of source files in a single project, which is small
 * enough for the local-tool use case.
 */
export function buildPerFileResolvers(
  root: string,
  files: string[]
): Map<string, Map<string, string>> {
  const perFile = new Map<string, Map<string, string>>();
  const rels = files.map((abs) => toForwardSlash(relative(root, abs)));
  const base = buildResolvers(root, files);
  const psr4 = buildPsr4Resolvers(root, files);

  for (let i = 0; i < files.length; i++) {
    const sourceRel = rels[i];
    const resolver = new Map<string, string>(base);
    // Merge PSR-4 FQCN → relPath entries (global, same for every file).
    for (const [fqcn, relPath] of psr4) {
      if (!resolver.has(fqcn)) resolver.set(fqcn, relPath);
    }
    const sourceDir = dirname(sourceRel);

    for (let j = 0; j < files.length; j++) {
      if (i === j) continue;
      const targetRel = rels[j];
      // Compute the path from `sourceDir` to `targetRel`. Then under
      // every common specifier form (./x, ../x, x, x/...).
      const spec = relativePath(sourceDir, targetRel);
      if (spec === null) continue;
      const forms = specifierForms(spec, targetRel);
      for (const f of forms) {
        if (!resolver.has(f)) resolver.set(f, targetRel);
      }
    }
    perFile.set(sourceRel, resolver);
  }
  return perFile;
}

/** dirname of a forward-slash path. */
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Relative path from `from` (dir) to `to` (file), using forward slashes.
 *  Returns `./<x>` for files in the same directory, `<subpath>/<x>` for
 *  descendants, `../<x>` for parents, and `../../<sibling>/<x>` for cousins.
 */
function relativePath(fromDir: string, to: string): string | null {
  if (to.length === 0) return null;
  const toParts = to.split("/");
  const toFile = toParts[toParts.length - 1];
  const toDir = toParts.slice(0, -1);
  const fromParts = fromDir === "" ? [] : fromDir.split("/");

  // Find common prefix length
  let common = 0;
  while (
    common < fromParts.length &&
    common < toDir.length &&
    fromParts[common] === toDir[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const downs = toDir.slice(common);

  if (ups === 0 && downs.length === 0) {
    // Same directory.
    return `./${toFile}`;
  }
  if (ups === 0) {
    // Descendant: relative path is the remaining downward segments.
    return `${downs.join("/")}/${toFile}`;
  }
  return `${"../".repeat(ups)}${downs.length > 0 ? `${downs.join("/")}/` : ""}${toFile}`;
}

/**
 * All plausible specifier forms for resolving `target` when a source
 * file uses spec `spec`. Includes:
 *   - the spec as-is
 *   - the spec with common file extensions appended (for extensionless
 *     `import 'foo'` patterns)
 *   - the bare basename (for `calls` heuristic)
 *   - the target's repo-relative path
 */
function specifierForms(spec: string, target: string): string[] {
  const out: string[] = [spec, target];
  const baseNoExt = stripExt(basename(target));
  if (baseNoExt && !out.includes(baseNoExt)) out.push(baseNoExt);
  // Extensionless form of spec (e.g. `./foo` for a target `foo.ts`) — the
  // most common ESM/TS relative-import form.
  const specNoExt = stripExt(spec);
  if (specNoExt !== spec && !out.includes(specNoExt)) out.push(specNoExt);
  // Common extension-appended forms for the spec.
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (!spec.endsWith(ext)) out.push(`${spec}${ext}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// index_codebase orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full index. Returns the stats block. Supports both full-rebuild
 * (`incremental=false`) and incremental (`incremental=true`, default)
 * modes per Spec 02 §3.
 *
 * For incremental mode, only files whose mtime is newer than their
 * `graph_nodes.updated_at` are re-parsed; their old outgoing edges
 * are first cleared (EC-CG-10), then fresh edges are written.
 */
export function indexCodebase(
  db: DatabaseType,
  root: string,
  incremental: boolean
): IndexResult {
  const t0 = Date.now();

  if (!incremental) {
    clearGraph(db);
  }

  const files = listSourceFiles(root);
  const perFileResolvers = buildPerFileResolvers(root, files);

  // In incremental mode, build a rel-path → row map for mtime comparison.
  const existingByRel = new Map<string, GraphNodeRow>();
  if (incremental) {
    for (const n of listAllNodes(db)) {
      existingByRel.set(toForwardSlash(relative(root, n.path)), n);
    }
  }

  for (const abs of files) {
    const rel = toForwardSlash(relative(root, abs));
    const ext = extname(abs);
    if (!getLanguageForExtension(ext)) continue;

    // Incremental: skip if file is unchanged.
    if (incremental) {
      const prev = existingByRel.get(rel);
      if (prev) {
        let fileMtime = 0;
        try {
          fileMtime = statSync(abs).mtimeMs;
        } catch {
          continue;
        }
        const dbMtime = Date.parse(prev.updated_at.replace(" ", "T") + "Z");
        if (fileMtime <= dbMtime) continue; // unchanged
      }
    }

    // Upsert the node.
    const isEntry = isEntryPointPath(rel) ? 1 : 0;
    const nodeId = upsertNode(db, rel, abs, isEntry);

    // Incremental re-parse: clear the file's outgoing edges first
    // (EC-CG-10). Incoming edges from other files are left alone.
    if (incremental) clearOutgoingEdges(db, nodeId);

    // Parse and insert edges.
    let source = "";
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue; // EC-CG-04
    }

    let edges: ReturnType<typeof parseFileEdges> = [];
    try {
      const resolvers = perFileResolvers.get(rel) ?? new Map();
      edges = parseFileEdges(rel, source, ext, resolvers);
    } catch {
      continue; // EC-CG-04
    }

    for (const e of edges) {
      // Ensure the target node exists.
      const toId = upsertNode(db, e.to, `${root}${sep}${e.to}`, 0);
      insertEdge(db, nodeId, toId, e.edge_type);
    }
  }

  // Persist the post-run edge snapshot for diff_graph. The snapshot is
  // taken over the WHOLE graph (not just this run's edges) so diff_graph
  // can compare any two points in time.
  const snapshot: ModuleEdge[] = listAllEdgesModuleNames(db);
  const commitHash = readCurrentCommitHash(root);
  recordIndexRun(db, commitHash, snapshot);

  const nodeCount = listAllNodes(db).length;
  const edgeCount = snapshot.length;

  return {
    node_count: nodeCount,
    edge_count: edgeCount,
    duration_ms: Date.now() - t0,
    commit_hash: commitHash,
  };
}
