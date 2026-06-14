// HTTP transport layer. Spec 08 + Spec 09.
//
// Exposes the existing MCP tool set over HTTP at `/mcp` using the SDK's
// StreamableHTTPServerTransport. Bearer auth is enforced before the route.
// Stateful mode: one transport instance per `Mcp-Session-Id`, kept in a
// map for the lifetime of the server process — "one server process serves
// many client sessions over time" (§ Session-boundary clarification).
//
// Also exposes `POST /ingest` (Spec 09) for the `project-brain index --push`
// CLI to push Graph DSL payloads without using the MCP protocol envelope.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database as DatabaseType } from "better-sqlite3";

import { createMcpServerWithTools } from "../index.js";
import { createBearerAuthMiddleware } from "./auth.js";
import { closeOpenSessions, createSession } from "../storage/health.js";
import { ingestGraphData } from "../tools/ingest.js";

export interface HttpServerHandle {
  shutdown(): void;
  port: number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Start the HTTP MCP server.
 *
 * - Binds to `host` (default from `HOST` env, else `127.0.0.1`).
 * - Listens on `port` (default from `PORT` env, else `8420`).
 * - Bearer token required on every request (EC-RT-03).
 * - Stateful Streamable HTTP transport: a fresh transport (and `sessions`
 *   row) is created for every `initialize` request, keyed by the
 *   `Mcp-Session-Id` the SDK assigns. Subsequent requests are routed to
 *   their transport by that header. `onsessioninitialized` opens a fresh
 *   SQLite `sessions` row so that `trackToolCall` records against it
 *   (Test Plan — Spec 06 interaction); `onsessionclosed` removes the
 *   transport from the map (EC-RT-06).
 */
export async function startHttpServer(
  db: DatabaseType,
  bearerToken: string,
  opts?: { host?: string; port?: number }
): Promise<HttpServerHandle> {
  const authMiddleware = createBearerAuthMiddleware(bearerToken);

  // One entry per active `Mcp-Session-Id` (EC-RT-06: a reconnecting client
  // with a new session id gets a new transport + a new `sessions` row).
  const sessions = new Map<string, SessionEntry>();

  /** Create a new transport + MCP server for a fresh `initialize` request. */
  async function createSessionEntry(): Promise<SessionEntry> {
    let entry: SessionEntry;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: async (sessionId) => {
        closeOpenSessions(db);
        createSession(db);
        sessions.set(sessionId, entry);
      },
      onsessionclosed: async (sessionId) => {
        sessions.delete(sessionId);
      },
    });

    const server = createMcpServerWithTools(db);
    await server.connect(transport);

    entry = { transport, server };
    return entry;
  }

  const host = opts?.host ?? process.env.HOST ?? "127.0.0.1";
  const requestedPort = opts?.port ?? Number(process.env.PORT ?? "8420");

  const httpServer = createServer((req, res) => {
    authMiddleware(req, res, () => {
      if (req.url === "/mcp") {
        handleMcpRequest(req, res).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("MCP transport error:", err instanceof Error ? err.message : String(err));
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      } else if (req.url === "/ingest" && req.method === "POST") {
        // Spec 09 — /ingest endpoint for project-brain index --push CLI
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes("application/json")) {
          res.statusCode = 415;
          res.setHeader("Content-Type", "text/plain");
          res.end("ERR Content-Type must be application/json");
          return;
        }
        collectBody(req, { maxBytes: 10 * 1024 * 1024 }) // 10 MB limit (VULN-04 fix)
          .then((body) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain");
              res.end("ERR invalid JSON");
              return;
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain");
              res.end("ERR invalid request body");
              return;
            }
            const p = parsed as Record<string, unknown>;
            const graphDsl = typeof p.graph_dsl === "string" ? p.graph_dsl : "";
            const mode = typeof p.mode === "string" ? p.mode : "";
            const result = ingestGraphData(db, { graph_dsl: graphDsl, mode });
            res.statusCode = result.startsWith("GRAPH: ingested") ? 200 : 400;
            res.setHeader("Content-Type", "text/plain");
            res.end(result);
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("Ingest error:", err instanceof Error ? err.message : String(err));
            if (!res.headersSent) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain");
              res.end("ERR invalid request body");
            }
          });
      } else {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("Not Found");
      }
    });
  });

  /** Route a `/mcp` request to its session's transport, creating one for `initialize`. */
  async function handleMcpRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const body = await collectBody(req, { maxBytes: 10 * 1024 * 1024 });

    let parsedBody: unknown;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error: Invalid JSON" },
            id: null,
          })
        );
        return;
      }
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry) {
      if (sessionId) {
        // Unknown/expired session id.
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          })
        );
        return;
      }
      if (!isInitializeRequest(parsedBody)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
            id: null,
          })
        );
        return;
      }
      entry = await createSessionEntry();
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  }

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, () => {
      httpServer.removeListener("error", reject);
      const addr = httpServer.address();
      const actualPort =
        addr && typeof addr === "object" ? addr.port : requestedPort;
      // eslint-disable-next-line no-console
      console.error(`code-brain-mcp HTTP ready — ${host}:${actualPort}`);
      resolve({
        port: actualPort,
        shutdown: () => {
          httpServer.close();
          for (const { transport, server } of sessions.values()) {
            transport.close();
            server.close();
          }
          sessions.clear();
        },
      });
    });
  });
}

/** Collect the full body of an IncomingMessage as a string. */
function collectBody(
  req: import("node:http").IncomingMessage,
  opts?: { maxBytes?: number }
): Promise<string> {
  const maxBytes = opts?.maxBytes ?? Number.POSITIVE_INFINITY;
  return new Promise((resolve, reject) => {
    let body = "";
    let byteLength = 0;
    req.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        req.destroy();
        reject(new Error("Request body exceeded size limit"));
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
