// Tests for storage/health.ts — Spec 06's sessions / session_tool_calls adapter.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeOpenSessions,
  createHealthSchema,
  createSession,
  getOpenSession,
  getToolCallsForSession,
  insertToolCall,
} from "./health.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createHealthSchema(db);
});

describe("createHealthSchema", () => {
  it("creates the sessions and session_tool_calls tables", () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("session_tool_calls");
  });

  it("is idempotent", () => {
    expect(() => createHealthSchema(db)).not.toThrow();
  });
});

describe("createSession / getOpenSession", () => {
  it("returns undefined when no session exists", () => {
    expect(getOpenSession(db)).toBeUndefined();
  });

  it("createSession returns an incrementing id and is open", () => {
    const id1 = createSession(db);
    expect(id1).toBe(1);
    const open = getOpenSession(db);
    expect(open?.id).toBe(id1);
    expect(open?.ended_at).toBeNull();
  });

  it("getOpenSession returns the most recently created open session", () => {
    createSession(db);
    const id2 = createSession(db);
    expect(getOpenSession(db)?.id).toBe(id2);
  });
});

describe("closeOpenSessions", () => {
  it("sets ended_at on open sessions", () => {
    const id = createSession(db);
    closeOpenSessions(db);
    expect(getOpenSession(db)).toBeUndefined();
    const row = db
      .prepare(`SELECT ended_at FROM sessions WHERE id = ?`)
      .get(id) as { ended_at: string | null };
    expect(row.ended_at).not.toBeNull();
  });

  it("is a no-op when no session is open", () => {
    expect(() => closeOpenSessions(db)).not.toThrow();
  });
});

describe("insertToolCall / getToolCallsForSession", () => {
  it("records tool calls in chronological order", () => {
    const id = createSession(db);
    insertToolCall(db, id, "get_context");
    insertToolCall(db, id, "validate_plan");
    insertToolCall(db, id, "log_decision");
    expect(getToolCallsForSession(db, id)).toEqual([
      "get_context",
      "validate_plan",
      "log_decision",
    ]);
  });

  it("returns an empty array for a session with no calls", () => {
    const id = createSession(db);
    expect(getToolCallsForSession(db, id)).toEqual([]);
  });

  it("only returns calls for the given session", () => {
    const id1 = createSession(db);
    insertToolCall(db, id1, "get_context");
    closeOpenSessions(db);
    const id2 = createSession(db);
    insertToolCall(db, id2, "validate_plan");
    expect(getToolCallsForSession(db, id1)).toEqual(["get_context"]);
    expect(getToolCallsForSession(db, id2)).toEqual(["validate_plan"]);
  });
});
