// Tests for Spec 09's ingest DSL parser.
// Covers §4 grammar parsing for both full and incremental modes.

import { describe, expect, it } from "vitest";

import {
  parseFullIngestDsl,
  parseIncrementalIngestDsl,
  validateAndParseFull,
  validateAndParseIncremental,
} from "./ingest-dsl.js";

// ---------------------------------------------------------------------------
// Full mode parsing
// ---------------------------------------------------------------------------

describe("parseFullIngestDsl", () => {
  it("parses a single node with no edges", () => {
    const dsl = `[src/main.ts]
path=src/main.ts
@`;
    const result = parseFullIngestDsl(dsl);
    expect(result.commitHash).toBe("unknown");
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0]).toEqual({
      module: "src/main.ts",
      path: "src/main.ts",
      entryPoint: 1,
      deprecated: 0,
      edges: [],
    });
  });

  it("parses a node with depends, calls, and side_effect edges", () => {
    const dsl = `[src/a.ts]
path=src/a.ts
>[src/b.ts]
c>[src/c.ts]
!>[src/d.ts]`;
    const result = parseFullIngestDsl(dsl);
    expect(result.nodes[0].edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", edgeType: "depends" },
      { from: "src/a.ts", to: "src/c.ts", edgeType: "calls" },
      { from: "src/a.ts", to: "src/d.ts", edgeType: "side_effect" },
    ]);
  });

  it("parses the optional commit= line", () => {
    const dsl = `commit=abc123
[src/main.ts]
path=src/main.ts`;
    const result = parseFullIngestDsl(dsl);
    expect(result.commitHash).toBe("abc123");
  });

  it("parses deprecated flag (~)", () => {
    const dsl = `[src/old.ts]
path=src/old.ts
~`;
    const result = parseFullIngestDsl(dsl);
    expect(result.nodes[0].deprecated).toBe(1);
    expect(result.nodes[0].entryPoint).toBe(0);
  });

  it("parses multiple nodes", () => {
    const dsl = `[src/a.ts]
path=src/a.ts
[src/b.ts]
path=src/b.ts
@`;
    const result = parseFullIngestDsl(dsl);
    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].module).toBe("src/a.ts");
    expect(result.nodes[1].module).toBe("src/b.ts");
  });

  it("defaults path to module when path= is absent", () => {
    const dsl = `[src/a.ts]
@`;
    const result = parseFullIngestDsl(dsl);
    expect(result.nodes[0].path).toBe("src/a.ts");
  });

  it("rejects a line outside a node block", () => {
    const dsl = `path=orphan`;
    expect(() => parseFullIngestDsl(dsl)).toThrow(/not inside a node block/);
  });

  it("rejects malformed edge line", () => {
    const dsl = `[src/a.ts]
bad_edge_line`;
    expect(() => parseFullIngestDsl(dsl)).toThrow(/invalid graph_dsl/);
  });
});

// ---------------------------------------------------------------------------
// Incremental mode parsing
// ---------------------------------------------------------------------------

describe("parseIncrementalIngestDsl", () => {
  it("parses +[module] add node with properties", () => {
    const dsl = `+[src/new.ts]
  path=src/new.ts
  @`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.commitHash).toBe("unknown");
    expect(result.addNodes.length).toBe(1);
    expect(result.addNodes[0]).toEqual({
      module: "src/new.ts",
      path: "src/new.ts",
      entryPoint: 1,
      deprecated: 0,
      edges: [],
    });
    expect(result.removeNodes.length).toBe(0);
    expect(result.addEdges.length).toBe(0);
    expect(result.removeEdges.length).toBe(0);
  });

  it("parses -[module] remove node", () => {
    const dsl = `-[src/old.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.removeNodes).toEqual(["src/old.ts"]);
  });

  it("parses +[from]>[to] add edge", () => {
    const dsl = `+[src/a.ts]>[src/b.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.addEdges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", edgeType: "depends" },
    ]);
  });

  it("parses +[from]c>[to] add calls edge", () => {
    const dsl = `+[src/a.ts]c>[src/b.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.addEdges[0].edgeType).toBe("calls");
  });

  it("parses +![from]>[to] add side_effect edge", () => {
    const dsl = `+![src/a.ts]>[src/b.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.addEdges[0].edgeType).toBe("side_effect");
  });

  it("parses -[from]>[to] remove edge", () => {
    const dsl = `-[src/a.ts]>[src/b.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.removeEdges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", edgeType: "depends" },
    ]);
  });

  it("parses -[from]c>[to] remove calls edge", () => {
    const dsl = `-[src/a.ts]c>[src/b.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.removeEdges[0].edgeType).toBe("calls");
  });

  it("parses -![from]>[to] remove side_effect edge", () => {
    const dsl = `-[src/a.ts]![src/b.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.removeEdges[0].edgeType).toBe("side_effect");
  });

  it("parses commit= line", () => {
    const dsl = `commit=def456
+[src/a.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.commitHash).toBe("def456");
  });

  it("parses mixed operations in one payload", () => {
    const dsl = `commit=abc
+[src/a.ts]
  path=src/a.ts
-[src/b.ts]
+[src/a.ts]>[src/c.ts]
-[src/d.ts]>[src/e.ts]`;
    const result = parseIncrementalIngestDsl(dsl);
    expect(result.addNodes.length).toBe(1);
    expect(result.removeNodes.length).toBe(1);
    expect(result.addEdges.length).toBe(1);
    expect(result.removeEdges.length).toBe(1);
  });

  it("rejects unrecognized line", () => {
    const dsl = `bad_line`;
    expect(() => parseIncrementalIngestDsl(dsl)).toThrow(/invalid graph_dsl/);
  });
});

// ---------------------------------------------------------------------------
// validateAndParse wrappers
// ---------------------------------------------------------------------------

describe("validateAndParseFull", () => {
  it("returns empty result for empty string (EC-LI-01)", () => {
    const result = validateAndParseFull("");
    expect(result.commitHash).toBe("unknown");
    expect(result.nodes).toEqual([]);
  });

  it("passes through valid payload", () => {
    const result = validateAndParseFull("[a]\npath=a\n");
    expect(result.nodes.length).toBe(1);
  });
});

describe("validateAndParseIncremental", () => {
  it("returns empty result for empty string", () => {
    const result = validateAndParseIncremental("");
    expect(result.commitHash).toBe("unknown");
    expect(result.addNodes).toEqual([]);
    expect(result.removeNodes).toEqual([]);
    expect(result.addEdges).toEqual([]);
    expect(result.removeEdges).toEqual([]);
  });

  it("passes through valid payload", () => {
    const result = validateAndParseIncremental("+[a]\n");
    expect(result.addNodes.length).toBe(1);
  });
});
