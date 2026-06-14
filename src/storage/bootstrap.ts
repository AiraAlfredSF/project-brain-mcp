// SQLite adapter — module_intents table. Spec 04.
//
// Owns:   `module_intents` and its single index. The only writer of this
//         table is Spec 04's `log_module_intent` tool (and the table
//         has a `CHECK (source = 'bootstrap')` constraint enforcing that).
// Cross-module: Spec 04 reads `graph_nodes` (Spec 02) only via Spec 02's
//         `listAllNodes()` export — never a direct SQL query against
//         `graph_nodes` here.

import type { Database as DatabaseType } from "better-sqlite3";

/** Shape of a `module_intents` row as returned by SQLite (arrays parsed). */
export interface ModuleIntentRow {
  id: number;
  module: string;
  intent: string;
  constraints: string[];
  caveats: string[];
  source: "bootstrap";
  created_at: string;
}

/** Result of `getModuleIntentCoverage()`. */
export interface ModuleIntentCoverage {
  /** Count of distinct modules with at least one `module_intents` row. */
  covered: number;
  /** Count of non-deprecated `graph_nodes` rows (i.e. the target total). */
  total: number;
}

/**
 * A `graph_nodes` row resolved to the minimum the bootstrap agent needs
 * (module + path) plus its `id` for ordering. The full row type lives in
 * `storage/graph.ts`; we re-declare a subset here so this file doesn't
 * drag in the entire graph storage surface.
 */
export interface UncoveredModuleRef {
  id: number;
  module: string;
  path: string;
}

/**
 * Create the `module_intents` table and its index. Idempotent — uses
 * `IF NOT EXISTS` everywhere.
 *
 * Schema per Spec 04 §2:
 *   - `constraints` and `caveats` are JSON-encoded string arrays, deserialized
 *     at the adapter boundary (per `absolute-rules-reference.md` DB type rules).
 *   - `source` is hard-coded to `'bootstrap'` via a CHECK constraint — this
 *     table has exactly one writer (Spec 04's `log_module_intent`).
 */
export function createBootstrapSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_intents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      module      TEXT NOT NULL,
      intent      TEXT NOT NULL,
      constraints TEXT NOT NULL DEFAULT '[]',
      caveats     TEXT NOT NULL DEFAULT '[]',
      source      TEXT NOT NULL DEFAULT 'bootstrap' CHECK (source = 'bootstrap'),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_module_intents_module ON module_intents(module);
  `);
}


/**
 * Insert a `module_intents` row and return the new id. Arrays are
 * JSON-serialized at the adapter boundary per the absolute-rules-
 * reference.md (DB Type Rules).
 */
export function insertModuleIntent(
  db: DatabaseType,
  module: string,
  intent: string,
  constraints: string[],
  caveats: string[]
): number {
  const stmt = db.prepare(
    `INSERT INTO module_intents (module, intent, constraints, caveats)
     VALUES (?, ?, ?, ?)`
  );
  const result = stmt.run(
    module,
    intent,
    JSON.stringify(constraints),
    JSON.stringify(caveats)
  );
  return Number(result.lastInsertRowid);
}

/**
 * Return all `module_intents` rows ordered by `id` ASC (insertion order).
 * Used by Spec 04's `get_bootstrap_status` to count `intents` and by
 * Spec 05 / future specs for re-deriving `constraints.md` content.
 */
export function listModuleIntents(db: DatabaseType): ModuleIntentRow[] {
  const rows = db
    .prepare(
      `SELECT id, module, intent, constraints, caveats, source, created_at
       FROM module_intents
       ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    module: string;
    intent: string;
    constraints: string;
    caveats: string;
    source: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    module: r.module,
    intent: r.intent,
    constraints: JSON.parse(r.constraints) as string[],
    caveats: JSON.parse(r.caveats) as string[],
    source: "bootstrap" as const,
    created_at: r.created_at,
  }));
}

/**
 * Coverage = `covered` (distinct modules with a `module_intents` row) vs.
 * `total` (non-deprecated `graph_nodes` rows). Per Spec 04 §3 definitions
 * of `incomplete` / `complete`:
 *
 *   - `incomplete`: `total > 0` AND `covered < total`
 *   - `complete`:   `total > 0` AND `covered >= total`
 *   - `never_run`:  `total === 0` AND `covered === 0`
 *
 * Deprecated modules (`graph_nodes.deprecated = 1`) are excluded from
 * `total` (EC-BA-06).
 */
export function getModuleIntentCoverage(db: DatabaseType): ModuleIntentCoverage {
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM graph_nodes WHERE deprecated = 0`
    )
    .get() as { n: number };

  // `covered` = count of distinct modules that have a `module_intents` row.
  // A module may have multiple `module_intents` rows (e.g. agent re-logged
  // the same module) but coverage only cares about the set of distinct
  // modules that have been touched.
  const coveredRow = db
    .prepare(
      `SELECT COUNT(DISTINCT module) AS n FROM module_intents`
    )
    .get() as { n: number };

  return { covered: coveredRow.n, total: totalRow.n };
}

/**
 * Find the first non-deprecated `graph_nodes` row that has no
 * `module_intents` row, ordered by `graph_nodes.id` ASC. Returns
 * `null` if every non-deprecated node is covered.
 *
 * Implementation note: we use a `NOT EXISTS` subquery against
 * `module_intents` rather than a `LEFT JOIN ... WHERE mi.id IS NULL` to
 * keep the plan small (SQLite's planner handles `NOT EXISTS` well for
 * these sizes). The subquery is correlated on `module_intents.module`
 * (no FK, so a textual equality is the right join condition).
 */
export function getNextUncoveredModule(
  db: DatabaseType
): UncoveredModuleRef | null {
  const row = db
    .prepare(
      `SELECT gn.id, gn.module, gn.path
       FROM graph_nodes gn
       WHERE gn.deprecated = 0
         AND NOT EXISTS (
           SELECT 1 FROM module_intents mi
           WHERE mi.module = gn.module
         )
       ORDER BY gn.id ASC
       LIMIT 1`
    )
    .get() as { id: number; module: string; path: string } | undefined;
  return row ?? null;
}
