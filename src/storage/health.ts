// SQLite adapter — sessions + session_tool_calls tables. Spec 06.
//
// Owns:   `sessions`, `session_tool_calls` tables and the indexes defined in
//         specs/details/approved/Spec_06_Session_Health_Monitor.md §2.

import type { Database as DatabaseType } from "better-sqlite3";

/** Shape of a `sessions` row as returned by SQLite. */
export interface SessionRow {
  id: number;
  started_at: string;
  ended_at: string | null;
}

/**
 * Create the `sessions` and `session_tool_calls` tables and their indexes.
 * Idempotent — uses `IF NOT EXISTS` everywhere.
 */
export function createHealthSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS session_tool_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      tool_name  TEXT NOT NULL,
      called_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_tool_calls_session_id ON session_tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_tool_calls_tool_name ON session_tool_calls(tool_name);
  `);
}

/**
 * Set `ended_at = now` on any `sessions` row that is still open
 * (`ended_at IS NULL`). Used by `start_session()` per EC-SH-04.
 */
export function closeOpenSessions(db: DatabaseType): void {
  db.prepare(
    `UPDATE sessions SET ended_at = datetime('now') WHERE ended_at IS NULL`
  ).run();
}

/** Insert a new `sessions` row (`ended_at = NULL`) and return its id. */
export function createSession(db: DatabaseType): number {
  const result = db.prepare(`INSERT INTO sessions DEFAULT VALUES`).run();
  return Number(result.lastInsertRowid);
}

/**
 * Return the currently open session (`ended_at IS NULL`), or `undefined`
 * if no session is open.
 */
export function getOpenSession(db: DatabaseType): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, started_at, ended_at FROM sessions
       WHERE ended_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get() as SessionRow | undefined;
}

/** Insert one row into `session_tool_calls` for `sessionId`. */
export function insertToolCall(
  db: DatabaseType,
  sessionId: number,
  toolName: string
): void {
  db.prepare(
    `INSERT INTO session_tool_calls (session_id, tool_name) VALUES (?, ?)`
  ).run(sessionId, toolName);
}

/**
 * Return the `tool_name` values recorded for `sessionId`, in chronological
 * (insertion) order.
 */
export function getToolCallsForSession(
  db: DatabaseType,
  sessionId: number
): string[] {
  const rows = db
    .prepare(
      `SELECT tool_name FROM session_tool_calls
       WHERE session_id = ?
       ORDER BY id ASC`
    )
    .all(sessionId) as { tool_name: string }[];
  return rows.map((r) => r.tool_name);
}
