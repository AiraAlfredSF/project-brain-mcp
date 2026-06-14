// SQLite adapter — constraints + sync_state tables. Spec 01.
//
// Owns:   `constraints`, `sync_state` tables and their indexes.
// Cross-module: Spec 04 (Bootstrap) and Spec 05 (Two-Way Sync) write to
//         `constraints` through this adapter — they never touch the table
//         directly. Spec 05 is the sole caller of `setLastSyncedAt()`.

import type { Database as DatabaseType } from "better-sqlite3";

/** Shape of a `constraints` row as returned by SQLite. */
export interface ConstraintRow {
  id: number;
  constraint_text: string;
  level: "hard" | "soft";
  source: string;
  confidence: "high" | "medium" | "low";
  flag: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Create the `constraints` and `sync_state` tables and their indexes.
 * Idempotent.
 *
 * `sync_state` is a singleton — `CHECK (id = 1)` enforces at most one row.
 */
export function createConstraintsSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS constraints (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      constraint_text TEXT NOT NULL,
      level           TEXT NOT NULL CHECK (level IN ('hard', 'soft')),
      source          TEXT NOT NULL,
      confidence      TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      flag            TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      last_synced TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_constraints_confidence ON constraints(confidence);
    CREATE INDEX IF NOT EXISTS idx_constraints_flag       ON constraints(flag);
  `);
}

/**
 * Insert a constraint and return the new row id.
 * Used by Spec 04 (Bootstrap) and Spec 05 (Two-Way Sync). Spec 01 itself
 * does not expose a public `log_constraint` tool.
 */
export function insertConstraint(
  db: DatabaseType,
  constraintText: string,
  level: "hard" | "soft",
  source: string,
  confidence: "high" | "medium" | "low",
  flag: string | null = null
): number {
  const stmt = db.prepare(
    `INSERT INTO constraints (constraint_text, level, source, confidence, flag)
     VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(constraintText, level, source, confidence, flag);
  return Number(result.lastInsertRowid);
}

/**
 * Return all constraints, ordered by confidence (high → medium → low),
 * then most recent first. `list_constraints` tool uses this.
 */
export function listConstraints(db: DatabaseType): ConstraintRow[] {
  // SQLite has no native enum ordering, so use CASE to enforce the
  // high → medium → low priority defined in Spec 01 §3 (`list_constraints`).
  return db
    .prepare(
      `SELECT id, constraint_text, level, source, confidence, flag, created_at, updated_at
       FROM constraints
       ORDER BY
         CASE confidence
           WHEN 'high'   THEN 0
           WHEN 'medium' THEN 1
           WHEN 'low'    THEN 2
           ELSE 3
         END ASC,
         datetime(created_at) DESC,
         id DESC`
    )
    .all() as ConstraintRow[];
}

/**
 * Return a single constraint by id, or undefined if not found.
 * Used by Spec 05's `ingest_constraints_file` for diff detection.
 */
export function getConstraintById(
  db: DatabaseType,
  id: number
): ConstraintRow | undefined {
  return db
    .prepare(
      `SELECT id, constraint_text, level, source, confidence, flag, created_at, updated_at
       FROM constraints WHERE id = ?`
    )
    .get(id) as ConstraintRow | undefined;
}

/**
 * Return all `level='hard'` constraints with the same ordering as
 * `listConstraints()`. Used by Spec 03's Plan Validator
 * (constraint checker, see Spec 03 §3 step 1 and §5 task 2). Soft
 * constraints are intentionally NOT included — the constraint checker
 * is the one that actually blocks, and only `hard` constraints block.
 */
export function listHardConstraints(db: DatabaseType): ConstraintRow[] {
  return db
    .prepare(
      `SELECT id, constraint_text, level, source, confidence, flag, created_at, updated_at
       FROM constraints
       WHERE level = 'hard'
       ORDER BY
         CASE confidence
           WHEN 'high'   THEN 0
           WHEN 'medium' THEN 1
           WHEN 'low'    THEN 2
           ELSE 3
         END ASC,
         datetime(created_at) DESC,
         id DESC`
    )
    .all() as ConstraintRow[];
}

/**
 * Read the `last_synced` timestamp from the `sync_state` singleton, or
 * `null` if Spec 05's `ingest_constraints_file` has not yet run.
 */
export function getLastSyncedAt(db: DatabaseType): string | null {
  const row = db
    .prepare(`SELECT last_synced FROM sync_state WHERE id = 1`)
    .get() as { last_synced: string | null } | undefined;
  return row?.last_synced ?? null;
}

/**
 * Upsert `last_synced` in the `sync_state` singleton. The only caller of
 * this is Spec 05's `ingest_constraints_file` (per fk-reference.md).
 */
export function setLastSyncedAt(db: DatabaseType, ts: string): void {
  db.prepare(
    `INSERT INTO sync_state (id, last_synced) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_synced = excluded.last_synced`
  ).run(ts);
}

/**
 * Update an existing constraint's text, level, confidence, and flag.
 * Used by Spec 05's `ingest_constraints_file` when a `[Cnnn]` entry
 * has changed text/level/confidence from the DB row.
 *
 * `flag` may be explicitly set to `null` to clear it (human resolved a flag).
 */
export function updateConstraint(
  db: DatabaseType,
  id: number,
  constraintText: string,
  level: "hard" | "soft",
  confidence: "high" | "medium" | "low",
  flag: string | null
): void {
  db.prepare(
    `UPDATE constraints
     SET constraint_text = ?, level = ?, confidence = ?, flag = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(constraintText, level, confidence, flag, id);
}

/**
 * Delete a constraint by id. Used by Spec 05's `ingest_constraints_file`
 * when a `[Cnnn]` entry is absent from the file (deleted by human).
 */
export function deleteConstraint(db: DatabaseType, id: number): void {
  db.prepare(`DELETE FROM constraints WHERE id = ?`).run(id);
}

/**
 * Set the `flag` column on a constraint. Used by Spec 05's
 * `flag_stale_constraints` and by `ingest_constraints_file` (to clear it).
 * If `flag` is already non-null, it is NOT overwritten (per EC-TS-08).
 */
export function setConstraintFlag(
  db: DatabaseType,
  id: number,
  flag: string
): boolean {
  const existing = db
    .prepare(`SELECT flag FROM constraints WHERE id = ?`)
    .get(id) as { flag: string | null } | undefined;
  if (!existing) return false;
  if (existing.flag !== null) return false; // already flagged, preserve
  db.prepare(
    `UPDATE constraints SET flag = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(flag, id);
  return true;
}

/**
 * Return all constraints where `flag IS NOT NULL`, in the same ordering
 * as `listConstraints()`. Used by Spec 05's `list_flagged_constraints`.
 */
export function listFlaggedConstraints(db: DatabaseType): ConstraintRow[] {
  return db
    .prepare(
      `SELECT id, constraint_text, level, source, confidence, flag, created_at, updated_at
       FROM constraints
       WHERE flag IS NOT NULL
       ORDER BY
         CASE confidence
           WHEN 'high'   THEN 0
           WHEN 'medium' THEN 1
           WHEN 'low'    THEN 2
           ELSE 3
         END ASC,
         datetime(created_at) DESC,
         id DESC`
    )
    .all() as ConstraintRow[];
}
