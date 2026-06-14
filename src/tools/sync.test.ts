// Tests for tools/sync.ts - Spec 05 Two-Way Sync.
// Covers: ingest/export_constraints_file, flag_stale_constraints, get_sync_status, list_flagged_constraints.

import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConstraintsSchema, insertConstraint, listConstraints } from "../storage/constraints.js";
import { createDecisionsSchema } from "../storage/decisions.js";
import { createGraphSchema } from "../storage/graph.js";
import { SYNC_FLAGGED } from "../format/sync.js";
import { resetSchemaSentForTesting } from "../format/dsl.js";
import {
  exportConstraintsFile,
  flagStaleConstraints,
  getSyncStatus,
  ingestConstraintsFile,
  listFlaggedConstraintsTool,
} from "./sync.js";

let db: DatabaseType;
let tmpDir: string;

function mdPath(): string { return join(tmpDir, "constraints.md"); }

beforeEach(() => {
  tmpDir = require("node:fs").mkdtempSync(tmpdir() + "/spec05-");
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  (process as any).__originalCwd = originalCwd;
  db = new Database(":memory:");
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  createGraphSchema(db);
  resetSchemaSentForTesting();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if ((process as any).__originalCwd) {
    process.chdir((process as any).__originalCwd);
  }
});

const BASE_MD = [
  "---",
  "version: 2",
  "last_updated: 2026-01-01T00:00:00Z",
  "last_synced: 2026-01-01T00:00:00Z",
  "---",
  "",
  "# Constraints",
  "",
  "## Architectural Boundaries",
  "",
  "_(none)_",
  "",
  "## Technology Constraints",
  "",
  "_(none)_",
].join("\n");

function writeMd(c: string) { writeFileSync("constraints.md", c, "utf8"); }
function readMd(): string { return readFileSync("constraints.md", "utf8"); }

describe("export_constraints_file", () => {
  it("happy path: writes constraints.md with correct format", () => {
    insertConstraint(db, "Payments black box", "hard", "manual", "high", null);
    insertConstraint(db, "Use SQLite", "soft", "manual", "high", null);
    insertConstraint(db, "Prefer esbuild", "soft", "bootstrap", "medium", null);
    const out = exportConstraintsFile(db);
    expect(out).toBe("SYNC: exported\nrows=3\nversion=1");
    expect(existsSync("constraints.md")).toBe(true);
    const content = readFileSync("constraints.md", "utf8");
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/version: 1/);
    expect(content).toMatch(/# Constraints/);
    expect(content).toMatch(/## Architectural Boundaries/);
    expect(content).toMatch(/## Technology Constraints/);
    expect(content).toMatch(/## .*Flagged/);
  });

  it("version increments on each call", () => {
    insertConstraint(db, "A", "hard", "manual", "high", null);
    exportConstraintsFile(db);
    exportConstraintsFile(db);
    const content = readFileSync("constraints.md", "utf8");
    expect(content).toMatch(/version: 2/);
  });

  it("empty table: file written with empty sections", () => {
    const out = exportConstraintsFile(db);
    expect(out).toMatch(/^SYNC: exported/);
    expect(out).toMatch(/rows=0/);
    expect(existsSync("constraints.md")).toBe(true);
  });
});

describe("ingest_constraints_file", () => {
  it("happy path: added + updated + removed", () => {
    insertConstraint(db, "Old payments text", "hard", "manual", "high", null);
    insertConstraint(db, "Use Postgres", "soft", "manual", "high", null);
    exportConstraintsFile(db);
    const edited = BASE_MD + "\n- [C001] (hard, manual, high) New payments text\n- Use SQLite, not Postgres.";
    writeMd(edited);
    const out = ingestConstraintsFile(db);
    expect(out).toMatch(/^SYNC: ingested/);
    expect(out).toMatch(/added=1/);
    expect(out).toMatch(/updated=1/);
    expect(out).toMatch(/removed=1/);
    const rows = listConstraints(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r: any) => r.id === 1)?.constraint_text).toBe("New payments text");
    const c003 = rows.find((r: any) => r.id === 3);
    expect(c003?.constraint_text).toBe("Use SQLite, not Postgres.");
    expect(c003?.level).toBe("soft");
    expect(c003?.source).toBe("manual");
    expect(c003?.confidence).toBe("high");
    expect(rows.find((r: any) => r.id === 2)).toBeUndefined();
  });

  it("ERR: file not found", () => {
    expect(ingestConstraintsFile(db).startsWith("ERR constraints.md not found")).toBe(true);
  });

  it("ERR: unknown constraint id - no partial writes", () => {
    writeMd(BASE_MD + "\n- [C999] (hard, manual, high) Bad constraint");
    const before = listConstraints(db).length;
    const out = ingestConstraintsFile(db);
    expect(out).toMatch(/ERR unknown constraint id: C999/);
    expect(listConstraints(db).length).toBe(before);
  });

  it("EC-TS-03: unchanged - 0 added/updated/removed", () => {
    insertConstraint(db, "A", "hard", "manual", "high", null);
    exportConstraintsFile(db);
    writeMd(readMd());
    const out = ingestConstraintsFile(db);
    expect(out).toMatch(/added=0/);
    expect(out).toMatch(/updated=0/);
    expect(out).toMatch(/removed=0/);
  });

  it("EC-TS-01: unbracketed entry is soft/manual/high", () => {
    insertConstraint(db, "A", "hard", "manual", "high", null);
    exportConstraintsFile(db);
    writeMd(BASE_MD + "\n- [C001] (hard, manual, high) A\n- Use SQLite.");
    const out = ingestConstraintsFile(db);
    expect(out).toMatch(/added=1/);
    const newRow = listConstraints(db).find((r: any) => r.id !== 1);
    expect(newRow?.level).toBe("soft");
    expect(newRow?.source).toBe("manual");
    expect(newRow?.confidence).toBe("high");
  });
});

describe("get_sync_status", () => {
  it("file_missing when constraints.md does not exist", () => {
    expect(getSyncStatus(db)).toBe("SYNC: file_missing");
  });

  it("synced after export with no further changes", () => {
    insertConstraint(db, "A", "hard", "manual", "high", null);
    exportConstraintsFile(db);
    expect(getSyncStatus(db)).toBe("SYNC: synced");
  });

  it("drift_detected when DB has a newer row", () => {
    insertConstraint(db, "A", "hard", "manual", "high", null);
    exportConstraintsFile(db);
    insertConstraint(db, "B", "soft", "manual", "high", null);
    expect(getSyncStatus(db)).toMatch(/^SYNC: drift_detected/);
  });
});

describe("list_flagged_constraints", () => {
  it("returns flagged constraint as a pipe-delimited C row, with the BRAIN DSL v1 header on first call", () => {
    insertConstraint(db, "Payments black box", "hard", "manual", "high",
      "edge web/routes.ts added in abc123");
    const out = listFlaggedConstraintsTool(db);
    expect(out).toMatch(
      /^BRAIN DSL v1\nD id\|decision\|rationale\|alts\|tags\|created_at\nF id\|description\|cause\|approach\|status\|created_at\nC id\|text\|level\|source\|confidence\|flag\|created_at\nC 1\|Payments black box\|hard\|manual\|high\|edge web\/routes\.ts added in abc123\|.+$/
    );
  });

  it("omits the BRAIN DSL v1 header on subsequent calls within the same session", () => {
    insertConstraint(db, "Payments black box", "hard", "manual", "high",
      "edge web/routes.ts added in abc123");
    listFlaggedConstraintsTool(db); // first call — consumes the header
    const out = listFlaggedConstraintsTool(db);
    expect(out.startsWith("BRAIN DSL v1")).toBe(false);
    expect(out).toContain("C 1|Payments black box");
  });

  it("returns empty string when no flagged constraints (and no header pending)", () => {
    insertConstraint(db, "A", "hard", "manual", "high", null);
    resetSchemaSentForTesting();
    expect(listFlaggedConstraintsTool(db)).toBe("BRAIN DSL v1\n" +
      "D id|decision|rationale|alts|tags|created_at\n" +
      "F id|description|cause|approach|status|created_at\n" +
      "C id|text|level|source|confidence|flag|created_at");
    expect(listFlaggedConstraintsTool(db)).toBe("");
  });
});

describe("flag_stale_constraints", () => {
  it("ERR: commit not a string", () => {
    expect(flagStaleConstraints(db, null as any)).toBe("ERR commit must be a string");
    expect(flagStaleConstraints(db, { commit: 42 } as any)).toBe("ERR commit must be a string");
    expect(flagStaleConstraints(db, { commit: "" })).toBe("ERR commit must be a string");
  });

  it("flags a hard constraint when a diff_graph edge change contradicts it", () => {
    // Snapshot at v1: no edge from api/billing.ts to infra/stripe.ts.
    db.prepare(
      `INSERT INTO graph_index_runs (commit_hash, edge_snapshot) VALUES (?, ?)`
    ).run("v1", JSON.stringify([]));
    // Snapshot at v2: a new direct edge to infra/stripe.ts was added.
    db.prepare(
      `INSERT INTO graph_index_runs (commit_hash, edge_snapshot) VALUES (?, ?)`
    ).run(
      "v2",
      JSON.stringify([
        { from: "api/billing.ts", to: "infra/stripe.ts", edge_type: "depends" },
      ])
    );

    const id = insertConstraint(
      db,
      "infra/stripe.ts is a black box — must not be imported directly",
      "hard",
      "manual",
      "high",
      null
    );

    const out = flagStaleConstraints(db, { commit: "v1" });
    expect(out).toBe([SYNC_FLAGGED, "checked=1", "newly_flagged=1"].join("\n"));

    const flagged = listConstraints(db).find((r) => r.id === id);
    expect(flagged?.flag).toMatch(/edge added.*infra\/stripe\.ts.*contradicts/);

    // The flagged constraint now shows up in list_flagged_constraints.
    const flaggedOut = listFlaggedConstraintsTool(db);
    expect(flaggedOut).toContain(`C ${id}`);
  });

  it("does not re-flag an already-flagged constraint (EC-TS-08)", () => {
    db.prepare(
      `INSERT INTO graph_index_runs (commit_hash, edge_snapshot) VALUES (?, ?)`
    ).run("v1", JSON.stringify([]));
    db.prepare(
      `INSERT INTO graph_index_runs (commit_hash, edge_snapshot) VALUES (?, ?)`
    ).run(
      "v2",
      JSON.stringify([
        { from: "api/billing.ts", to: "infra/stripe.ts", edge_type: "depends" },
      ])
    );

    insertConstraint(
      db,
      "infra/stripe.ts is a black box — must not be imported directly",
      "hard",
      "manual",
      "high",
      "already flagged"
    );

    const out = flagStaleConstraints(db, { commit: "v1" });
    expect(out).toBe([SYNC_FLAGGED, "checked=1", "newly_flagged=0"].join("\n"));
  });
});
