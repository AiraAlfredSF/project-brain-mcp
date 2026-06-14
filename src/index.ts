// MCP server entry point — tool registration.
//
// Spec 01 implemented: log_decision, log_failure, get_context, list_constraints.
// Spec 02 implemented: index_codebase, get_dependents, get_dependencies,
//                      get_blast_radius, diff_graph, find_entry_points.
// Spec 03 implemented: validate_plan.
// Spec 04 implemented: get_bootstrap_status, run_bootstrap,
//                      log_module_intent, write_constraints_draft.
// Spec 05 implemented: ingest_constraints_file, export_constraints_file,
//                      flag_stale_constraints, get_sync_status,
//                      list_flagged_constraints.
// Spec 06 implemented: start_session, record_tool_call, get_session_health.
// Future specs (07) will register their tools here as they land.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createConstraintsSchema } from "./storage/constraints.js";
import { createGraphSchema } from "./storage/graph.js";
import { createDecisionsSchema } from "./storage/decisions.js";
import { createBootstrapSchema } from "./storage/bootstrap.js";
import { createHealthSchema } from "./storage/health.js";
import {
  diffGraph,
  findEntryPoints,
  getBlastRadius,
  getDependencies,
  getDependents,
  indexCodebaseTool,
} from "./tools/graph.js";
import { validatePlan } from "./tools/validator.js";
import {
  getBootstrapStatus,
  logModuleIntent,
  runBootstrap,
  writeConstraintsDraft,
} from "./tools/bootstrap.js";
import {
  exportConstraintsFile,
  flagStaleConstraints,
  getSyncStatus,
  ingestConstraintsFile,
  listFlaggedConstraintsTool,
} from "./tools/sync.js";
import {
  getContext,
  listAllConstraints,
  logDecision,
  logFailure,
} from "./tools/decision.js";
import {
  getSessionHealth,
  recordToolCallTool,
  startSession,
  trackToolCall,
} from "./tools/health.js";
import { ingestGraphData } from "./tools/ingest.js";

// ---------------------------------------------------------------------------
// Resolve the on-disk DB path.
//
// Per base-schema-reference.md, the local DB lives in `.project-brain/`
// inside the *target* repository the agent is working in — i.e. the CWD
// the MCP server was launched from, not the server's own install dir.
//
// We resolve `.project-brain/decisions.db` relative to the CWD and let
// `mkdirSync` create the directory on first run. Spec 01 introduces no
// ENV variables (per §8 of the spec); the PROJECT_BRAIN_DB override is
// a future-proofing affordance only.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH =
  process.env.PROJECT_BRAIN_DB ??
  resolve(process.cwd(), ".project-brain/decisions.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

/** Singleton DB handle. Initialized once at module load. */
export const db: DatabaseType = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// Apply schemas. Idempotent.
createDecisionsSchema(db);
createConstraintsSchema(db);
createGraphSchema(db);
createBootstrapSchema(db);
createHealthSchema(db);


// ---------------------------------------------------------------------------
// MCP server + tool registration.
// ---------------------------------------------------------------------------

// Tool response helper — wraps a DSL string into a single text-content block
// per MCP `CallToolResult` contract.
function dslResult(dsl: string) {
  return {
    content: [{ type: "text" as const, text: dsl }],
  };
}

/**
 * Create an MCP server, register all tools, and return it.
 * Used by both stdio and HTTP transports.
 */
export function createMcpServerWithTools(dbInstance: DatabaseType): McpServer {
  // Shadow the module-level db export so all handler lambdas below use the
  // passed-in instance (required for per-transport DB handles in remote mode).
  const db = dbInstance;

  const server = new McpServer(
    {
      name: "code-brain-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Wraps `server.registerTool` so that every tool call (including
  // `start_session` and `record_tool_call` itself, per Spec 06 EC-SH-01) is
  // recorded into `session_tool_calls` via `trackToolCall()` after the
  // handler runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function registerTool(
    name: string,
    meta: any,
    handler: (...args: any[]) => Promise<ReturnType<typeof dslResult>>
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.registerTool(name, meta, async (...args: any[]) => {
      const result = await handler(...args);
      trackToolCall(dbInstance, name);
      return result;
    });
  }

// ---------------------------------------------------------------------------
// Input schemas.
//
// We declare the *shape* here so the SDK can validate and forward typed
// args to our handler. The handler functions in tools/decision.ts are
// themselves the source of truth for business validation (per Spec 01
// §3 Error conditions) and accept `unknown` defensively. The Zod schemas
// below are deliberately permissive — the same input shapes the spec
// documents, no more, no less.
// ---------------------------------------------------------------------------

const logDecisionInputSchema = {
  decision: z.string(),
  rationale: z.string(),
  alternatives_rejected: z.array(z.string()),
  tags: z.array(z.string()).optional(),
};

const logFailureInputSchema = {
  description: z.string(),
  cause: z.string(),
  approach_tried: z.string(),
};

const getContextInputSchema = {
  topic: z.string(),
  limit: z.number().int().positive().optional(),
};

// `list_constraints` takes no arguments — pass an empty object schema so
// the SDK calls our handler with `(args, extra)` instead of just `(extra)`.
const listConstraintsInputSchema = {};

registerTool(
  "log_decision",
  {
    title: "Log Decision",
    description:
      "Record a decision with its rationale and rejected alternatives. " +
      "Returns `OK D <id>` on success or `ERR <message>` on validation failure.",
    inputSchema: logDecisionInputSchema,
  },
  async (args) => dslResult(logDecision(db, args))
);

registerTool(
  "log_failure",
  {
    title: "Log Failure",
    description:
      "Record an approach that failed, so future sessions don't repeat it. " +
      "Returns `OK F <id>` on success or `ERR <message>` on validation failure.",
    inputSchema: logFailureInputSchema,
  },
  async (args) => dslResult(logFailure(db, args))
);

registerTool(
  "get_context",
  {
    title: "Get Context",
    description:
      "Fuzzy-search prior decisions and failures relevant to `topic`, " +
      "most recent first, capped at `limit` (default 5). " +
      "First call of the session emits the one-time `BRAIN DSL v1` header.",
    inputSchema: getContextInputSchema,
  },
  async (args) => dslResult(getContext(db, args))
);

registerTool(
  "list_constraints",
  {
    title: "List Constraints",
    description:
      "Return all constraints, sorted by confidence (high → medium → low) " +
      "then most recent first. First call of the session emits the one-time " +
      "`BRAIN DSL v1` header.",
    inputSchema: listConstraintsInputSchema,
  },
  async () => dslResult(listAllConstraints(db))
);

// ===========================================================================
// Spec 02 — Code Graph Engine
// ===========================================================================

const indexCodebaseInputSchema = {
  path: z.string().optional(),
  incremental: z.boolean().optional(),
};

const getDependentsInputSchema = {
  module: z.string(),
  depth: z.number().int().min(1).max(10).optional(),
};

const getDependenciesInputSchema = {
  module: z.string(),
  depth: z.number().int().min(1).max(10).optional(),
};

const getBlastRadiusInputSchema = {
  module: z.string(),
};

const diffGraphInputSchema = {
  since_commit: z.string(),
};

const findEntryPointsInputSchema = {
  intent: z.string(),
};

registerTool(
  "index_codebase",
  {
    title: "Index Codebase",
    description:
      "Walk the target repo's file tree, parse each supported source file, " +
      "and (re)build `graph_nodes`/`graph_edges`. " +
      "Returns `GRAPH: indexed` with `node_count`/`edge_count`/`duration_ms`.",
    inputSchema: indexCodebaseInputSchema,
  },
  async (args) => dslResult(indexCodebaseTool(db, args ?? {}))
);

registerTool(
  "get_dependents",
  {
    title: "Get Dependents",
    description:
      "Return modules that depend on (call into, or are affected by) " +
      "`module`, traversed up to `depth` hops (1..10, default 1). " +
      "Returns Graph DSL with `^callers d=<n>` sections.",
    inputSchema: getDependentsInputSchema,
  },
  async (args) => dslResult(getDependents(db, args))
);

registerTool(
  "get_dependencies",
  {
    title: "Get Dependencies",
    description:
      "Return modules that `module` depends on, traversed up to `depth` " +
      "hops (1..10, default 1). Returns Graph DSL with `>deps d=<n>` " +
      "sections; `!>` prefixes `side_effect` edges.",
    inputSchema: getDependenciesInputSchema,
  },
  async (args) => dslResult(getDependencies(db, args))
);

registerTool(
  "get_blast_radius",
  {
    title: "Get Blast Radius",
    description:
      "Return the full transitive set of dependents of `module` with " +
      "depth annotations on every line (no depth cap). " +
      "If I change `module`, what's affected and how far away?",
    inputSchema: getBlastRadiusInputSchema,
  },
  async (args) => dslResult(getBlastRadius(db, args))
);

registerTool(
  "diff_graph",
  {
    title: "Diff Graph",
    description:
      "Report structural graph changes (edges added/removed) since the " +
      "index run recorded at `since_commit`. " +
      "`+` added, `-` removed, `!` prefix marks `side_effect` edges.",
    inputSchema: diffGraphInputSchema,
  },
  async (args) => dslResult(diffGraph(db, args))
);

registerTool(
  "find_entry_points",
  {
    title: "Find Entry Points",
    description:
      "Semantic search over `graph_nodes` for an `intent` description. " +
      "Top 3 matches, `@` prefixes entry points, `~` prefixes deprecated " +
      "nodes (both may co-occur as `@~[old/entry.ts]`).",
    inputSchema: findEntryPointsInputSchema,
  },
  async (args) => dslResult(findEntryPoints(db, args))
);

// ===========================================================================
// Spec 09 — Local Indexer Ingest
// ===========================================================================

const ingestGraphDataInputSchema = {
  graph_dsl: z.string(),
  mode: z.enum(["full", "incremental"]),
};

registerTool(
  "ingest_graph_data",
  {
    title: "Ingest Graph Data",
    description:
      "Parse a Graph DSL payload and write to `graph_nodes`/`graph_edges`. " +
      "`mode: full` replaces the entire graph; `mode: incremental" +
      " applies an add/remove diff. Returns `GRAPH: ingested` with " +
      "`nodes_updated`, `edges_updated`, `mode`, and `timestamp`." +
      "All writes are atomic — a malformed payload produces `ERR invalid graph_dsl` " +
      "with zero side effects.",
    inputSchema: ingestGraphDataInputSchema,
  },
  async (args) => dslResult(ingestGraphData(db, args))
);

// ===========================================================================
// Spec 03 — Plan Validator
// ===========================================================================

const validatePlanInputSchema = {
  steps: z.array(z.string()),
  task: z.string(),
};

registerTool(
  "validate_plan",
  {
    title: "Validate Plan",
    description:
      "Evaluate a proposed multi-step plan against the project's hard " +
      "constraints, open failures, and architectural boundaries. " +
      "Returns `PLAN: approved` (no body) or `PLAN: blocked` with " +
      "one `step[n]=` / `fix=` pair per flagged step (in step order). " +
      "First call of the session emits the one-time `BRAIN DSL v1` header.",
    inputSchema: validatePlanInputSchema,
  },
  async (args) => dslResult(validatePlan(db, args))
);

// ===========================================================================
// Spec 04 — Bootstrap Agent
// ===========================================================================

const getBootstrapStatusInputSchema = {};

const runBootstrapInputSchema = {
  path: z.string().optional(),
};

const logModuleIntentInputSchema = {
  module: z.string(),
  intent: z.string(),
  constraints: z.array(z.string()),
  caveats: z.array(z.string()),
};

const writeConstraintsDraftInputSchema = {};

registerTool(
  "get_bootstrap_status",
  {
    title: "Get Bootstrap Status",
    description:
      "Report whether bootstrap has been run, and if so, whether it is " +
      "complete (`complete`) or still in progress (`incomplete`). " +
      "Returns one of: `BOOTSTRAP: never_run`, " +
      "`BOOTSTRAP: incomplete modules=N intents=M`, or " +
      "`BOOTSTRAP: complete modules=N intents=N`.",
    inputSchema: getBootstrapStatusInputSchema,
  },
  async () => dslResult(getBootstrapStatus(db))
);

registerTool(
  "run_bootstrap",
  {
    title: "Run Bootstrap",
    description:
      "Multi-turn bootstrap orchestration. On each call, re-indexes the " +
      "target repo (default cwd) and returns the next uncovered module's " +
      "path for the calling agent to read and describe via " +
      "`log_module_intent`. When all modules are covered, regenerates " +
      "`constraints.md` and returns `BOOTSTRAP: complete`. Calling again " +
      "once complete short-circuits to `BOOTSTRAP: already_complete`.",
    inputSchema: runBootstrapInputSchema,
  },
  async (args) => dslResult(runBootstrap(db, args ?? {}))
);

registerTool(
  "log_module_intent",
  {
    title: "Log Module Intent",
    description:
      "Record the inferred purpose, constraints, and caveats for one " +
      "module. Writes one row to `module_intents` and one row per " +
      "constraint to Spec 01's `constraints` table (with " +
      "`level='soft'`, `source='bootstrap'`, `confidence='medium'`).",
    inputSchema: logModuleIntentInputSchema,
  },
  async (args) => dslResult(logModuleIntent(db, args))
);

registerTool(
  "write_constraints_draft",
  {
    title: "Write Constraints Draft",
    description:
      "Regenerate `constraints.md` at the target repo root from " +
      "Spec 01's `constraints` table, in Spec 05's file format " +
      "(YAML frontmatter + Architectural Boundaries / " +
      "Technology Constraints / ⚠ Flagged for Review sections).",
    inputSchema: writeConstraintsDraftInputSchema,
  },
  async () => dslResult(writeConstraintsDraft(db))
);

// ===========================================================================
// Spec 05 — Two-Way Sync
// ===========================================================================

const ingestConstraintsFileInputSchema = {};

const exportConstraintsFileInputSchema = {};

const flagStaleConstraintsInputSchema = {
  commit: z.string(),
};

const getSyncStatusInputSchema = {};

const listFlaggedConstraintsInputSchema = {};

registerTool(
  "ingest_constraints_file",
  {
    title: "Ingest Constraints File",
    description:
      "Parse `constraints.md` (after a manual human edit) and apply the " +
      "diff to Spec 01's `constraints` table. Returns `SYNC: ingested` " +
      "with `added`, `updated`, `removed` counts.",
    inputSchema: ingestConstraintsFileInputSchema,
  },
  async () => dslResult(ingestConstraintsFile(db))
);

registerTool(
  "export_constraints_file",
  {
    title: "Export Constraints File",
    description:
      "Regenerate `constraints.md` from Spec 01's `constraints` table, " +
      "preserving existing [Cnnn] ids and section placement rules. " +
      "Returns `SYNC: exported` with `rows` and `version`.",
    inputSchema: exportConstraintsFileInputSchema,
  },
  async () => dslResult(exportConstraintsFile(db))
);

registerTool(
  "flag_stale_constraints",
  {
    title: "Flag Stale Constraints",
    description:
      "Given a git commit hash (from a post-commit hook), use Spec 02's " +
      "`diff_graph` to find structural edge changes, and flag hard " +
      "constraints whose module references contradict the changes. " +
      "Returns `SYNC: flagged` with `checked` and `newly_flagged` counts.",
    inputSchema: flagStaleConstraintsInputSchema,
  },
  async (args) => dslResult(flagStaleConstraints(db, args))
);

registerTool(
  "get_sync_status",
  {
    title: "Get Sync Status",
    description:
      "Compare `constraints.md`'s frontmatter against Spec 01's `constraints` " +
      "table to detect drift. Returns one of: `SYNC: synced`, " +
      "`SYNC: drift_detected` with a reason, or `SYNC: file_missing`.",
    inputSchema: getSyncStatusInputSchema,
  },
  async () => dslResult(getSyncStatus(db))
);

registerTool(
  "list_flagged_constraints",
  {
    title: "List Flagged Constraints",
    description:
      "Return all `constraints` rows where `flag IS NOT NULL`, using " +
      "Spec 01's `C` row DSL format, for an agent or human to review " +
      "before the next `export_constraints_file` call.",
    inputSchema: listFlaggedConstraintsInputSchema,
  },
  async () => dslResult(listFlaggedConstraintsTool(db))
);

// ===========================================================================
// Spec 06 — Session Health Monitor
// ===========================================================================

const startSessionInputSchema = {};

const recordToolCallInputSchema = {
  tool_name: z.string(),
};

const getSessionHealthInputSchema = {};

registerTool(
  "start_session",
  {
    title: "Start Session",
    description:
      "Begin a new session: close any previously-open session, open a new " +
      "one, and reset the compliance checklist. Returns `SESSION: started` " +
      "with `session_id=<n>`. First call of the session emits the one-time " +
      "`BRAIN DSL v1` header.",
    inputSchema: startSessionInputSchema,
  },
  async () => dslResult(startSession(db))
);

registerTool(
  "record_tool_call",
  {
    title: "Record Tool Call",
    description:
      "Record one tool invocation against the current open session " +
      "(opening one implicitly if needed). Normally called automatically " +
      "by the server's tool-dispatch layer after every tool call. " +
      "Returns `OK TC` or `ERR tool_name is required`.",
    inputSchema: recordToolCallInputSchema,
  },
  async (args) => dslResult(recordToolCallTool(db, args))
);

registerTool(
  "get_session_health",
  {
    title: "Get Session Health",
    description:
      "Evaluate the current open session's tool-call history against the " +
      "compliance checklist (get_context before acting, validate_plan " +
      "before log_decision). Returns `SESSION: compliant|warnings|violations` " +
      "with `calls:`, `missing:`, and `action:` lines.",
    inputSchema: getSessionHealthInputSchema,
  },
  async () => dslResult(getSessionHealth(db))
);

  return server;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Transport mode from ENV (§8). */
const TRANSPORT_MODE = process.env.TRANSPORT_MODE ?? "local";

/** Bearer token required for remote mode (§8). */
const PROJECT_BRAIN_TOKEN = process.env.PROJECT_BRAIN_TOKEN;

/** SQLite busy_timeout for remote mode (§8, EC-RT-05). */
const SQLITE_BUSY_TIMEOUT_MS =
  Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? "5000");

async function main(): Promise<void> {
  if (TRANSPORT_MODE === "remote") {
    // EC-RT-02: fail fast if token missing in remote mode
    if (!PROJECT_BRAIN_TOKEN || PROJECT_BRAIN_TOKEN.trim() === "") {
      // eslint-disable-next-line no-console
      console.error("ERR PROJECT_BRAIN_TOKEN is required when TRANSPORT_MODE=remote");
      process.exit(1);
    }

    // Enable WAL for concurrent HTTP access (§2)
    db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    const { startHttpServer } = await import("./transport/http.js");
    const { shutdown } = await startHttpServer(db, PROJECT_BRAIN_TOKEN);

    // Graceful shutdown
    const cleanup = () => {
      shutdown();
      db.close();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } else {
    // EC-RT-01 / EC-RT-04: local mode — stdio, no auth, no WAL change
    const server = createMcpServerWithTools(db);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // eslint-disable-next-line no-console
    console.error(`code-brain-mcp ready — DB at ${DB_PATH}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("code-brain-mcp failed to start:", err);
  process.exit(1);
});
