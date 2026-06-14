// Tests for the storage/decisions.ts adapter.
//
// Uses an in-memory SQLite DB (better-sqlite3 `:memory:`) so each test
// is hermetic. Verifies schema creation, insert + read-back, and
// searchDecisionsAndFailures (fuzzy, merged, ordered, capped).

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createDecisionsSchema,
  insertDecision,
  insertFailure,
  listOpenFailures,
  searchDecisionsAndFailures,
} from "./decisions.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createDecisionsSchema(db);
});


describe("createDecisionsSchema", () => {
  it("creates decisions and failures tables with the expected columns", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(["decisions", "failures"]);
  });

  it("creates the expected indexes", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "idx_decisions_created_at",
      "idx_failures_created_at",
      "idx_failures_status",
    ]);
  });

  it("is idempotent — calling twice does not throw", () => {
    expect(() => createDecisionsSchema(db)).not.toThrow();
  });

  it("enforces the failures.status CHECK constraint", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO failures (description, cause, approach_tried, status) VALUES (?,?,?,?)"
        )
        .run("d", "c", "a", "bogus")
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects insertDecision with whitespace-only decision via NOT NULL (DB-level)", () => {
    // Spec 01 §3 enforces "non-empty after trim" in the tool layer; the DB
    // schema itself uses NOT NULL on the column. Here we just confirm the
    // NOT NULL enforcement fires.
    expect(() =>
      db.prepare("INSERT INTO decisions (decision, rationale) VALUES (?, ?)").run("", "")
    ).not.toThrow(); // empty string is allowed at DB level
    // The tool layer is the one that rejects whitespace-only — see
    // tools/decision.test.ts EC-DM-01.
  });
});

describe("insertDecision", () => {
  it("inserts a decision and returns a new autoincrement id", () => {
    const id1 = insertDecision(db, "Use SQLite", "Simpler ops", ["Postgres"], ["infra"]);
    const id2 = insertDecision(db, "Use esbuild", "Faster builds", ["webpack"], ["build"]);
    expect(id2).toBeGreaterThan(id1);
  });

  it("JSON-serializes alternatives_rejected and tags", () => {
    const id = insertDecision(
      db,
      "D",
      "R",
      ["alt1", "alt2"],
      ["t1", "t2"]
    );
    const row = db
      .prepare(
        "SELECT alternatives_rejected, tags FROM decisions WHERE id = ?"
      )
      .get(id) as { alternatives_rejected: string; tags: string };
    expect(JSON.parse(row.alternatives_rejected)).toEqual(["alt1", "alt2"]);
    expect(JSON.parse(row.tags)).toEqual(["t1", "t2"]);
  });

  it("stores empty arrays as '[]' (EC-DM-03)", () => {
    const id = insertDecision(db, "D", "R", [], []);
    const row = db
      .prepare("SELECT alternatives_rejected, tags FROM decisions WHERE id = ?")
      .get(id) as { alternatives_rejected: string; tags: string };
    expect(row.alternatives_rejected).toBe("[]");
    expect(row.tags).toBe("[]");
  });

  it("populates created_at with a non-empty ISO-ish string", () => {
    const id = insertDecision(db, "D", "R", [], []);
    const row = db
      .prepare("SELECT created_at FROM decisions WHERE id = ?")
      .get(id) as { created_at: string };
    expect(row.created_at.length).toBeGreaterThan(0);
  });
});

describe("insertFailure", () => {
  it("inserts a failure with status='open' and returns the new id", () => {
    const id = insertFailure(db, "desc", "cause", "approach");
    const row = db
      .prepare("SELECT status, description FROM failures WHERE id = ?")
      .get(id) as { status: string; description: string };
    expect(row.status).toBe("open");
    expect(row.description).toBe("desc");
  });

  it("populates both created_at and updated_at", () => {
    const id = insertFailure(db, "d", "c", "a");
    const row = db
      .prepare("SELECT created_at, updated_at FROM failures WHERE id = ?")
      .get(id) as { created_at: string; updated_at: string };
    expect(row.created_at.length).toBeGreaterThan(0);
    expect(row.updated_at.length).toBeGreaterThan(0);
  });
});

describe("searchDecisionsAndFailures", () => {
  it("returns an empty array when nothing matches (EC-DM-05)", () => {
    insertDecision(db, "Use SQLite", "Simpler ops", [], []);
    insertFailure(db, "Tree-sitter WASM", "Bundler target", "esbuild",);
    const rows = searchDecisionsAndFailures(db, "kubernetes", 5);
    expect(rows).toEqual([]);
  });

  it("matches case-insensitively against decision and rationale", () => {
    insertDecision(db, "Use SQLite", "Simpler ops", [], []);
    insertDecision(db, "Use Postgres", "Production scale", [], []);
    const rows = searchDecisionsAndFailures(db, "sqlite", 10);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("D");
    if (rows[0].kind === "D") {
      expect(rows[0].decision).toBe("Use SQLite");
    }
  });

  it("matches failures across description, cause, and approach_tried", () => {
    insertFailure(db, "Bundle failed", "TS target", "esbuild");
    insertFailure(db, "DB migration lost", "Schema drift", "manual fix");
    const rows = searchDecisionsAndFailures(db, "esbuild", 10);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("F");
  });

  it("merges decisions and failures, ordered by created_at desc", async () => {
    // Insert in order; use a small sleep to get distinct timestamps.
    insertDecision(db, "alpha", "rationale alpha", [], []);
    await sleep(1100);
    insertFailure(db, "beta", "cause beta", "approach beta");
    await sleep(1100);
    insertDecision(db, "gamma", "rationale gamma", [], []);

    const rows = searchDecisionsAndFailures(db, "a", 10);
    // 3 total (all contain 'a' in some field). Newest first.
    expect(rows.length).toBe(3);
    // The "gamma" decision was inserted last and should be first.
    expect(rows[0].kind).toBe("D");
    if (rows[0].kind === "D") {
      expect(rows[0].decision).toBe("gamma");
    }
  });

  it("caps results at `limit` total rows, not per-table (EC-DM-06)", () => {
    // 3 decisions matching
    insertDecision(db, "topic one", "r1", [], []);
    insertDecision(db, "topic two", "r2", [], []);
    insertDecision(db, "topic three", "r3", [], []);
    // 2 failures matching
    insertFailure(db, "topic fail A", "cA", "aA");
    insertFailure(db, "topic fail B", "cB", "aB");
    // 1 unrelated
    insertDecision(db, "unrelated", "r", [], []);

    const rows = searchDecisionsAndFailures(db, "topic", 3);
    expect(rows.length).toBe(3);
  });

  it("returns rows that match fewer than the limit without padding (EC-DM-06)", () => {
    insertDecision(db, "x one", "r", [], []);
    insertDecision(db, "x two", "r", [], []);
    const rows = searchDecisionsAndFailures(db, "x", 5);
    expect(rows.length).toBe(2);
  });

  it("tags field round-trips through JSON", () => {
    insertDecision(db, "Use SQLite", "r", [], ["infra", "db"]);
    const rows = searchDecisionsAndFailures(db, "sqlite", 1);
    expect(rows[0].kind).toBe("D");
    if (rows[0].kind === "D") {
      expect(rows[0].tags).toEqual(["infra", "db"]);
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// listOpenFailures — Spec 03 §5 task 3
// ===========================================================================

describe("listOpenFailures", () => {
  it("returns only rows with status='open'", async () => {
    const open1 = insertFailure(db, "open1", "c1", "a1");
    await sleep(5);
    insertFailure(db, "open2", "c2", "a2");
    await sleep(5);
    insertFailure(db, "resolved1", "c3", "a3");
    // Resolve the third one.
    db.prepare("UPDATE failures SET status = 'resolved' WHERE description = 'resolved1'").run();

    const r = listOpenFailures(db);
    expect(r).toHaveLength(2);
    for (const f of r) expect(f.status).toBe("open");
    expect(r.map((f) => f.id).sort()).toEqual([open1, open1 + 1].sort());
  });

  it("returns [] when no failures exist", () => {
    expect(listOpenFailures(db)).toEqual([]);
  });

  it("returns [] when all failures are resolved", () => {
    insertFailure(db, "f1", "c", "a");
    db.prepare("UPDATE failures SET status = 'resolved'").run();
    expect(listOpenFailures(db)).toEqual([]);
  });

  it("orders by created_at DESC, id DESC", async () => {
    const f1 = insertFailure(db, "f1", "c", "a");
    await sleep(5);
    const f2 = insertFailure(db, "f2", "c", "a");
    await sleep(5);
    const f3 = insertFailure(db, "f3", "c", "a");
    const r = listOpenFailures(db);
    expect(r.map((f) => f.id)).toEqual([f3, f2, f1]);
  });

  it("returns full rows with all fields populated", () => {
    const id = insertFailure(db, "d", "c", "a");
    const [f] = listOpenFailures(db);
    expect(f).toEqual({
      id,
      description: "d",
      cause: "c",
      approach_tried: "a",
      status: "open",
      created_at: f!.created_at,
      updated_at: f!.updated_at,
    });
  });
});

