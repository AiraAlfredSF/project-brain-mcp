// Tests for the storage/graph.ts adapter.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  bfsFromNode,
  clearGraph,
  clearOutgoingEdges,
  createGraphSchema,
  getIndexRunByCommit,
  getLatestIndexRun,
  getNodeByModule,
  insertEdge,
  listAllEdgesModuleNames,
  listAllNodes,
  parseEdgeSnapshot,
  recordIndexRun,
  searchNodes,
  upsertNode,
} from "./graph.js";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  createGraphSchema(db);
});


describe("createGraphSchema", () => {
  it("creates the three tables and their indexes", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "graph_edges",
      "graph_index_runs",
      "graph_nodes",
    ]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_graph%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "idx_graph_edges_from_node",
      "idx_graph_edges_to_node",
      "idx_graph_edges_type",
      "idx_graph_index_runs_commit",
      "idx_graph_nodes_entry_point",
      "idx_graph_nodes_module",
    ]);
  });

  it("is idempotent", () => {
    expect(() => createGraphSchema(db)).not.toThrow();
  });

  it("enforces the entry_point CHECK constraint", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO graph_nodes (module, path, entry_point) VALUES (?, ?, ?)"
        )
        .run("x", "/p", 2)
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces the edge_type CHECK constraint", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    expect(() =>
      db
        .prepare("INSERT INTO graph_edges (from_node, to_node, edge_type) VALUES (?, ?, ?)")
        .run(a, b, "bogus")
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces the module UNIQUE constraint", () => {
    upsertNode(db, "a", "/p/a", 0);
    expect(() =>
      db
        .prepare("INSERT INTO graph_nodes (module, path) VALUES (?, ?)")
        .run("a", "/p/dup")
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe("upsertNode", () => {
  it("returns the new id on first insert", () => {
    expect(upsertNode(db, "a", "/p/a", 0)).toBe(1);
    expect(upsertNode(db, "b", "/p/b", 0)).toBe(2);
  });

  it("returns the EXISTING id on conflict, not the last-inserted id (regression)", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    // Re-upsert `a` — should return `a`, not `b`.
    const a2 = upsertNode(db, "a", "/p/a", 0);
    expect(a2).toBe(a);
    // Re-upsert `b` — should return `b`, not whatever was last.
    const b2 = upsertNode(db, "b", "/p/b", 0);
    expect(b2).toBe(b);
  });

  it("refreshes path/entry_point/deprecated on conflict", () => {
    const a = upsertNode(db, "a", "/p/a", 0, 0);
    const a2 = upsertNode(db, "a", "/p/a-new", 1, 1);
    expect(a2).toBe(a);
    const row = getNodeByModule(db, "a");
    expect(row?.path).toBe("/p/a-new");
    expect(row?.entry_point).toBe(1);
    expect(row?.deprecated).toBe(1);
  });
});

describe("insertEdge / clearOutgoingEdges / clearGraph", () => {
  it("insertEdge inserts and returns new id", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    expect(insertEdge(db, a, b, "depends")).toBe(1);
    expect(insertEdge(db, a, b, "calls")).toBe(2);
  });

  it("insertEdge drops self-edges", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    expect(insertEdge(db, a, a, "depends")).toBe(-1);
    const count = (db
      .prepare("SELECT COUNT(*) AS c FROM graph_edges")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("clearOutgoingEdges only removes edges where from_node = nodeId (EC-CG-10)", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    const c = upsertNode(db, "c", "/p/c", 0);
    insertEdge(db, a, b, "depends");
    insertEdge(db, a, c, "depends");
    insertEdge(db, b, c, "depends");
    const removed = clearOutgoingEdges(db, a);
    expect(removed).toBe(2);
    // b → c is still there (incoming edge to c from b, not from a).
    const remaining = db
      .prepare("SELECT * FROM graph_edges")
      .all() as { from_node: number; to_node: number }[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].from_node).toBe(b);
  });

  it("clearGraph empties both tables", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    insertEdge(db, a, b, "depends");
    clearGraph(db);
    expect(listAllNodes(db)).toEqual([]);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM graph_edges").get() as { c: number })
        .c
    ).toBe(0);
  });
});

describe("listAllEdgesModuleNames", () => {
  it("returns module-name triples joined from the two node tables", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    insertEdge(db, a, b, "calls");
    const rows = listAllEdgesModuleNames(db);
    expect(rows).toEqual([
      { from_name: "a", to_name: "b", edge_type: "calls" },
    ]);
  });
});

describe("bfsFromNode (the BFS primitive used by get_dependents/get_dependencies/get_blast_radius)", () => {
  // Build a 3-node linear chain: A → B → C, plus a back-edge D → A and a
  // cross-edge B → D (so the graph has some branching).
  function seedGraph() {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    const c = upsertNode(db, "c", "/p/c", 0);
    const d = upsertNode(db, "d", "/p/d", 0);
    insertEdge(db, a, b, "depends");
    insertEdge(db, b, c, "depends");
    insertEdge(db, d, a, "depends"); // → makes A a dependent of D
    insertEdge(db, b, d, "depends");
    return { a, b, c, d };
  }

  it("get_dependents: BFS downstream from A at depth=1 returns B", () => {
    // A → B, so A's dependents (what A depends on, BFS downstream) include B.
    const { a } = seedGraph();
    const hops = bfsFromNode(db, a, "outgoing", 1);
    expect(hops).toEqual([{ module: "b", depth: 1, edge_type: "depends" }]);
  });

  it("get_dependents: BFS downstream from A at depth=2 returns B, C, D", () => {
    const { a } = seedGraph();
    const hops = bfsFromNode(db, a, "outgoing", 2);
    // a → b → c, a → b → d
    expect(hops).toContainEqual({ module: "b", depth: 1, edge_type: "depends" });
    expect(hops).toContainEqual({ module: "c", depth: 2, edge_type: "depends" });
    expect(hops).toContainEqual({ module: "d", depth: 2, edge_type: "depends" });
  });

  it("get_dependencies: BFS upstream from A at depth=1 returns D", () => {
    // D → A, so A's dependencies (what depends on A) include D.
    const { a } = seedGraph();
    const hops = bfsFromNode(db, a, "incoming", 1);
    expect(hops).toEqual([{ module: "d", depth: 1, edge_type: "depends" }]);
  });

  it("blast_radius: BFS with maxDepth=0 is unbounded (returns D and B for upstream)", () => {
    // A is the start. Walking upstream (incoming edges) of A:
    // depth 1: D (D → A).
    // depth 2: B (B → D, the incoming edge to D).
    const { a } = seedGraph();
    const hops = bfsFromNode(db, a, "incoming", 0);
    expect(hops.map((h) => h.module).sort()).toEqual(["b", "d"]);
  });

  it("EC-CG-05: cyclic graph (A→B and B→A) does not loop forever", () => {
    const a = upsertNode(db, "a", "/p/a", 0);
    const b = upsertNode(db, "b", "/p/b", 0);
    insertEdge(db, a, b, "depends");
    insertEdge(db, b, a, "depends");
    // Walk downstream from a: b is reached at depth 1. From b we
    // would walk to a but a is the start node, so we skip it.
    const hops = bfsFromNode(db, a, "outgoing", 5);
    expect(hops).toEqual([{ module: "b", depth: 1, edge_type: "depends" }]);
  });

  it("EC-CG-06: depth=10 on a chain returns only the reachable nodes", () => {
    const { a } = seedGraph();
    const hops = bfsFromNode(db, a, "outgoing", 10);
    const modules = hops.map((h) => h.module).sort();
    expect(modules).toEqual(["b", "c", "d"]);
  });

  it("returns empty array when no neighbors", () => {
    const a = upsertNode(db, "lonely", "/p/l", 0);
    expect(bfsFromNode(db, a, "outgoing", 5)).toEqual([]);
    expect(bfsFromNode(db, a, "incoming", 5)).toEqual([]);
  });
});

describe("searchNodes (used by find_entry_points)", () => {
  it("scores rows by token-match count", () => {
    upsertNode(db, "src/api/login.ts", "/p", 1);
    upsertNode(db, "src/api/middleware/rate_limit.ts", "/p", 0);
    upsertNode(db, "src/auth/session.ts", "/p", 0);
    upsertNode(db, "src/utils/string.ts", "/p", 0);
    const r = searchNodes(db, ["api", "login"], 5);
    // 'login' module: 'login' in module (1), 'api' in module (1) → score 2.
    // 'rate_limit' module: 'api' in module (1) → score 1.
    // 'session' module: neither → 0 (filtered out).
    // 'string' module: neither → 0 (filtered out).
    expect(r.length).toBe(2);
    // login.ts wins on score (2 vs 1) AND has entry_point=1.
    expect(r[0].module).toBe("src/api/login.ts");
  });

  it("returns empty when no tokens match", () => {
    upsertNode(db, "a.ts", "/p", 0);
    expect(searchNodes(db, ["zzz", "yyy"], 5)).toEqual([]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) upsertNode(db, `m${i}.ts`, "/p", 0);
    const r = searchNodes(db, ["m"], 3);
    expect(r.length).toBe(3);
  });

  it("EC-CG-08: ties broken by entry_point DESC, then id ASC", () => {
    // Two nodes that match 'api' exactly once each. The entry_point
    // node wins, regardless of insertion order.
    const _a = upsertNode(db, "src/api/zzz.ts", "/p", 0); // id=1
    const _b = upsertNode(db, "src/api/aaa.ts", "/p", 1); // id=2, entry_point
    const r = searchNodes(db, ["api"], 5);
    // Both match `api` once. B has entry_point=1, so it wins.
    expect(r[0].module).toBe("src/api/aaa.ts");
  });
});

describe("recordIndexRun / getIndexRunByCommit / getLatestIndexRun / parseEdgeSnapshot", () => {
  it("round-trips an edge snapshot", () => {
    recordIndexRun(db, "abc123", [
      { from: "a", to: "b", edge_type: "depends" },
      { from: "a", to: "c", edge_type: "calls" },
    ]);
    const r = getIndexRunByCommit(db, "abc123");
    expect(r).not.toBeNull();
    expect(r?.commit_hash).toBe("abc123");
    expect(parseEdgeSnapshot(r!.edge_snapshot)).toEqual([
      { from: "a", to: "b", edge_type: "depends" },
      { from: "a", to: "c", edge_type: "calls" },
    ]);
  });

  it("EC-CG-07: getIndexRunByCommit returns null for unknown commit", () => {
    recordIndexRun(db, "abc", []);
    expect(getIndexRunByCommit(db, "zzz")).toBeNull();
  });

  it("matches a commit by short prefix", () => {
    recordIndexRun(db, "abcdef123456", []);
    expect(getIndexRunByCommit(db, "abcdef")).not.toBeNull();
  });

  it("getLatestIndexRun returns the most recent", () => {
    recordIndexRun(db, "first", []);
    recordIndexRun(db, "second", []);
    recordIndexRun(db, "third", []);
    expect(getLatestIndexRun(db)?.commit_hash).toBe("third");
  });

  it("parseEdgeSnapshot filters out invalid entries", () => {
    const good = JSON.stringify([
      { from: "a", to: "b", edge_type: "depends" },
      { from: "x", to: "y", edge_type: "bogus" },
      { not: "an edge" },
      "string",
    ]);
    expect(parseEdgeSnapshot(good)).toEqual([
      { from: "a", to: "b", edge_type: "depends" },
    ]);
  });

  it("parseEdgeSnapshot returns [] on non-JSON input", () => {
    expect(parseEdgeSnapshot("not json")).toEqual([]);
  });
});
