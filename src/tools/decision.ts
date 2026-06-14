// log_decision, log_failure, get_context, list_constraints — Spec 01.
//
// All four tools are pure read/write/format against the storage layer.
// No raw JSON is ever returned to the agent — all responses go through
// format/dsl.ts (per absolute-rules-reference.md, MCP Contract).

import type { Database as DatabaseType } from "better-sqlite3";

import {
  formatContextRow,
  formatConstraintRow,
  formatErr,
  formatOk,
  markSchemaSent,
  takeSchemaHeaderIfNeeded,
} from "../format/dsl.js";
import { listConstraints } from "../storage/constraints.js";
import {
  insertDecision,
  insertFailure,
  searchDecisionsAndFailures,
} from "../storage/decisions.js";


// ---------------------------------------------------------------------------
// log_decision
// ---------------------------------------------------------------------------

/**
 * log_decision(decision, rationale, alternatives_rejected, tags?)
 *
 * Returns the DSL `OK D <id>` confirmation, or an `ERR ...` line.
 * Per Spec 01 §3, `decision` and `rationale` must be non-empty after trim;
 * `alternatives_rejected` is required and must be an array; `tags` is
 * optional and defaults to `[]`.
 */
export function logDecision(
  db: DatabaseType,
  rawInput: unknown
): string {
  if (!isRecord(rawInput)) {
    return formatErr("decision and rationale are required");
  }

  const { decision, rationale, alternatives_rejected, tags } = rawInput;

  // Inline narrowing — each branch is its own typeof check so TS narrows
  // each binding independently when we trim/call below.
  if (typeof decision !== "string" || decision.trim().length === 0) {
    return formatErr("decision and rationale are required");
  }
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    return formatErr("decision and rationale are required");
  }

  // `alternatives_rejected` is required and must be an array. Per EC-DM-02,
  // an omitted param is treated as missing/invalid.
  if (!Array.isArray(alternatives_rejected)) {
    return formatErr("alternatives_rejected must be an array");
  }
  if (!alternatives_rejected.every((x) => typeof x === "string")) {
    return formatErr("alternatives_rejected must be an array of strings");
  }

  // `tags` is optional. Per EC-DM-03, omitted tags store '[]' and render as
  // empty in the DSL output. If tags is provided but malformed, we treat
  // it as empty rather than rejecting the call.
  let tagList: string[] = [];
  if (Array.isArray(tags) && tags.every((x) => typeof x === "string")) {
    tagList = tags as string[];
  }

  const id = insertDecision(
    db,
    decision.trim(),
    rationale.trim(),
    alternatives_rejected as string[],
    tagList
  );
  return formatOk("D", id);
}

// ---------------------------------------------------------------------------
// log_failure
// ---------------------------------------------------------------------------

/**
 * log_failure(description, cause, approach_tried)
 *
 * Returns `OK F <id>` or an `ERR ...` line. All three params are required
 * and must be non-empty after trim.
 */
export function logFailure(db: DatabaseType, rawInput: unknown): string {
  if (!isRecord(rawInput)) {
    return formatErr("description, cause, and approach_tried are required");
  }

  const { description, cause, approach_tried } = rawInput;

  if (typeof description !== "string" || description.trim().length === 0) {
    return formatErr("description, cause, and approach_tried are required");
  }
  if (typeof cause !== "string" || cause.trim().length === 0) {
    return formatErr("description, cause, and approach_tried are required");
  }
  if (typeof approach_tried !== "string" || approach_tried.trim().length === 0) {
    return formatErr("description, cause, and approach_tried are required");
  }

  const id = insertFailure(
    db,
    description.trim(),
    cause.trim(),
    approach_tried.trim()
  );
  return formatOk("F", id);
}

// ---------------------------------------------------------------------------
// get_context
// ---------------------------------------------------------------------------

/**
 * get_context(topic, limit=5)
 *
 * Fuzzy search across decisions + failures, most recent first, capped at
 * `limit` rows total. Emits the one-time `BRAIN DSL v1` schema block on
 * the first qualifying call of the session (EC-DM-08).
 */
export function getContext(db: DatabaseType, rawInput: unknown): string {
  if (!isRecord(rawInput)) {
    return formatErr("topic is required");
  }

  const { topic, limit } = rawInput;

  if (typeof topic !== "string" || topic.trim().length === 0) {
    return formatErr("topic is required");
  }

  // `limit` is optional (default 5) and must be a positive integer when
  // provided. Accept either a number or a numeric string (some MCP clients
  // pass numbers as strings over the wire).
  let effectiveLimit = 5;
  if (limit !== undefined && limit !== null) {
    const n =
      typeof limit === "number"
        ? limit
        : typeof limit === "string" && /^\d+$/.test(limit)
        ? Number(limit)
        : NaN;
    if (!Number.isInteger(n) || n <= 0) {
      return formatErr("limit must be a positive integer");
    }
    effectiveLimit = n;
  }

  const rows = searchDecisionsAndFailures(db, topic.trim(), effectiveLimit);
  const lines: string[] = [];

  const header = takeSchemaHeaderIfNeeded();
  if (header !== null) {
    lines.push(header);
    markSchemaSent();
  }

  for (const r of rows) {
    lines.push(formatContextRow(r));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// list_constraints
// ---------------------------------------------------------------------------

/**
 * list_constraints() — no parameters.
 *
 * Returns all constraints, ordered by confidence (high → medium → low)
 * then `created_at` DESC. Emits the one-time `BRAIN DSL v1` schema block
 * on the first qualifying call of the session (EC-DM-08).
 */
export function listAllConstraints(db: DatabaseType): string {
  const rows = listConstraints(db);
  const lines: string[] = [];

  const header = takeSchemaHeaderIfNeeded();
  if (header !== null) {
    lines.push(header);
    markSchemaSent();
  }

  for (const r of rows) {
    lines.push(formatConstraintRow(r));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Local input-validation helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
