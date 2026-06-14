// SQLite adapter — graph_nodes, graph_edges, graph_index_runs. Spec 02.
//
// Owns:   the three graph tables + their indexes.
// Cross-module: Spec 03/04/05/07 read graph data through this adapter
//         only; no other module writes to these tables. Spec 01's
//         decisions/failures/constraints are read by Spec 03 directly
//         through Spec 01's adapter — never re-queried here.

import type { Database as DatabaseType } from "better-sqlite3";

/** Edge type enum. Matches the `graph_edges.edge_type` CHECK constraint. */
export type EdgeType = "depends" | "calls" | "side_effect";

/** Shape of a `graph_nodes` row as returned by SQLite. */
export interface GraphNodeRow {
  id: number;
  module: string;
  path: string;
  entry_point: 0 | 1;
  deprecated: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** Shape of a `graph_edges` row as returned by SQLite. */
export interface GraphEdgeRow {
  id: number;
  from_node: number;
  to_node: number;
  edge_type: EdgeType;
  created_at: string;
}

/**
 * An edge resolved to module-name triples — the shape used in
 * `graph_index_runs.edge_snapshot` and by `diff_graph` for human-readable
 * diffs. `edge_type: "side_effect"` is preserved verbatim.
 */
export interface ModuleEdge {
  from: string;
  to: string;
  edge_type: EdgeType;
}

/** A row from `graph_index_runs`. */
export interface GraphIndexRunRow {
  id: number;
  commit_hash: string;
  edge_snapshot: string; // JSON-encoded ModuleEdge[]
  created_at: string;
}

/**
 * Create the three graph tables and their indexes. Idempotent.
 */
export function createGraphSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      module       TEXT NOT NULL UNIQUE,
      path         TEXT NOT NULL,
      entry_point  INTEGER NOT NULL DEFAULT 0 CHECK (entry_point IN (0, 1)),
      deprecated   INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0, 1)),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node  INTEGER NOT NULL REFERENCES graph_nodes(id),
      to_node    INTEGER NOT NULL REFERENCES graph_nodes(id),
      edge_type  TEXT NOT NULL CHECK (edge_type IN ('depends', 'calls', 'side_effect')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_index_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_hash   TEXT NOT NULL,
      edge_snapshot TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_graph_nodes_module      ON graph_nodes(module);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_entry_point ON graph_nodes(entry_point);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from_node   ON graph_edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to_node     ON graph_edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type        ON graph_edges(edge_type);
    CREATE INDEX IF NOT EXISTS idx_graph_index_runs_commit ON graph_index_runs(commit_hash);
  `);
}

/**
 * Upsert a node by `module` (the unique key). Returns the node id. Refreshes
 * `updated_at` and updates `path`/`entry_point`/`deprecated` on every call.
 *
 * Implementation note: SQLite's `lastInsertRowid` after an `ON CONFLICT DO
 * UPDATE` reflects the *previous* successful insert's id, not this row's,
 * so we can't use it. We use a transaction that selects the id before
 * inserting (and the row may not yet exist).
 */
export function upsertNode(
  db: DatabaseType,
  moduleName: string,
  path: string,
  entryPoint: 0 | 1,
  deprecated: 0 | 1 = 0
): number {
  // Fast path: if it exists, return its id.
  const existing = db
    .prepare(`SELECT id FROM graph_nodes WHERE module = ?`)
    .get(moduleName) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE graph_nodes
       SET path = ?, entry_point = ?, deprecated = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(path, entryPoint, deprecated, existing.id);
    return existing.id;
  }
  // Slow path: insert.
  const result = db
    .prepare(
      `INSERT INTO graph_nodes (module, path, entry_point, deprecated)
       VALUES (?, ?, ?, ?)`
    )
    .run(moduleName, path, entryPoint, deprecated);
  return Number(result.lastInsertRowid);
}

/**
 * Insert a single edge. Caller is responsible for the `from_node`/`to_node`
 * ids already existing in `graph_nodes` (Spec 02 always upserts nodes first
 * via `upsertNode()`). Self-edges are dropped (graph noise).
 */
export function insertEdge(
  db: DatabaseType,
  fromNode: number,
  toNode: number,
  edgeType: EdgeType
): number {
  if (fromNode === toNode) return -1;
  const result = db
    .prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type) VALUES (?, ?, ?)`
    )
    .run(fromNode, toNode, edgeType);
  return Number(result.lastInsertRowid);
}

/**
 * Delete all outgoing edges from `nodeId`. Called by `index_codebase`
 * (incremental mode) before re-inserting the re-parsed file's edges, so
 * stale edges from a prior parse don't accumulate (EC-CG-10). Incoming
 * edges (`to_node = nodeId`, i.e. other files' dependencies on this one)
 * are NOT cleared.
 */
export function clearOutgoingEdges(
  db: DatabaseType,
  nodeId: number
): number {
  const result = db
    .prepare(`DELETE FROM graph_edges WHERE from_node = ?`)
    .run(nodeId);
  return Number(result.changes);
}

/** Delete every row from `graph_nodes` and `graph_edges`. EC-CG-01. */
export function clearGraph(db: DatabaseType): void {
  db.exec(`DELETE FROM graph_edges; DELETE FROM graph_nodes;`);
}

/** Look up a node by its exact `module` name. Returns `null` if missing. */
export function getNodeByModule(
  db: DatabaseType,
  moduleName: string
): GraphNodeRow | null {
  const row = db
    .prepare(
      `SELECT id, module, path, entry_point, deprecated, created_at, updated_at
       FROM graph_nodes WHERE module = ?`
    )
    .get(moduleName) as GraphNodeRow | undefined;
  return row ?? null;
}

/** Return every node. */
export function listAllNodes(db: DatabaseType): GraphNodeRow[] {
  return db
    .prepare(
      `SELECT id, module, path, entry_point, deprecated, created_at, updated_at
       FROM graph_nodes`
    )
    .all() as GraphNodeRow[];
}

/** Return every edge (raw, joined with module names for human use). */
export function listAllEdgesModuleNames(
  db: DatabaseType
): ModuleEdge[] {
  return db
    .prepare(
      `SELECT n_from.module AS from_name,
              n_to.module   AS to_name,
              e.edge_type
       FROM graph_edges e
       JOIN graph_nodes n_from ON n_from.id = e.from_node
       JOIN graph_nodes n_to   ON n_to.id   = e.to_node`
    )
    .all() as ModuleEdge[];
}

// ---------------------------------------------------------------------------
// BFS traversal — getDependents, getDependencies, getBlastRadius
//
// All three operate on the same primitive: BFS from a seed node id, with a
// depth cap (or no cap for blast radius), and a visited-set keyed on
// `node_id -> shallowest depth observed` so a node reached at depth 2 and
// at depth 1 is reported at depth 1 only (EC-CG-05).
// ---------------------------------------------------------------------------

interface BfsHop {
  module: string;
  depth: number;
  edge_type: EdgeType;
}

/**
 * BFS over `graph_edges` from `startNodeId`, walking in the given
 * direction:
 *   - `"incoming"` — edges whose `to_node` is the start (i.e. modules
 *     that point at the start node; "who depends on me").
 *   - `"outgoing"` — edges whose `from_node` is the start (i.e.
 *     modules the start node points at; "what I depend on").
 *
 * `maxDepth` of `0` means "no cap" (used by `getBlastRadius`). The
 * starting node is NOT included in the output.
 */
export function bfsFromNode(
  db: DatabaseType,
  startNodeId: number,
  direction: "incoming" | "outgoing",
  maxDepth: number
): BfsHop[] {
  // seen[node_id] = shallowest depth at which this node was first reached
  const seen = new Map<number, number>();
  let frontier: number[] = [startNodeId];
  seen.set(startNodeId, 0);

  const out: BfsHop[] = [];

  let depth = 0;
  const cap = maxDepth === 0 ? Number.POSITIVE_INFINITY : maxDepth;

  while (frontier.length > 0 && depth < cap) {
    const nextFrontier: number[] = [];
    const placeholders = frontier.map(() => "?").join(",");
    const neighborSelect =
      direction === "outgoing"
        ? db
            .prepare(
              `SELECT e.to_node AS neighbor_id, n.module AS neighbor_module, e.edge_type AS edge_type
               FROM graph_edges e
               JOIN graph_nodes n ON n.id = e.to_node
               WHERE e.from_node IN (${placeholders})`
            )
            .all(...frontier)
        : db
            .prepare(
              `SELECT e.from_node AS neighbor_id, n.module AS neighbor_module, e.edge_type AS edge_type
               FROM graph_edges e
               JOIN graph_nodes n ON n.id = e.from_node
               WHERE e.to_node IN (${placeholders})`
            )
            .all(...frontier);

    for (const row of neighborSelect as Array<{
      neighbor_id: number;
      neighbor_module: string;
      edge_type: EdgeType;
    }>) {
      if (row.neighbor_id === startNodeId) continue;
      const already = seen.get(row.neighbor_id);
      if (already !== undefined && already <= depth + 1) {
        continue; // already recorded at this depth or shallower
      }
      seen.set(row.neighbor_id, depth + 1);
      out.push({ module: row.neighbor_module, depth: depth + 1, edge_type: row.edge_type });
      nextFrontier.push(row.neighbor_id);
    }

    frontier = nextFrontier;
    depth += 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// find_entry_points — token-match scoring over graph_nodes
// ---------------------------------------------------------------------------

/**
 * Score every graph_nodes row by how many of the (lowercased) tokens
 * appear as substrings in `module` or `path`. Returns the top `limit`
 * rows as `{ id, module, path, entry_point, deprecated, score }`,
 * ordered by:
 *   1. score DESC
 *   2. entry_point DESC (entry points win on ties — EC-CG-08)
 *   3. id ASC (stable ordering for further ties)
 *
 * `tokens` should already be lowercased and non-empty. Rows with score 0
 * are excluded.
 */
// Scores every node against every token via substring matching, which
// can't be pushed down to a SQL ORDER BY/LIMIT — the whole table is
// scanned and scored in JS before the top `limit` rows are taken. O(n)
// per call; acceptable at "local tool" scale (see indexer.ts's resolver
// build, which is O(n^2) for the same reason), but a known scaling
// ceiling if find_entry_points is called frequently on very large repos.
export function searchNodes(
  db: DatabaseType,
  tokens: string[],
  limit: number
): Array<GraphNodeRow & { score: number }> {
  if (tokens.length === 0) return [];
  const all = listAllNodes(db);
  const scored = all
    .map((n) => {
      const mod = n.module.toLowerCase();
      const pth = n.path.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (t.length === 0) continue;
        if (mod.includes(t)) score += 1;
        if (pth.includes(t)) score += 1;
      }
      return { ...n, score };
    })
    .filter((n) => n.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.entry_point !== a.entry_point) return b.entry_point - a.entry_point;
    return a.id - b.id;
  });

  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// graph_index_runs — diff_graph support
// ---------------------------------------------------------------------------

/**
 * Append a new index-run row. Called once at the end of every
 * `index_codebase` run (Spec 02 §5 last task).
 */
export function recordIndexRun(
  db: DatabaseType,
  commitHash: string,
  edgeSnapshot: ModuleEdge[]
): number {
  const result = db
    .prepare(
      `INSERT INTO graph_index_runs (commit_hash, edge_snapshot) VALUES (?, ?)`
    )
    .run(commitHash, JSON.stringify(edgeSnapshot));
  return Number(result.lastInsertRowid);
}

/**
 * Look up the most recent `graph_index_runs` row for `commitHash` (full or
 * short). Returns `null` if no run was ever recorded for that commit —
 * `diff_graph` then returns `ERR unknown commit: <hash>` (EC-CG-07).
 */
export function getIndexRunByCommit(
  db: DatabaseType,
  commitHash: string
): GraphIndexRunRow | null {
  const rows = db
    .prepare(
      `SELECT id, commit_hash, edge_snapshot, created_at
       FROM graph_index_runs
       WHERE commit_hash = ? OR commit_hash LIKE ?
       ORDER BY id DESC LIMIT 1`
    )
    .all(commitHash, `${commitHash}%`) as GraphIndexRunRow[];
  return rows[0] ?? null;
}

/** Get the most recently-recorded index run, regardless of commit. */
export function getLatestIndexRun(
  db: DatabaseType
): GraphIndexRunRow | null {
  const row = db
    .prepare(
      `SELECT id, commit_hash, edge_snapshot, created_at
       FROM graph_index_runs
       ORDER BY id DESC LIMIT 1`
    )
    .get() as GraphIndexRunRow | undefined;
  return row ?? null;
}

/** Decode the `edge_snapshot` JSON column. */
export function parseEdgeSnapshot(snapshot: string): ModuleEdge[] {
  try {
    const parsed = JSON.parse(snapshot);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof e.from === "string" &&
        typeof e.to === "string" &&
        (e.edge_type === "depends" ||
          e.edge_type === "calls" ||
          e.edge_type === "side_effect")
    ) as ModuleEdge[];
  } catch {
    return [];
  }
}
