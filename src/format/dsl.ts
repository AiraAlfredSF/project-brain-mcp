// SQLite results → DSL string formatters.
//
// DSL foundation defined in Spec 01 §4. Every other module (Spec 02..07)
// routes its tool responses through this file. Never hand-format DSL
// strings inline.
//
// See:
//   - specs/details/approved/Spec_01_Decision_Memory.md §3, §4
//   - specs/details/absolute-rules-reference.md (MCP Contract, DB Type Rules)

import type { ConstraintRow } from "../storage/constraints.js";
import type { ContextRow, DecisionRow, FailureRow } from "../storage/decisions.js";

// Re-export the row types so callers (tool handlers, other specs) can
// import them through this single entry point if they prefer.
export type {
  ConstraintRow,
} from "../storage/constraints.js";
export type {
  ContextRow,
  DecisionRow,
  FailureRow,
} from "../storage/decisions.js";

// ---------------------------------------------------------------------------
// Session-level schema-injection flag (EC-DM-08, Spec 01 §4)
//
// In-process module-level boolean. Reset only on process restart (which for
// a stdio MCP server corresponds to a new session). get_context /
// list_constraints (and, per Spec 06, start_session) check this flag before
// deciding whether to prepend the BRAIN DSL v1 header block.
// ---------------------------------------------------------------------------

let schemaSent = false;

export function hasSchemaBeenSent(): boolean {
  return schemaSent;
}

export function markSchemaSent(): void {
  schemaSent = true;
}

/** Test-only — clears the in-process flag so a single test process can
 *  verify the "first call of the session" behaviour repeatedly. */
export function resetSchemaSentForTesting(): void {
  schemaSent = false;
}

// ---------------------------------------------------------------------------
// Schema header — the one-time `BRAIN DSL v1` block (EC-DM-08).
// ---------------------------------------------------------------------------

/** The three format lines that follow the `BRAIN DSL v1` header. */
export const SCHEMA_FORMAT_LINES: readonly string[] = [
  "D id|decision|rationale|alts|tags|created_at",
  "F id|description|cause|approach|status|created_at",
  "C id|text|level|source|confidence|flag|created_at",
] as const;

/**
 * Return the one-time `BRAIN DSL v1` header block (header + 3 format lines),
 * or `null` if the schema has already been sent this session.
 *
 * Callers should `markSchemaSent()` immediately after consuming the block.
 */
export function takeSchemaHeaderIfNeeded(): string | null {
  if (hasSchemaBeenSent()) return null;
  return ["BRAIN DSL v1", ...SCHEMA_FORMAT_LINES].join("\n");
}

// ---------------------------------------------------------------------------
// Field encoding rules (Spec 01 §4, apply to all DSL formatters, all specs)
// ---------------------------------------------------------------------------

/**
 * Escape a single field for DSL output.
 *   - Literal `|` → `\|`
 *   - Newlines and tabs → single space
 *   - `null`/`undefined` → empty string (per "A NULL column renders as an
 *     empty field" rule)
 */
export function escapeField(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n\t]+/g, " ");
}

/** Join an array<string> with commas. Empty array → empty string. */
export function formatArrayField(arr: string[] | null | undefined): string {
  if (!arr || arr.length === 0) return "";
  return arr.join(",");
}

// ---------------------------------------------------------------------------
// Row formatters — Decision / Failure / Constraint DSL lines.
// ---------------------------------------------------------------------------

/** Format a `decisions` row as `D id|decision|rationale|alts|tags|created_at`. */
export function formatDecisionRow(row: DecisionRow): string {
  const fields = [
    String(row.id),
    escapeField(row.decision),
    escapeField(row.rationale),
    formatArrayField(row.alternatives_rejected),
    formatArrayField(row.tags),
    escapeField(row.created_at),
  ];
  return `D ${fields.join("|")}`;
}

/** Format a `failures` row as `F id|description|cause|approach|status|created_at`. */
export function formatFailureRow(row: FailureRow): string {
  const fields = [
    String(row.id),
    escapeField(row.description),
    escapeField(row.cause),
    escapeField(row.approach_tried),
    escapeField(row.status),
    escapeField(row.created_at),
  ];
  return `F ${fields.join("|")}`;
}

/**
 * Format a `constraints` row as
 * `C id|text|level|source|confidence|flag|created_at`.
 * `flag` renders as empty when NULL (EC-DM-09).
 */
export function formatConstraintRow(row: ConstraintRow): string {
  const fields = [
    String(row.id),
    escapeField(row.constraint_text),
    escapeField(row.level),
    escapeField(row.source),
    escapeField(row.confidence),
    escapeField(row.flag), // null → "" (EC-DM-09)
    escapeField(row.created_at),
  ];
  return `C ${fields.join("|")}`;
}

/** Format a `ContextRow` (used by get_context) to its D or F line. */
export function formatContextRow(row: ContextRow): string {
  return row.kind === "D"
    ? formatDecisionRow(row)
    : formatFailureRow(row);
}

// ---------------------------------------------------------------------------
// Write-confirmation and error line formatters.
// ---------------------------------------------------------------------------

/** `OK D 12` / `OK F 7` / `OK C 3` style write confirmations. */
export function formatOk(prefix: "D" | "F" | "C", id: number): string {
  return `OK ${prefix} ${id}`;
}

/** `ERR <message>` validation/error line. */
export function formatErr(message: string): string {
  return `ERR ${message}`;
}

// ===========================================================================
// Graph DSL — Spec 02 §3, §4
//
// Formatters for: [module], >deps, ^callers, !, @, ~, d=<n>, GRAPH:,
// DIFF:, ENTRY:, +/-, and the various depth-section groupings used by
// get_dependents / get_dependencies / get_blast_radius / diff_graph /
// find_entry_points.
// ===========================================================================

/**
 * `[module]` node header. Pipe characters in the module name are escaped
 * via `escapeField()` (Spec 02 §4 last paragraph).
 */
export function formatNodeHeader(module: string): string {
  return `[${escapeField(module)}]`;
}

/**
 * Build the prefix flags for a node reference line — `@` for entry points,
 * `~` for deprecated, and optionally `!` for `side_effect` edges
 * (e.g. `!>@[db/users.ts]`). Order is `!`, `@`, `~`, then `[module]`.
 */
export function formatNodeLine(opts: {
  module: string;
  entryPoint?: 0 | 1 | boolean;
  deprecated?: 0 | 1 | boolean;
  sideEffect?: boolean;
}): string {
  const entry = opts.entryPoint === 1 || opts.entryPoint === true;
  const dep = opts.deprecated === 1 || opts.deprecated === true;
  const se = opts.sideEffect === true;
  let prefix = "";
  if (se) prefix += "!";
  if (entry) prefix += "@";
  if (dep) prefix += "~";
  return `${prefix}${formatNodeHeader(opts.module)}`;
}

/**
 * `>deps d=<n>` / `^callers d=<n>` section-header line, with leading
 * indentation and an optional `d=<n>` depth annotation.
 */
export function formatSectionHeader(
  direction: "deps" | "callers",
  depth: number | null,
  indent: number = 0
): string {
  const pad = "  ".repeat(indent);
  const arrow = direction === "deps" ? ">" : "^";
  const d = depth === null ? "" : ` d=${depth}`;
  return `${pad}${arrow}${direction}${d}`;
}

/**
 * A single `>deps` child line: leading `>` (or `!>` for side_effect) +
 * `[module]`. Per Spec 02 §3 `get_dependencies` worked example:
 *   `  >[auth/session.ts]`
 *   `  !>[db/users.ts]`
 */
export function formatDepChildLine(
  module: string,
  sideEffect: boolean,
  indent: number = 0
): string {
  const pad = "  ".repeat(indent);
  const arrow = sideEffect ? "!>" : ">";
  return `${pad}${arrow}${formatNodeHeader(module)}`;
}

/**
 * A `^callers` child line: leading `^` + `[module]`. Per Spec 02 §3
 * `get_dependents` worked example: `  ^[api/login.ts]`.
 */
export function formatCallerChildLine(
  module: string,
  indent: number = 0
): string {
  const pad = "  ".repeat(indent);
  return `${pad}^${formatNodeHeader(module)}`;
}

// ---------------------------------------------------------------------------
// get_dependents / get_dependencies depth-grouped output
// ---------------------------------------------------------------------------

/**
 * Group BFS hops by their `depth` field. Returns an array of
 * `{ depth, modules }` blocks in BFS order, suitable for serializing as:
 *
 * ```
 * [module]
 * ^callers d=1
 *   ^[a]
 *   ^[b]
 * d=2
 *   ^[c]
 * ```
 */
export function groupHopsByDepth(
  hops: ReadonlyArray<{ module: string; depth: number }>
): Array<{ depth: number; modules: string[] }> {
  const groups = new Map<number, string[]>();
  for (const h of hops) {
    const list = groups.get(h.depth) ?? [];
    list.push(h.module);
    groups.set(h.depth, list);
  }
  return Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([depth, modules]) => ({ depth, modules }));
}

/** Stable sort modules within a depth group (alphabetical). */
export function sortModulesAlphabetical(modules: string[]): string[] {
  return [...modules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// get_blast_radius — flat annotated output
// ---------------------------------------------------------------------------

/**
 * `  d=<n> ^[module]` line for `get_blast_radius`. Caller sorts the
 * hops; this is just the line shape. Note the leading `^` matches the
 * `^callers` section header above it.
 */
export function formatBlastLine(
  module: string,
  depth: number,
  indent: number = 0
): string {
  const pad = "  ".repeat(indent);
  return `${pad}d=${depth} ^${formatNodeHeader(module)}`;
}

// ---------------------------------------------------------------------------
// diff_graph output
// ---------------------------------------------------------------------------

/**
 * `+[from]>[to]` (added) or `-[from]>[to]` (removed) line. `sideEffect`
 * prepends `!` between the sign and `[from]`, e.g. `+!api/billing.ts>...`.
 *
 * Per Spec 02 §3 diff_graph's worked example:
 *   +[api/billing.ts]>[infra/stripe.ts]
 *   +!api/billing.ts>db/invoices.ts
 *   -[api/legacy_billing.ts]>[infra/stripe_v1.ts]
 */
export function formatDiffLine(opts: {
  from: string;
  to: string;
  sideEffect: boolean;
  added: boolean;
}): string {
  const sign = opts.added ? "+" : "-";
  const se = opts.sideEffect ? "!" : "";
  // For non-side-effect lines, brackets are preserved; for side-effect
  // lines, the spec's example omits them around the from module.
  if (opts.sideEffect) {
    return `${sign}${se}${escapeField(opts.from)}>${escapeField(opts.to)}`;
  }
  return `${sign}${se}${formatNodeHeader(opts.from)}>${formatNodeHeader(opts.to)}`;
}

/** `DIFF: since=<commit>` header line. */
export function formatDiffHeader(commit: string): string {
  return `DIFF: since=${commit}`;
}

// ---------------------------------------------------------------------------
// find_entry_points output
// ---------------------------------------------------------------------------

/** `ENTRY: intent="<intent>"` header line. */
export function formatEntryHeader(intent: string): string {
  return `ENTRY: intent="${escapeField(intent)}"`;
}

// ---------------------------------------------------------------------------
// index_codebase output
// ---------------------------------------------------------------------------

/** `GRAPH: indexed` header line. */
export const GRAPH_INDEXED_HEADER = "GRAPH: indexed";

/** `GRAPH: ingested` header line — Spec 09. */
export const GRAPH_INGESTED_HEADER = "GRAPH: ingested";

/** `node_count=<n>`, `edge_count=<n>`, `duration_ms=<n>` lines. */
export function formatGraphStats(
  nodeCount: number,
  edgeCount: number,
  durationMs: number
): string[] {
  return [
    `node_count=${nodeCount}`,
    `edge_count=${edgeCount}`,
    `duration_ms=${durationMs}`,
  ];
}

/**
 * Spec 09 ingest stats lines:
 *   nodes_updated=<n>
 *   edges_updated=<n>
 *   mode=full|incremental
 *   timestamp=<ISO 8601>
 */
export function formatIngestStats(
  nodesUpdated: number,
  edgesUpdated: number,
  mode: string,
  timestamp: string
): string[] {
  return [
    `nodes_updated=${nodesUpdated}`,
    `edges_updated=${edgesUpdated}`,
    `mode=${mode}`,
    `timestamp=${timestamp}`,
  ];
}

// ===========================================================================
// Plan DSL — Spec 03 §3, §4
//
// Formatters for: PLAN: approved|blocked, step[<n>]=<reason>, fix=<suggestion>.
// These lines use `=` as the delimiter (NOT `|`), so per Spec 03 §4 the
// only field-level encoding we apply is the newline-collapse (via
// `escapeField()`) — but `escapeField()` ALSO escapes literal `|`, which
// Spec 03 §4 explicitly says should be a no-op for `=`-delimited lines.
// We therefore use a dedicated `escapePlanField()` that collapses newlines
// but leaves `|` characters as-is.
// ===========================================================================

/**
 * Field-level encoder for `=`-delimited Plan DSL lines. Collapses any
 * newlines / tabs / carriage returns to a single space, but does NOT
 * escape literal `|` characters (per Spec 03 §4, last paragraph).
 */
function escapePlanField(value: string): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\r\n\t]+/g, " ");
}

/**
 * `PLAN: approved` or `PLAN: blocked` verdict line. The argument is the
 * boolean of the overall outcome (`true` = approved, `false` = blocked).
 */
export function formatPlanVerdict(approved: boolean): string {
  return approved ? "PLAN: approved" : "PLAN: blocked";
}

/**
 * `step[<n>]=<reason>` line. `n` is 1-indexed (matches the position in
 * the input `steps` array per Spec 03 §3).
 *
 * Per Spec 03 §4, newlines in `reason` are collapsed to a single space,
 * but literal `|` characters are passed through unchanged (no `\|`
 * escaping, because these lines use `=` as the delimiter and there is
 * no structural ambiguity to escape).
 */
export function formatStepFinding(stepIndex1Based: number, reason: string): string {
  return `step[${stepIndex1Based}]=${escapePlanField(reason)}`;
}

/**
 * `fix=<suggestion>` line. Always immediately follows its `step[n]=`
 * line. Same encoding rules as `formatStepFinding`.
 */
export function formatFix(suggestion: string): string {
  return `fix=${escapePlanField(suggestion)}`;
}

// ===========================================================================
// Bootstrap DSL — Spec 04 §3, §4
//
// Formatters for: BOOTSTRAP: <state>, modules=, intents=, next_module=,
// progress=, modules_processed=, constraints_written=, draft: ..., OK MI <id>,
// OK constraints.md, rows=, bootstrap=, manual=.
//
// As with Plan DSL (Spec 03), these lines use `=` as the delimiter and
// reuse `escapePlanField()` so literal `|` characters are preserved
// unchanged. The formatters take pre-formatted numbers and strings;
// callers do the data shaping.
// ===========================================================================

/**
 * `BOOTSTRAP: complete` / `BOOTSTRAP: incomplete` / `BOOTSTRAP: never_run`
 * header line for `get_bootstrap_status`.
 */
export function formatBootstrapStatus(
  state: "complete" | "incomplete" | "never_run"
): string {
  return `BOOTSTRAP: ${state}`;
}

/** `modules=<n>` and `intents=<n>` stat lines (complete/incomplete only). */
export function formatBootstrapStatusStats(
  modules: number,
  intents: number
): string[] {
  return [`modules=${modules}`, `intents=${intents}`];
}

/** `BOOTSTRAP: in_progress` header line for `run_bootstrap`. */
export const BOOTSTRAP_IN_PROGRESS_HEADER = "BOOTSTRAP: in_progress";

/** `next_module=<path>` line (in_progress only). */
export function formatNextModule(path: string): string {
  return `next_module=${escapePlanField(path)}`;
}

/** `progress=<covered>/<total>` line (in_progress only). */
export function formatBootstrapProgress(covered: number, total: number): string {
  return `progress=${covered}/${total}`;
}

/** `BOOTSTRAP: already_complete` header line (run_bootstrap short-circuit). */
export const BOOTSTRAP_ALREADY_COMPLETE_HEADER = "BOOTSTRAP: already_complete";

/** `BOOTSTRAP: complete` header line (run_bootstrap completing turn). */
export const BOOTSTRAP_COMPLETE_HEADER = "BOOTSTRAP: complete";

/** `modules_processed=<n>` line (complete only). */
export function formatBootstrapModulesProcessed(n: number): string {
  return `modules_processed=${n}`;
}

/** `constraints_written=<n>` line (complete / OK MI). */
export function formatConstraintsWritten(n: number): string {
  return `constraints_written=${n}`;
}

/** `draft: constraints.md` line (complete only). */
export const BOOTSTRAP_DRAFT_LINE = "draft: constraints.md";

/** `OK MI <id>` line — log_module_intent confirmation. */
export function formatModuleIntentOk(id: number): string {
  return `OK MI ${id}`;
}

/** `OK constraints.md` line — write_constraints_draft confirmation. */
export const CONSTRAINTS_DRAFT_OK_HEADER = "OK constraints.md";

/** `rows=<n>` line for write_constraints_draft. */
export function formatConstraintsDraftRows(n: number): string {
  return `rows=${n}`;
}

/** `bootstrap=<n>` line for write_constraints_draft. */
export function formatConstraintsDraftBootstrap(n: number): string {
  return `bootstrap=${n}`;
}

/** `manual=<n>` line for write_constraints_draft. */
export function formatConstraintsDraftManual(n: number): string {
  return `manual=${n}`;
}

// ===========================================================================
// Session DSL — Spec 06 §3, §4
//
// Formatters for: SESSION: started|compliant|warnings|violations,
// session_id=, calls:, missing:, action:, OK TC.
// ===========================================================================

/** `SESSION: started` header line — start_session confirmation. */
export const SESSION_STARTED_HEADER = "SESSION: started";

/** `session_id=<n>` line (start_session only). */
export function formatSessionId(id: number): string {
  return `session_id=${id}`;
}

/** `OK TC` — record_tool_call confirmation. */
export const OK_TC = "OK TC";

/** `SESSION: compliant|warnings|violations` verdict line for get_session_health. */
export function formatSessionState(
  state: "compliant" | "warnings" | "violations"
): string {
  return `SESSION: ${state}`;
}

/**
 * `calls: <tool_name>, <tool_name>, ...` line — chronological, comma-separated.
 * Per EC-SH-05, callers should omit this line entirely when `calls` is empty
 * rather than calling this formatter.
 */
export function formatSessionCalls(calls: string[]): string {
  return `calls: ${calls.join(", ")}`;
}

/** `missing: <description>` line — one per unmet checklist item. */
export function formatSessionMissing(text: string): string {
  return `missing: ${text}`;
}

/** `action: <suggestion>` line — immediately follows its `missing:` line. */
export function formatSessionAction(text: string): string {
  return `action: ${text}`;
}
