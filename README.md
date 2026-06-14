# project-brain-mcp

Standalone [MCP](https://modelcontextprotocol.io) server that gives CLI
coding agents (Claude Code, Cline, Cursor, opencode) persistent decision
memory, codebase dependency-graph awareness, plan validation against
architectural constraints, and a self-bootstrapping `constraints.md` file —
backed by a local SQLite database (`.project-brain/decisions.db`) in each
project it's wired into.

## CLI agent support status

| Agent | Status |
|---|---|
| **Claude Code** | ✅ Tested end-to-end (indexing, dependency graph, decision memory, plan validation, bootstrap, all 24 tools). |
| **Cline** | ⚠️ Skill package shipped (`skills/cline/`), install script support present — not yet verified end-to-end. |
| **Cursor** | ⚠️ Skill package shipped (`skills/cursor/`), install script support present — not yet verified end-to-end. |
| **opencode** | ⚠️ Skill package shipped (`skills/opencode/`), install script support present — not yet verified end-to-end. |

If you try this with Cline, Cursor, or opencode, please open an issue with
what worked / didn't — that feedback directly shapes which agent gets
verified next.

---

## Use case scenarios

These are real flows this server enables once wired into a project (the
examples below are from testing against a Laravel/PHP codebase, but the same
flows apply to any supported language):

- **Onboarding into an unfamiliar codebase.** Run `index_codebase` once, then
  `run_bootstrap` — the agent walks every module, records its inferred
  purpose/constraints/caveats via `log_module_intent`, and generates a draft
  `constraints.md` (Architectural Boundaries, Technology Constraints) for you
  to review and correct.

- **"What breaks if I change this?"** Before editing a shared model or
  service, the agent calls `get_dependents` / `get_blast_radius` to see every
  file that transitively depends on it — e.g. confirming that changing
  `app/Models/User.php` only affects `database/seeders/DatabaseSeeder.php`,
  not half the app.

- **Don't repeat past mistakes.** When an approach fails (a library doesn't
  fit, a migration breaks under load, etc.), the agent logs it with
  `log_failure`. In a later session, `get_context(topic)` surfaces that
  failure before the agent tries the same thing again.

- **Plan review against architectural rules.** Before executing a multi-step
  plan, `validate_plan(task, steps)` checks each step against logged hard
  constraints and graph-derived boundaries, returning `PLAN: blocked` with
  specific fixes if a step would violate one.

- **"Where do I even start?"** For a feature request described in plain
  English, `find_entry_points(intent)` does a semantic search over indexed
  modules — e.g. `intent="HTTP request entry point for the web application"`
  returned the relevant controllers in a Laravel app.

- **Tracking structural drift over time.** `diff_graph(since_commit)` shows
  which dependency edges were added/removed since a given commit — useful
  after pulling a large set of changes before continuing work.

---

## Supported languages

The code-graph indexer (`index_codebase`) parses these file types via
[tree-sitter](https://tree-sitter.github.io/tree-sitter/):

| Language | Extensions |
|---|---|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| Java | `.java` |
| C / C++ | `.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh` |
| PHP | `.php` (PSR-4 `use` resolution via `composer.json`) |

Other file types are indexed as plain nodes but produce no dependency edges.

---

## Prerequisites

- Node.js `^20 || ^22 || >=24`
- A git working tree for the project you want to wire this into (most tools
  work without git, but `diff_graph` and the incremental CLI ingest path use
  the current commit hash)

---

## Install & build

```bash
git clone <this-repo>
cd code-brain-mcp
npm install
npm run build
```

This produces `dist/src/index.js` (the MCP server entry point) and
`dist/cli/index.js` (the `project-brain` CLI for remote ingest, see below).

---

## Setup in a project

### Option A — automated install script (recommended)

From the root of the project you want to add code-brain-mcp to:

```bash
/path/to/code-brain-mcp/scripts/install.sh
```

The script:

1. Detects which agent(s) you use, based on marker files in your project:
   - **Claude Code**: `CLAUDE.md` or `.claude/`
   - **Cline**: `.clinerules` or `.cline/`
   - **Cursor**: `.cursorrules` or `.cursor/`
   - **opencode**: `AGENTS.md` or `.opencode/`
2. Installs/merges the matching skill package from `skills/<agent>/` into
   your project (project-memory instructions + a bootstrap flow), preserving
   any existing content in those files (code-brain-mcp's block is wrapped in
   `<!-- code-brain-mcp:start/end -->` markers).
3. Registers the MCP server in your agent's config (`.mcp.json`,
   `.cursor/mcp.json`, `opencode.json`). Cline stores MCP config outside the
   repo — the script prints the entry to add manually via the Cline "MCP
   Servers" panel.
4. Creates `.project-brain/` (the local SQLite database directory) if it
   doesn't already exist.
5. Installs a `.git/hooks/post-commit` hook (for the optional remote-ingest
   workflow, see below).

If no marker file is detected, the script exits with instructions for adding
one manually.

### Option B — manual config (Claude Code)

Add to `.mcp.json` (or your global `~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "code-brain": {
      "command": "node",
      "args": ["/path/to/code-brain-mcp/dist/src/index.js"]
    }
  }
}
```

Then copy `skills/claude-code/CLAUDE.md` and `skills/claude-code/bootstrap.md`
into your project so Claude Code knows how/when to call the tools.

---

## First run

In a fresh Claude Code session in your project:

1. `start_session()`
2. `get_context(topic="...")` — loads project memory, required before other
   tool calls per the session-health checker.
3. `index_codebase(incremental=false)` — builds the initial dependency graph.
4. `get_bootstrap_status()` — if `never_run`, run `run_bootstrap(path)`
   repeatedly (see `skills/<agent>/bootstrap.md` for the full multi-turn
   flow) to populate `constraints.md` with the project's architectural
   boundaries and technology constraints.

After that, `CLAUDE.md` (or the equivalent rule file for your agent) describes
the always-on behaviors: calling `get_dependents`/`get_dependencies`/
`get_blast_radius` before changing a module, `validate_plan` before executing
a multi-step plan, `log_decision`/`log_failure` to build up project memory,
etc.

---

## Transport modes

| Mode | Default | Auth | Notes |
|---|---|---|---|
| `local` (stdio) | yes | none | Single project, single SQLite file, spawned by your agent. |
| `remote` (HTTP) | set `TRANSPORT_MODE=remote` | `PROJECT_BRAIN_TOKEN` bearer token (required — server refuses to start without it) | Enables `WAL` mode + `SQLITE_BUSY_TIMEOUT_MS` for concurrent access; see `scripts/project-brain.service` for a systemd unit example. |

Remote mode env vars: `TRANSPORT_MODE`, `PROJECT_BRAIN_TOKEN`, `HOST`
(default `127.0.0.1`), `PORT` (default `8420`), `SQLITE_BUSY_TIMEOUT_MS`
(default `5000`).

### Remote ingest CLI

For the remote-server setup, the `project-brain` CLI (`dist/cli/index.js`)
pushes graph updates from a separate machine/CI job:

```bash
project-brain index --full --push --url https://your-server --token $PROJECT_BRAIN_TOKEN
project-brain index --since <commit> --push --url https://your-server --token $PROJECT_BRAIN_TOKEN
```

The installed `post-commit` git hook runs the `--since HEAD~1 --push`
incremental form automatically if `PROJECT_BRAIN_URL` is set in your
environment.

---

## Project memory file: `constraints.md`

`export_constraints_file()` generates a human-readable `constraints.md` at
your project root (YAML frontmatter + Architectural Boundaries / Technology
Constraints / Flagged-for-review sections). Edit it by hand, then call
`ingest_constraints_file()` to sync your edits back into the database. See
`constraints.md` in this repo for a live example of the format.

---

## A note on secrets

`index_codebase` never reads or stores raw file contents — it only parses
source files (per the extensions listed above) for import/dependency edges,
and stores file paths + module names in `.project-brain/decisions.db`. It
never reads `.env` files or similar.

The `decisions`/`failures`/`module_intents`/`constraints` tables store
free-text written by your agent via `log_decision`, `log_failure`, and
`log_module_intent` — avoid having your agent paste secrets/credentials into
those calls, the same way you would with any chat. `.project-brain/` is
already in `.gitignore`, so this database stays local and is never committed.

---

## Roadmap

- **Verify Cline / Cursor / opencode support.** Skill packages and install
  paths exist for all three (`skills/<agent>/`), but only Claude Code has
  been tested end-to-end so far.
- **Plugin-based language support.** Today, adding a language means adding a
  tree-sitter grammar dependency and a walker function in
  `src/parser/treesitter.ts` (see PHP support as the most recent example).
  The goal is to make this a drop-in plugin interface so the community can
  add languages (Java/Kotlin for Android, C#/.NET, etc.) without touching
  core indexer code.
- **Composer autoload beyond PSR-4.** PHP support currently resolves `use`
  statements via PSR-4 only; `classmap`/`files`/`psr-0` autoload strategies
  and multi-`composer.json` monorepos are not yet covered.
- **Non-code / document repos.** The dependency-graph model is code-specific
  today (tree-sitter ASTs). An exploratory direction is a parallel
  "document graph" mode for non-code repositories (e.g. a folder of legal
  contracts or policy documents) — same decision-memory/constraints-file
  mechanics, but relationships derived from document structure/references
  instead of imports. This is an early idea, not yet scoped into a spec.

Contributions and issue reports toward any of the above are welcome.

---

## Development

```bash
npm test        # vitest
npm run build   # tsc
npm run dev      # run the server directly via tsx, stdio mode
```
