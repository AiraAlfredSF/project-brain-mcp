// ingest_graph_data tool handler. Spec 09.
//
// Parses incoming Graph DSL payload and writes to Spec 02's
// `graph_nodes`/`graph_edges`/`graph_index_runs` tables.
// All writes are inside a single SQLite transaction (EC-LI-04).

import type { Database as DatabaseType } from "better-sqlite3";

import {
  clearGraph,
  insertEdge,
  listAllEdgesModuleNames,
  recordIndexRun,
  upsertNode,
  type ModuleEdge,
} from "../storage/graph.js";
import {
  validateAndParseFull,
  validateAndParseIncremental,
} from "../format/ingest-dsl.js";
import {
  GRAPH_INGESTED_HEADER,
  formatIngestStats,
  formatErr,
} from "../format/dsl.js";

// ---------------------------------------------------------------------------
// ingest_graph_data(graph_dsl, mode)
// ---------------------------------------------------------------------------

/**
 * Ingest graph data from a Graph DSL payload.
 *
 * Parameters:
 *   - graph_dsl: string — the payload in §4 format
 *   - mode: "full" | "incremental"
 *
 * Returns: `GRAPH: ingested` with stats, or `ERR ...` on validation failure.
 */
export function ingestGraphData(
  db: DatabaseType,
  rawInput: unknown
): string {
  // Validate input shape
  if (!isRecord(rawInput)) {
    return formatErr("graph_dsl and mode are required");
  }

  const { graph_dsl, mode } = rawInput;
  if (typeof graph_dsl !== "string") {
    return formatErr("graph_dsl must be a string");
  }
  if (mode !== "full" && mode !== "incremental") {
    return formatErr("mode must be 'full' or 'incremental'");
  }

  // Empty string is valid for both modes (EC-LI-01)
  const trimmed = graph_dsl.trim();

  // Parse and validate BEFORE any writes (EC-LI-04)
  let commitHash = "unknown";
  try {
    if (mode === "full") {
      const parsed = validateAndParseFull(graph_dsl);
      commitHash = parsed.commitHash;

      // All writes inside one transaction
      const tx = db.transaction(() => {
        clearGraph(db);

        for (const node of parsed.nodes) {
          upsertNode(db, node.module, node.path, node.entryPoint, node.deprecated);
          for (const edge of node.edges) {
            const fromId = upsertNode(db, edge.from, edge.from, 0);
            const toId = upsertNode(db, edge.to, edge.to, 0);
            insertEdge(db, fromId, toId, edge.edgeType);
          }
        }

        const snapshot: ModuleEdge[] = listAllEdgesModuleNames(db);
        recordIndexRun(db, commitHash, snapshot);
      });
      tx();

      const nodeCount = parsed.nodes.length;
      const edgeCount = parsed.nodes.reduce((sum, n) => sum + n.edges.length, 0);
      return [
        GRAPH_INGESTED_HEADER,
        ...formatIngestStats(nodeCount, edgeCount, mode, new Date().toISOString()),
      ].join("\n");
    } else {
      // incremental
      const parsed = validateAndParseIncremental(graph_dsl);
      commitHash = parsed.commitHash;

      const tx = db.transaction(() => {
        // 1. Add new nodes
        for (const node of parsed.addNodes) {
          upsertNode(db, node.module, node.path, node.entryPoint, node.deprecated);
          for (const edge of node.edges) {
            const fromId = upsertNode(db, edge.from, edge.from, 0);
            const toId = upsertNode(db, edge.to, edge.to, 0);
            insertEdge(db, fromId, toId, edge.edgeType);
          }
        }

        // 2. Remove nodes (and all their edges, both directions)
        for (const moduleName of parsed.removeNodes) {
          const node = db
            .prepare("SELECT id FROM graph_nodes WHERE module = ?")
            .get(moduleName) as { id: number } | undefined;
          if (node) {
            db.prepare("DELETE FROM graph_edges WHERE from_node = ? OR to_node = ?")
              .run(node.id, node.id);
            db.prepare("DELETE FROM graph_nodes WHERE id = ?")
              .run(node.id);
          }
        }

        // 3. Add edges (creating nodes if needed, EC-LI-02)
        for (const edge of parsed.addEdges) {
          const fromId = upsertNode(db, edge.from, edge.from, 0);
          const toId = upsertNode(db, edge.to, edge.to, 0);
          insertEdge(db, fromId, toId, edge.edgeType);
        }

        // 4. Remove edges
        for (const edge of parsed.removeEdges) {
          const fromNode = db
            .prepare("SELECT id FROM graph_nodes WHERE module = ?")
            .get(edge.from) as { id: number } | undefined;
          const toNode = db
            .prepare("SELECT id FROM graph_nodes WHERE module = ?")
            .get(edge.to) as { id: number } | undefined;
          if (fromNode && toNode) {
            db.prepare(
              "DELETE FROM graph_edges WHERE from_node = ? AND to_node = ? AND edge_type = ?"
            ).run(fromNode.id, toNode.id, edge.edgeType);
          }
        }

        // 5. Record index run with post-ingest snapshot
        const snapshot: ModuleEdge[] = listAllEdgesModuleNames(db);
        recordIndexRun(db, commitHash, snapshot);
      });
      tx();

      const nodeCount = parsed.addNodes.length + parsed.removeNodes.length;
      const edgeCount = parsed.addEdges.length + parsed.removeEdges.length;
      return [
        GRAPH_INGESTED_HEADER,
        ...formatIngestStats(nodeCount, edgeCount, mode, new Date().toISOString()),
      ].join("\n");
    }
  } catch (err) {
    // EC-LI-04: parse error → no partial writes (transaction already rolled back)
    return formatErr("invalid graph_dsl");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
