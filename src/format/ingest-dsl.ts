// Graph DSL ingest parser — inverse of Spec 02's output formatters.
//
// Parses the §4 ingest format produced by `project-brain index --push`
// into structured objects for `ingest_graph_data` to write to
// `graph_nodes`/`graph_edges` via `storage/graph.ts`.

import type { EdgeType } from "../storage/graph.js";

/** A parsed node block from the full-mode ingest format. */
export interface IngestNode {
  module: string;
  path: string;
  entryPoint: 0 | 1;
  deprecated: 0 | 1;
  edges: IngestEdge[];
}

/** A parsed edge from the ingest format. */
export interface IngestEdge {
  from: string;
  to: string;
  edgeType: EdgeType;
}

/** Result of parsing a full-mode payload. */
export interface FullParseResult {
  commitHash: string;
  nodes: IngestNode[];
}

/** Result of parsing an incremental-mode payload. */
export interface IncrementalParseResult {
  commitHash: string;
  addNodes: IngestNode[];
  removeNodes: string[]; // module names to remove
  addEdges: IngestEdge[];
  removeEdges: IngestEdge[];
}

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

/** Extract the text inside `[...]` brackets, or null if malformed. */
function extractBrackets(line: string): string | null {
  const match = line.match(/^\[(.*)\]$/);
  return match ? match[1] : null;
}

/** Extract module name from `[module]` at the start of a line. */
function extractModule(line: string): string | null {
  const match = line.match(/^\[(.+?)\]$/);
  return match ? match[1] : null;
}

/** Parse an edge line like `>[to]`, `c>[to]`, `!>[to]`. Returns null if invalid. */
function parseEdgeLine(fromModule: string, line: string): IngestEdge | null {
  // Pattern: optional prefix (c or !) followed by >[module]
  const match = line.match(/^(c|!)?>(.+)$/);
  if (!match) return null;

  const prefix = match[1]; // undefined, 'c', or '!'
  const targetRaw = match[2];

  // Target must be wrapped in brackets
  const targetMatch = targetRaw.match(/^\[(.+?)\]$/);
  if (!targetMatch) return null;
  const to = targetMatch[1];

  let edgeType: EdgeType;
  if (prefix === "c") edgeType = "calls";
  else if (prefix === "!") edgeType = "side_effect";
  else edgeType = "depends";

  return { from: fromModule, to, edgeType };
}

// ---------------------------------------------------------------------------
// Full mode parser
// ---------------------------------------------------------------------------

/**
 * Parse a full-mode Graph DSL payload.
 *
 * Grammar:
 *   commit=<hash>          (optional first line)
 *   [module/path.ts]       node header
 *   path=<relative path>   (optional, defaults to module)
 *   @                      (optional, entry_point=1)
 *   ~                      (optional, deprecated=1)
 *   >[other/module.ts]     edge — depends
 *   c>[other/module.ts]    edge — calls
 *   !>[other/module.ts]    edge — side_effect
 *
 * Returns { nodes, commitHash } or throws with message for invalid lines.
 */
export function parseFullIngestDsl(dsl: string): FullParseResult {
  const lines = dsl.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  let commitHash = "unknown";
  const nodes: IngestNode[] = [];
  let currentNode: IngestNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Optional commit hash on first line
    if (i === 0 && line.startsWith("commit=")) {
      commitHash = line.slice("commit=".length);
      continue;
    }

    // Node header: [module]
    if (line.startsWith("[")) {
      const moduleName = extractModule(line);
      if (!moduleName) {
        throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
      }
      if (currentNode) nodes.push(currentNode);
      currentNode = {
        module: moduleName,
        path: moduleName,
        entryPoint: 0,
        deprecated: 0,
        edges: [],
      };
      continue;
    }

    if (!currentNode) {
      throw new Error(
        `invalid graph_dsl at line ${i + 1}: ${line} (not inside a node block)`
      );
    }

    // path=<relative path>
    if (line.startsWith("path=")) {
      currentNode.path = line.slice("path=".length);
      continue;
    }

    // @ flag
    if (line === "@") {
      currentNode.entryPoint = 1;
      continue;
    }

    // ~ flag
    if (line === "~") {
      currentNode.deprecated = 1;
      continue;
    }

    // Edge line
    const edge = parseEdgeLine(currentNode.module, line);
    if (edge) {
      currentNode.edges.push(edge);
      continue;
    }

    // Unrecognized line
    throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
  }

  if (currentNode) nodes.push(currentNode);

  return { commitHash, nodes };
}

// ---------------------------------------------------------------------------
// Incremental mode parser
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this line look like an edge line (not a node line)?
 * Edge lines: [from]>[to], [from]c>[to], ![from]>[to], [from]![to]
 * Node lines: [module]  (no > after the closing bracket)
 */
function isIncrementalEdgeLine(line: string): boolean {
  // ![from]>[to] form
  if (line.startsWith("![")) return true;
  if (!line.startsWith("[")) return false;
  // Look for patterns like [from]>, [from]c>, [from]!
  return /^\[.+?\](?:c|!)?>/.test(line) || /^\[.+?\]!/.test(line);
}

/**
 * Parse an incremental-mode Graph DSL payload.
 *
 * Grammar:
 *   commit=<hash>              (optional first line)
 *   +[module/path.ts]          add node
 *     path=<relative path>     (indented, optional)
 *     @                        (indented, optional)
 *     ~                        (indented, optional)
 *   -[removed/module.ts]       remove node
 *   +[from]>[to]               add edge — depends
 *   +[from]c>[to]              add edge — calls
 *   +![from]>[to]              add edge — side_effect
 *   -[from]>[to]               remove edge — depends
 *   -[from]c>[to]              remove edge — calls
 *   -[from]![to]               remove edge — side_effect (spec §4: "analogous -c>, -! forms")
 *
 * Note: the spec says -[from]>[to] for 'depends', -[from]c>[to] for 'calls',
 * -[from]![to] for 'side_effect'. I also accept -![from]>[to] for side_effect
 * to be consistent with the + form.
 */
export function parseIncrementalIngestDsl(
  dsl: string
): IncrementalParseResult {
  const rawLines = dsl.split("\n");
  const lines = rawLines.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);

  let commitHash = "unknown";
  const addNodes: IngestNode[] = [];
  const removeNodes: string[] = [];
  const addEdges: IngestEdge[] = [];
  const removeEdges: IngestEdge[] = [];

  let i = 0;

  // Optional commit hash on first line
  if (lines[0]?.startsWith("commit=")) {
    commitHash = lines[0].slice("commit=".length);
    i = 1;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    // +[from]>[to] or +[from]c>[to] or +![from]>[to] — add edge
    // Must be checked BEFORE +[module] node add, because both start with +[
    // An edge line has > inside; a node line ends with just ]
    if (line.startsWith("+") && isIncrementalEdgeLine(line.slice(1))) {
      const edge = parseIncrementalEdgeLine(line.slice(1));
      if (!edge) {
        throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
      }
      addEdges.push(edge);
      i++;
      continue;
    }

    // +[module] — add node (no > inside)
    if (line.startsWith("+[") && line.endsWith("]")) {
      const moduleName = extractModule(line.slice(1));
      if (!moduleName) {
        throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
      }
      const node: IngestNode = {
        module: moduleName,
        path: moduleName,
        entryPoint: 0,
        deprecated: 0,
        edges: [],
      };
      i++;
      // Consume indented property lines
      while (i < lines.length) {
        const next = lines[i].trim();
        if (next.startsWith("+[") || next.startsWith("-[") || next.startsWith("commit=")) {
          break;
        }
        if (next.startsWith("path=")) {
          node.path = next.slice("path=".length);
        } else if (next === "@") {
          node.entryPoint = 1;
        } else if (next === "~") {
          node.deprecated = 1;
        } else {
          throw new Error(`invalid graph_dsl at line ${i + 1}: ${next}`);
        }
        i++;
      }
      addNodes.push(node);
      continue;
    }

    // -[from]>[to] or -[from]c>[to] or -[from]![to] — remove edge
    // Must be checked BEFORE -[module] node remove, because both start with -[
    // An edge line has > inside; a node line ends with just ]
    if (line.startsWith("-") && isIncrementalEdgeLine(line.slice(1))) {
      const edge = parseIncrementalEdgeLine(line.slice(1));
      if (!edge) {
        throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
      }
      removeEdges.push(edge);
      i++;
      continue;
    }

    // -[module] — remove node (no > inside)
    if (line.startsWith("-[") && line.endsWith("]")) {
      const moduleName = extractModule(line.slice(1));
      if (!moduleName) {
        throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
      }
      removeNodes.push(moduleName);
      i++;
      continue;
    }

    throw new Error(`invalid graph_dsl at line ${i + 1}: ${line}`);
  }

  return { commitHash, addNodes, removeNodes, addEdges, removeEdges };
}

/** Parse an incremental edge line like `[from]>[to]`, `[from]c>[to]`, `[from]![to]` or `![from]>[to]`. */
function parseIncrementalEdgeLine(line: string): IngestEdge | null {
  // Handle ![from]>[to] form (with ! before the [])
  if (line.startsWith("!")) {
    const rest = line.slice(1);
    const modMatch = rest.match(/^\[(.+?)\]>(.+)$/);
    if (!modMatch) return null;
    const toMatch = modMatch[2].match(/^\[(.+?)\]$/);
    if (!toMatch) return null;
    return { from: modMatch[1], to: toMatch[1], edgeType: "side_effect" };
  }

  // Handle [from]![to] form (no > between ! and [to])
  const bangMatch = line.match(/^\[(.+?)\]!(\[.+\])$/);
  if (bangMatch) {
    const toMatch = bangMatch[2].match(/^\[(.+?)\]$/);
    if (!toMatch) return null;
    return { from: bangMatch[1], to: toMatch[1], edgeType: "side_effect" };
  }

  // Handle [from]c>[to] and [from]>[to] forms
  const match = line.match(/^\[(.+?)\](c|!)?>(.+)$/);
  if (!match) return null;

  const from = match[1];
  const prefix = match[2]; // undefined, 'c', or '!'
  const targetRaw = match[3];

  const toMatch = targetRaw.match(/^\[(.+?)\]$/);
  if (!toMatch) return null;
  const to = toMatch[1];

  let edgeType: EdgeType;
  if (prefix === "c") edgeType = "calls";
  else if (prefix === "!") edgeType = "side_effect";
  else edgeType = "depends";

  return { from, to, edgeType };
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate that a full-mode payload contains only valid lines.
 * Returns the parsed result or throws with a clear message.
 */
export function validateAndParseFull(dsl: string): FullParseResult {
  if (dsl.trim() === "") {
    return { commitHash: "unknown", nodes: [] };
  }
  return parseFullIngestDsl(dsl);
}

/**
 * Validate that an incremental-mode payload contains only valid lines.
 * Returns the parsed result or throws with a clear message.
 */
export function validateAndParseIncremental(
  dsl: string
): IncrementalParseResult {
  if (dsl.trim() === "") {
    return { commitHash: "unknown", addNodes: [], removeNodes: [], addEdges: [], removeEdges: [] };
  }
  return parseIncrementalIngestDsl(dsl);
}
