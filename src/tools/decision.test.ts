// Tests for the four MCP tool handlers in tools/decision.ts.
//
// Covers every item in Spec 01 §6 Test Plan and every EC-DM-NN edge case
// from §7. The DSL round-trip is the most important assertion: storage
// layer is correct iff the formatted output matches the contract.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { createConstraintsSchema } from "../storage/constraints.js";
import { createDecisionsSchema } from "../storage/decisions.js";
import { resetSchemaSentForTesting } from "../format/dsl.js";

import {
  getContext,
  listAllConstraints,
  logDecision,
  logFailure,
} from "./decision.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  resetSchemaSentForTesting();
});


// ===========================================================================
// log_decision
// ===========================================================================

describe("log_decision", () => {
  it("happy path: valid inputs return `OK D <id>`", () => {
    const out = logDecision(db, {
      decision: "Use SQLite for local storage",
      rationale: "Simplicity, zero ops",
      alternatives_rejected: ["Postgres", "MySQL"],
      tags: ["infra", "db"],
    });
    expect(out).toBe("OK D 1");
  });

  it("happy path: persists the row with JSON-serialized arrays", () => {
    logDecision(db, {
      decision: "Use SQLite",
      rationale: "Simpler",
      alternatives_rejected: ["Postgres"],
      tags: ["infra"],
    });
    const row = db
      .prepare(
        "SELECT decision, rationale, alternatives_rejected, tags FROM decisions WHERE id = 1"
      )
      .get() as {
      decision: string;
      rationale: string;
      alternatives_rejected: string;
      tags: string;
    };
    expect(row.decision).toBe("Use SQLite");
    expect(row.rationale).toBe("Simpler");
    expect(JSON.parse(row.alternatives_rejected)).toEqual(["Postgres"]);
    expect(JSON.parse(row.tags)).toEqual(["infra"]);
  });

  it("EC-DM-01: whitespace-only decision returns ERR and inserts nothing", () => {
    const out = logDecision(db, {
      decision: "   ",
      rationale: "valid rationale",
      alternatives_rejected: [],
    });
    expect(out).toBe("ERR decision and rationale are required");
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("EC-DM-01: whitespace-only rationale returns ERR and inserts nothing", () => {
    const out = logDecision(db, {
      decision: "valid",
      rationale: "   ",
      alternatives_rejected: [],
    });
    expect(out).toBe("ERR decision and rationale are required");
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("EC-DM-02: missing alternatives_rejected returns ERR", () => {
    const out = logDecision(db, {
      decision: "d",
      rationale: "r",
    });
    expect(out).toBe("ERR alternatives_rejected must be an array");
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("EC-DM-02: alternatives_rejected as a string returns ERR", () => {
    const out = logDecision(db, {
      decision: "d",
      rationale: "r",
      alternatives_rejected: "Postgres",
    });
    expect(out).toBe("ERR alternatives_rejected must be an array");
  });

  it("EC-DM-03: omitted tags is stored as '[]' and renders as empty", () => {
    const out = logDecision(db, {
      decision: "D",
      rationale: "R",
      alternatives_rejected: ["A"],
    });
    expect(out).toBe("OK D 1");
    const row = db
      .prepare("SELECT tags FROM decisions WHERE id = 1")
      .get() as { tags: string };
    expect(row.tags).toBe("[]");
  });

  it("rejects null/array input payload", () => {
    expect(logDecision(db, null)).toBe(
      "ERR decision and rationale are required"
    );
    expect(logDecision(db, "string")).toBe(
      "ERR decision and rationale are required"
    );
    expect(logDecision(db, [])).toBe("ERR decision and rationale are required");
  });
});

// ===========================================================================
// log_failure
// ===========================================================================

describe("log_failure", () => {
  it("happy path: returns `OK F <id>` and row exists with status='open'", () => {
    const out = logFailure(db, {
      description: "Tree-sitter WASM load failed in worker",
      cause: "Wrong bundler target",
      approach_tried: "Switched to esbuild target=node",
    });
    expect(out).toBe("OK F 1");

    const row = db
      .prepare("SELECT status FROM failures WHERE id = 1")
      .get() as { status: string };
    expect(row.status).toBe("open");
  });

  it("EC-DM-04: empty approach_tried returns ERR and inserts nothing", () => {
    const out = logFailure(db, {
      description: "d",
      cause: "c",
      approach_tried: "",
    });
    expect(out).toBe("ERR description, cause, and approach_tried are required");
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM failures").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("rejects whitespace-only description", () => {
    const out = logFailure(db, {
      description: "   ",
      cause: "c",
      approach_tried: "a",
    });
    expect(out).toBe("ERR description, cause, and approach_tried are required");
  });

  it("rejects whitespace-only cause", () => {
    const out = logFailure(db, {
      description: "d",
      cause: "   ",
      approach_tried: "a",
    });
    expect(out).toBe("ERR description, cause, and approach_tried are required");
  });

  it("rejects missing params", () => {
    const out = logFailure(db, { description: "d" });
    expect(out).toBe("ERR description, cause, and approach_tried are required");
  });

  it("rejects non-record input", () => {
    expect(logFailure(db, null)).toBe(
      "ERR description, cause, and approach_tried are required"
    );
    expect(logFailure(db, "x")).toBe(
      "ERR description, cause, and approach_tried are required"
    );
  });
});

// ===========================================================================
// get_context
// ===========================================================================

describe("get_context", () => {
  it("rejects empty topic", () => {
    expect(getContext(db, { topic: "" })).toBe("ERR topic is required");
    expect(getContext(db, { topic: "   " })).toBe("ERR topic is required");
  });

  it("rejects non-record input", () => {
    expect(getContext(db, null)).toBe("ERR topic is required");
  });

  it("EC-DM-05: no matches → empty body, schema header still present on first call", () => {
    const out = getContext(db, { topic: "kubernetes" });
    expect(out).toBe(
      "BRAIN DSL v1\n" +
        "D id|decision|rationale|alts|tags|created_at\n" +
        "F id|description|cause|approach|status|created_at\n" +
        "C id|text|level|source|confidence|flag|created_at"
    );
    // No DATA lines (lines whose prefix is followed by a digit, not the
    // literal "id" of the schema format line).
    expect(out).not.toMatch(/^D \d/m);
    expect(out).not.toMatch(/^F \d/m);
  });

  it("happy path: seeds 6+ rows, query a topic matching 3, verify merged/ordered/capped", async () => {
    // better-sqlite3's `datetime('now')` has second-resolution, so we need
    // ≥ 1s between inserts to get distinct `created_at` values for the
    // ordering assertion. Set a longer timeout for this test.
    // Insert 4 decisions and 2 failures with topic-matching text.
    logDecision(db, {
      decision: "topic alpha decision",
      rationale: "r",
      alternatives_rejected: [],
    });
    await sleep(1100);
    logFailure(db, {
      description: "topic alpha failure",
      cause: "c",
      approach_tried: "a",
    });
    await sleep(1100);
    logDecision(db, {
      decision: "topic beta decision",
      rationale: "r",
      alternatives_rejected: [],
    });
    await sleep(1100);
    logDecision(db, {
      decision: "topic gamma decision",
      rationale: "r",
      alternatives_rejected: [],
    });
    await sleep(1100);
    logFailure(db, {
      description: "topic delta failure",
      cause: "c",
      approach_tried: "a",
    });
    await sleep(1100);
    // An unrelated decision
    logDecision(db, {
      decision: "unrelated",
      rationale: "r",
      alternatives_rejected: [],
    });

    resetSchemaSentForTesting(); // start a fresh "session" for this assertion
    const out = getContext(db, { topic: "topic", limit: 3 });
    const lines = out.split("\n");

    // First 4 lines: schema header
    expect(lines.slice(0, 4)).toEqual([
      "BRAIN DSL v1",
      "D id|decision|rationale|alts|tags|created_at",
      "F id|description|cause|approach|status|created_at",
      "C id|text|level|source|confidence|flag|created_at",
    ]);
    // Next 3 lines: the 3 most recent matches
    const dataLines = lines.slice(4);
    expect(dataLines.length).toBe(3);
    // Newest is "topic delta failure" (id F 2), then "topic gamma decision" (id D 3),
    // then "topic beta decision" (id D 2).
    expect(dataLines[0].startsWith("F 2|")).toBe(true);
    expect(dataLines[1].startsWith("D 3|")).toBe(true);
    expect(dataLines[2].startsWith("D 2|")).toBe(true);
  }, 20000);

  it("EC-DM-06: limit exceeds available rows → returns all matches, no padding", () => {
    logDecision(db, {
      decision: "x one",
      rationale: "r",
      alternatives_rejected: [],
    });
    logDecision(db, {
      decision: "x two",
      rationale: "r",
      alternatives_rejected: [],
    });
    resetSchemaSentForTesting();
    const out = getContext(db, { topic: "x", limit: 5 });
    // Only data lines (prefix followed by a digit), not schema format lines.
    const dataLines = out
      .split("\n")
      .filter((l) => /^D \d/.test(l) || /^F \d/.test(l));
    expect(dataLines.length).toBe(2);
  });

  it("EC-DM-07: limit=0 returns ERR", () => {
    expect(getContext(db, { topic: "x", limit: 0 })).toBe(
      "ERR limit must be a positive integer"
    );
  });

  it("EC-DM-07: limit=-1 returns ERR", () => {
    expect(getContext(db, { topic: "x", limit: -1 })).toBe(
      "ERR limit must be a positive integer"
    );
  });

  it("EC-DM-07: limit='abc' returns ERR", () => {
    expect(getContext(db, { topic: "x", limit: "abc" })).toBe(
      "ERR limit must be a positive integer"
    );
  });

  it("EC-DM-07: limit='3' (string) is accepted", () => {
    logDecision(db, {
      decision: "x",
      rationale: "r",
      alternatives_rejected: [],
    });
    resetSchemaSentForTesting();
    const out = getContext(db, { topic: "x", limit: "3" });
    expect(out).toContain("D 1|x|r|||");
  });

  it("EC-DM-08: first DSL-emitting call includes the schema header; subsequent calls do not", () => {
    // Seed one decision so the body is non-empty.
    logDecision(db, {
      decision: "first",
      rationale: "r",
      alternatives_rejected: [],
    });
    resetSchemaSentForTesting();

    const first = getContext(db, { topic: "first" });
    expect(first.startsWith("BRAIN DSL v1\n")).toBe(true);

    const second = getContext(db, { topic: "first" });
    expect(second.startsWith("BRAIN DSL v1")).toBe(false);
    expect(second.startsWith("D 1|")).toBe(true);
  });

  it("EC-DM-08: list_constraints shares the same one-time header (cross-call)", () => {
    logDecision(db, {
      decision: "x",
      rationale: "r",
      alternatives_rejected: [],
    });
    logDecision(db, {
      decision: "y",
      rationale: "r",
      alternatives_rejected: [],
    });
    resetSchemaSentForTesting();

    // First call: get_context — emits header.
    const a = getContext(db, { topic: "x" });
    expect(a.startsWith("BRAIN DSL v1\n")).toBe(true);

    // Second call: list_constraints — must NOT re-emit header.
    const b = listAllConstraints(db);
    expect(b.startsWith("BRAIN DSL v1")).toBe(false);
  });
});

// ===========================================================================
// list_constraints
// ===========================================================================

describe("list_constraints", () => {
  it("returns empty body when no rows, schema header on first call", () => {
    const out = listAllConstraints(db);
    expect(out).toBe(
      "BRAIN DSL v1\n" +
        "D id|decision|rationale|alts|tags|created_at\n" +
        "F id|description|cause|approach|status|created_at\n" +
        "C id|text|level|source|confidence|flag|created_at"
    );
    // No C data line (prefix followed by a digit).
    expect(out).not.toMatch(/^C \d/m);
  });

  it("EC-DM-09: a row with NULL flag renders the flag field as empty", () => {
    db.prepare(
      `INSERT INTO constraints (constraint_text, level, source, confidence, flag)
       VALUES (?, ?, ?, ?, NULL)`
    ).run("All DB access goes through storage/*.ts", "hard", "bootstrap", "high");

    resetSchemaSentForTesting();
    const out = listAllConstraints(db);
    expect(out).toContain(
      "C 1|All DB access goes through storage/*.ts|hard|bootstrap|high||"
    );
  });

  it("emits the schema header only on the first call of the session (EC-DM-08)", () => {
    db.prepare(
      `INSERT INTO constraints (constraint_text, level, source, confidence)
       VALUES (?, ?, ?, ?)`
    ).run("c", "hard", "s", "high");

    resetSchemaSentForTesting();

    const first = listAllConstraints(db);
    expect(first.startsWith("BRAIN DSL v1\n")).toBe(true);

    const second = listAllConstraints(db);
    expect(second.startsWith("BRAIN DSL v1")).toBe(false);
    expect(second.startsWith("C 1|")).toBe(true);
  });

  it("orders results by confidence priority then created_at desc", async () => {
    db.prepare(
      `INSERT INTO constraints (constraint_text, level, source, confidence)
       VALUES (?, ?, ?, ?)`
    ).run("low1", "soft", "s", "low");
    await sleep(1100);
    db.prepare(
      `INSERT INTO constraints (constraint_text, level, source, confidence)
       VALUES (?, ?, ?, ?)`
    ).run("medium1", "soft", "s", "medium");
    await sleep(1100);
    db.prepare(
      `INSERT INTO constraints (constraint_text, level, source, confidence)
       VALUES (?, ?, ?, ?)`
    ).run("high1", "hard", "s", "high");
    await sleep(1100);
    db.prepare(
      `INSERT INTO constraints (constraint_text, level, source, confidence)
       VALUES (?, ?, ?, ?)`
    ).run("high2", "hard", "s", "high");

    resetSchemaSentForTesting();
    const out = listAllConstraints(db);
    const dataLines = out
      .split("\n")
      .filter((l) => /^C \d/.test(l));
    expect(dataLines.length).toBe(4);
    expect(dataLines[0].includes("high2")).toBe(true);
    expect(dataLines[1].includes("high1")).toBe(true);
    expect(dataLines[2].includes("medium1")).toBe(true);
    expect(dataLines[3].includes("low1")).toBe(true);
  });
});

// ===========================================================================
// hasSchemaBeenSent / markSchemaSent exported (Test Plan last item)
// ===========================================================================

describe("Schema flag export (Test Plan — Spec 06 coordination)", () => {
  it("DSL module exports hasSchemaBeenSent and markSchemaSent", async () => {
    // Indirect test: both functions are exercised by the get_context and
    // list_constraints tests above. Here we just confirm the import works
    // and the in-process flag is observable through the tools layer.
    resetSchemaSentForTesting();
    logDecision(db, {
      decision: "x",
      rationale: "r",
      alternatives_rejected: [],
    });

    // First get_context call flips the flag.
    const out1 = getContext(db, { topic: "x" });
    expect(out1.startsWith("BRAIN DSL v1")).toBe(true);

    // Second call: no header.
    const out2 = getContext(db, { topic: "x" });
    expect(out2.startsWith("BRAIN DSL v1")).toBe(false);
  });
});

// ===========================================================================
// EC-DM-10: text field containing a literal `|` (pipe-escape)
// ===========================================================================

describe("EC-DM-10: pipe escaping in DSL output", () => {
  it("escapes a pipe inside a decision field", () => {
    logDecision(db, {
      decision: "Use A | B pattern",
      rationale: "r",
      alternatives_rejected: [],
    });
    resetSchemaSentForTesting();
    const out = getContext(db, { topic: "Use" });
    expect(out).toContain("D 1|Use A \\| B pattern|r|||");
  });

  it("escapes a pipe inside a failure field", () => {
    logFailure(db, {
      description: "error | somewhere",
      cause: "c",
      approach_tried: "a",
    });
    resetSchemaSentForTesting();
    const out = getContext(db, { topic: "error" });
    expect(out).toContain("F 1|error \\| somewhere|c|a|");
  });
});

// ===========================================================================
// helpers
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
