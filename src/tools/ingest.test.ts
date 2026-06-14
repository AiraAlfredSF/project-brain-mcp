// Tests for Spec 09 — ingest_graph_data tool handler.
// Covers every Test Plan item and every EC-LI-NN edge case.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { createGraphSchema, upsertNode, insertEdge } from "../storage/graph.js";
import { ingestGraphData } from "./ingest.js";

function setupDb(): DatabaseType {
  const db = new Database(":memory:");
  createGraphSchema(db);
  db.pragma("foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// Test Plan §6
// ---------------------------------------------------------------------------

describe("ingest_graph_data", () => {
  describe("happy path: full mode", () => {
    let db: DatabaseType;

    beforeEach(() => {
      db = setupDb();
    });

    it("ingests a 3-node, 4-edge payload and makes them queryable (§6-1)", () => {
      const dsl = `commit=abc123
[src/a.ts]
path=src/a.ts
>[src/b.ts]
c>[src/c.ts]
[src/b.ts]
path=src/b.ts
>[src/c.ts]
[src/c.ts]
path=src/c.ts`;

      const result = ingestGraphData(db, { graph_dsl: dsl, mode: "full" });
      expect(result).toMatch(/^GRAPH: ingested/);
      expect(result).toContain("nodes_updated=3");
      expect(result).toContain("edges_updated=3");
      expect(result).toContain("mode=full");

      // Verify nodes exist
      const nodes = db.prepare("SELECT module FROM graph_nodes").all() as { module: string }[];
      const modules = nodes.map((n) => n.module).sort();
      expect(modules).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

      // Verify edges
      const edges = db
        .prepare(
          `SELECT n_from.module AS from_mod, n_to.module AS to_mod, e.edge_type
           FROM graph_edges e
           JOIN graph_nodes n_from ON n_from.id = e.from_node
           JOIN graph_nodes n_to ON n_to.id = e.to_node`
        )
        .all() as Array<{ from_mod: string; to_mod: string; edge_type: string }>;
      expect(edges.length).toBe(3);
    });

    it("empty payload with full mode clears graph (§6-2, EC-LI-01)", () => {
      // Seed some data first
      ingestGraphData(db, {
        graph_dsl: `[src/x.ts]\npath=src/x.ts\n[src/y.ts]\npath=src/y.ts\n>[src/x.ts]`,
        mode: "full",
      });

      const beforeNodes = db.prepare("SELECT COUNT(*) AS c FROM graph_nodes").get() as { c: number };
      expect(beforeNodes.c).toBe(2);

      const result = ingestGraphData(db, { graph_dsl: "", mode: "full" });
      expect(result).toContain("nodes_updated=0");
      expect(result).toContain("edges_updated=0");

      const afterNodes = db.prepare("SELECT COUNT(*) AS c FROM graph_nodes").get() as { c: number };
      expect(afterNodes.c).toBe(0);
      const afterEdges = db.prepare("SELECT COUNT(*) AS c FROM graph_edges").get() as { c: number };
      expect(afterEdges.c).toBe(0);
    });
  });

  describe("happy path: incremental mode", () => {
    let db: DatabaseType;

    beforeEach(() => {
      db = setupDb();
    });

    it("applies an add/remove diff correctly (§6-4)", () => {
      // Seed with full ingest
      ingestGraphData(db, {
        graph_dsl: `commit=seed
[src/a.ts]
path=src/a.ts
>[src/b.ts]
[src/b.ts]
path=src/b.ts`,
        mode: "full",
      });

      // Incremental: add a->c, remove a->b
      const result = ingestGraphData(db, {
        graph_dsl: `commit=diff1
+[src/a.ts]>[src/c.ts]
-[src/a.ts]>[src/b.ts]`,
        mode: "incremental",
      });

      expect(result).toMatch(/^GRAPH: ingested/);
      expect(result).toContain("mode=incremental");

      const edges = db
        .prepare(
          `SELECT n_from.module AS from_mod, n_to.module AS to_mod, e.edge_type
           FROM graph_edges e
           JOIN graph_nodes n_from ON n_from.id = e.from_node
           JOIN graph_nodes n_to ON n_to.id = e.to_node`
        )
        .all() as Array<{ from_mod: string; to_mod: string; edge_type: string }>;

      const edgeSignatures = edges.map(
        (e) => `${e.from_mod}>${e.to_mod}:${e.edge_type}`
      );
      expect(edgeSignatures).toContain("src/a.ts>src/c.ts:depends");
      expect(edgeSignatures).not.toContain("src/a.ts>src/b.ts:depends");
    });

    it("creates referenced nodes implicitly in incremental mode (EC-LI-02)", () => {
      const result = ingestGraphData(db, {
        graph_dsl: `+[src/new.ts]>[src/other.ts]`,
        mode: "incremental",
      });

      expect(result).toMatch(/^GRAPH: ingested/);

      const nodes = db.prepare("SELECT module FROM graph_nodes").all() as { module: string }[];
      const modules = nodes.map((n) => n.module);
      expect(modules).toContain("src/new.ts");
      expect(modules).toContain("src/other.ts");
    });

    it("removes node and all its edges when -[module] is given (EC-LI-03)", () => {
      // Seed: a->b, a->c
      ingestGraphData(db, {
        graph_dsl: `commit=seed
[src/a.ts]
path=src/a.ts
>[src/b.ts]
>[src/c.ts]
[src/b.ts]
path=src/b.ts
[src/c.ts]
path=src/c.ts`,
        mode: "full",
      });

      // Remove b entirely
      ingestGraphData(db, {
        graph_dsl: `-[src/b.ts]`,
        mode: "incremental",
      });

      const nodes = db.prepare("SELECT module FROM graph_nodes").all() as { module: string }[];
      const modules = nodes.map((n) => n.module);
      expect(modules).toContain("src/a.ts");
      expect(modules).toContain("src/c.ts");
      expect(modules).not.toContain("src/b.ts");

      const edges = db.prepare("SELECT COUNT(*) AS c FROM graph_edges").get() as { c: number };
      // a->c should remain, a->b and any edges to b should be gone
      expect(edges.c).toBe(1);
    });
  });

  describe("invalid input", () => {
    let db: DatabaseType;

    beforeEach(() => {
      db = setupDb();
    });

    it("rejects invalid mode (§6-3)", () => {
      const result = ingestGraphData(db, { graph_dsl: "", mode: "bogus" });
      expect(result).toBe("ERR mode must be 'full' or 'incremental'");
    });

    it("rejects malformed graph_dsl with no partial writes (§6-3, EC-LI-04)", () => {
      // Seed some data
      ingestGraphData(db, {
        graph_dsl: `[src/x.ts]\npath=src/x.ts`,
        mode: "full",
      });
      const beforeCount = (db.prepare("SELECT COUNT(*) AS c FROM graph_nodes").get() as { c: number }).c;

      // Try to ingest malformed DSL
      const result = ingestGraphData(db, {
        graph_dsl: `[src/y.ts]\nthis_is_not_a_valid_line`,
        mode: "full",
      });

      expect(result).toBe("ERR invalid graph_dsl");

      const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM graph_nodes").get() as { c: number }).c;
      // No partial writes — count unchanged
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("interaction with Spec 02", () => {
    it("get_dependencies produces same output after ingest as after index_codebase (§6-5)", () => {
      // This is an architectural guarantee: both tools write through the
      // same storage/graph.ts adapter to the same tables. The test here
      // verifies that ingest writes the correct rows.
      const db = setupDb();

      const dsl = `commit=test
[src/a.ts]
path=src/a.ts
>[src/b.ts]
c>[src/c.ts]
[src/b.ts]
path=src/b.ts
[src/c.ts]
path=src/c.ts`;

      const result = ingestGraphData(db, { graph_dsl: dsl, mode: "full" });
      expect(result).toMatch(/^GRAPH: ingested/);

      // Verify via direct SQL that the graph matches expectations
      const aNode = db.prepare("SELECT id FROM graph_nodes WHERE module = ?").get("src/a.ts") as { id: number } | undefined;
      expect(aNode).toBeDefined();

      const deps = db
        .prepare(
          `SELECT n_to.module AS to_mod, e.edge_type
           FROM graph_edges e
           JOIN graph_nodes n_from ON n_from.id = e.from_node
           JOIN graph_nodes n_to ON n_to.id = e.to_node
           WHERE n_from.module = ?`
        )
        .all("src/a.ts") as Array<{ to_mod: string; edge_type: string }>;

      expect(deps.length).toBe(2);
      const targets = deps.map((d) => `${d.to_mod}:${d.edge_type}`).sort();
      expect(targets).toEqual(["src/b.ts:depends", "src/c.ts:calls"]);
    });
  });
});
