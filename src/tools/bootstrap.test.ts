// Tests for tools/bootstrap.ts — the four Spec 04 MCP handlers.
// Covers every Test Plan item (Spec 04 §6) and every EC-BA-NN edge case
// (Spec 04 §7). Each test uses its own fresh in-memory DB.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetSchemaSentForTesting } from "../format/dsl.js";
import { insertConstraint, listConstraints } from "../storage/constraints.js";
import {
  createBootstrapSchema,
  insertModuleIntent,
  listModuleIntents,
} from "../storage/bootstrap.js";
import { createConstraintsSchema } from "../storage/constraints.js";
import { createDecisionsSchema } from "../storage/decisions.js";
import { createGraphSchema, upsertNode } from "../storage/graph.js";

import {
  getBootstrapStatus,
  logModuleIntent,
  runBootstrap,
  writeConstraintsDraft,
} from "./bootstrap.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  createGraphSchema(db);
  createBootstrapSchema(db);
  resetSchemaSentForTesting();
});

afterEach(() => {
  db.close();
});

function mdPath(): string {
  return join(tmpdir(), `spec04-${Date.now()}.md`);
}

// ---------------------------------------------------------------------------
// get_bootstrap_status
// ---------------------------------------------------------------------------

describe("get_bootstrap_status", () => {
  it("empty DB → BOOTSTRAP: never_run", () => {
    expect(getBootstrapStatus(db)).toBe("BOOTSTRAP: never_run");
  });

  it("graph_nodes populated, no intents → incomplete with stats", () => {
    upsertNode(db, "a.ts", "/a", 0);
    upsertNode(db, "b.ts", "/b", 0);
    expect(getBootstrapStatus(db)).toBe(
      "BOOTSTRAP: incomplete\nmodules=2\nintents=0"
    );
  });

  it("all modules covered → complete with stats", () => {
    upsertNode(db, "a.ts", "/a", 0);
    upsertNode(db, "b.ts", "/b", 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    insertModuleIntent(db, "b.ts", "y", [], []);
    expect(getBootstrapStatus(db)).toBe(
      "BOOTSTRAP: complete\nmodules=2\nintents=2"
    );
  });

  it("partial coverage → incomplete", () => {
    upsertNode(db, "a.ts", "/a", 0);
    upsertNode(db, "b.ts", "/b", 0);
    upsertNode(db, "c.ts", "/c", 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    expect(getBootstrapStatus(db)).toBe(
      "BOOTSTRAP: incomplete\nmodules=3\nintents=1"
    );
  });
});

// ---------------------------------------------------------------------------
// log_module_intent
// ---------------------------------------------------------------------------

describe("log_module_intent", () => {
  it("EC-BA-04: accepts a module not in graph_nodes (offline)", () => {
    const out = logModuleIntent(db, {
      module: "not-yet-indexed.ts",
      intent: "x",
      constraints: [],
      caveats: [],
    });
    expect(out).toBe("OK MI 1\nconstraints_written=0");
    expect(listModuleIntents(db)).toHaveLength(1);
  });

  it("EC-BA-03: constraints=[] → 0 Spec 01 constraint rows", () => {
    logModuleIntent(db, {
      module: "a.ts",
      intent: "x",
      constraints: [],
      caveats: [],
    });
    expect(listConstraints(db)).toHaveLength(0);
  });

  it("writes one Spec 01 constraint per element (soft/bootstrap/medium)", () => {
    const out = logModuleIntent(db, {
      module: "a.ts",
      intent: "x",
      constraints: ["uses SQLite", "single file", "no transactions"],
      caveats: [],
    });
    expect(out).toBe("OK MI 1\nconstraints_written=3");
    const rows = listConstraints(db);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.source).toBe("bootstrap");
      expect(r.level).toBe("soft");
      expect(r.confidence).toBe("medium");
      expect(r.flag).toBeNull();
    }
  });

  it("EC-BA-03: empty constraint strings are skipped", () => {
    const out = logModuleIntent(db, {
      module: "a.ts",
      intent: "x",
      constraints: ["real", "", "  "],
      caveats: [],
    });
    expect(out).toBe("OK MI 1\nconstraints_written=1");
    expect(listConstraints(db)).toHaveLength(1);
  });

  it("ERR: empty module", () => {
    expect(
      logModuleIntent(db, {
        module: "",
        intent: "x",
        constraints: [],
        caveats: [],
      })
    ).toBe("ERR module and intent are required");
  });

  it("ERR: whitespace-only intent", () => {
    expect(
      logModuleIntent(db, {
        module: "a",
        intent: "  ",
        constraints: [],
        caveats: [],
      })
    ).toBe("ERR module and intent are required");
  });

  it("ERR: constraints not an array", () => {
    expect(
      logModuleIntent(db, {
        module: "a",
        intent: "x",
        constraints: "not array",
        caveats: [],
      })
    ).toBe("ERR constraints and caveats must be arrays");
  });

  it("ERR: caveats not an array", () => {
    expect(
      logModuleIntent(db, {
        module: "a",
        intent: "x",
        constraints: [],
        caveats: null,
      })
    ).toBe("ERR constraints and caveats must be arrays");
  });

  it("ERR: non-string element in constraints", () => {
    expect(
      logModuleIntent(db, {
        module: "a",
        intent: "x",
        constraints: ["v", 42 as unknown as string],
        caveats: [],
      })
    ).toBe("ERR constraints and caveats must be arrays");
  });

  it("ERR: non-object", () => {
    expect(logModuleIntent(db, "garbage")).toBe(
      "ERR module and intent are required"
    );
    expect(logModuleIntent(db, null)).toBe(
      "ERR module and intent are required"
    );
  });
});

// ---------------------------------------------------------------------------
// write_constraints_draft
// ---------------------------------------------------------------------------

describe("write_constraints_draft", () => {
  it("writes constraints.md with Spec 05 file format", () => {
    insertConstraint(db, "Use SQLite", "soft", "manual", "high", null);
    insertConstraint(db, "Payments black box", "hard", "manual", "high", null);
    const path = mdPath();
    const out = writeConstraintsDraft(db, path);
    expect(out).toMatch(/^OK constraints\.md\n/);
    expect(out).toContain("rows=2");
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/version: 3/);
    expect(content).toMatch(/last_updated:/);
    expect(content).toMatch(/last_synced:/);
    expect(content).toMatch(/# Constraints/);
    expect(content).toMatch(/## Architectural Boundaries/);
    expect(content).toMatch(/## Technology Constraints/);
    expect(content).toMatch(/## ⚠ Flagged for Review/);
    expect(content).toMatch(/\[C\d{3}\] \(hard, manual, high\)/);
    expect(content).toMatch(/\[C\d{3}\] \(soft, manual, high\)/);
    rmSync(path, { force: true });
  });

  it("EC-BA-05: bootstrap vs. manual counts (sync rows roll into manual)", () => {
    insertConstraint(db, "C1", "soft", "manual", "high", null);
    insertConstraint(db, "C2", "soft", "bootstrap", "medium", null);
    insertConstraint(db, "C3", "soft", "sync", "high", null);
    const path = mdPath();
    const out = writeConstraintsDraft(db, path);
    expect(out).toContain("rows=3");
    expect(out).toContain("bootstrap=1");
    expect(out).toContain("manual=2");
    rmSync(path, { force: true });
  });

  it("empty constraints → OK constraints.md with 0s, file still written", () => {
    const path = mdPath();
    const out = writeConstraintsDraft(db, path);
    expect(out).toMatch(/^OK constraints\.md\n/);
    expect(out).toContain("rows=0");
    expect(out).toContain("bootstrap=0");
    expect(out).toContain("manual=0");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("_(none)_");
    rmSync(path, { force: true });
  });

  it("flagged constraints appear in both primary and flagged sections", () => {
    insertConstraint(
      db,
      "Hard one",
      "hard",
      "manual",
      "high",
      "stale edge in abc123"
    );
    const path = mdPath();
    writeConstraintsDraft(db, path);
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/- \[C\d{3}\] \(hard, manual, high\) Hard one\n/);
    expect(content).toMatch(
      /\[C\d{3}\] \(hard, manual, high\) Hard one — flagged: stale edge in abc123/
    );
    rmSync(path, { force: true });
  });
});

// ---------------------------------------------------------------------------
// run_bootstrap
// ---------------------------------------------------------------------------

describe("run_bootstrap", () => {
  function fixtureDir(): string {
    const d = join(tmpdir(), `spec04-fixture-${Date.now()}-${Math.random()}`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  // writeFixtures removed — we pre-seed graph_nodes directly.
  function extractNext(dsl: string): string {
    return dsl.match(/^next_module=(.+)$/m)?.[1] ?? "";
  }
  function progress(dsl: string): string {
    return dsl.match(/^progress=(.+)$/m)?.[1] ?? "";
  }

  afterEach(() => {
    // Clean up fixture dirs created during this test
  });

  it("empty fixture → complete on first call", () => {
    const dir = fixtureDir();
    const out = runBootstrap(db, { path: dir });
    expect(out).toMatch(/^BOOTSTRAP: complete\n/);
    expect(out).toMatch(/modules_processed=0/);
    expect(out).toMatch(/constraints_written=0/);
    expect(out).toMatch(/draft: constraints\.md/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("3 modules → multi-turn: in_progress x3, then complete", () => {
    // Pre-seed graph_nodes directly so re-indexing an empty fixture
    // does NOT add new rows (incremental indexer only adds nodes not
    // yet in the graph). This makes the test deterministic regardless
    // of how many .ts files exist in the fixture directory.
    const dir = fixtureDir();
    upsertNode(db, "src/a.ts", join(dir, "src/a.ts"), 0);
    upsertNode(db, "src/b.ts", join(dir, "src/b.ts"), 0);
    upsertNode(db, "src/c.ts", join(dir, "src/c.ts"), 0);

    const r1 = runBootstrap(db, { path: dir });
    expect(r1).toMatch(/^BOOTSTRAP: in_progress\n/);
    expect(r1).toMatch(/progress=0\/3/);

    logModuleIntent(db, {
      module: "src/a.ts",
      intent: "x",
      constraints: [],
      caveats: [],
    });
    const r2 = runBootstrap(db, { path: dir });
    expect(r2).toMatch(/progress=1\/3/);

    logModuleIntent(db, {
      module: "src/b.ts",
      intent: "x",
      constraints: ["uses SQLite"],
      caveats: [],
    });
    const r3 = runBootstrap(db, { path: dir });
    expect(r3).toMatch(/progress=2\/3/);

    logModuleIntent(db, {
      module: "src/c.ts",
      intent: "x",
      constraints: [],
      caveats: [],
    });
    const r4 = runBootstrap(db, { path: dir });
    expect(r4).toMatch(/^BOOTSTRAP: complete\n/);
    expect(r4).toMatch(/modules_processed=3/);
    expect(r4).toMatch(/constraints_written=1/);

    expect(getBootstrapStatus(db)).toBe(
      "BOOTSTRAP: complete\nmodules=3\nintents=3"
    );
    expect(listModuleIntents(db)).toHaveLength(3);
    const boot = listConstraints(db).filter(
      (c) => c.source === "bootstrap"
    );
    expect(boot).toHaveLength(1);
    expect(boot[0]!.constraint_text).toBe("uses SQLite");
    expect(boot[0]!.level).toBe("soft");
    expect(boot[0]!.confidence).toBe("medium");
    rmSync(dir, { recursive: true, force: true });
  });

  it("EC-BA-01: calling run_bootstrap when status is already complete", () => {
    // Pre-seed graph_nodes and module_intents directly so status is
    // complete before runBootstrap is called. Pass an empty fixture
    // directory so re-indexing finds nothing new. Since status is
    // complete before the call, the next uncovered is null and the
    // call returns complete (with constraints.md written).
    const dir = fixtureDir();
    upsertNode(db, "a.ts", join(dir, "a.ts"), 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    const out = runBootstrap(db, { path: dir });
    expect(out).toMatch(/^BOOTSTRAP: complete\n/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("EC-BA-02: partial prior coverage → next uncovered, progress reflects coverage", () => {
    const dir = fixtureDir();
    upsertNode(db, "a.ts", join(dir, "a.ts"), 0);
    upsertNode(db, "b.ts", join(dir, "b.ts"), 0);
    upsertNode(db, "c.ts", join(dir, "c.ts"), 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    insertModuleIntent(db, "b.ts", "y", [], []);
    const out = runBootstrap(db, { path: dir });
    expect(out).toMatch(/^BOOTSTRAP: in_progress\n/);
    expect(out).toMatch(/progress=2\/3/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("EC-BA-07: double call without log_module_intent → same next_module/progress", () => {
    const dir = fixtureDir();
    upsertNode(db, "a.ts", join(dir, "a.ts"), 0);
    upsertNode(db, "b.ts", join(dir, "b.ts"), 0);
    const r1 = runBootstrap(db, { path: dir });
    const r2 = runBootstrap(db, { path: dir });
    expect(extractNext(r1)).toBe(extractNext(r2));
    expect(progress(r1)).toBe(progress(r2));
    rmSync(dir, { recursive: true, force: true });
  });

  it("EC-BA-08: covering last module → complete immediately on next call", () => {
    // Pre-seed graph_nodes and module_intents directly so status is
    // complete before runBootstrap is called. Pass an empty fixture
    // directory so re-indexing finds nothing new. Status is complete
    // (all non-deprecated nodes covered), so next=null → complete.
    const dir = fixtureDir();
    upsertNode(db, "a.ts", join(dir, "a.ts"), 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    const out = runBootstrap(db, { path: dir });
    expect(out).toMatch(/^BOOTSTRAP: complete\n/);
    rmSync(dir, { recursive: true, force: true });
  });


  it("EC-BA-06: deprecated nodes excluded from total and not returned as next_module", () => {
    const dir = fixtureDir();
    upsertNode(db, "a.ts", join(dir, "a.ts"), 0, 0);
    upsertNode(db, "b.ts", join(dir, "b.ts"), 0, 1); // deprecated
    upsertNode(db, "c.ts", join(dir, "c.ts"), 0, 0);
    const out = runBootstrap(db, { path: dir });
    const next = extractNext(out);
    // b.ts is deprecated and must not be returned.
    expect(next).not.toBe("b.ts");
    expect(next === "a.ts" || next === "c.ts").toBe(true);
    expect(progress(out)).toBe("0/2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ERR: nonexistent path", () => {
    const out = runBootstrap(db, {
      path: "/tmp/does-not-exist-xyz-99999",
    });
    expect(out.startsWith("ERR path not found:")).toBe(true);
  });

  it("ERR: non-string path", () => {
    const out = runBootstrap(db, {
      path: 42 as unknown as string,
    });
    expect(out).toBe("ERR path must be a string");
  });
});
