#!/usr/bin/env node
// project-brain CLI — Spec 09.
//
//   project-brain index [--full | --since <commit>] --push
//
// Walks the repo tree (or a diff slice), parses source files with
// Spec 02's tree-sitter layer, serializes to Graph DSL ingest format,
// and POSTs to `${PROJECT_BRAIN_URL}/ingest`.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, relative, sep } from "node:path";

import {
  buildPerFileResolvers,
  listSourceFiles,
  readCurrentCommitHash,
} from "../src/parser/indexer.js";
import {
  getLanguageForExtension,
  isEntryPointPath,
  parseFileEdges,
} from "../src/parser/treesitter.js";
import type { ParsedEdge } from "../src/parser/treesitter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CliNode {
  module: string;
  path: string;
  entryPoint: 0 | 1;
  deprecated: 0 | 1;
  edges: ParsedEdge[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] !== "index") {
    console.error("Usage: project-brain index [--full | --since <commit>] --push");
    process.exit(1);
  }

  let full = false;
  let since: string | null = null;
  let push = false;
  let url = process.env.PROJECT_BRAIN_URL ?? "";
  let token = process.env.PROJECT_BRAIN_TOKEN ?? "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--full") full = true;
    else if (args[i] === "--since" && i + 1 < args.length) since = args[++i];
    else if (args[i] === "--push") push = true;
    else if (args[i] === "--url" && i + 1 < args.length) url = args[++i];
    else if (args[i] === "--token" && i + 1 < args.length) token = args[++i];
  }

  if (!full && !since) {
    console.error("Either --full or --since <commit> is required");
    process.exit(1);
  }
  if (!push) {
    console.error("--push is required");
    process.exit(1);
  }
  if (!url) {
    console.error("PROJECT_BRAIN_URL is required for --push");
    process.exit(1);
  }
  if (!token) {
    console.error("PROJECT_BRAIN_TOKEN is required for --push");
    process.exit(1);
  }

  const root = process.cwd();

  // EC-LI-05: validate commit exists before doing any work
  if (since) {
    try {
      execFileSync("git", ["cat-file", "-e", since], {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      console.error(`commit ${since} not found`);
      process.exit(1);
    }
  }

  let dsl: string;
  let mode: "full" | "incremental";

  if (full) {
    mode = "full";
    dsl = buildFullDsl(root);
  } else {
    mode = "incremental";
    dsl = buildIncrementalDsl(root, since!);
  }

  if (push) {
    await pushDsl(url, token, dsl, mode);
  }
}

// ---------------------------------------------------------------------------
// Full-mode DSL builder
// ---------------------------------------------------------------------------

function buildFullDsl(root: string): string {
  const commitHash = readCurrentCommitHash(root);
  const files = listSourceFiles(root);
  const perFileResolvers = buildPerFileResolvers(root, files);

  const lines: string[] = [`commit=${commitHash}`];

  for (const abs of files) {
    const rel = toForwardSlash(relative(root, abs));
    const ext = extname(abs);
    if (!getLanguageForExtension(ext)) continue;

    const node = parseNode(abs, rel, ext, perFileResolvers.get(rel) ?? new Map());
    if (!node) continue;

    lines.push(`[${node.module}]`);
    lines.push(`path=${node.path}`);
    if (node.entryPoint) lines.push("@");
    if (node.deprecated) lines.push("~");

    for (const e of node.edges) {
      lines.push(edgeToDsl(e));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Incremental-mode DSL builder
// ---------------------------------------------------------------------------

function buildIncrementalDsl(root: string, sinceCommit: string): string {
  // Get changed files from git
  const diffOut = execFileSync(
    "git",
    ["diff", "--name-status", sinceCommit, "HEAD"],
    { cwd: root, encoding: "utf8" }
  );

  const changedFiles: { rel: string; status: string }[] = [];
  for (const line of diffOut.trim().split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0].charAt(0); // A, M, D, R, etc.
    const rel = parts[1];
    changedFiles.push({ rel, status });
  }

  const commitHash = readCurrentCommitHash(root);
  const lines: string[] = [`commit=${commitHash}`];

  // Build resolvers from current tree (good enough for edge diff in most cases)
  const allFiles = listSourceFiles(root);
  const perFileResolvers = buildPerFileResolvers(root, allFiles);

  for (const { rel, status } of changedFiles) {
    const ext = extname(rel);
    if (!getLanguageForExtension(ext)) continue;

    if (status === "D") {
      // Deleted file — remove node and all its edges
      lines.push(`-[${toForwardSlash(rel)}]`);
      continue;
    }

    // Added or modified — parse current version
    const abs = `${root}${sep}${rel}`;
    const currentNode = parseNode(abs, toForwardSlash(rel), ext, perFileResolvers.get(toForwardSlash(rel)) ?? new Map());
    if (!currentNode) continue;

    // Try to parse old version for edge-level diff
    const oldEdges = parseOldNodeEdges(root, sinceCommit, rel, ext, perFileResolvers.get(toForwardSlash(rel)) ?? new Map());

    // Emit +[module] block
    lines.push(`+[${currentNode.module}]`);
    lines.push(`path=${currentNode.path}`);
    if (currentNode.entryPoint) lines.push("@");
    if (currentNode.deprecated) lines.push("~");

    // For edges, emit all current edges as + and removed edges as -
    const oldEdgeSet = new Set(oldEdges.map(edgeKey));
    for (const e of currentNode.edges) {
      lines.push(`+${edgeToDsl(e)}`);
    }
    for (const oldEdge of oldEdges) {
      if (!currentNode.edges.some((e) => edgeKey(e) === edgeKey(oldEdge))) {
        lines.push(`-${edgeToDsl(oldEdge)}`);
      }
    }
  }

  return lines.join("\n");
}

/** Parse a single file into a CliNode. Returns null on failure. */
function parseNode(
  absPath: string,
  relPath: string,
  ext: string,
  resolvers: Map<string, string>
): CliNode | null {
  let source = "";
  try {
    source = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }

  let edges: ParsedEdge[] = [];
  try {
    edges = parseFileEdges(relPath, source, ext, resolvers);
  } catch {
    return null;
  }

  return {
    module: relPath,
    path: absPath,
    entryPoint: isEntryPointPath(relPath) ? 1 : 0,
    deprecated: 0,
    edges,
  };
}

/** Try to parse the old version of a file at a specific commit. */
function parseOldNodeEdges(
  root: string,
  commit: string,
  relPath: string,
  ext: string,
  resolvers: Map<string, string>
): ParsedEdge[] {
  let source: string;
  try {
    source = execFileSync(
      "git",
      ["show", `${commit}:${toForwardSlash(relPath)}`],
      { cwd: root, encoding: "utf8" }
    );
  } catch {
    return [];
  }

  try {
    return parseFileEdges(toForwardSlash(relPath), source, ext, resolvers);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DSL serialization helpers
// ---------------------------------------------------------------------------

function edgeToDsl(edge: ParsedEdge): string {
  const prefix =
    edge.edge_type === "calls"
      ? "c"
      : edge.edge_type === "side_effect"
      ? "!"
      : "";
  return `${prefix}>[${edge.to}]`;
}

function edgeKey(edge: ParsedEdge): string {
  return `${edge.from}>${edge.to}>${edge.edge_type}`;
}

function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// HTTP push
// ---------------------------------------------------------------------------

async function pushDsl(
  url: string,
  token: string,
  dsl: string,
  mode: "full" | "incremental"
): Promise<void> {
  const ingestUrl = `${url.replace(/\/$/, "")}/ingest`;
  const body = JSON.stringify({ graph_dsl: dsl, mode });

  let res: Response;
  try {
    res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
    });
  } catch (err) {
    // EC-LI-06: unreachable server
    console.error("Failed to connect to ingest endpoint:", err);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`Ingest failed (${res.status}): ${text}`);
    process.exit(1);
  }

  console.log(text);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("project-brain failed:", err);
  process.exit(1);
});
