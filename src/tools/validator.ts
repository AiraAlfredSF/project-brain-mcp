// validate_plan — Spec 03.
//
// Pure read/evaluate layer. Owns no tables; reads `constraints` (Spec 01),
// `failures` (Spec 01), and `graph_nodes`/`graph_edges` (Spec 02) through
// their respective storage adapters.
//
// Three-stage per-step evaluation (first-match-wins per step, per EC-PV-02):
//   1. Constraint checker    — token-overlap match against hard constraints
//   2. Failure pattern match — token-overlap match against open failures
//   3. Boundary checker      — module-pair check against the graph + a
//                              "black box" / "API only" hard constraint
//
// Token-overlap definition per EC-PV-05: lowercase + whitespace-tokenize,
// exclude common stop-words, drop tokens of length < 4, require ≥ 2
// significant tokens to overlap between the step and the candidate row.

import type { Database as DatabaseType } from "better-sqlite3";

import { listHardConstraints, type ConstraintRow } from "../storage/constraints.js";
import { listOpenFailures, type FailureRow } from "../storage/decisions.js";
import {
  getNodeByModule,
  type GraphNodeRow,
} from "../storage/graph.js";

import {
  formatErr,
  formatFix,
  formatPlanVerdict,
  formatStepFinding,
  markSchemaSent,
  takeSchemaHeaderIfNeeded,
} from "../format/dsl.js";


// ---------------------------------------------------------------------------
// Constants — EC-PV-05 stop words, EC-PV-06 boundary phrase list
// ---------------------------------------------------------------------------

/** Stop words for token-overlap matching (EC-PV-05). */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "that",
  "with",
  "from",
  "into",
  "this",
]);

/** Phrase fragments that mark a hard constraint as a "boundary" constraint
 *  (EC-PV-06). Matched case-insensitively as substrings. */
const BOUNDARY_PHRASES: readonly string[] = [
  "black box",
  "api only",
  "do not import directly",
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a proposed multi-step plan against the project's hard
 * constraints, open failures, and architectural boundaries. Returns
 * either `PLAN: approved` (with no body) or `PLAN: blocked` followed
 * by one `step[n]=` / `fix=` pair per flagged step, in step order.
 *
 * See Spec 03 §3 for the per-checker semantics, and §7 for the
 * complete edge-case list.
 */
export function validatePlan(
  db: DatabaseType,
  rawInput: unknown
): string {
  // 1. Input validation (Spec 03 §3 error conditions).
  if (!isRecord(rawInput)) return formatErr("steps must be a non-empty array of non-empty strings");
  const { steps, task } = rawInput;
  if (!Array.isArray(steps)) {
    return formatErr("steps must be a non-empty array of non-empty strings");
  }
  if (steps.length === 0) {
    return formatErr("steps must be a non-empty array of non-empty strings");
  }
  // Each element must be a non-empty string after trim.
  for (const s of steps) {
    if (typeof s !== "string" || s.trim().length === 0) {
      return formatErr("steps must be a non-empty array of non-empty strings");
    }
  }
  if (typeof task !== "string" || task.trim().length === 0) {
    return formatErr("task is required");
  }

  // 2. One-time BRAIN DSL v1 header (shared with Specs 01/02/06).
  const lines: string[] = [];
  const header = takeSchemaHeaderIfNeeded();
  if (header) {
    lines.push(header);
    markSchemaSent();
  }

  // 3. Load checker inputs. Empty tables → checkers are no-ops (EC-PV-04).
  const hardConstraints = listHardConstraints(db);
  const openFailures = listOpenFailures(db);

  // Pre-build the per-constraint "is this a boundary constraint?" flag
  // (EC-PV-06). Per the spec's worked example, a hard constraint is a
  // boundary constraint if its text contains one of the boundary
  // phrases (`black box` / `API only` / `do not import directly`) —
  // the constraint does NOT need to mention a specific module name. The
  // boundary checker matches the constraint's phrase against ANY
  // boundary-restricted module the step happens to name.
  const boundaryConstraints: ConstraintRow[] = hardConstraints.filter((c) =>
    hasBoundaryPhrase(c.constraint_text)
  );
  // Map: module name (substring) → the constraint that owns the boundary
  // phrase. A constraint can own multiple modules; we register the
  // whole row against every detected module in the constraint's text so
  // the checker can find it. If the constraint text does not name any
  // module directly, the constraint applies to any boundary-restricted
  // module the step names — handled in checkArchitecturalBoundary via
  // a fallback match.
  const boundaryConstraintByModule: Map<string, ConstraintRow[]> = new Map();
  for (const c of boundaryConstraints) {
    const modules = extractModuleMentions(c.constraint_text);
    if (modules.length === 0) {
      // No module in the text → register under a sentinel key so the
      // boundary checker can find it when ANY module is named.
      const list = boundaryConstraintByModule.get("*") ?? [];
      list.push(c);
      boundaryConstraintByModule.set("*", list);
    } else {
      for (const m of modules) {
        const list = boundaryConstraintByModule.get(m) ?? [];
        list.push(c);
        boundaryConstraintByModule.set(m, list);
      }
    }
  }

  // 4. Per-step evaluation. First-match-wins per step (EC-PV-02).
  const findings: Array<{ stepIndex1Based: number; reason: string; fix: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as string;
    const finding = evaluateStep({
      step,
      stepIndex1Based: i + 1,
      hardConstraints,
      openFailures,
      db,
      boundaryConstraintByModule,
    });
    if (finding) findings.push(finding);
  }

  // 5. Emit DSL. Per EC-PV-08, sort by step index ascending (input order
  //    is already ascending, so no sort needed; this is explicit for
  //    traceability).
  findings.sort((a, b) => a.stepIndex1Based - b.stepIndex1Based);
  const approved = findings.length === 0;
  lines.push(formatPlanVerdict(approved));
  for (const f of findings) {
    lines.push(formatStepFinding(f.stepIndex1Based, f.reason));
    lines.push(formatFix(f.fix));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-step evaluation
// ---------------------------------------------------------------------------

interface EvaluateStepArgs {
  step: string;
  stepIndex1Based: number;
  hardConstraints: ConstraintRow[];
  openFailures: FailureRow[];
  db: DatabaseType;
  boundaryConstraintByModule: Map<string, ConstraintRow[]>;
}

/**
 * Apply the three checkers in order. Returns `null` if the step passes
 * all three, or a `{ reason, fix }` object on the first match.
 */
function evaluateStep(args: EvaluateStepArgs): {
  stepIndex1Based: number;
  reason: string;
  fix: string;
} | null {
  // 1. Constraint checker.
  const stepTokens = tokenize(args.step);
  for (const c of args.hardConstraints) {
    if (tokenOverlapCount(stepTokens, tokenize(c.constraint_text)) >= 2) {
      return {
        stepIndex1Based: args.stepIndex1Based,
        reason:
          `Step matches hard constraint C${c.id} ` +
          `(${trimForFinding(c.constraint_text)})`,
        fix: fixForConstraint(c),
      };
    }
  }
  // 2. Failure pattern matcher.
  for (const f of args.openFailures) {
    const failureTokens = tokenize(f.description + " " + f.approach_tried);
    if (tokenOverlapCount(stepTokens, failureTokens) >= 2) {
      return {
        stepIndex1Based: args.stepIndex1Based,
        reason:
          `Step matches open failure F${f.id} ` +
          `(${trimForFinding(f.description)}) — ` +
          `same approach_tried pattern`,
        fix: fixForFailure(f),
      };
    }
  }
  // 3. Architectural boundary checker.
  const boundaryFinding = checkArchitecturalBoundary(
    args.step,
    args.stepIndex1Based,
    args.db,
    args.boundaryConstraintByModule
  );
  if (boundaryFinding) return boundaryFinding;

  return null;
}

// ---------------------------------------------------------------------------
// Constraint checker helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize free text for the overlap test.
 *   - lower-case
 *   - split on non-word chars (spaces, dots, slashes, etc.)
 *   - drop tokens shorter than 4 chars
 *   - drop stop-words (EC-PV-05)
 *   - return a Set for O(1) overlap counting
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 4) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** |A ∩ B|. Used by the EC-PV-05 "≥ 2 overlapping significant tokens" rule. */
export function tokenOverlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/**
 * Trim a `constraints` row's text down to something that fits in a
 * single-line `step[n]=` finding without being noisy. We collapse
 * whitespace (escapeField already does this) and cap at ~120 chars.
 */
function trimForFinding(text: string): string {
  const collapsed = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length <= 120) return collapsed;
  return collapsed.slice(0, 117) + "...";
}

function fixForConstraint(c: ConstraintRow): string {
  return `See constraint C${c.id}: ${trimForFinding(c.constraint_text)}`;
}

function fixForFailure(f: FailureRow): string {
  return `See failure F${f.id} — still open and unresolved; avoid the same approach_tried`;
}

// ---------------------------------------------------------------------------
// Architectural boundary checker (EC-PV-06, EC-PV-07)
// ---------------------------------------------------------------------------

/** Substring-match any boundary phrase. Case-insensitive. */
function hasBoundaryPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return BOUNDARY_PHRASES.some((p) => lower.includes(p));
}

/**
 * Pull module-like substrings out of free text. We accept anything that
 * contains a `/` and at least one alnum path segment, e.g.
 * `infra/stripe.ts`, `api/billing`, `db/invoices`, `src/api/login.ts`.
 * Single-word bare basenames are too ambiguous to use as-is (a
 * constraint like "do not edit payments directly" contains no
 * module-like substring, and we don't want to over-trigger).
 */
export function extractModuleMentions(text: string): string[] {
  const out: string[] = [];
  const re = /[a-z0-9_][a-z0-9_\-]*(\/[a-z0-9_\-]+)+\.[a-z0-9_]+|[a-z0-9_][a-z0-9_\-]*(\/[a-z0-9_\-]+)+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Look up a `graph_nodes.module` row for an extracted mention. The
 * mention may be a partial path or include an extension; we try a few
 * common transformations. Returns `null` if the project has no row that
 * matches (EC-PV-07: unknown modules don't block).
 */
function resolveModuleNode(
  db: DatabaseType,
  mention: string
): GraphNodeRow | null {
  // Direct lookup.
  const direct = getNodeByModule(db, mention);
  if (direct) return direct;
  // Strip extension (`.ts`, `.js`, `.py`, etc.).
  const stripped = mention.replace(/\.[a-z0-9]+$/i, "");
  const s2 = getNodeByModule(db, stripped);
  if (s2) return s2;
  // Drop the last path segment (e.g. `src/api/login` → `src/api`).
  const parts = mention.split("/");
  if (parts.length > 1) {
    const shorter = parts.slice(0, -1).join("/");
    const s3 = getNodeByModule(db, shorter);
    if (s3) return s3;
  }
  return null;
}

/**
 * Architectural boundary checker (EC-PV-06, EC-PV-07).
 *
 * Returns a finding iff ALL of:
 *   1. The step mentions two or more modules that resolve to `graph_nodes`.
 *   2. At least one of those modules is "boundary-restricted" — i.e. it
 *      appears in a hard constraint's text alongside a boundary phrase
 *      (`black box` / `API only` / `do not import directly`).
 *   3. There is NO direct `graph_edges` row connecting the boundary-
 *      restricted module to the second named module in either direction
 *      (i.e. neither `A → B` nor `B → A`).
 */
function checkArchitecturalBoundary(
  step: string,
  stepIndex1Based: number,
  db: DatabaseType,
  boundaryConstraintByModule: Map<string, ConstraintRow[]>
):
  | { stepIndex1Based: number; reason: string; fix: string }
  | null {
  const mentions = extractModuleMentions(step);
  if (mentions.length < 2) return null;

  // Resolve mentions → node ids, dedupe, and track which ones are
  // boundary-restricted. Boundary constraints registered under the
  // `*` sentinel (no module in the constraint text) apply to ANY
  // resolved module.
  const resolved: Array<{
    mention: string;
    node: GraphNodeRow;
    boundaryConstraints: ConstraintRow[];
  }> = [];
  for (const m of mentions) {
    const node = resolveModuleNode(db, m);
    if (!node) continue; // EC-PV-07: unknown module is not a violation
    let restricted = boundaryConstraintByModule.get(node.module) ?? [];
    // If the constraint text didn't name a module, the constraint
    // applies to any module the step names.
    const wildcard = boundaryConstraintByModule.get("*") ?? [];
    if (wildcard.length > 0) {
      // Dedupe by id (a module could be both named and wildcarded).
      const seen = new Set<number>();
      const merged: ConstraintRow[] = [];
      for (const c of [...restricted, ...wildcard]) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          merged.push(c);
        }
      }
      restricted = merged;
    }
    resolved.push({ mention: m, node, boundaryConstraints: restricted });
  }
  if (resolved.length < 2) return null;

  // For each restricted module, see whether any other resolved module
  // has no connecting edge to it. The first such pair wins.
  for (let i = 0; i < resolved.length; i++) {
    const a = resolved[i];
    if (a.boundaryConstraints.length === 0) continue;
    for (let j = 0; j < resolved.length; j++) {
      if (i === j) continue;
      const b = resolved[j];
      if (hasAnyEdgeBetween(db, a.node.id, b.node.id)) continue;
      // Boundary violation: A is restricted, B is unconnected to A.
      const c = a.boundaryConstraints[0]!;
      return {
        stepIndex1Based,
        reason:
          `Step crosses boundary of restricted module [${a.node.module}] ` +
          `into [${b.node.module}] with no graph_edges row connecting them — ` +
          `violates hard constraint C${c.id} ` +
          `(${trimForFinding(c.constraint_text)})`,
        fix:
          `Use the public API of [${a.node.module}] instead of importing it directly`,
      };
    }
  }
  return null;
}

/** True iff there is at least one `graph_edges` row connecting A and B
 *  in either direction at depth ≤ 1. */
function hasAnyEdgeBetween(
  db: DatabaseType,
  nodeA: number,
  nodeB: number
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM graph_edges
       WHERE (from_node = ? AND to_node = ?)
          OR (from_node = ? AND to_node = ?)
       LIMIT 1`
    )
    .get(nodeA, nodeB, nodeB, nodeA);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Misc helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
