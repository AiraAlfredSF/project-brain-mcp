// start_session, record_tool_call, get_session_health — Spec 06.
//
// All reads/writes to `sessions` / `session_tool_calls` go through
// storage/health.ts. No direct SQLite table access here.

import type { Database as DatabaseType } from "better-sqlite3";

import {
  closeOpenSessions,
  createSession,
  getOpenSession,
  getToolCallsForSession,
  insertToolCall,
} from "../storage/health.js";

import {
  formatErr,
  formatSessionAction,
  formatSessionCalls,
  formatSessionId,
  formatSessionMissing,
  formatSessionState,
  markSchemaSent,
  OK_TC,
  SESSION_STARTED_HEADER,
  takeSchemaHeaderIfNeeded,
} from "../format/dsl.js";

// ---------------------------------------------------------------------------
// Shared helper — used both by the exported tools below and by the
// server's tool-dispatch layer (src/index.ts) to record every tool call.
// ---------------------------------------------------------------------------

/**
 * Record one `session_tool_calls` row against the current open session,
 * implicitly opening a new session first if none is open (EC-SH-02).
 */
export function trackToolCall(db: DatabaseType, toolName: string): void {
  const session = getOpenSession(db) ?? { id: createSession(db) };
  insertToolCall(db, session.id, toolName);
}

// ---------------------------------------------------------------------------
// start_session
// ---------------------------------------------------------------------------

/**
 * start_session() — no parameters.
 *
 * Closes any previously-open session, opens a new one, and emits the
 * one-time `BRAIN DSL v1` header if it hasn't been sent yet this process
 * (EC-DM-08 / Spec 06 §3).
 */
export function startSession(db: DatabaseType): string {
  closeOpenSessions(db);
  const sessionId = createSession(db);

  const lines: string[] = [];

  const header = takeSchemaHeaderIfNeeded();
  if (header !== null) {
    lines.push(header);
    markSchemaSent();
  }

  lines.push(SESSION_STARTED_HEADER);
  lines.push(formatSessionId(sessionId));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// record_tool_call
// ---------------------------------------------------------------------------

/**
 * record_tool_call(tool_name) — records one tool invocation against the
 * current open session (opening one implicitly if needed, EC-SH-02).
 */
export function recordToolCallTool(db: DatabaseType, rawInput: unknown): string {
  if (rawInput === null || rawInput === undefined || typeof rawInput !== "object") {
    return formatErr("tool_name is required");
  }
  const obj = rawInput as Record<string, unknown>;
  if (typeof obj.tool_name !== "string" || obj.tool_name.trim() === "") {
    return formatErr("tool_name is required");
  }
  const toolName = obj.tool_name.trim();

  trackToolCall(db, toolName);

  const lines: string[] = [];

  const header = takeSchemaHeaderIfNeeded();
  if (header !== null) {
    lines.push(header);
    markSchemaSent();
  }

  lines.push(OK_TC);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_session_health
// ---------------------------------------------------------------------------

/**
 * get_session_health() — no parameters.
 *
 * Evaluates the current open session's `session_tool_calls` (opening one
 * implicitly if needed, EC-SH-02/05) against the §3 compliance checklist:
 *
 *   1. Context check: `get_context` appears before the first
 *      `log_decision`/`validate_plan` call (or anywhere, if neither has
 *      occurred yet). Failing this → `violations`.
 *   2. Plan validation: if any `log_decision` call has occurred, at least
 *      one `validate_plan` call exists earlier than the FIRST such call
 *      (per EC-SH-06, a single `validate_plan` covers subsequent
 *      `log_decision` calls). Failing this (check 1 passing) → `warnings`.
 *
 * Both passing → `compliant`.
 */
export function getSessionHealth(db: DatabaseType): string {
  const session = getOpenSession(db) ?? { id: createSession(db) };
  const calls = getToolCallsForSession(db, session.id);

  const lines: string[] = [];

  const header = takeSchemaHeaderIfNeeded();
  if (header !== null) {
    lines.push(header);
    markSchemaSent();
  }

  const firstCriticalIdx = calls.findIndex(
    (c) => c === "log_decision" || c === "validate_plan"
  );
  const getContextIdx = calls.indexOf("get_context");
  const check1 =
    firstCriticalIdx === -1
      ? getContextIdx !== -1
      : getContextIdx !== -1 && getContextIdx < firstCriticalIdx;

  let check2 = true;
  const firstLogDecisionIdx = calls.indexOf("log_decision");
  if (firstLogDecisionIdx !== -1) {
    const validatePlanIdx = calls.indexOf("validate_plan");
    check2 = validatePlanIdx !== -1 && validatePlanIdx < firstLogDecisionIdx;
  }

  const state = !check1 ? "violations" : !check2 ? "warnings" : "compliant";

  lines.push(formatSessionState(state));

  if (calls.length > 0) {
    lines.push(formatSessionCalls(calls));
  }

  if (state === "violations") {
    lines.push(formatSessionMissing("get_context at session start"));
    lines.push(
      formatSessionAction("call get_context to load project memory before continuing")
    );
  } else if (state === "warnings") {
    lines.push(formatSessionMissing("validate_plan before log_decision"));
    lines.push(
      formatSessionAction(
        "call validate_plan before logging further architectural decisions"
      )
    );
  }

  return lines.join("\n");
}
