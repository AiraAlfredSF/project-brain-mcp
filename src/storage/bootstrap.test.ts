// Tests for storage/bootstrap.ts — Spec 04's module_intents adapter.
//
// Covers schema, insertModuleIntent, listModuleIntents,
// getModuleIntentCoverage, and getNextUncoveredModule.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { createConstraintsSchema } from "./constraints.js";
import { createDecisionsSchema } from "./decisions.js";
import { createGraphSchema, upsertNode } from "./graph.js";

import {
  createBootstrapSchema,
  getModuleIntentCoverage,
  getNextUncoveredModule,
  insertModuleIntent,
  listModuleIntents,
} from "./bootstrap.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  createGraphSchema(db);
  createBootstrapSchema(db);
});


// ===========================================================================
// createBootstrapSchema
// ===========================================================================

describe("createBootstrapSchema", () => {
  it("creates the module_intents table", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("module_intents");
  });

  it("creates the idx_module_intents_module index", () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_module_intents_module");
  });

  it("is idempotent (calling twice doesn't error)", () => {
    expect(() => createBootstrapSchema(db)).not.toThrow();
    expect(() => createBootstrapSchema(db)).not.toThrow();
  });
});

// ===========================================================================
// insertModuleIntent / listModuleIntents
// ===========================================================================

describe("insertModuleIntent + listModuleIntents", () => {
  it("inserts and reads back a row with constraints and caveats arrays", () => {
    const id = insertModuleIntent(
      db,
      "src/a.ts",
      "module A is the entry point",
      ["uses SQLite", "single-file"],
      ["no transactions across modules"]
    );
    expect(id).toBeGreaterThan(0);

    const rows = listModuleIntents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id,
      module: "src/a.ts",
      intent: "module A is the entry point",
      constraints: ["uses SQLite", "single-file"],
      caveats: ["no transactions across modules"],
      source: "bootstrap",
      created_at: rows[0]!.created_at,
    });
  });

  it("supports empty constraints and caveats arrays", () => {
    insertModuleIntent(db, "src/x.ts", "x", [], []);
    const rows = listModuleIntents(db);
    expect(rows[0]!.constraints).toEqual([]);
    expect(rows[0]!.caveats).toEqual([]);
  });

  it("stores arrays as JSON internally (rejects non-string elements via JS)", () => {
    // We're calling the JS adapter, not the SQL layer, so type
    // checking is on us. We can however verify the row is valid
    // by round-tripping through listModuleIntents.
    insertModuleIntent(
      db,
      "src/y.ts",
      "y",
      ["a", "b"],
      ["c"]
    );
    const stored = db
      .prepare("SELECT constraints, caveats FROM module_intents")
      .all() as { constraints: string; caveats: string }[];
    expect(JSON.parse(stored[0]!.constraints)).toEqual(["a", "b"]);
    expect(JSON.parse(stored[0]!.caveats)).toEqual(["c"]);
  });

  it("orders by id ASC", () => {
    insertModuleIntent(db, "a", "1", [], []);
    insertModuleIntent(db, "b", "2", [], []);
    insertModuleIntent(db, "c", "3", [], []);
    expect(listModuleIntents(db).map((r) => r.intent)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("enforces the source='bootstrap' CHECK constraint (via raw SQL)", () => {
    // Direct INSERT with source='manual' must be rejected by the CHECK.
    expect(() =>
      db
        .prepare(
          "INSERT INTO module_intents (module, intent, source) VALUES (?, ?, 'manual')"
        )
        .run("src/a.ts", "x")
    ).toThrow(/CHECK constraint failed/);
  });
});

// ===========================================================================
// getModuleIntentCoverage
// ===========================================================================

describe("getModuleIntentCoverage", () => {
  it("returns { covered: 0, total: 0 } on an empty graph", () => {
    expect(getModuleIntentCoverage(db)).toEqual({ covered: 0, total: 0 });
  });

  it("excludes deprecated nodes from total (EC-BA-06)", () => {
    upsertNode(db, "a.ts", "/a", 0, 0);
    upsertNode(db, "b.ts", "/b", 0, 0);
    upsertNode(db, "c.ts", "/c", 0, 1); // deprecated
    expect(getModuleIntentCoverage(db)).toEqual({ covered: 0, total: 2 });
  });

  it("counts distinct modules as covered (duplicates don't double-count)", () => {
    upsertNode(db, "a.ts", "/a", 0);
    upsertNode(db, "b.ts", "/b", 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    insertModuleIntent(db, "a.ts", "x again", [], []); // duplicate module
    insertModuleIntent(db, "b.ts", "y", [], []);
    expect(getModuleIntentCoverage(db)).toEqual({ covered: 2, total: 2 });
  });
});

// ===========================================================================
// getNextUncoveredModule
// ===========================================================================

describe("getNextUncoveredModule", () => {
  it("returns null when graph_nodes is empty", () => {
    expect(getNextUncoveredModule(db)).toBeNull();
  });

  it("returns the first non-deprecated node by id ASC when nothing is covered", () => {
    upsertNode(db, "a.ts", "/path/a.ts", 0); // id 1
    upsertNode(db, "b.ts", "/path/b.ts", 0); // id 2
    upsertNode(db, "c.ts", "/path/c.ts", 0); // id 3
    expect(getNextUncoveredModule(db)).toEqual({
      id: 1,
      module: "a.ts",
      path: "/path/a.ts",
    });
  });

  it("skips modules that already have a module_intents row", () => {
    upsertNode(db, "a.ts", "/path/a.ts", 0); // id 1
    upsertNode(db, "b.ts", "/path/b.ts", 0); // id 2
    upsertNode(db, "c.ts", "/path/c.ts", 0); // id 3
    insertModuleIntent(db, "a.ts", "x", [], []);
    expect(getNextUncoveredModule(db)).toEqual({
      id: 2,
      module: "b.ts",
      path: "/path/b.ts",
    });
  });

  it("skips deprecated modules (EC-BA-06)", () => {
    upsertNode(db, "old.ts", "/old", 0, 1); // deprecated → skipped
    upsertNode(db, "new.ts", "/new", 0, 0); // id 2
    expect(getNextUncoveredModule(db)).toEqual({
      id: 2,
      module: "new.ts",
      path: "/new",
    });
  });

  it("returns null when every non-deprecated module is covered", () => {
    upsertNode(db, "a.ts", "/a", 0);
    upsertNode(db, "b.ts", "/b", 0);
    insertModuleIntent(db, "a.ts", "x", [], []);
    insertModuleIntent(db, "b.ts", "y", [], []);
    expect(getNextUncoveredModule(db)).toBeNull();
  });
});
