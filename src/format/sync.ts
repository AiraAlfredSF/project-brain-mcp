// constraints.md parser and serializer — Spec 05 §3.
//
// Owns the `constraints.md` file format entirely. No SQLite table writes
// happen here — parsing produces an intermediate representation that callers
// (tools/sync.ts) commit to Spec 01's `constraints` table.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolveFs } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed frontmatter from constraints.md.
 * `version` is a monotonically incrementing integer.
 * `last_updated` and `last_synced` are ISO-8601 strings.
 */
export interface ConstraintsMdFrontmatter {
  version: number;
  last_updated: string;
  last_synced: string;
}

/**
 * A single constraint entry parsed from constraints.md.
 * `id` is null for new unbracketed entries (INSERT candidates).
 * `flag` is the reason text after "— flagged:" (only for Flagged section).
 * `rawText` is the full text after the parenthetical, for re-serialization.
 */
export interface ParsedConstraint {
  id: number | null; // null = new unbracketed entry
  level: "hard" | "soft";
  source: string;
  confidence: "high" | "medium" | "low";
  text: string; // constraint_text (after parenthetical)
  flag: string | null; // null = unflagged; set = flagged reason
}

/**
 * Full parsed representation of constraints.md.
 */
export interface ParsedConstraintsMd {
  frontmatter: ConstraintsMdFrontmatter;
  entries: ParsedConstraint[];
}

// ---------------------------------------------------------------------------
// DSL output formatters
// ---------------------------------------------------------------------------

export const SYNC_HEADER = "SYNC:";
export const SYNC_INGESTED  = "SYNC: ingested";
export const SYNC_EXPORTED  = "SYNC: exported";
export const SYNC_FLAGGED   = "SYNC: flagged";
export const SYNC_SYNCED    = "SYNC: synced";
export const SYNC_DRIFT     = "SYNC: drift_detected";
export const SYNC_MISSING   = "SYNC: file_missing";

export function formatSyncAdded(n: number)  { return `added=${n}`; }
export function formatSyncUpdated(n: number){ return `updated=${n}`; }
export function formatSyncRemoved(n: number){ return `removed=${n}`; }
export function formatSyncRows(n: number)   { return `rows=${n}`; }
export function formatSyncVersion(n: number){ return `version=${n}`; }
export function formatSyncChecked(n: number){ return `checked=${n}`; }
export function formatSyncNewlyFlagged(n: number){ return `newly_flagged=${n}`; }
export function formatSyncReason(text: string){ return `reason=${text}`; }

// ---------------------------------------------------------------------------
// Parser — constraints.md → ParsedConstraintsMd
// ---------------------------------------------------------------------------

/**
 * Parse `constraints.md` from `path` (default: `process.cwd()/constraints.md`).
 * Throws if the file does not exist or has malformed frontmatter.
 *
 * Section assignment (Architectural Boundaries vs. Technology Constraints vs.
 * Flagged) is read from the heading under which each `[Cnnn]` entry appears.
 * The Flagged section entries MUST have a `[Cnnn]` prefix (EC-TS-06).
 *
 * Unbracketed lines (no `[Cnnn]`) under Architectural Boundaries → hard.
 * Unbracketed lines under Technology Constraints → soft.
 * Unbracketed lines under Flagged → `ERR unknown constraint id: <none>`.
 *
 * Each entry's `(level, source, confidence)` tuple is read from the
 * parenthetical following `[Cnnn]` (or derived for new entries).
 * The remaining text after the parenthetical is the `constraint_text`.
 */
export function parseConstraintsMd(path?: string): ParsedConstraintsMd {
  const filePath = path ?? resolveFs(process.cwd(), "constraints.md");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`constraints.md not found — run write_constraints_draft (Spec 04) or export_constraints_file first`);
  }
  return parseConstraintsMdString(raw);
}

/**
 * Parse a raw string of constraints.md content.
 * Exposed for testing (avoids filesystem).
 */
export function parseConstraintsMdString(raw: string): ParsedConstraintsMd {
  const lines = raw.split("\n");

  // 1. Frontmatter
  if (lines[0]?.trim() !== "---") {
    throw new Error("malformed constraints.md frontmatter");
  }
  const frontmatterEnd = lines.indexOf("---", 1);
  if (frontmatterEnd === -1) {
    throw new Error("malformed constraints.md frontmatter");
  }
  const fmLines = lines.slice(1, frontmatterEnd);
  const fm: ConstraintsMdFrontmatter = {
    version: NaN,
    last_updated: "",
    last_synced: "",
  };
  for (const line of fmLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim() as keyof ConstraintsMdFrontmatter;
    const val = line.slice(colon + 1).trim();
    if (key === "version") {
      fm.version = parseInt(val, 10);
      if (isNaN(fm.version)) throw new Error("malformed constraints.md frontmatter");
    } else if (key === "last_updated" || key === "last_synced") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fm as any)[key] = val;
    }
  }
  if (isNaN(fm.version) || !fm.last_updated) {
    throw new Error("malformed constraints.md frontmatter");
  }

  // 2. Body: parse sections and entries
  const bodyLines = lines.slice(frontmatterEnd + 1);
  const entries: ParsedConstraint[] = [];
  let currentSection: "arch" | "tech" | "flagged" | "outside" = "outside";

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    const stripped = line.trimStart();

    // Detect section headings
    if (stripped.startsWith("## ")) {
      const heading = stripped.slice(3).trim();
      if (heading === "Architectural Boundaries") {
        currentSection = "arch";
      } else if (heading === "Technology Constraints") {
        currentSection = "tech";
      } else if (heading.startsWith("⚠") || heading.includes("Flagged")) {
        currentSection = "flagged";
      } else {
        currentSection = "outside";
      }
      continue;
    }

    if (currentSection === "outside") continue;
    if (!stripped.startsWith("-")) continue;

    const entryText = stripped.slice(1).trim(); // after leading "-"

    // Extract [Cnnn] prefix and the parenthetical
    const bracketMatch = entryText.match(/^\[C(\d+)\]\s*\(([^)]+)\)\s*(.*)$/s);

    if (bracketMatch) {
      const id = parseInt(bracketMatch[1]!, 10);
      const meta = bracketMatch[2]!.trim();
      let after = bracketMatch[3]!;

      // Check for "— flagged: <reason>" suffix
      let flag: string | null = null;
      const flaggedIdx = after.indexOf("— flagged:");
      if (flaggedIdx !== -1) {
        flag = after.slice(flaggedIdx + 10).trim();
        after = after.slice(0, flaggedIdx).trim();
      }

      const metaParts = meta.split(",").map((s) => s.trim());
      const [level, source, confidence] = metaParts;
      if (!["hard", "soft"].includes(level)) {
        throw new Error(`malformed constraint level in [C${id}] entry`);
      }
      if (!["high", "medium", "low"].includes(confidence)) {
        throw new Error(`malformed constraint confidence in [C${id}] entry`);
      }

      // In Flagged section, flag MUST be non-null
      if (currentSection === "flagged" && flag === null) {
        throw new Error(`ERR unknown constraint id: <none>`);
      }

      entries.push({
        id,
        level: level as "hard" | "soft",
        source: source ?? "manual",
        confidence: confidence as "high" | "medium" | "low",
        text: after,
        flag,
      });
    } else {
      // Unbracketed entry
      if (currentSection === "flagged") {
        // EC-TS-06: flagged section entries must have [Cnnn]
        throw new Error(`ERR unknown constraint id: <none>`);
      }
      const level: "hard" | "soft" = currentSection === "arch" ? "hard" : "soft";
      entries.push({
        id: null,
        level,
        source: "manual",
        confidence: "high",
        text: entryText.trim(),
        flag: null,
      });
    }
  }

  return { frontmatter: fm, entries };
}

// ---------------------------------------------------------------------------
// Serializer — ConstraintRow[] → constraints.md string
// ---------------------------------------------------------------------------

/**
 * Render a `constraints` table row as a `[Cnnn]` line for the Markdown file.
 * The `section` parameter determines the heading context (for flag precedence).
 *
 * Format per spec §3:
 *   - [C001] (hard, manual, high) <text>
 *   - [C001] (hard, manual, high) <text> — flagged: <reason>   (in flagged section)
 */
function renderConstraintLine(
  id: number,
  text: string,
  level: "hard" | "soft",
  source: string,
  confidence: "high" | "medium" | "low",
  flag: string | null,
  inFlaggedSection: boolean
): string {
  const idStr = `C${String(id).padStart(3, "0")}`;
  const meta = `(${level}, ${source}, ${confidence})`;
  const baseText = `${text}`;
  if (inFlaggedSection && flag !== null) {
    return `- [${idStr}] ${meta} ${baseText} — flagged: ${flag}`;
  }
  return `- [${idStr}] ${meta} ${baseText}`;
}

/**
 * Serialize a list of constraint rows to a `constraints.md` string.
 *
 * Section assignment per EC-TS-02:
 *   - `flag IS NOT NULL` → ⚠ Flagged for Review ONLY (never duplicated)
 *   - `level = 'hard'` + flag IS NULL → Architectural Boundaries
 *   - `level = 'soft'` + flag IS NULL → Technology Constraints
 *
 * `version` is incremented from `prevVersion`. `last_updated` is set to now.
 * `last_synced` is carried forward from `prevLastSynced` (may be null → "").
 */
export function serializeConstraintsMd(
  rows: import("../storage/constraints.js").ConstraintRow[],
  prevVersion: number,
  prevLastSynced: string | null
): string {
  const version = prevVersion + 1;
  const lastUpdated = new Date().toISOString().replace(".000Z", "Z");
  const lastSynced = prevLastSynced ?? "";

  const hardFlagged:   typeof rows = [];
  const softFlagged:   typeof rows = [];
  const hardUnflagged: typeof rows = [];
  const softUnflagged: typeof rows = [];

  for (const row of rows) {
    if (row.flag !== null) {
      (row.level === "hard" ? hardFlagged : softFlagged).push(row);
    } else {
      (row.level === "hard" ? hardUnflagged : softUnflagged).push(row);
    }
  }

  const render = (
    r: (typeof rows)[number],
    inFlagged: boolean
  ) =>
    renderConstraintLine(
      r.id,
      r.constraint_text,
      r.level,
      r.source,
      r.confidence,
      r.flag,
      inFlagged
    );

  const section = (
    heading: string,
    items: typeof rows,
    inFlagged: boolean
  ) => {
    if (items.length === 0) {
      return `## ${heading}\n\n_(none)_\n`;
    }
    const lines = items.map((r) => render(r, inFlagged)).join("\n");
    return `## ${heading}\n\n${lines}\n`;
  };

  const frontmatter = [
    "---",
    `version: ${version}`,
    `last_updated: ${lastUpdated}`,
    `last_synced: ${lastSynced}`,
    "---",
  ].join("\n");

  const body = [
    "# Constraints",
    "",
    section("Architectural Boundaries", hardUnflagged, false),
    section("Technology Constraints", softUnflagged, false),
    section("⚠ Flagged for Review", [...hardFlagged, ...softFlagged], true),
  ].join("\n");

  return `${frontmatter}\n\n${body}\n`;
}
