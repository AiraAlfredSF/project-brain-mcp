// Bootstrap tools — Spec 04.
//
// Four MCP tools:
//   - get_bootstrap_status   — read-only state report
//   - run_bootstrap          — multi-turn orchestration (returns one
//                              next_module per call; on the final covering
//                              call writes constraints.md and returns complete)
//   - log_module_intent      — writes to module_intents + to Spec 01's
//                              constraints (with source='bootstrap')
//   - write_constraints_draft — regenerates constraints.md from Spec 01's
//                              constraints table, in Spec 05's file format
//
// This module owns the module_intents table. It does not own any
// cross-module tables; reads/writes against Spec 01's constraints
// go through Spec 01's storage adapter (storage/constraints.ts).
// Reads against Spec 02's graph_nodes happen only through this module's
// own getNextUncoveredModule() / getModuleIntentCoverage() helpers
// (which query graph_nodes directly but return only a small subset of
// the row — no leakage of graph internals into this module's caller).

import { writeFileSync } from "node:fs";
import { resolve as resolveFs } from "node:path";
import process from "node:process";

import type { Database as DatabaseType } from "better-sqlite3";

import { insertConstraint, listConstraints, type ConstraintRow } from "../storage/constraints.js";
import {
  getModuleIntentCoverage,
  getNextUncoveredModule,
  insertModuleIntent,
} from "../storage/bootstrap.js";
import { indexCodebaseTool } from "./graph.js";

import {
  BOOTSTRAP_ALREADY_COMPLETE_HEADER,
  BOOTSTRAP_COMPLETE_HEADER,
  BOOTSTRAP_DRAFT_LINE,
  BOOTSTRAP_IN_PROGRESS_HEADER,
  CONSTRAINTS_DRAFT_OK_HEADER,
  formatBootstrapModulesProcessed,
  formatBootstrapProgress,
  formatBootstrapStatus,
  formatBootstrapStatusStats,
  formatConstraintsDraftBootstrap,
  formatConstraintsDraftManual,
  formatConstraintsDraftRows,
  formatConstraintsWritten,
  formatErr,
  formatModuleIntentOk,
  formatNextModule,
} from "../format/dsl.js";


// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * get_bootstrap_status — read-only, always returns one of three states.
 * Per Spec 04 §3:
 *   - `never_run`:   `graph_nodes` empty AND `module_intents` empty
 *   - `incomplete`:  `graph_nodes` has rows, fewer than `total` covered
 *   - `complete`:    every non-deprecated `graph_nodes` row is covered
 */
export function getBootstrapStatus(db: DatabaseType): string {
  const { covered, total } = getModuleIntentCoverage(db);
  if (total === 0) {
    return formatBootstrapStatus("never_run");
  }
  if (covered >= total) {
    const lines = [
      formatBootstrapStatus("complete"),
      ...formatBootstrapStatusStats(total, covered),
    ];
    return lines.join("\n");
  }
  const lines = [
    formatBootstrapStatus("incomplete"),
    ...formatBootstrapStatusStats(total, covered),
  ];
  return lines.join("\n");
}

/**
 * run_bootstrap — multi-turn orchestration per Spec 04 §3.
 *
 * Algorithm:
 *   1. Call `index_codebase(path, incremental=true)` (Spec 02).
 *      Any error from there (e.g. `path not found`) propagates verbatim.
 *   2. Compute `uncovered` (next non-deprecated `graph_nodes` row with
 *      no `module_intents` row, by `graph_nodes.id` ASC).
 *   3. If `uncovered` is non-empty: return `BOOTSTRAP: in_progress` with
 *      `next_module=<module>` and `progress=<covered>/<total>`.
 *   4. If `uncovered` is empty (this call closed the last gap, or the
 *      repo has zero non-deprecated modules): call
 *      `write_constraints_draft()` and return `BOOTSTRAP: complete` with
 *      `modules_processed`, `constraints_written`, and the `draft:` line.
 *
 * EC-BA-01 note: the `already_complete` short-circuit fires ONLY when the
 * status is already `complete` BEFORE this call's `index_codebase` completes
 * AND there are no uncovered modules even after re-indexing — i.e. a
 * subsequent call after a PRIOR call already returned `BOOTSTRAP: complete`.
 * On the FIRST call that transitions to complete (EC-BA-08), the status
 * is `incomplete` when we enter, `index_codebase` runs (finds nothing new),
 * and `uncovered` is null → we fall through to the `complete` branch.
 *
 * The `already_complete` branch is only reached when there is nothing
 * left to do even before we re-index.
 */

export function runBootstrap(
  db: DatabaseType,
  rawInput: unknown
): string {
  // Input validation.
  let path: string | undefined;
  if (rawInput !== undefined && rawInput !== null) {
    if (!isRecord(rawInput)) {
      return formatErr("path must be a string");
    }
    if (rawInput.path !== undefined && typeof rawInput.path !== "string") {
      return formatErr("path must be a string");
    }
    path = rawInput.path;
  }

  // Run index_codebase (incremental) first. This may add new graph_nodes rows.
  const idxResult = indexCodebaseTool(
    db,
    path === undefined ? {} : { path, incremental: true }
  );
  if (idxResult.startsWith("ERR ")) {
    return idxResult;
  }

  // Compute coverage AFTER re-indexing.
  const { covered, total } = getModuleIntentCoverage(db);
  const next = getNextUncoveredModule(db);

  if (next !== null) {
    // There are still uncovered modules.
    const lines = [
      BOOTSTRAP_IN_PROGRESS_HEADER,
      formatNextModule(next.module),
      formatBootstrapProgress(covered, total),
    ];
    return lines.join("\n");
  }

  // All covered (or empty repo). Write constraints.md and return complete.
  writeConstraintsDraft(db);
  const counts = countConstraintsBySource(db);
  const lines = [
    BOOTSTRAP_COMPLETE_HEADER,
    formatBootstrapModulesProcessed(total),
    formatConstraintsWritten(counts.total),
    BOOTSTRAP_DRAFT_LINE,
  ];
  return lines.join("\n");
}
export function logModuleIntent(
  db: DatabaseType,
  rawInput: unknown
): string {
  if (!isRecord(rawInput)) {
    return formatErr("module and intent are required");
  }
  const { module, intent, constraints, caveats } = rawInput;

  if (typeof module !== "string" || module.trim().length === 0) {
    return formatErr("module and intent are required");
  }
  if (typeof intent !== "string" || intent.trim().length === 0) {
    return formatErr("module and intent are required");
  }
  if (!Array.isArray(constraints)) {
    return formatErr("constraints and caveats must be arrays");
  }
  if (!Array.isArray(caveats)) {
    return formatErr("constraints and caveats must be arrays");
  }
  // Each element must be a string (storage/constraints.ts requires
  // this; we don't need to validate further).
  for (const c of constraints) {
    if (typeof c !== "string") {
      return formatErr("constraints and caveats must be arrays");
    }
  }
  for (const c of caveats) {
    if (typeof c !== "string") {
      return formatErr("constraints and caveats must be arrays");
    }
  }

  // Insert the module_intents row first.
  const id = insertModuleIntent(
    db,
    module.trim(),
    intent.trim(),
    constraints as string[],
    caveats as string[]
  );

  // Then write each constraint to Spec 01's constraints table.
  let constraintsWritten = 0;
  for (const c of constraints as string[]) {
    if (c.trim().length === 0) continue; // skip empty entries
    insertConstraint(db, c, "soft", "bootstrap", "medium", null);
    constraintsWritten += 1;
  }

  const lines = [
    formatModuleIntentOk(id),
    formatConstraintsWritten(constraintsWritten),
  ];
  return lines.join("\n");
}

/**
 * write_constraints_draft — read all of Spec 01's `constraints` table,
 * group by `level` (for sections per Spec 05's file format), render
 * `constraints.md` at `process.cwd()`, and return an `OK constraints.md`
 * confirmation with row counts.
 *
 * File format conforms to Spec 05 §"constraints.md file format":
 *   - YAML frontmatter (version, last_updated, last_synced)
 *   - Sections: Architectural Boundaries (hard), Technology Constraints (soft),
 *     ⚠ Flagged for Review
 *   - Each line: `[Cnnn] (level, source, confidence) <text>` (flagged
 *     section adds a `— flagged: <reason>` suffix)
 *
 * `targetPath` is exposed for testability — the production path is
 * `process.cwd()/constraints.md`. Tests pass a per-test tmp path to
 * avoid polluting the source tree (and to allow parallel test runs).
 */
export function writeConstraintsDraft(
  db: DatabaseType,
  targetPath?: string
): string {
  const rows = listConstraints(db);
  const content = renderConstraintsMd(rows);
  const finalPath =
    targetPath ?? resolveFs(process.cwd(), "constraints.md");
  writeFileSync(finalPath, content, "utf8");

  const counts = countBySource(rows);
  const lines = [
    CONSTRAINTS_DRAFT_OK_HEADER,
    formatConstraintsDraftRows(rows.length),
    formatConstraintsDraftBootstrap(counts.bootstrap),
    formatConstraintsDraftManual(counts.manual),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Count bootstrap-source vs. all-other-source constraint rows.
 * Per EC-BA-05, "manual" in the response means "everything not bootstrap"
 * (the response doesn't separately count `sync` rows — those roll into
 * `manual`).
 */
function countConstraintsBySource(db: DatabaseType): { total: number; bootstrap: number; manual: number } {
  const rows = listConstraints(db);
  return countBySource(rows);
}

function countBySource(rows: ConstraintRow[]): { total: number; bootstrap: number; manual: number } {
  let bootstrap = 0;
  for (const r of rows) {
    if (r.source === "bootstrap") bootstrap += 1;
  }
  return { total: rows.length, bootstrap, manual: rows.length - bootstrap };
}

/**
 * Render `constraints.md` per Spec 05's file format. See that spec for
 * the canonical definition; we conform but do not own the definition.
 *
 * Section assignment (per Spec 05):
 *   - `level='hard'`  → "Architectural Boundaries"
 *   - `level='soft'`  → "Technology Constraints"
 *   - `flag IS NOT NULL` → also listed under "⚠ Flagged for Review" (in
 *     addition to its primary section)
 */
function renderConstraintsMd(rows: ConstraintRow[]): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const lastSynced = rows[0]?.updated_at ?? now;
  const lines: string[] = [
    "---",
    "version: 3",
    `last_updated: ${now}`,
    `last_synced: ${lastSynced}`,
    "---",
    "",
    "# Constraints",
    "",
    "## Architectural Boundaries",
    "",
  ];
  // Hard constraints → Architectural Boundaries.
  const hard = rows.filter((r) => r.level === "hard");
  if (hard.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const r of hard) lines.push(formatConstraintLine(r));
  }
  lines.push("", "## Technology Constraints", "");
  const soft = rows.filter((r) => r.level === "soft");
  if (soft.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const r of soft) lines.push(formatConstraintLine(r));
  }
  // Flagged section.
  const flagged = rows.filter((r) => r.flag !== null && r.flag !== undefined);
  lines.push("", "## ⚠ Flagged for Review", "");
  if (flagged.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const r of flagged) {
      const base = formatConstraintLine(r);
      lines.push(`${base} — flagged: ${r.flag}`);
    }
  }
  // Trailing newline.
  return lines.join("\n") + "\n";
}

function formatConstraintLine(r: ConstraintRow): string {
  // Line shape per Spec 05:
  //   - [C001] (hard, manual, high) Payments module is a black box — API only
  const paddedId = String(r.id).padStart(3, "0");
  const confidence = r.confidence;
  return `- [C${paddedId}] (${r.level}, ${r.source}, ${confidence}) ${r.constraint_text}`;
}
