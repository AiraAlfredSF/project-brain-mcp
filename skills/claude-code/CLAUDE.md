<!-- code-brain-mcp:start -->
# code-brain-mcp — Project Memory & Codebase Awareness

This project is wired up with the `code-brain` MCP server. It gives you
persistent decision memory, a codebase dependency graph, plan validation
against architectural constraints, and a self-bootstrapping constraints file.
The statements below are always-on behaviors, not a one-time checklist.

## Session lifecycle

- At the start of every session, you call `start_session()`. This resets your
  compliance tracking and (on the first call of the process) prints the
  `BRAIN DSL v1` schema header you need to interpret every other tool's output.
- You periodically call `get_session_health()` (roughly every 10 turns) to
  self-check whether you've loaded context and validated your plans as
  expected. If it returns `SESSION: warnings` or `SESSION: violations`, you
  follow the `action:` line(s) before continuing.
- `record_tool_call` is invoked automatically by the server after every tool
  call — you never call it yourself.

## Decision memory (Spec 01)

- Before starting any task, you call `get_context(topic)` for the task's
  topic, so you don't repeat past mistakes or re-litigate settled decisions.
- You call `list_constraints()` to review the project's architectural and
  technology constraints before making changes that might touch them.
- After making an architectural decision (choosing a library, pattern, data
  model, API shape, etc.), you call `log_decision(decision, rationale,
  alternatives_rejected, tags)`.
- When an approach fails (a fix doesn't work, a library doesn't fit, a design
  hits a wall), you call `log_failure(description, cause, approach_tried)`
  before trying an alternative.

## Codebase graph (Spec 02)

- After the project is first set up, or whenever the code graph seems stale
  relative to the working tree, you call `index_codebase()` to (re)build the
  dependency graph.
- Before modifying a module, you call `get_dependents(module)` to see what
  depends on it.
- Before changing a module, you call `get_dependencies(module)` to understand
  what it relies on.
- Before a significant or risky change, you call `get_blast_radius(module)` to
  see the full transitive impact, not just direct dependents.
- After pulling new commits, you call `diff_graph(since_commit)` to see what
  structural changes (edges added/removed) happened since the last index.
- When starting a task described at a high level, you call
  `find_entry_points(intent)` to locate the relevant module(s) to start from.

## Plan validation (Spec 03)

- Before executing any multi-step plan, you call `validate_plan(steps, task)`.
  If it returns `PLAN: blocked`, you address every `step[n]=`/`fix=` pair
  before proceeding — you do not execute a blocked plan.

## Bootstrap (Spec 04)

- At the start of work on a project you haven't bootstrapped yet, you call
  `get_bootstrap_status()`. If it returns `BOOTSTRAP: never_run`, see
  `bootstrap.md` for the full flow.
- While bootstrapping, you call `run_bootstrap(path)` repeatedly until it
  returns `BOOTSTRAP: complete`.
- For each module `run_bootstrap` hands you, you read the module and call
  `log_module_intent(module, intent, constraints, caveats)` describing its
  purpose, constraints, and caveats.
- You generally do not call `write_constraints_draft()` directly —
  `run_bootstrap` calls it for you on completion. You call it directly only if
  `constraints.md` needs to be regenerated outside of bootstrap.

## Two-way constraints sync (Spec 05)

- After any change that adds or updates constraints in the database (e.g. a
  `log_decision` that implies a new constraint, or `flag_stale_constraints`
  flagging one), you call `export_constraints_file()` to regenerate
  `constraints.md`.
- If a human has manually edited `constraints.md`, you call
  `ingest_constraints_file()` to apply that diff back into the database before
  trusting the database's constraint list.
- You periodically call `get_sync_status()` to check whether `constraints.md`
  and the database have drifted apart, and resolve drift before relying on
  either.
- After a commit changes the dependency graph, you call
  `flag_stale_constraints(commit)` to check whether any hard constraints now
  contradict the new structure.
- Before your next `export_constraints_file()` call, you call
  `list_flagged_constraints()` and review/resolve any flagged entries.
<!-- code-brain-mcp:end -->
