// Tests for the storage/constraints.ts adapter.
//
// Covers schema creation (constraints + sync_state singleton), insert,
// list ordering (confidence priority), and the sync_state read/write
// helpers that Spec 05 will use.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createConstraintsSchema,
  getLastSyncedAt,
  insertConstraint,
  listConstraints,
  listHardConstraints,
  setLastSyncedAt,
} from "./constraints.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createConstraintsSchema(db);
});


describe("createConstraintsSchema", () => {
  it("creates constraints and sync_state tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual([
      "constraints",
      "sync_state",
    ]);
  });

  it("creates the expected indexes", () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "idx_constraints_confidence",
      "idx_constraints_flag",
    ]);
  });

  it("sync_state enforces singleton via CHECK (id = 1)", () => {
    expect(() =>
      db.prepare("INSERT INTO sync_state (id, last_synced) VALUES (?, ?)").run(2, "x")
    ).toThrow(/CHECK constraint failed/);
  });

  it("is idempotent", () => {
    expect(() => createConstraintsSchema(db)).not.toThrow();
  });

  it("enforces constraints.level enum", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO constraints (constraint_text, level, source, confidence) VALUES (?,?,?,?)"
        )
        .run("c", "bogus", "s", "high")
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces constraints.confidence enum", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO constraints (constraint_text, level, source, confidence) VALUES (?,?,?,?)"
        )
        .run("c", "hard", "s", "bogus")
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("insertConstraint / listConstraints", () => {
  it("inserts and returns the new id", () => {
    const id = insertConstraint(
      db,
      "All DB access through storage/*.ts",
      "hard",
      "bootstrap",
      "high"
    );
    expect(id).toBeGreaterThan(0);
  });

  it("stores NULL flag by default and accepts an explicit flag (EC-DM-09)", () => {
    const a = insertConstraint(db, "a", "hard", "s", "high");
    const b = insertConstraint(db, "b", "soft", "s", "low", "stale");
    const rowA = db
      .prepare("SELECT flag FROM constraints WHERE id = ?")
      .get(a) as { flag: string | null };
    const rowB = db
      .prepare("SELECT flag FROM constraints WHERE id = ?")
      .get(b) as { flag: string | null };
    expect(rowA.flag).toBeNull();
    expect(rowB.flag).toBe("stale");
  });

  it("listConstraints orders by confidence priority high → medium → low", async () => {
    insertConstraint(db, "low1", "soft", "s", "low");
    await sleep(5);
    insertConstraint(db, "medium1", "soft", "s", "medium");
    await sleep(5);
    insertConstraint(db, "high1", "hard", "s", "high");
    await sleep(5);
    insertConstraint(db, "high2", "hard", "s", "high");

    const rows = listConstraints(db);
    expect(rows.map((r) => r.confidence)).toEqual([
      "high",
      "high",
      "medium",
      "low",
    ]);
  });

  it("listConstraints within the same confidence orders by created_at desc", async () => {
    insertConstraint(db, "first", "hard", "s", "high");
    await sleep(1100);
    insertConstraint(db, "second", "hard", "s", "high");
    await sleep(1100);
    insertConstraint(db, "third", "hard", "s", "high");

    const rows = listConstraints(db);
    expect(rows.map((r) => r.constraint_text)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("listConstraints returns empty array when no rows", () => {
    expect(listConstraints(db)).toEqual([]);
  });
});

describe("sync_state singleton (Spec 05 read/write)", () => {
  it("getLastSyncedAt returns null before any sync", () => {
    expect(getLastSyncedAt(db)).toBeNull();
  });

  it("setLastSyncedAt inserts a value readable by getLastSyncedAt", () => {
    setLastSyncedAt(db, "2026-06-12T10:00:00Z");
    expect(getLastSyncedAt(db)).toBe("2026-06-12T10:00:00Z");
  });

  it("setLastSyncedAt upserts — second call updates the same row", () => {
    setLastSyncedAt(db, "2026-06-12T10:00:00Z");
    setLastSyncedAt(db, "2026-06-13T11:00:00Z");
    expect(getLastSyncedAt(db)).toBe("2026-06-13T11:00:00Z");

    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM sync_state").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// listHardConstraints — Spec 03 §5 task 2
// ===========================================================================

describe("listHardConstraints", () => {
  it("returns only rows with level='hard'", () => {
    insertConstraint(db, "H1 hard", "hard", "manual", "high", null);
    insertConstraint(db, "S1 soft", "soft", "manual", "medium", null);
    insertConstraint(db, "H2 hard", "hard", "manual", "high", null);
    insertConstraint(db, "S2 soft", "soft", "manual", "low", null);
    const r = listHardConstraints(db);
    expect(r).toHaveLength(2);
    for (const c of r) expect(c.level).toBe("hard");
  });

  it("returns [] when no hard constraints exist", () => {
    insertConstraint(db, "S1 soft", "soft", "manual", "high", null);
    expect(listHardConstraints(db)).toEqual([]);
  });

  it("returns [] when the table is empty", () => {
    expect(listHardConstraints(db)).toEqual([]);
  });

  it("orders by confidence (high → medium → low), then most recent first", () => {
    // Inserted in this order; tiebreak on created_at uses id DESC
    // (higher id = more recent insert).
    insertConstraint(db, "low1", "hard", "manual", "low", null);
    insertConstraint(db, "med1", "hard", "manual", "medium", null);
    insertConstraint(db, "high1", "hard", "manual", "high", null);
    insertConstraint(db, "high2", "hard", "manual", "high", null);
    const r = listHardConstraints(db);
    expect(r.map((c) => c.constraint_text)).toEqual([
      "high2",
      "high1",
      "med1",
      "low1",
    ]);
  });

  it("returns full rows with all fields populated", () => {
    insertConstraint(db, "H1", "hard", "bootstrap", "high", "payments");
    const [c] = listHardConstraints(db);
    expect(c).toEqual({
      id: c!.id,
      constraint_text: "H1",
      level: "hard",
      source: "bootstrap",
      confidence: "high",
      flag: "payments",
      created_at: c!.created_at,
      updated_at: c!.updated_at,
    });
  });
});
