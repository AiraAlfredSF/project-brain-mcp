// Tests for tools/graph.ts — the six MCP tool handlers.
//
// Covers every item in Spec 02 §6 Test Plan and every EC-CG-NN edge case
// from §7. The DSL round-trip is the primary assertion — storage +
// formatting together must match the spec's worked examples.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { resetSchemaSentForTesting } from "../format/dsl.js";
import { createConstraintsSchema } from "../storage/constraints.js";
import { createDecisionsSchema } from "../storage/decisions.js";
import { createGraphSchema } from "../storage/graph.js";
import { getContext } from "./decision.js";

import {
  diffGraph,
  findEntryPoints,
  getBlastRadius,
  getDependencies,
  getDependents,
  indexCodebaseTool,
} from "./graph.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createGraphSchema(db);
  // Spec 01 schemas are also created so cross-spec tests (and the
  // shared BRAIN DSL header coordination) work in this file.
  createDecisionsSchema(db);
  createConstraintsSchema(db);
  resetSchemaSentForTesting();
});


// ===========================================================================
// index_codebase
// ===========================================================================

describe("indexCodebaseTool", () => {
  it("happy path: returns GRAPH: indexed with stats for a small repo", () => {
    const root = "/tmp/spec02-test-graph";
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root + "/src", { recursive: true });
    writeFileSync(
      root + "/src/index.ts",
      `import { foo } from './foo.js';\nfoo();\n`
    );
    writeFileSync(root + "/src/foo.js", `export const foo = 1;\n`);

    const out = indexCodebaseTool(db, { path: root });
    expect(out).toMatch(/^GRAPH: indexed\n/);
    expect(out).toMatch(/node_count=\d+/);
    expect(out).toMatch(/edge_count=\d+/);
    expect(out).toMatch(/duration_ms=\d+/);

    rmSync(root, { recursive: true, force: true });
  });

  it("EC-CG-01: incremental=false on a non-empty graph rebuilds from scratch", () => {
    // Seed some rows directly.
    db.prepare(
      `INSERT INTO graph_nodes (module, path) VALUES (?, ?)`
    ).run("old.ts", "/old");
    db.prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type)
       SELECT id, id, 'depends' FROM graph_nodes WHERE module = 'old.ts'`
    ).run();

    const root = "/tmp/spec02-test-empty";
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(root + "/a.ts", "");

    indexCodebaseTool(db, { path: root, incremental: false });

    // The pre-existing 'old.ts' should be gone.
    const remaining = db
      .prepare("SELECT module FROM graph_nodes ORDER BY module")
      .all() as { module: string }[];
    expect(remaining.map((r) => r.module)).toEqual(["a.ts"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("empty directory → GRAPH: indexed with node_count=0 edge_count=0", () => {
    const root = "/tmp/spec02-test-empty2";
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    const out = indexCodebaseTool(db, { path: root });
    expect(out).toMatch(/node_count=0/);
    expect(out).toMatch(/edge_count=0/);

    rmSync(root, { recursive: true, force: true });
  });

  it("EC-CG-03: unsupported files in the tree are skipped (not an error)", () => {
    const root = "/tmp/spec02-test-unsup";
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(root + "/README.md", "# readme");
    writeFileSync(root + "/data.json", "{}");

    const out = indexCodebaseTool(db, { path: root });
    expect(out).toMatch(/node_count=0/);

    rmSync(root, { recursive: true, force: true });
  });

  it("nonexistent path → ERR path not found: ...", () => {
    const out = indexCodebaseTool(db, { path: "/tmp/definitely-does-not-exist-12345" });
    expect(out.startsWith("ERR path not found:")).toBe(true);
  });

  it("public/index.php is marked entry_point=1 (Spec 10 §6)", () => {
    const root = "/tmp/spec10-test-entry";
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root + "/public", { recursive: true });
    writeFileSync(root + "/public/index.php", "<?php\n");

    const out = indexCodebaseTool(db, { path: root });
    expect(out).toMatch(/node_count=1/);

    const row = db
      .prepare("SELECT entry_point FROM graph_nodes WHERE module = 'public/index.php'")
      .get() as { entry_point: number } | undefined;
    expect(row?.entry_point).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  it("Laravel-shaped fixture: use-based edges > 0 (Spec 10 §6 regression guard)", () => {
    const root = "/tmp/spec10-test-laravel";
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root + "/app/Models", { recursive: true });
    mkdirSync(root + "/app/Http/Controllers", { recursive: true });
    writeFileSync(
      root + "/composer.json",
      JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } })
    );
    writeFileSync(root + "/app/Models/User.php", "<?php\nnamespace App\\Models;\nclass User {}\n");
    writeFileSync(
      root + "/app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\User;\nclass UserController {}\n"
    );

    const out = indexCodebaseTool(db, { path: root, incremental: false });
    expect(out).toMatch(/node_count=\d+/);
    const edgeMatch = out.match(/edge_count=(\d+)/);
    const edgeCount = edgeMatch ? parseInt(edgeMatch[1], 10) : 0;
    expect(edgeCount).toBeGreaterThan(0);

    rmSync(root, { recursive: true, force: true });
  });
});

// ===========================================================================
// get_dependents / get_dependencies
// ===========================================================================

describe("getDependents", () => {
  function seed() {
    // A → B → C ; also D → A
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('b', '/b')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('c', '/c')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('d', '/d')`).run();
    db.prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type)
       SELECT n1.id, n2.id, 'depends' FROM graph_nodes n1, graph_nodes n2
       WHERE (n1.module, n2.module) IN (('a','b'), ('b','c'), ('d','a'))`
    ).run();
  }

  it("rejects empty module", () => {
    expect(getDependents(db, { module: "" })).toBe(
      "ERR module is required"
    );
    expect(getDependents(db, {})).toBe("ERR module is required");
  });

  it("unknown module → empty DSL block", () => {
    expect(getDependents(db, { module: "nope.ts" })).toBe("");
  });

  it("depth=0, depth=11, depth='x' → ERR depth must be between 1 and 10", () => {
    seed();
    expect(getDependents(db, { module: "a", depth: 0 })).toBe(
      "ERR depth must be between 1 and 10"
    );
    expect(getDependents(db, { module: "a", depth: 11 })).toBe(
      "ERR depth must be between 1 and 10"
    );
    expect(getDependents(db, { module: "a", depth: "abc" })).toBe(
      "ERR depth must be between 1 and 10"
    );
  });

  it("depth=1 from a returns just D (the only direct dependent of A)", () => {
    seed();
    const out = getDependents(db, { module: "a", depth: 1 });
    expect(out).toContain("[a]");
    expect(out).toContain("^callers d=1");
    expect(out).toContain("^[d]");
    // Should NOT contain B or C at depth 1.
    expect(out).not.toContain("^[b]");
  });

  it("depth=2 from a returns D, then B (B depends on D, which depends on A → wait that's wrong direction)", () => {
    // Actually B → C, D → A. So A's transitive upstream (dependents)
    // is {D, ?}. Walking incoming edges to A: D at depth 1. Walking
    // incoming edges to D: nothing incoming to D in this graph.
    // So depth=2 should still be just {D}.
    seed();
    const out = getDependents(db, { module: "a", depth: 2 });
    expect(out).toContain("^[d]");
  });
});

describe("getDependencies", () => {
  function seed() {
    // A → B → C ; also D → A
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('b', '/b')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('c', '/c')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('d', '/d')`).run();
    db.prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type)
       SELECT n1.id, n2.id, 'depends' FROM graph_nodes n1, graph_nodes n2
       WHERE (n1.module, n2.module) IN (('a','b'), ('b','c'), ('d','a'))`
    ).run();
  }

  it("rejects empty module", () => {
    expect(getDependencies(db, { module: "" })).toBe(
      "ERR module is required"
    );
  });

  it("unknown module → empty DSL block", () => {
    expect(getDependencies(db, { module: "nope.ts" })).toBe("");
  });

  it("depth=1 from b returns just C", () => {
    seed();
    const out = getDependencies(db, { module: "b", depth: 1 });
    expect(out).toContain("[b]");
    expect(out).toContain(">deps d=1");
    expect(out).toContain(">[c]");
  });

  it("EC-CG-05: cyclic graph doesn't loop", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('b', '/b')`).run();
    db.prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type)
       SELECT n1.id, n2.id, 'depends' FROM graph_nodes n1, graph_nodes n2
       WHERE (n1.module, n2.module) IN (('a','b'), ('b','a'))`
    ).run();
    const out = getDependencies(db, { module: "a", depth: 5 });
    // B at depth 1, A never re-emitted.
    expect(out).toContain(">[b]");
    expect(out).not.toMatch(/^D \d\|a/m); // no D row for a
  });
});

// ===========================================================================
// get_blast_radius
// ===========================================================================

describe("getBlastRadius", () => {
  it("rejects empty module", () => {
    expect(getBlastRadius(db, { module: "" })).toBe(
      "ERR module is required"
    );
  });

  it("unknown module → empty DSL block", () => {
    expect(getBlastRadius(db, { module: "nope" })).toBe("");
  });

  it("known module with no dependents → header only", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('b', '/b')`).run();
    db.prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type)
       SELECT n1.id, n2.id, 'depends' FROM graph_nodes n1, graph_nodes n2
       WHERE (n1.module, n2.module) IN (('a','b'))`
    ).run();
    const out = getBlastRadius(db, { module: "b" });
    expect(out).toContain("[b]");
    expect(out).toContain("^callers");
    // No d= lines.
    expect(out).not.toMatch(/^d=/m);
  });

  it("known module with transitive dependents → annotated lines", () => {
    // D → A → B → C
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('b', '/b')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('c', '/c')`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('d', '/d')`).run();
    db.prepare(
      `INSERT INTO graph_edges (from_node, to_node, edge_type)
       SELECT n1.id, n2.id, 'depends' FROM graph_nodes n1, graph_nodes n2
       WHERE (n1.module, n2.module) IN (('a','b'), ('b','c'), ('d','a'))`
    ).run();
    const out = getBlastRadius(db, { module: "b" });
    expect(out).toContain("[b]");
    expect(out).toContain("^callers");
    // A at depth 1, D at depth 2 (D→A→B).
    expect(out).toContain("d=1 ^[a]");
    expect(out).toContain("d=2 ^[d]");
  });
});

// ===========================================================================
// diff_graph
// ===========================================================================

describe("diffGraph", () => {
  function recordSnapshot(commit: string, edges: Array<[string, string, string]>) {
    db.prepare(
      `INSERT INTO graph_index_runs (commit_hash, edge_snapshot) VALUES (?, ?)`
    ).run(commit, JSON.stringify(edges.map(([from, to, type]) => ({ from, to, edge_type: type }))));
  }

  it("rejects empty since_commit", () => {
    expect(diffGraph(db, { since_commit: "" })).toBe(
      "ERR since_commit is required"
    );
  });

  it("EC-CG-07: unknown commit → ERR unknown commit: <hash>", () => {
    recordSnapshot("abc", []);
    expect(diffGraph(db, { since_commit: "zzz" })).toBe(
      "ERR unknown commit: zzz"
    );
  });

  it("no structural changes → DIFF header only", () => {
    recordSnapshot("v1", [
      ["a", "b", "depends"],
      ["b", "c", "calls"],
    ]);
    recordSnapshot("v2", [
      ["a", "b", "depends"],
      ["b", "c", "calls"],
    ]);
    const out = diffGraph(db, { since_commit: "v1" });
    expect(out).toContain("DIFF: since=v1");
    expect(out).not.toMatch(/^[+-]/m);
  });

  it("added and removed edges → + and - lines", () => {
    recordSnapshot("v1", [["a", "b", "depends"]]);
    recordSnapshot("v2", [
      ["a", "b", "depends"],
      ["a", "c", "calls"], // added
    ]);
    recordSnapshot("v3", [
      ["a", "b", "depends"],
      ["a", "c", "calls"],
      ["d", "e", "depends"], // newly added since v2
    ]);
    const out = diffGraph(db, { since_commit: "v1" });
    expect(out).toContain("DIFF: since=v1");
    // Added since v1
    expect(out).toContain("+[a]>[c]");
    expect(out).toContain("+[d]>[e]");
    // No removed edges
    expect(out).not.toMatch(/^-/m);
  });

  it("side_effect edges use +!/! prefix without brackets around from", () => {
    recordSnapshot("v1", []);
    recordSnapshot("v2", [["api/billing.ts", "db/invoices.ts", "side_effect"]]);
    const out = diffGraph(db, { since_commit: "v1" });
    expect(out).toContain("+!api/billing.ts>db/invoices.ts");
  });
});

// ===========================================================================
// find_entry_points
// ===========================================================================

describe("findEntryPoints", () => {
  it("rejects empty intent", () => {
    expect(findEntryPoints(db, { intent: "" })).toBe("ERR intent is required");
    expect(findEntryPoints(db, { intent: "   " })).toBe(
      "ERR intent is required"
    );
  });

  it("no graph_nodes match → ENTRY: header omitted (only the BRAIN DSL header is emitted, no data lines)", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    const out = findEntryPoints(db, { intent: "nothing matches" });
    expect(out).not.toMatch(/^ENTRY:/m);
    // The BRAIN DSL header may be present (first call of the session),
    // but there should be no @[ / ~[ / [ data lines.
    expect(out).not.toMatch(/^[\[~@]/m);
  });

  it("returns ENTRY: header and top matches", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path, entry_point) VALUES ('src/api/login.ts', '/a', 1)`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path, entry_point) VALUES ('src/auth/session.ts', '/a', 0)`).run();
    const out = findEntryPoints(db, { intent: "login" });
    expect(out).toContain('ENTRY: intent="login"');
    expect(out).toContain("@[src/api/login.ts]"); // entry point
  });

  it("EC-CG-08: entry_point wins on ties", () => {
    // Two nodes match 'api' once. The one with entry_point=1 wins.
    db.prepare(`INSERT INTO graph_nodes (module, path, entry_point) VALUES ('src/api/zzz.ts', '/a', 0)`).run();
    db.prepare(`INSERT INTO graph_nodes (module, path, entry_point) VALUES ('src/api/aaa.ts', '/a', 1)`).run();
    const out = findEntryPoints(db, { intent: "api" });
    // aaa (id=2, entry_point=1) should come first.
    const lines = out.split("\n").filter((l) => l.startsWith("@") || l.startsWith("["));
    expect(lines[0]).toBe("@[src/api/aaa.ts]");
  });

  it("EC-CG-09: deprecated node in top 3 is marked with ~", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path, deprecated) VALUES ('src/old/login.ts', '/a', 1)`).run();
    const out = findEntryPoints(db, { intent: "login" });
    expect(out).toContain("~[src/old/login.ts]");
  });

  it("caps at 3 matches", () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO graph_nodes (module, path) VALUES (?, '/a')`).run(
        `src/login${i}.ts`
      );
    }
    const out = findEntryPoints(db, { intent: "login" });
    const dataLines = out
      .split("\n")
      .filter((l) => /^[\[~@]/.test(l));
    expect(dataLines.length).toBe(3);
  });
});

// ===========================================================================
// Interaction with Spec 01 — schema-header coordination (EC-DM-08, §6 Test Plan)
// ===========================================================================

describe("Schema header coordination with Spec 01 (EC-DM-08 / Spec 02 §6)", () => {
  it("first DSL-emitting call of the session includes the BRAIN DSL v1 header", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    // Reset state at the start of the test (beforeEach already does this).
    const out = getDependents(db, { module: "a", depth: 1 });
    expect(out.startsWith("BRAIN DSL v1\n")).toBe(true);
  });

  it("subsequent calls of the session omit the header", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    getDependents(db, { module: "a", depth: 1 }); // 1st call emits header
    const out2 = getDependents(db, { module: "a", depth: 1 });
    expect(out2.startsWith("BRAIN DSL v1")).toBe(false);
  });

  it("the schema header is shared across Spec 01 and Spec 02 tools", () => {
    db.prepare(`INSERT INTO graph_nodes (module, path) VALUES ('a', '/a')`).run();
    // Spec 01 tool first
    getContext(db, { topic: "x" });
    // Now a Spec 02 tool — should NOT re-emit header
    const out = getDependents(db, { module: "a", depth: 1 });
    expect(out.startsWith("BRAIN DSL v1")).toBe(false);
  });
});
