// Tests for tools/health.ts — Spec 06 Session Health Monitor.
// Covers: start_session, record_tool_call, get_session_health, and the
// EC-SH-01..06 edge cases.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { resetSchemaSentForTesting } from "../format/dsl.js";
import { createConstraintsSchema } from "../storage/constraints.js";
import { createDecisionsSchema } from "../storage/decisions.js";
import { createGraphSchema } from "../storage/graph.js";
import { createHealthSchema, getOpenSession, getToolCallsForSession } from "../storage/health.js";

import { getSessionHealth, recordToolCallTool, startSession, trackToolCall } from "./health.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  createGraphSchema(db);
  createHealthSchema(db);
  resetSchemaSentForTesting();
});

describe("start_session", () => {
  it("first call of the session: BRAIN DSL v1 header + SESSION: started session_id=1", () => {
    const out = startSession(db);
    expect(out).toBe(
      [
        "BRAIN DSL v1",
        "D id|decision|rationale|alts|tags|created_at",
        "F id|description|cause|approach|status|created_at",
        "C id|text|level|source|confidence|flag|created_at",
        "SESSION: started",
        "session_id=1",
      ].join("\n")
    );
  });

  it("second call in the same process: no header, new session_id, prior session closed", () => {
    startSession(db);
    const firstSessionId = getOpenSession(db)!.id;
    const out = startSession(db);
    expect(out).toBe("SESSION: started\nsession_id=2");

    const closed = db
      .prepare(`SELECT ended_at FROM sessions WHERE id = ?`)
      .get(firstSessionId) as { ended_at: string | null };
    expect(closed.ended_at).not.toBeNull();
  });
});

describe("record_tool_call", () => {
  it("ERR: tool_name empty/whitespace-only", () => {
    expect(recordToolCallTool(db, { tool_name: "" })).toBe("ERR tool_name is required");
    expect(recordToolCallTool(db, { tool_name: "   " })).toBe("ERR tool_name is required");
    expect(recordToolCallTool(db, {})).toBe("ERR tool_name is required");
    expect(recordToolCallTool(db, null)).toBe("ERR tool_name is required");
  });

  it("happy path: OK TC, recorded against the open session", () => {
    startSession(db);
    const out = recordToolCallTool(db, { tool_name: "get_context" });
    expect(out).toBe("OK TC");
    const sessionId = getOpenSession(db)!.id;
    expect(getToolCallsForSession(db, sessionId)).toContain("get_context");
  });

  it("EC-SH-02: no open session — implicitly opens one and records OK TC", () => {
    const out = recordToolCallTool(db, { tool_name: "get_context" });
    expect(out.endsWith("OK TC")).toBe(true);
    const session = getOpenSession(db);
    expect(session).toBeDefined();
    expect(getToolCallsForSession(db, session!.id)).toEqual(["get_context"]);
  });
});

describe("get_session_health", () => {
  it("empty/no-result case: SESSION: violations, calls: absent, missing: get_context at session start", () => {
    const out = getSessionHealth(db);
    expect(out.endsWith(
      [
        "SESSION: violations",
        "missing: get_context at session start",
        "action: call get_context to load project memory before continuing",
      ].join("\n")
    )).toBe(true);
  });

  it("EC-SH-05: zero tool calls — calls: line omitted entirely", () => {
    const out = getSessionHealth(db);
    expect(out).not.toContain("calls:");
  });

  it("check 1 passes when get_context has been called", () => {
    startSession(db);
    trackToolCall(db, "get_context");
    const out = getSessionHealth(db);
    expect(out).toBe("SESSION: compliant\ncalls: get_context");
  });

  it("warnings: log_decision without a prior validate_plan", () => {
    startSession(db);
    trackToolCall(db, "get_context");
    trackToolCall(db, "log_decision");
    const out = getSessionHealth(db);
    expect(out).toBe(
      [
        "SESSION: warnings",
        "calls: get_context, log_decision",
        "missing: validate_plan before log_decision",
        "action: call validate_plan before logging further architectural decisions",
      ].join("\n")
    );
  });

  it("compliant: get_context, validate_plan, log_decision", () => {
    startSession(db);
    trackToolCall(db, "get_context");
    trackToolCall(db, "validate_plan");
    trackToolCall(db, "log_decision");
    const out = getSessionHealth(db);
    expect(out).toBe("SESSION: compliant\ncalls: get_context, validate_plan, log_decision");
  });

  it("EC-SH-06: a single validate_plan covers multiple subsequent log_decision calls", () => {
    startSession(db);
    trackToolCall(db, "get_context");
    trackToolCall(db, "validate_plan");
    trackToolCall(db, "log_decision");
    trackToolCall(db, "log_decision");
    const out = getSessionHealth(db);
    expect(out.split("\n")[0]).toBe("SESSION: compliant");
  });

  it("violations takes priority when both checks fail", () => {
    startSession(db);
    trackToolCall(db, "log_decision");
    const out = getSessionHealth(db);
    expect(out.split("\n")[0]).toBe("SESSION: violations");
  });

  it("EC-SH-04: only the currently-open session's calls are evaluated", () => {
    startSession(db);
    trackToolCall(db, "get_context");
    trackToolCall(db, "log_decision");
    // Start a new session — the prior session's calls (including the
    // unmatched log_decision) should no longer count.
    startSession(db);
    const out = getSessionHealth(db);
    expect(out.split("\n")[0]).toBe("SESSION: violations");
    expect(out).not.toContain("calls:");
  });
});

describe("trackToolCall (dispatch-layer side effect)", () => {
  it("EC-SH-02: opens a session implicitly if none is open", () => {
    expect(getOpenSession(db)).toBeUndefined();
    trackToolCall(db, "index_codebase");
    const session = getOpenSession(db);
    expect(session).toBeDefined();
    expect(getToolCallsForSession(db, session!.id)).toEqual(["index_codebase"]);
  });

  it("EC-SH-01: record_tool_call for start_session targets the newly opened session", () => {
    startSession(db); // opens session 1
    const sessionId = getOpenSession(db)!.id;
    trackToolCall(db, "start_session");
    expect(getToolCallsForSession(db, sessionId)).toEqual(["start_session"]);
  });
});
