// Tests for tools/validator.ts — the `validate_plan` MCP handler.
//
// Covers every item in Spec 03 §6 (Test Plan) and every EC-PV-NN edge
// case from §7. Each test is named after the traceable ID so the
// coverage is obvious at a glance.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { resetSchemaSentForTesting } from "../format/dsl.js";
import {
  createConstraintsSchema,
  insertConstraint,
} from "../storage/constraints.js";
import {
  createDecisionsSchema,
  insertFailure,
} from "../storage/decisions.js";
import {
  createGraphSchema,
  insertEdge,
  upsertNode,
} from "../storage/graph.js";

import {
  extractModuleMentions,
  tokenize,
  tokenOverlapCount,
  validatePlan,
} from "./validator.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  createGraphSchema(db);
  resetSchemaSentForTesting();
});


// ===========================================================================
// Test Plan items (Spec 03 §6)
// ===========================================================================

describe("Test Plan: happy path", () => {
  it("returns 'PLAN: approved' for a plan with no touching constraints/failures/boundaries", () => {
    const out = validatePlan(db, {
      steps: ["do thing", "do another thing"],
      task: "improve performance",
    });
    // The BRAIN DSL v1 header is emitted on the first call.
    expect(out).toMatch(/^BRAIN DSL v1\n/);
    expect(out).toMatch(/^PLAN: approved$/m);
    expect(out).not.toMatch(/^step\[/m);
    expect(out).not.toMatch(/^fix=/m);
  });
});

describe("Test Plan: empty-result / fresh project (EC-PV-04)", () => {
  it("returns 'PLAN: approved' for any plan when all tables are empty", () => {
    // Tables are empty in the beforeEach — no constraints, no failures,
    // no graph. This is the fresh-project case.
    const out = validatePlan(db, {
      steps: ["write a new feature", "deploy it", "test it"],
      task: "ship a feature",
    });
    expect(out).toMatch(/^PLAN: approved$/m);
  });
});

describe("Test Plan: invalid input", () => {
  it("steps=[] → ERR steps must be a non-empty array of non-empty strings", () => {
    expect(validatePlan(db, { steps: [], task: "x" })).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
  it("steps=[''] → ERR steps must be a non-empty array of non-empty strings", () => {
    expect(validatePlan(db, { steps: [""], task: "x" })).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
  it("steps=['  '] (whitespace-only) → ERR steps must be a non-empty array of non-empty strings", () => {
    expect(validatePlan(db, { steps: ["  "], task: "x" })).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
  it("steps=['do', '   '] (mixed) → ERR", () => {
    expect(validatePlan(db, { steps: ["do", "   "], task: "x" })).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
  it("task='' → ERR task is required", () => {
    expect(validatePlan(db, { steps: ["x"], task: "" })).toBe(
      "ERR task is required"
    );
  });
  it("task='   ' (whitespace) → ERR task is required", () => {
    expect(validatePlan(db, { steps: ["x"], task: "   " })).toBe(
      "ERR task is required"
    );
  });
  it("steps missing entirely → ERR steps must be a non-empty array of non-empty strings", () => {
    expect(validatePlan(db, { task: "x" } as unknown as { steps: string[]; task: string })).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
  it("steps not an array → ERR", () => {
    expect(
      validatePlan(db, { steps: "not an array", task: "x" } as unknown as { steps: string[]; task: string })
    ).toBe("ERR steps must be a non-empty array of non-empty strings");
  });
  it("non-object input → ERR", () => {
    expect(validatePlan(db, "garbage")).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
    expect(validatePlan(db, null)).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
    expect(validatePlan(db, undefined)).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
});

describe("Test Plan: cross-spec with Spec 01 (hard constraint + open failure)", () => {
  it("two steps each matching a different source → 'PLAN: blocked' with 2 findings, 1-indexed", () => {
    // Hard constraint about "payments"
    insertConstraint(
      db,
      "Do not edit payments processing logic directly",
      "hard",
      "manual",
      "high",
      null
    );
    // Open failure about tree-sitter WASM
    insertFailure(
      db,
      "tree-sitter WASM load in worker thread",
      "wasm load failure",
      "loaded tree-sitter wasm in a worker thread"
    );
    const out = validatePlan(db, {
      steps: [
        "Edit payments processing module",
        "load tree-sitter WASM in a worker thread to parse files",
        "do something unrelated",
      ],
      task: "refactor",
    });
    expect(out).toMatch(/^PLAN: blocked$/m);
    // Two findings, 1-indexed, in step order.
    expect(out).toMatch(/^step\[1\]=/m);
    expect(out).toMatch(/^fix=/m);
    expect(out).toMatch(/^step\[2\]=/m);
    expect(out).toMatch(/^fix=/m);
    // Step 3 (the unrelated one) is NOT flagged.
    expect(out).not.toMatch(/^step\[3\]=/m);
  });

  it("EC-PV-02: step that matches both a hard constraint and an open failure → constraint wins", () => {
    // Construct a step + constraint + failure such that both checkers
    // would match. Constraint: about "payments". Failure: also about
    // "payments" (different angle, same domain). Both should token-match
    // a step that mentions payments. Constraint checker runs first →
    // step is cited as the constraint hit.
    insertConstraint(
      db,
      "Do not modify payments subsystem directly",
      "hard",
      "manual",
      "high",
      null
    );
    insertFailure(
      db,
      "payments API integration broke last time",
      "wrong endpoint URL",
      "called payments API with v1 path"
    );
    const out = validatePlan(db, {
      steps: ["modify payments subsystem and call payments API"],
      task: "refactor",
    });
    expect(out).toMatch(/^PLAN: blocked$/m);
    expect(out).toMatch(/^step\[1\]=Step matches hard constraint C1 /m);
  });
});

describe("Test Plan: cross-spec with Spec 02 (architectural boundary)", () => {
  it("step names two modules with no edge + a boundary constraint → 'PLAN: blocked' with boundary finding", () => {
    // Boundary constraint: short, no module name in text (spec worked example).
    insertConstraint(
      db,
      "payments: API only",
      "hard",
      "manual",
      "high",
      null
    );
    // Two indexed modules.
    upsertNode(db, "infra/stripe.ts", "/p", 0);
    upsertNode(db, "api/billing.ts", "/p", 0);
    // No edge between them.
    const out = validatePlan(db, {
      steps: [
        "Editing infra/stripe.ts directly, also api/billing.ts changes",
      ],
      task: "refactor payments",
    });
    expect(out).toMatch(/^PLAN: blocked$/m);
    expect(out).toMatch(/^step\[1\]=Step crosses boundary of restricted module \[infra\/stripe\.ts\] into \[api\/billing\.ts\] /m);
    expect(out).toMatch(/^fix=Use the public API of \[infra\/stripe\.ts\] instead of importing it directly$/m);
  });

  it("EC-PV-07: step references a module not in graph_nodes → not a boundary violation", () => {
    insertConstraint(
      db,
      "payments: API only",
      "hard",
      "manual",
      "high",
      null
    );
    // Only one of the two mentioned modules is in graph_nodes.
    upsertNode(db, "api/billing.ts", "/p", 0);
    const out = validatePlan(db, {
      steps: [
        "Edit unindexed/payments.ts and api/billing.ts at the same time",
      ],
      task: "x",
    });
    // The unindexed module is silently ignored; only one module is
    // resolvable, so the boundary checker (which needs ≥ 2 resolved
    // modules) does not fire.
    expect(out).toMatch(/^PLAN: approved$/m);
  });

  it("edge connects the two named modules → no boundary violation (per §3 step 3)", () => {
    insertConstraint(
      db,
      "payments: API only",
      "hard",
      "manual",
      "high",
      null
    );
    const a = upsertNode(db, "infra/stripe.ts", "/p", 0);
    const b = upsertNode(db, "api/billing.ts", "/p", 0);
    insertEdge(db, a, b, "calls");
    const out = validatePlan(db, {
      steps: ["Edit infra/stripe.ts and api/billing.ts together"],
      task: "x",
    });
    expect(out).toMatch(/^PLAN: approved$/m);
  });
});

// ===========================================================================
// Edge cases (Spec 03 §7)
// ===========================================================================

describe("EC-PV-01: all steps pass all three checkers → PLAN: approved", () => {
  it("yields only the verdict line, no step/fix lines", () => {
    // Empty tables — all three checkers are no-ops.
    const out = validatePlan(db, {
      steps: ["do thing", "do another thing"],
      task: "x",
    });
    // After the (one-time) BRAIN DSL header, only the verdict.
    const lines = out.split("\n");
    const verdict = lines.find((l) => l.startsWith("PLAN:"));
    expect(verdict).toBe("PLAN: approved");
    expect(out).not.toMatch(/^step\[/m);
    expect(out).not.toMatch(/^fix=/m);
  });
});

describe("EC-PV-03: steps contains a whitespace-only element", () => {
  it("ERRs BEFORE the evaluation loop runs (no rows are scanned)", () => {
    // If we got into the loop, the failure row would be found and the
    // step would be flagged. So a clean ERR proves we bailed early.
    insertFailure(
      db,
      "tree-sitter WASM load in worker",
      "wasm load",
      "loaded tree-sitter wasm in worker"
    );
    const out = validatePlan(db, {
      steps: ["do thing", "   "],
      task: "x",
    });
    expect(out).toBe(
      "ERR steps must be a non-empty array of non-empty strings"
    );
  });
});

describe("EC-PV-05: token-overlap match (≥ 2 significant tokens)", () => {
  it("the tokenizer drops length-<4 tokens and stop-words", () => {
    // "the" / "and" / "with" / "this" / length-3 "edt" should all be
    // dropped. "payments" and "directly" are kept.
    const toks = tokenize("the and with this edt payments directly");
    expect(toks.has("the")).toBe(false);
    expect(toks.has("and")).toBe(false);
    expect(toks.has("with")).toBe(false);
    expect(toks.has("this")).toBe(false);
    expect(toks.has("edt")).toBe(false); // length < 4
    expect(toks.has("payments")).toBe(true);
    expect(toks.has("directly")).toBe(true);
  });

  it("tokenOverlapCount returns |A ∩ B|", () => {
    const a = tokenize("alpha beta gamma delta");
    const b = tokenize("beta delta epsilon");
    expect(tokenOverlapCount(a, b)).toBe(2);
    expect(tokenOverlapCount(a, new Set())).toBe(0);
    expect(tokenOverlapCount(a, a)).toBe(4);
  });

  it("step with 0 or 1 overlapping significant tokens is NOT a match", () => {
    // Hard constraint: "Use OAuth for external authentication"
    // Step: "Refactor the login flow with OAuth" — 1 overlap ("oauth").
    insertConstraint(
      db,
      "Use OAuth for external authentication",
      "hard",
      "manual",
      "high",
      null
    );
    const out = validatePlan(db, {
      steps: ["Refactor the login flow with OAuth"],
      task: "x",
    });
    // Only 1 overlap → not a match → approved.
    expect(out).toMatch(/^PLAN: approved$/m);
  });

  it("step with 2+ overlapping significant tokens IS a match", () => {
    // Same constraint, step with 2+ overlaps: "Replace login OAuth with
    // external authentication" — "oauth", "external", "authentication" = 3.
    insertConstraint(
      db,
      "Use OAuth for external authentication",
      "hard",
      "manual",
      "high",
      null
    );
    const out = validatePlan(db, {
      steps: ["Replace login OAuth with external authentication"],
      task: "x",
    });
    expect(out).toMatch(/^PLAN: blocked$/m);
    expect(out).toMatch(/^step\[1\]=Step matches hard constraint C1 /m);
  });
});

describe("EC-PV-06: boundary constraint phrasing (black box / API only / do not import directly)", () => {
  it("'API only' in constraint text marks it as a boundary constraint", () => {
    // Use a constraint text that does NOT overlap with the step (no
    // module name in it), so the constraint checker doesn't fire
    // first and we get to the boundary checker.
    insertConstraint(
      db,
      "payments: API only",
      "hard",
      "manual",
      "high",
      null
    );
    upsertNode(db, "infra/stripe.ts", "/p", 0);
    upsertNode(db, "api/billing.ts", "/p", 0);
    const out = validatePlan(db, {
      steps: ["Edit infra/stripe.ts and api/billing.ts"],
      task: "x",
    });
    expect(out).toMatch(/^step\[1\]=Step crosses boundary /m);
  });

  it("'black box' in constraint text marks it as a boundary constraint", () => {
    // Constraint text uses the phrase but no module name, so the
    // constraint checker doesn't match and the boundary checker fires.
    insertConstraint(
      db,
      "payments: black box — do not peek",
      "hard",
      "manual",
      "high",
      null
    );
    upsertNode(db, "infra/stripe.ts", "/p", 0);
    upsertNode(db, "api/billing.ts", "/p", 0);
    const out = validatePlan(db, {
      steps: ["Edit infra/stripe.ts and api/billing.ts together"],
      task: "x",
    });
    expect(out).toMatch(/^step\[1\]=Step crosses boundary /m);
  });

  it("'do not import directly' marks a constraint as boundary", () => {
    insertConstraint(
      db,
      "auth subsystem: do not import directly",
      "hard",
      "manual",
      "high",
      null
    );
    upsertNode(db, "auth/session.ts", "/p", 0);
    upsertNode(db, "api/routes.ts", "/p", 0);
    const out = validatePlan(db, {
      steps: ["Edit auth/session.ts and api/routes.ts together"],
      task: "x",
    });
    expect(out).toMatch(/^step\[1\]=Step crosses boundary /m);
  });

  it("a hard constraint WITHOUT a boundary phrase does NOT trigger the boundary checker", () => {
    // Hard constraint that does NOT contain a boundary phrase and that
    // DOES share 2+ tokens with the step (so the constraint checker
    // fires first, and the boundary checker should NOT fire because
    // the constraint is not a "boundary" constraint).
    insertConstraint(
      db,
      "Refactor login flow with OAuth tokens",
      "hard",
      "manual",
      "high",
      null
    );
    upsertNode(db, "auth/oauth.ts", "/p", 0);
    upsertNode(db, "auth/session.ts", "/p", 0);
    // No edge between them.
    const out = validatePlan(db, {
      steps: ["Refactor auth/oauth.ts and auth/session.ts together"],
      task: "x",
    });
    // Constraint checker fires (token overlap: refactor, auth).
    // Boundary checker should NOT fire (no boundary phrase in C1).
    expect(out).toMatch(/^step\[1\]=Step matches hard constraint C1 /m);
    expect(out).not.toMatch(/crosses boundary/m);
  });
});

describe("EC-PV-08: multiple steps flagged → step[n]= in input order", () => {
  it("3 of 5 steps flagged across all three checkers → 3 findings, in step-index order", () => {
    // Step 2 → hard constraint match
    insertConstraint(
      db,
      "Do not edit payments processing logic directly",
      "hard",
      "manual",
      "high",
      null
    );
    // Step 4 → open failure match
    insertFailure(
      db,
      "tree-sitter WASM load in worker thread",
      "wasm load",
      "loaded tree-sitter wasm in worker"
    );
    // Step 5 → architectural boundary
    insertConstraint(
      db,
      "payments: API only",
      "hard",
      "manual",
      "high",
      null
    );
    upsertNode(db, "infra/stripe.ts", "/p", 0);
    upsertNode(db, "db/invoices.ts", "/p", 0);
    const out = validatePlan(db, {
      steps: [
        "do something unrelated", // step 1, no match
        "Edit payments processing logic", // step 2, constraint match
        "do another unrelated thing", // step 3, no match
        "load tree-sitter WASM in a worker thread", // step 4, failure match
        "Edit infra/stripe.ts and db/invoices.ts directly", // step 5, boundary
      ],
      task: "x",
    });
    expect(out).toMatch(/^PLAN: blocked$/m);
    // Three findings.
    const stepLines = out
      .split("\n")
      .filter((l) => /^step\[\d+\]=/.test(l));
    expect(stepLines).toHaveLength(3);
    // In step-index order.
    expect(stepLines[0]).toMatch(/^step\[2\]=/);
    expect(stepLines[1]).toMatch(/^step\[4\]=/);
    expect(stepLines[2]).toMatch(/^step\[5\]=/);
  });
});

// ===========================================================================
// extractModuleMentions unit tests
// ===========================================================================

describe("extractModuleMentions (helper for boundary checker)", () => {
  it("returns an empty array when no module-like substring is present", () => {
    expect(extractModuleMentions("do some unrelated thing")).toEqual([]);
  });
  it("extracts dotted module names (path/file.ext)", () => {
    expect(extractModuleMentions("Edit infra/stripe.ts and api/billing.ts")).toEqual([
      "infra/stripe.ts",
      "api/billing.ts",
    ]);
  });
  it("extracts undotted module names (path/dir)", () => {
    expect(extractModuleMentions("Edit auth/session together")).toEqual([
      "auth/session",
    ]);
  });
  it("ignores single-word bare basenames (no path separator)", () => {
    expect(extractModuleMentions("rename foo to bar")).toEqual([]);
  });
  it("returns matches in source order", () => {
    const out = extractModuleMentions("a/b.ts and c/d/e.py then f/g.ts");
    expect(out).toEqual(["a/b.ts", "c/d/e.py", "f/g.ts"]);
  });
});

// ===========================================================================
// Schema-header coordination with Specs 01/02
// ===========================================================================

describe("BRAIN DSL v1 header coordination with Specs 01/02/06", () => {
  it("first call of the session emits the header", () => {
    const out = validatePlan(db, { steps: ["x"], task: "y" });
    expect(out.startsWith("BRAIN DSL v1\n")).toBe(true);
  });
  it("subsequent calls of the session omit the header", () => {
    validatePlan(db, { steps: ["x"], task: "y" });
    const out2 = validatePlan(db, { steps: ["x"], task: "y" });
    expect(out2.startsWith("BRAIN DSL v1")).toBe(false);
  });
});
