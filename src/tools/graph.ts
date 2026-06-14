// index_codebase, get_dependents, get_dependencies, get_blast_radius,
// diff_graph, find_entry_points — Spec 02.
//
// All six tools are pure read/write/format against the storage layer.
// No raw JSON is ever returned to the agent — all responses go through
// format/dsl.ts (per absolute-rules-reference.md, MCP Contract).
//
// Cross-module: the graph DSL header injection (BRAIN DSL v1) is
// coordinated with Spec 01's session flag — the first DSL-emitting
// call of the session (whether a Spec 01 or Spec 02 tool) emits the
// header; subsequent calls omit it. See `markSchemaSent()`.

import { statSync } from "node:fs";
import { resolve as resolveFs } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import {
  formatBlastLine,
  formatCallerChildLine,
  formatDepChildLine,
  formatDiffHeader,
  formatDiffLine,
  formatEntryHeader,
  formatErr,
  formatGraphStats,
  formatNodeHeader,
  formatNodeLine,
  formatOk,
  formatSectionHeader,
  GRAPH_INDEXED_HEADER,
  groupHopsByDepth,
  sortModulesAlphabetical,
} from "../format/dsl.js";
import { markSchemaSent, takeSchemaHeaderIfNeeded } from "../format/dsl.js";
import {
  bfsFromNode,
  getIndexRunByCommit,
  getLatestIndexRun,
  getNodeByModule,
  listAllEdgesModuleNames,
  listAllNodes,
  parseEdgeSnapshot,
  recordIndexRun,
  searchNodes,
  type EdgeType,
  type GraphNodeRow,
  type ModuleEdge,
} from "../storage/graph.js";
import { indexCodebase } from "../parser/indexer.js";


// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

/** Validate `depth` is a positive integer 1..10. Returns the number or `null`. */
function parseDepth(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
    n = Number(raw);
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  return n;
}

/** Prepend the BRAIN DSL v1 header if not yet sent this session. */
function maybeEmitSchemaHeader(): string | null {
  const h = takeSchemaHeaderIfNeeded();
  if (h !== null) markSchemaSent();
  return h;
}

// ---------------------------------------------------------------------------
// index_codebase
// ---------------------------------------------------------------------------

/**
 * index_codebase(path?, incremental=true)
 *
 * Walks the target directory, parses source files, and (re)builds
 * `graph_nodes`/`graph_edges`. Returns the GRAPH: indexed block.
 */
export function indexCodebaseTool(
  db: DatabaseType,
  rawInput: unknown
): string {
  if (!isRecord(rawInput)) {
    // No args is OK; defaults apply. An explicit non-record is a caller error.
    return formatErr("invalid input");
  }
  const { path, incremental } = rawInput;
  const targetPath =
    typeof path === "string" && path.length > 0
      ? resolveFs(path)
      : resolveFs(process.cwd());

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(targetPath);
  } catch {
    return formatErr(`path not found: ${path ?? targetPath}`);
  }
  if (!stat.isDirectory()) {
    return formatErr(`path not found: ${path ?? targetPath}`);
  }
  const inc =
    incremental === undefined || incremental === null
      ? true
      : Boolean(incremental);

  const r = indexCodebase(db, targetPath, inc);
  const lines: string[] = [GRAPH_INDEXED_HEADER, ...formatGraphStats(r.node_count, r.edge_count, r.duration_ms)];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_dependents / get_dependencies
// ---------------------------------------------------------------------------

/**
 * get_dependents(module, depth=1) — BFS upstream, depth-grouped output.
 *
 * Module is required (case-sensitive). Depth 1..10, default 1.
 */
export function getDependents(
  db: DatabaseType,
  rawInput: unknown
): string {
  return renderNeighbors(db, rawInput, "incoming");
}

/** get_dependencies(module, depth=1) — BFS downstream, depth-grouped. */
export function getDependencies(
  db: DatabaseType,
  rawInput: unknown
): string {
  return renderNeighbors(db, rawInput, "outgoing");
}

function renderNeighbors(
  db: DatabaseType,
  rawInput: unknown,
  direction: "incoming" | "outgoing"
): string {
  if (!isRecord(rawInput)) return formatErr("module is required");
  const { module, depth } = rawInput;
  if (typeof module !== "string" || module.length === 0) {
    return formatErr("module is required");
  }
  const d = parseDepth(depth ?? 1);
  if (d === null) {
    return formatErr("depth must be between 1 and 10");
  }
  const node = getNodeByModule(db, module);
  if (!node) return ""; // unknown module → empty DSL block

  const hops = bfsFromNode(db, node.id, direction, d);

  // Collapse hops to one edge_type per module, for rendering `!>` on
  // side_effect edges. If a module is reached via multiple edges of
  // different types, side_effect wins (it's the more dangerous of the
  // two — the more visible signal should not be hidden).
  const edgesByModule = new Map<string, EdgeType>();
  for (const hop of hops) {
    const prev = edgesByModule.get(hop.module);
    if (prev === undefined || (prev !== "side_effect" && hop.edge_type === "side_effect")) {
      edgesByModule.set(hop.module, hop.edge_type);
    }
  }

  const lines: string[] = [];
  const header = maybeEmitSchemaHeader();
  if (header) lines.push(header);

  lines.push(formatNodeHeader(module));

  if (hops.length === 0) {
    return lines.join("\n");
  }

  // groupHopsByDepth preserves BFS order; we further sort modules
  // alphabetically within each depth for stable output.
  // `direction` here is the BFS direction (incoming/outgoing from the
  // start node). For the section header we map:
  //   incoming → `^callers` (the start node's callers, i.e. things
  //              that depend on it)
  //   outgoing → `>deps`    (the start node's dependencies, i.e.
  //              things it depends on)
  const groups = groupHopsByDepth(hops);
  for (const g of groups) {
    if (direction === "incoming") {
      lines.push(formatSectionHeader("callers", g.depth, 0));
      for (const m of sortModulesAlphabetical(g.modules)) {
        lines.push(formatCallerChildLine(m, 1));
      }
    } else {
      lines.push(formatSectionHeader("deps", g.depth, 0));
      for (const m of sortModulesAlphabetical(g.modules)) {
        const se = edgesByModule.get(m) === "side_effect";
        lines.push(formatDepChildLine(m, se, 1));
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_blast_radius
// ---------------------------------------------------------------------------

/**
 * get_blast_radius(module) — full transitive dependents with depth
 * annotations on every line. No depth cap.
 */
export function getBlastRadius(
  db: DatabaseType,
  rawInput: unknown
): string {
  if (!isRecord(rawInput)) return formatErr("module is required");
  const { module } = rawInput;
  if (typeof module !== "string" || module.length === 0) {
    return formatErr("module is required");
  }
  const node = getNodeByModule(db, module);
  if (!node) return ""; // unknown module → empty DSL block

  // BFS with no cap (maxDepth=0 in the storage helper).
  const hops = bfsFromNode(db, node.id, "incoming", 0);

  const lines: string[] = [];
  const header = maybeEmitSchemaHeader();
  if (header) lines.push(header);
  lines.push(formatNodeHeader(module));

  if (hops.length === 0) {
    return lines.join("\n");
  }

  lines.push(formatSectionHeader("callers", null, 0));
  // Group by depth and sort modules within each depth alphabetically.
  const groups = groupHopsByDepth(hops);
  for (const g of groups) {
    for (const m of sortModulesAlphabetical(g.modules)) {
      lines.push(formatBlastLine(m, g.depth, 1));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// diff_graph
// ---------------------------------------------------------------------------

/**
 * diff_graph(since_commit) — edges added/removed since the index-run
 * recorded at `since_commit`. Reads the index-run markers from
 * `graph_index_runs` and diffs the latest snapshot against the snapshot
 * for the requested commit.
 */
export function diffGraph(
  db: DatabaseType,
  rawInput: unknown
): string {
  if (!isRecord(rawInput)) return formatErr("since_commit is required");
  const { since_commit } = rawInput;
  if (typeof since_commit !== "string" || since_commit.length === 0) {
    return formatErr("since_commit is required");
  }

  const oldRun = getIndexRunByCommit(db, since_commit);
  if (!oldRun) {
    return formatErr(`unknown commit: ${since_commit}`);
  }
  const latest = getLatestIndexRun(db);
  if (!latest) {
    // No runs at all → just the header.
    return formatDiffHeader(since_commit);
  }

  const oldEdges = parseEdgeSnapshot(oldRun.edge_snapshot);
  const newEdges = parseEdgeSnapshot(latest.edge_snapshot);

  const oldSet = new Set(oldEdges.map(edgeKey));
  const newSet = new Set(newEdges.map(edgeKey));

  const lines: string[] = [];
  const header = maybeEmitSchemaHeader();
  if (header) lines.push(header);
  lines.push(formatDiffHeader(since_commit));

  // Added edges.
  for (const e of newEdges) {
    if (!oldSet.has(edgeKey(e))) {
      lines.push(
        formatDiffLine({
          from: e.from,
          to: e.to,
          sideEffect: e.edge_type === "side_effect",
          added: true,
        })
      );
    }
  }
  // Removed edges.
  for (const e of oldEdges) {
    if (!newSet.has(edgeKey(e))) {
      lines.push(
        formatDiffLine({
          from: e.from,
          to: e.to,
          sideEffect: e.edge_type === "side_effect",
          added: false,
        })
      );
    }
  }

  return lines.join("\n");
}

function edgeKey(e: ModuleEdge): string {
  return `${e.from}|${e.to}|${e.edge_type}`;
}

// ---------------------------------------------------------------------------
// find_entry_points
// ---------------------------------------------------------------------------

/**
 * find_entry_points(intent) — top 3 nodes by token-match score,
 * weighted toward entry_point=1 rows, with `~` prefix for deprecated
 * nodes (EC-CG-09), `@` for entry points, both combined as `@~` if
 * applicable.
 */
export function findEntryPoints(
  db: DatabaseType,
  rawInput: unknown
): string {
  if (!isRecord(rawInput)) return formatErr("intent is required");
  const { intent } = rawInput;
  if (typeof intent !== "string" || intent.trim().length === 0) {
    return formatErr("intent is required");
  }

  const tokens = intent
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const matches = searchNodes(db, tokens, 3);

  const lines: string[] = [];
  const header = maybeEmitSchemaHeader();
  if (header) lines.push(header);

  if (matches.length === 0) return lines.join("\n");

  lines.push(formatEntryHeader(intent));
  for (const m of matches) {
    lines.push(
      formatNodeLine({
        module: m.module,
        entryPoint: m.entry_point,
        deprecated: m.deprecated,
      })
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
