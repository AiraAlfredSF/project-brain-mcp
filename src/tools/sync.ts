// Spec 05 — Two-Way Sync: 5 MCP tool handlers.
//
// All reads/writes to `constraints` go through storage/constraints.ts.
// No direct SQLite table access here. `flag_stale_constraints` reads
// graph data via Spec 02's diffGraph function.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolveFs } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { getConstraintById, listConstraints } from "../storage/constraints.js";
import {
  deleteConstraint,
  getLastSyncedAt,
  insertConstraint,
  listFlaggedConstraints,
  setConstraintFlag,
  setLastSyncedAt,
  updateConstraint,
} from "../storage/constraints.js";

import { diffGraph } from "./graph.js";

import {
  formatConstraintRow,
  markSchemaSent,
  takeSchemaHeaderIfNeeded,
} from "../format/dsl.js";
import {
  formatSyncAdded,
  formatSyncChecked,
  formatSyncNewlyFlagged,
  formatSyncReason,
  formatSyncRemoved,
  formatSyncRows,
  formatSyncUpdated,
  formatSyncVersion,
  parseConstraintsMd,
  serializeConstraintsMd,
  SYNC_DRIFT,
  SYNC_EXPORTED,
  SYNC_FLAGGED,
  SYNC_INGESTED,
  SYNC_MISSING,
  SYNC_SYNCED,
} from "../format/sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONSTRAINTS_MD = "constraints.md";

function mdPath(): string {
  return resolveFs(process.cwd(), CONSTRAINTS_MD);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// Read current frontmatter version from constraints.md without full parsing.
// Returns 0 if the file doesn't exist (first-ever export).
function readCurrentVersion(): number {
  const path = mdPath();
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^version:\s*(\d+)/m);
  return m ? parseInt(m[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
// export_constraints_file
// ---------------------------------------------------------------------------

export function exportConstraintsFile(db: DatabaseType): string {
  const rows = listConstraints(db);
  const prevVersion = readCurrentVersion();
  const prevLastSynced = getLastSyncedAt(db);
  const content = serializeConstraintsMd(rows, prevVersion, prevLastSynced);
  writeFileSync(mdPath(), content, "utf8");
  const lines = [
    SYNC_EXPORTED,
    formatSyncRows(rows.length),
    formatSyncVersion(prevVersion + 1),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ingest_constraints_file
// ---------------------------------------------------------------------------

export function ingestConstraintsFile(db: DatabaseType): string {
  const path = mdPath();
  if (!existsSync(path)) {
    return `ERR ${CONSTRAINTS_MD} not found — run write_constraints_draft (Spec 04) or export_constraints_file first`;
  }

  let parsed: ReturnType<typeof parseConstraintsMd>;
  try {
    parsed = parseConstraintsMd(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      return `ERR ${CONSTRAINTS_MD} not found — run write_constraints_draft (Spec 04) or export_constraints_file first`;
    }
    if (msg.includes("malformed")) {
      return "ERR malformed constraints.md frontmatter";
    }
    return `ERR ${msg}`;
  }

  const { entries } = parsed;

  // Build set of ids present in the file.
  const fileIds = new Set<number>();
  for (const e of entries) {
    if (e.id !== null) fileIds.add(e.id);
  }

  // Map: id → current DB row (for diff detection).
  const existingRows = new Map<number, ReturnType<typeof getConstraintById>>();
  for (const id of fileIds) {
    const row = getConstraintById(db, id);
    existingRows.set(id, row);
  }

  // First pass: validate all [Cnnn] entries exist in DB (unless null = new).
  // EC-TS-06: flagged-section entries without [Cnnn] already thrown from parser.
  for (const e of entries) {
    if (e.id !== null && existingRows.get(e.id) === undefined) {
      return `ERR unknown constraint id: C${String(e.id).padStart(3, "0")}`;
    }
  }

  // Second pass: detect removed ids (in DB but not in file).
  const allDbIds = new Set<number>(
    listConstraints(db).map((r) => r.id)
  );
  const removed = [...allDbIds].filter((id) => !fileIds.has(id));

  let added = 0;
  let updated = 0;

  // Third pass: process each entry.
  for (const e of entries) {
    if (e.id === null) {
      // New unbracketed entry
      insertConstraint(db, e.text, e.level, "manual", "high", null);
      added++;
    } else {
      const dbRow = existingRows.get(e.id)!;
      // EC-TS-03: unchanged → skip
      const unchanged =
        dbRow!.constraint_text === e.text &&
        dbRow!.level === e.level &&
        dbRow!.confidence === e.confidence &&
        dbRow!.flag === (e.flag ?? null);
      if (unchanged) continue;

      // Update: if the entry is no longer in the flagged section,
      // clear the flag (human resolved it).
      const newFlag = e.flag ?? null;
      updateConstraint(db, e.id, e.text, e.level, e.confidence, newFlag);
      updated++;
    }
  }

  // Fourth pass: delete removed ids.
  for (const id of removed) {
    deleteConstraint(db, id);
  }

  // EC-TS-04: set last_synced to now.
  setLastSyncedAt(db, nowIso());

  const lines = [
    SYNC_INGESTED,
    formatSyncAdded(added),
    formatSyncUpdated(updated),
    formatSyncRemoved(removed.length),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_sync_status
// ---------------------------------------------------------------------------

export function getSyncStatus(db: DatabaseType): string {
  const path = mdPath();
  if (!existsSync(path)) {
    return SYNC_MISSING;
  }

  let parsed: ReturnType<typeof parseConstraintsMd>;
  try {
    parsed = parseConstraintsMd(path);
  } catch {
    return `${SYNC_DRIFT}\n${formatSyncReason("malformed frontmatter")}`;
  }

  const { frontmatter, entries } = parsed;
  const lastUpdatedDate = new Date(frontmatter.last_updated).getTime();
  const rows = listConstraints(db);

  // Check if any constraint row was created/updated after the last export.
  const changed = rows.filter((row) => {
    const rowUpdatedAt = new Date(row.updated_at).getTime();
    const rowCreatedAt = new Date(row.created_at).getTime();
    return rowUpdatedAt > lastUpdatedDate || rowCreatedAt > lastUpdatedDate;
  });
  if (changed.length > 0) {
    return `${SYNC_DRIFT}\n${formatSyncReason(`${changed.length} row(s) changed since last export`)}`;
  }

  // Check if the file content has been manually edited since last export
  // (i.e. it no longer matches the DB rows).
  const dbById = new Map(rows.map((r) => [r.id, r]));
  const fileIds = new Set<number>();
  let contentDiffers = false;
  for (const e of entries) {
    if (e.id === null) {
      contentDiffers = true;
      break;
    }
    fileIds.add(e.id);
    const dbRow = dbById.get(e.id);
    if (
      !dbRow ||
      dbRow.constraint_text !== e.text ||
      dbRow.level !== e.level ||
      dbRow.confidence !== e.confidence ||
      (dbRow.flag ?? null) !== (e.flag ?? null)
    ) {
      contentDiffers = true;
      break;
    }
  }
  if (!contentDiffers && fileIds.size !== rows.length) {
    contentDiffers = true;
  }

  if (contentDiffers) {
    return `${SYNC_DRIFT}\n${formatSyncReason("file edited but not yet ingested")}`;
  }

  return SYNC_SYNCED;
}

// ---------------------------------------------------------------------------
// list_flagged_constraints
// ---------------------------------------------------------------------------

export function listFlaggedConstraintsTool(db: DatabaseType): string {
  const rows = listFlaggedConstraints(db);
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
// flag_stale_constraints
// ---------------------------------------------------------------------------

/**
 * Parse a `diff_graph` DSL line as emitted by `formatDiffLine`:
 * `+[src/a.ts]>[src/b.ts]` / `-[src/a.ts]>[src/b.ts]` (regular edges) or
 * `+!src/a.ts>src/b.ts` / `-!src/a.ts>src/b.ts` (side-effect edges, no
 * brackets around `from`/`to`).
 * Returns `{ sign: '+'|'-', from: string, to: string }` or null.
 */
function parseDiffLine(line: string): {
  sign: "+" | "-";
  from: string;
  to: string;
} | null {
  const m = line.match(/^([+-])!?\[?([^\]>]+)\]?>\[?([^\]]+)\]?$/);
  if (!m) return null;
  return { sign: m[1] as "+" | "-", from: m[2]!, to: m[3]! };
}

/**
 * Extract module path strings from a constraint's `constraint_text`.
 * Matches backtick-quoted paths: `src/a.ts`, `infra/stripe.ts`, etc.
 * Also extracts any bare path-like tokens (with / separators).
 */
function extractModuleNames(text: string): string[] {
  // Match backtick-quoted paths
  const quoted = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  // Match path-like segments (word characters and /): e.g. src/a.ts, infra/stripe
  const bare = [...text.matchAll(/\b([\w./-]+\/[\w./-]+)\b/g)].map(
    (m) => m[1]!
  );
  return [...new Set([...quoted, ...bare])];
}

/**
 * Determine whether an edge change contradicts a hard constraint.
 *
 * EC-TS-05 logic:
 *   - "must not" / "black box" constraint → check `+` lines (forbidden edge added)
 *   - "must depend on" / "requires" constraint → check `-` lines (required edge removed)
 *
 * Both checks use exact substring match against the modules in the constraint text.
 */
function edgeContradictsConstraint(
  constraintText: string,
  sign: "+" | "-",
  from: string,
  to: string
): boolean {
  const lower = constraintText.toLowerCase();
  const forbidsPositive =
    lower.includes("must not") ||
    lower.includes("no direct") ||
    lower.includes("black box") ||
    lower.includes("api only");
  const requiresNegative =
    lower.includes("must depend") ||
    lower.includes("must import") ||
    lower.includes("requires");

  const modules = extractModuleNames(constraintText);
  const involvesFrom = modules.some((m) => from.includes(m) || m.includes(from));
  const involvesTo = modules.some((m) => to.includes(m) || m.includes(to));

  if (!involvesFrom && !involvesTo) return false;

  if (sign === "+" && forbidsPositive) return true;
  if (sign === "-" && requiresNegative) return true;

  return false;
}

export function flagStaleConstraints(
  db: DatabaseType,
  rawInput: unknown
): string {
  // Validate input
  let commit: string;
  if (
    rawInput === null ||
    rawInput === undefined ||
    typeof rawInput !== "object"
  ) {
    return "ERR commit must be a string";
  }
  const obj = rawInput as Record<string, unknown>;
  if (typeof obj.commit !== "string" || obj.commit.trim() === "") {
    return "ERR commit must be a string";
  }
  commit = obj.commit.trim();

  // Call diff_graph (Spec 02) to get structural edge changes.
  const diffResult = diffGraph(db, { since_commit: commit });

  // Propagate ERR from diff_graph.
  if (diffResult.startsWith("ERR ")) {
    return diffResult;
  }

  // Parse `+` and `-` lines from diff_graph output.
  const diffLines = diffResult.split("\n");
  const changedEdges: { sign: "+" | "-"; from: string; to: string }[] = [];
  for (const line of diffLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
      const parsed = parseDiffLine(trimmed);
      if (parsed) changedEdges.push(parsed);
    }
  }

  // Find all hard constraints.
  const hardConstraints = listConstraints(db).filter((r) => r.level === "hard");

  let newlyFlagged = 0;
  let checked = 0;

  for (const constraint of hardConstraints) {
    if (constraint.flag !== null) {
      // Already flagged — skip (EC-TS-08), but still count as checked.
      checked++;
      continue;
    }

    checked++;

    for (const edge of changedEdges) {
      if (
        edgeContradictsConstraint(
          constraint.constraint_text,
          edge.sign,
          edge.from,
          edge.to
        )
      ) {
        const reason = `edge ${edge.sign === "+" ? "added" : "removed"} [${edge.sign}${edge.from}]>[${edge.to}] contradicts this constraint`;
        const didSet = setConstraintFlag(db, constraint.id, reason);
        if (didSet) newlyFlagged++;
        break; // One flag per constraint
      }
    }
  }

  const lines = [
    SYNC_FLAGGED,
    formatSyncChecked(checked),
    formatSyncNewlyFlagged(newlyFlagged),
  ];
  return lines.join("\n");
}
