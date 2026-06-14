// SQLite adapter — decisions + failures tables. Spec 01.
//
// Owns:   `decisions`, `failures` tables and the indexes defined in
//         specs/details/approved/Spec_01_Decision_Memory.md §2.
// Cross-module: Spec 03 (Plan Validator) reads `failures` through this
//         adapter; no other module writes to these tables.

import type { Database as DatabaseType } from "better-sqlite3";

/** Shape of a `decisions` row as returned by SQLite (JSON arrays parsed). */
export interface DecisionRow {
  id: number;
  decision: string;
  rationale: string;
  alternatives_rejected: string[];
  tags: string[];
  created_at: string;
}

/** Shape of a `failures` row as returned by SQLite. */
export interface FailureRow {
  id: number;
  description: string;
  cause: string;
  approach_tried: string;
  status: "open" | "resolved";
  created_at: string;
  updated_at: string;
}

/** Discriminated union for merged get_context results. */
export type ContextRow =
  | ({ kind: "D" } & DecisionRow)
  | ({ kind: "F" } & FailureRow);

/**
 * Create the `decisions` and `failures` tables and their indexes.
 * Idempotent — uses `IF NOT EXISTS` everywhere.
 */
export function createDecisionsSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      decision              TEXT NOT NULL,
      rationale             TEXT NOT NULL,
      alternatives_rejected TEXT NOT NULL DEFAULT '[]',
      tags                  TEXT NOT NULL DEFAULT '[]',
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS failures (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      description     TEXT NOT NULL,
      cause           TEXT NOT NULL,
      approach_tried  TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_failures_created_at  ON failures(created_at);
    CREATE INDEX IF NOT EXISTS idx_failures_status      ON failures(status);
  `);
}

/**
 * Insert a decision and return the new row id. Arrays are JSON-serialized
 * at the adapter boundary per the absolute-rules-reference.md (DB Type Rules).
 */
export function insertDecision(
  db: DatabaseType,
  decision: string,
  rationale: string,
  alternativesRejected: string[],
  tags: string[]
): number {
  const stmt = db.prepare(
    `INSERT INTO decisions (decision, rationale, alternatives_rejected, tags)
     VALUES (?, ?, ?, ?)`
  );
  const result = stmt.run(
    decision,
    rationale,
    JSON.stringify(alternativesRejected),
    JSON.stringify(tags)
  );
  return Number(result.lastInsertRowid);
}

/**
 * Insert a failure with `status='open'` (default) and return the new row id.
 */
export function insertFailure(
  db: DatabaseType,
  description: string,
  cause: string,
  approachTried: string
): number {
  const stmt = db.prepare(
    `INSERT INTO failures (description, cause, approach_tried)
     VALUES (?, ?, ?)`
  );
  const result = stmt.run(description, cause, approachTried);
  return Number(result.lastInsertRowid);
}

/**
 * Return all `status='open'` failures ordered by `created_at` DESC
 * (then id DESC to break ties). Used by Spec 03's Plan Validator
 * (failure pattern matcher, see Spec 03 §3 step 2 and §5 task 3).
 * Resolved failures are intentionally excluded — the matcher only
 * blocks on patterns that are *still* open problems.
 */
export function listOpenFailures(db: DatabaseType): FailureRow[] {
  return db
    .prepare(
      `SELECT id, description, cause, approach_tried, status, created_at, updated_at
       FROM failures
       WHERE status = 'open'
       ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all() as FailureRow[];
}

/**
 * Fuzzy-search decisions and failures whose text columns contain `topic`
 * (case-insensitive `LIKE '%topic%'`). Results are merged and ordered by
 * `created_at` DESC, then capped at `limit` rows total (not per table).
 */
export function searchDecisionsAndFailures(
  db: DatabaseType,
  topic: string,
  limit: number
): ContextRow[] {
  const like = `%${topic}%`;

  // Pull at most `limit` matching rows from each table, newest first —
  // the merged+sorted result can never need more than `limit` from
  // either side, so this bounds the in-memory merge to 2*limit rows
  // regardless of table size.
  const decisions = db
    .prepare(
      `SELECT id, decision, rationale, alternatives_rejected, tags, created_at
       FROM decisions
       WHERE LOWER(decision) LIKE LOWER(?)
          OR LOWER(rationale) LIKE LOWER(?)
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(like, like, limit) as Array<{
    id: number;
    decision: string;
    rationale: string;
    alternatives_rejected: string;
    tags: string;
    created_at: string;
  }>;

  const failures = db
    .prepare(
      `SELECT id, description, cause, approach_tried, status, created_at, updated_at
       FROM failures
       WHERE LOWER(description) LIKE LOWER(?)
          OR LOWER(cause) LIKE LOWER(?)
          OR LOWER(approach_tried) LIKE LOWER(?)
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(like, like, like, limit) as Array<{
    id: number;
    description: string;
    cause: string;
    approach_tried: string;
    status: "open" | "resolved";
    created_at: string;
    updated_at: string;
  }>;

  // Merge, sort by created_at DESC, then cap at limit.
  const merged: ContextRow[] = [
    ...decisions.map((d) => ({
      kind: "D" as const,
      id: d.id,
      decision: d.decision,
      rationale: d.rationale,
      alternatives_rejected: JSON.parse(d.alternatives_rejected) as string[],
      tags: JSON.parse(d.tags) as string[],
      created_at: d.created_at,
    })),
    ...failures.map((f) => ({
      kind: "F" as const,
      id: f.id,
      description: f.description,
      cause: f.cause,
      approach_tried: f.approach_tried,
      status: f.status,
      created_at: f.created_at,
      updated_at: f.updated_at,
    })),
  ];

  merged.sort((a, b) => {
    // DESC by created_at; tiebreak by id DESC.
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });

  return merged.slice(0, limit);
}
