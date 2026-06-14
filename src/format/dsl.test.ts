// Tests for the DSL foundation (Spec 01 §4).
// Covers all field-encoding rules, row formatters, and the one-time
// schema-injection flag (EC-DM-08, EC-DM-09, EC-DM-10).

import { describe, expect, it, beforeEach } from "vitest";

import {
  escapeField,
  formatArrayField,
  formatConstraintRow,
  formatContextRow,
  formatDecisionRow,
  formatErr,
  formatFailureRow,
  formatOk,
  hasSchemaBeenSent,
  markSchemaSent,
  resetSchemaSentForTesting,
  SCHEMA_FORMAT_LINES,
  takeSchemaHeaderIfNeeded,
} from "./dsl.js";

beforeEach(() => {
  resetSchemaSentForTesting();
});

describe("escapeField (Spec 01 §4 Field encoding)", () => {
  it("returns empty string for null", () => {
    expect(escapeField(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(escapeField(undefined)).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeField("Use SQLite")).toBe("Use SQLite");
  });

  it("escapes a literal pipe as \\| (EC-DM-10)", () => {
    expect(escapeField("Use A | B pattern")).toBe("Use A \\| B pattern");
  });

  it("collapses newlines and tabs to a single space", () => {
    expect(escapeField("line1\nline2\tcol")).toBe("line1 line2 col");
  });

  it("collapses carriage returns as well", () => {
    expect(escapeField("a\r\nb")).toBe("a b");
  });

  it("escapes pipe AND collapses newline in the same field", () => {
    expect(escapeField("a|b\nc")).toBe("a\\|b c");
  });
});

describe("formatArrayField", () => {
  it("renders empty array as empty string", () => {
    expect(formatArrayField([])).toBe("");
  });

  it("renders null/undefined as empty string", () => {
    expect(formatArrayField(null)).toBe("");
    expect(formatArrayField(undefined)).toBe("");
  });

  it("comma-joins non-empty array", () => {
    expect(formatArrayField(["infra", "db"])).toBe("infra,db");
  });
});


describe("formatDecisionRow", () => {
  it("formats a typical decision row", () => {
    const line = formatDecisionRow({
      id: 12,
      decision: "Use SQLite for local storage",
      rationale: "Simplicity, zero ops",
      alternatives_rejected: ["Postgres", "MySQL"],
      tags: ["infra", "db"],
      created_at: "2026-06-10T10:00:00Z",
    });
    expect(line).toBe(
      "D 12|Use SQLite for local storage|Simplicity, zero ops|Postgres,MySQL|infra,db|2026-06-10T10:00:00Z"
    );
  });

  it("renders empty alts/tags as empty fields", () => {
    const line = formatDecisionRow({
      id: 1,
      decision: "x",
      rationale: "y",
      alternatives_rejected: [],
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(line).toBe("D 1|x|y|||2026-01-01T00:00:00Z");
  });

  it("escapes pipes in text fields (EC-DM-10)", () => {
    const line = formatDecisionRow({
      id: 1,
      decision: "Use A | B pattern",
      rationale: "r",
      alternatives_rejected: [],
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(line).toBe("D 1|Use A \\| B pattern|r|||2026-01-01T00:00:00Z");
  });
});

describe("formatFailureRow", () => {
  it("formats a typical failure row", () => {
    const line = formatFailureRow({
      id: 7,
      description: "Tree-sitter WASM load failed in worker",
      cause: "Wrong bundler target",
      approach_tried: "Switched to esbuild target=node",
      status: "open",
      created_at: "2026-06-09T08:30:00Z",
      updated_at: "2026-06-09T08:30:00Z",
    });
    expect(line).toBe(
      "F 7|Tree-sitter WASM load failed in worker|Wrong bundler target|Switched to esbuild target=node|open|2026-06-09T08:30:00Z"
    );
  });
});

describe("formatConstraintRow", () => {
  it("renders a constraint row with NULL flag as empty field (EC-DM-09)", () => {
    const line = formatConstraintRow({
      id: 3,
      constraint_text: "All DB access goes through storage/*.ts",
      level: "hard",
      source: "bootstrap",
      confidence: "high",
      flag: null,
      created_at: "2026-06-08T12:00:00Z",
      updated_at: "2026-06-08T12:00:00Z",
    });
    // Two consecutive pipes around the empty flag field.
    expect(line).toBe(
      "C 3|All DB access goes through storage/*.ts|hard|bootstrap|high||2026-06-08T12:00:00Z"
    );
  });

  it("renders a constraint row with a flag value", () => {
    const line = formatConstraintRow({
      id: 9,
      constraint_text: "Prefer esbuild over webpack for workers",
      level: "soft",
      source: "sync",
      confidence: "medium",
      flag: "stale",
      created_at: "2026-06-11T09:15:00Z",
      updated_at: "2026-06-11T09:15:00Z",
    });
    expect(line).toBe(
      "C 9|Prefer esbuild over webpack for workers|soft|sync|medium|stale|2026-06-11T09:15:00Z"
    );
  });
});

describe("formatContextRow (used by get_context)", () => {
  it("dispatches a DecisionRow to a D line", () => {
    const line = formatContextRow({
      kind: "D",
      id: 1,
      decision: "d",
      rationale: "r",
      alternatives_rejected: [],
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(line.startsWith("D ")).toBe(true);
  });

  it("dispatches a FailureRow to an F line", () => {
    const line = formatContextRow({
      kind: "F",
      id: 1,
      description: "d",
      cause: "c",
      approach_tried: "a",
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(line.startsWith("F ")).toBe(true);
  });
});

describe("formatOk / formatErr", () => {
  it("formats OK D 12 / OK F 7 / OK C 3 write confirmations", () => {
    expect(formatOk("D", 12)).toBe("OK D 12");
    expect(formatOk("F", 7)).toBe("OK F 7");
    expect(formatOk("C", 3)).toBe("OK C 3");
  });

  it("formats ERR <message> lines", () => {
    expect(formatErr("topic is required")).toBe("ERR topic is required");
  });
});

describe("Session-level schema-injection flag (EC-DM-08)", () => {
  it("starts false", () => {
    expect(hasSchemaBeenSent()).toBe(false);
  });

  it("flips to true after markSchemaSent()", () => {
    markSchemaSent();
    expect(hasSchemaBeenSent()).toBe(true);
  });

  it("takeSchemaHeaderIfNeeded returns the block on first call and null after", () => {
    const first = takeSchemaHeaderIfNeeded();
    expect(first).not.toBeNull();
    expect(first).toBe(
      "BRAIN DSL v1\n" + SCHEMA_FORMAT_LINES.join("\n")
    );
    // Caller is expected to call markSchemaSent() right after.
    markSchemaSent();
    expect(hasSchemaBeenSent()).toBe(true);
    expect(takeSchemaHeaderIfNeeded()).toBeNull();
  });

  it("resetSchemaSentForTesting clears the flag", () => {
    markSchemaSent();
    resetSchemaSentForTesting();
    expect(hasSchemaBeenSent()).toBe(false);
    expect(takeSchemaHeaderIfNeeded()).not.toBeNull();
  });
});

// ===========================================================================
// Graph DSL formatters (Spec 02 §3, §4)
// ===========================================================================

import {
  formatBlastLine,
  formatCallerChildLine,
  formatDepChildLine,
  formatDiffHeader,
  formatDiffLine,
  formatEntryHeader,
  formatGraphStats,
  formatNodeHeader,
  formatNodeLine,
  formatSectionHeader,
  GRAPH_INDEXED_HEADER,
  groupHopsByDepth,
  sortModulesAlphabetical,
} from "./dsl.js";

describe("formatNodeHeader", () => {
  it("wraps a module name in [brackets]", () => {
    expect(formatNodeHeader("src/api/login.ts")).toBe("[src/api/login.ts]");
  });
  it("escapes a literal pipe in the module name", () => {
    expect(formatNodeHeader("a|b")).toBe("[a\\|b]");
  });
});

describe("formatNodeLine — prefix flags", () => {
  it("renders a plain module without flags", () => {
    expect(formatNodeLine({ module: "x.ts" })).toBe("[x.ts]");
  });
  it("prefixes @ for entry points", () => {
    expect(formatNodeLine({ module: "x.ts", entryPoint: 1 })).toBe("@[x.ts]");
  });
  it("prefixes ~ for deprecated nodes (EC-CG-09)", () => {
    expect(formatNodeLine({ module: "x.ts", deprecated: 1 })).toBe("~[x.ts]");
  });
  it("co-occurs @~ for an entry point that is also deprecated (EC-CG-09)", () => {
    expect(
      formatNodeLine({ module: "x.ts", entryPoint: 1, deprecated: 1 })
    ).toBe("@~[x.ts]");
  });
  it("prefixes ! for side_effect edges", () => {
    expect(formatNodeLine({ module: "x.ts", sideEffect: true })).toBe(
      "![x.ts]"
    );
  });
  it("orders !, @, ~", () => {
    expect(
      formatNodeLine({
        module: "x.ts",
        sideEffect: true,
        entryPoint: 1,
        deprecated: 1,
      })
    ).toBe("!@~[x.ts]");
  });
  it("accepts boolean true for entryPoint/deprecated", () => {
    expect(
      formatNodeLine({ module: "x.ts", entryPoint: true, deprecated: true })
    ).toBe("@~[x.ts]");
  });
});

describe("formatSectionHeader / formatDepChildLine / formatCallerChildLine", () => {
  it("renders >deps d=<n>", () => {
    expect(formatSectionHeader("deps", 1)).toBe(">deps d=1");
  });
  it("renders ^callers d=<n>", () => {
    expect(formatSectionHeader("callers", 2)).toBe("^callers d=2");
  });
  it("omits d= when depth is null", () => {
    expect(formatSectionHeader("callers", null)).toBe("^callers");
  });
  it("formatDepChildLine with sideEffect", () => {
    expect(formatDepChildLine("db/users.ts", true, 1)).toBe("  !>[db/users.ts]");
  });
  it("formatDepChildLine without sideEffect", () => {
    expect(formatDepChildLine("auth/session.ts", false, 1)).toBe(
      "  >[auth/session.ts]"
    );
  });
  it("formatCallerChildLine indents by 1", () => {
    expect(formatCallerChildLine("api/login.ts", 1)).toBe("  ^[api/login.ts]");
  });
});

describe("formatBlastLine (get_blast_radius)", () => {
  it("renders `  d=<n> ^[module]`", () => {
    expect(formatBlastLine("api/login.ts", 1, 1)).toBe("  d=1 ^[api/login.ts]");
  });
});

describe("groupHopsByDepth + sortModulesAlphabetical", () => {
  it("groups hops by depth, preserves order, sorts modules within", () => {
    const hops = [
      { module: "z", depth: 1 },
      { module: "a", depth: 1 },
      { module: "m", depth: 2 },
    ];
    const groups = groupHopsByDepth(hops);
    expect(groups).toEqual([
      { depth: 1, modules: ["z", "a"] },
      { depth: 2, modules: ["m"] },
    ]);
    // Caller's responsibility to sort within.
    expect(sortModulesAlphabetical(groups[0].modules)).toEqual(["a", "z"]);
  });
});

describe("formatDiffLine / formatDiffHeader (diff_graph)", () => {
  it("renders +[a]>[b] for an added non-side-effect edge", () => {
    expect(
      formatDiffLine({ from: "a", to: "b", sideEffect: false, added: true })
    ).toBe("+[a]>[b]");
  });
  it("renders -[a]>[b] for a removed non-side-effect edge", () => {
    expect(
      formatDiffLine({ from: "a", to: "b", sideEffect: false, added: false })
    ).toBe("-[a]>[b]");
  });
  it("renders +!a>b for a side-effect edge (omits brackets around from)", () => {
    expect(
      formatDiffLine({ from: "a", to: "b", sideEffect: true, added: true })
    ).toBe("+!a>b");
  });
  it("renders -!a>b for a removed side-effect edge", () => {
    expect(
      formatDiffLine({ from: "a", to: "b", sideEffect: true, added: false })
    ).toBe("-!a>b");
  });
  it("formatDiffHeader", () => {
    expect(formatDiffHeader("a1b2c3d")).toBe("DIFF: since=a1b2c3d");
  });
});

describe("formatEntryHeader / GRAPH_INDEXED_HEADER / formatGraphStats", () => {
  it("formatEntryHeader", () => {
    expect(formatEntryHeader("add login")).toBe('ENTRY: intent="add login"');
  });
  it("formatEntryHeader escapes pipes in the intent", () => {
    expect(formatEntryHeader("a | b")).toBe('ENTRY: intent="a \\| b"');
  });
  it("GRAPH_INDEXED_HEADER is the literal string", () => {
    expect(GRAPH_INDEXED_HEADER).toBe("GRAPH: indexed");
  });
  it("formatGraphStats returns three lines", () => {
    expect(formatGraphStats(142, 389, 2140)).toEqual([
      "node_count=142",
      "edge_count=389",
      "duration_ms=2140",
    ]);
  });
});

// ===========================================================================
// Plan DSL formatters (Spec 03 §3, §4)
// ===========================================================================

import {
  formatFix,
  formatPlanVerdict,
  formatStepFinding,
} from "./dsl.js";

describe("formatPlanVerdict", () => {
  it("renders 'PLAN: approved' when approved=true", () => {
    expect(formatPlanVerdict(true)).toBe("PLAN: approved");
  });
  it("renders 'PLAN: blocked' when approved=false", () => {
    expect(formatPlanVerdict(false)).toBe("PLAN: blocked");
  });
});

describe("formatStepFinding", () => {
  it("uses 1-based step indexing", () => {
    expect(formatStepFinding(1, "reason")).toBe("step[1]=reason");
    expect(formatStepFinding(7, "reason")).toBe("step[7]=reason");
  });
  it("collapses newlines in the reason to a single space (Spec 03 §4)", () => {
    expect(formatStepFinding(2, "line1\nline2")).toBe("step[2]=line1 line2");
    expect(formatStepFinding(2, "a\rb\nc")).toBe("step[2]=a b c");
  });
  it("preserves literal '|' characters (Spec 03 §4 — `=` lines don't escape `|`)", () => {
    expect(formatStepFinding(1, "C1 | C2 | C3")).toBe("step[1]=C1 | C2 | C3");
  });
  it("accepts and preserves multi-word reasons", () => {
    expect(formatStepFinding(3, "Use the public API instead")).toBe(
      "step[3]=Use the public API instead"
    );
  });
});

describe("formatFix", () => {
  it("renders 'fix=<suggestion>'", () => {
    expect(formatFix("Use the public API of foo.ts")).toBe(
      "fix=Use the public API of foo.ts"
    );
  });
  it("collapses newlines in the suggestion to a single space", () => {
    expect(formatFix("line1\nline2")).toBe("fix=line1 line2");
  });
  it("preserves literal '|' characters", () => {
    expect(formatFix("A | B")).toBe("fix=A | B");
  });
});

// ===========================================================================
// Bootstrap DSL formatters (Spec 04 §3, §4)
// ===========================================================================

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
  formatModuleIntentOk,
  formatNextModule,
} from "./dsl.js";

describe("formatBootstrapStatus", () => {
  it("renders each of the three states", () => {
    expect(formatBootstrapStatus("complete")).toBe("BOOTSTRAP: complete");
    expect(formatBootstrapStatus("incomplete")).toBe("BOOTSTRAP: incomplete");
    expect(formatBootstrapStatus("never_run")).toBe("BOOTSTRAP: never_run");
  });
});

describe("formatBootstrapStatusStats", () => {
  it("renders modules= and intents= lines", () => {
    expect(formatBootstrapStatusStats(18, 11)).toEqual([
      "modules=18",
      "intents=11",
    ]);
  });
});

describe("formatBootstrapInProgress (next_module + progress)", () => {
  it("preserves literal '|' in the path (Spec 04 §4 same as Plan DSL §4)", () => {
    expect(formatNextModule("src/api|admin.ts")).toBe("next_module=src/api|admin.ts");
  });
  it("renders progress=covered/total", () => {
    expect(formatBootstrapProgress(3, 18)).toBe("progress=3/18");
    expect(formatBootstrapProgress(0, 0)).toBe("progress=0/0");
  });
});

describe("Bootstrap header constants", () => {
  it("match the spec's literal strings", () => {
    expect(BOOTSTRAP_IN_PROGRESS_HEADER).toBe("BOOTSTRAP: in_progress");
    expect(BOOTSTRAP_ALREADY_COMPLETE_HEADER).toBe("BOOTSTRAP: already_complete");
    expect(BOOTSTRAP_COMPLETE_HEADER).toBe("BOOTSTRAP: complete");
    expect(BOOTSTRAP_DRAFT_LINE).toBe("draft: constraints.md");
    expect(CONSTRAINTS_DRAFT_OK_HEADER).toBe("OK constraints.md");
  });
});

describe("Bootstrap OK / stat lines", () => {
  it("formatModuleIntentOk emits 'OK MI <id>'", () => {
    expect(formatModuleIntentOk(9)).toBe("OK MI 9");
  });
  it("formatConstraintsWritten emits 'constraints_written=<n>'", () => {
    expect(formatConstraintsWritten(0)).toBe("constraints_written=0");
    expect(formatConstraintsWritten(7)).toBe("constraints_written=7");
  });
  it("formatBootstrapModulesProcessed emits 'modules_processed=<n>'", () => {
    expect(formatBootstrapModulesProcessed(18)).toBe("modules_processed=18");
  });
  it("formatConstraintsDraft{Stats} emits the row/bootstrap/manual lines", () => {
    expect(formatConstraintsDraftRows(23)).toBe("rows=23");
    expect(formatConstraintsDraftBootstrap(7)).toBe("bootstrap=7");
    expect(formatConstraintsDraftManual(16)).toBe("manual=16");
  });
});
