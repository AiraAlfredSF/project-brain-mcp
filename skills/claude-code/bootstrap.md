<!-- code-brain-mcp:start -->
# code-brain-mcp — Bootstrap Flow (Spec 04)

When you start work on a project wired up with `code-brain-mcp` for the first
time, run this flow before anything else:

1. Call `get_bootstrap_status()`.
   - `BOOTSTRAP: complete modules=N intents=N` — bootstrap has already run.
     Nothing to do here; proceed with the task normally.
   - `BOOTSTRAP: incomplete modules=N intents=M` — bootstrap was started but
     not finished. Continue from step 2.
   - `BOOTSTRAP: never_run` — start at step 2.

2. Call `run_bootstrap(path)` (omit `path` to use the project root).
   - If it returns `BOOTSTRAP: in_progress next_module=<path>
     progress=<covered>/<total>`, read `<path>` and call
     `log_module_intent(module, intent, constraints, caveats)` describing:
     - `intent`: the module's purpose, in your own words.
     - `constraints`: any hard rules this module's code implies (e.g. "must
       not import from X", "all writes go through Y").
     - `caveats`: anything surprising, fragile, or worth flagging for a future
       agent.
   - Call `run_bootstrap(path)` again, and repeat for each `next_module`.

3. When `run_bootstrap` returns `BOOTSTRAP: complete modules_processed=N
   constraints_written=M draft: constraints.md`, bootstrap is done — it has
   already regenerated `constraints.md` for you.

4. Review the generated `constraints.md` at the project root. It contains
   `## Architectural Boundaries` and `## Technology Constraints` sections
   derived from your `log_module_intent` calls. If anything looks wrong, edit
   the file directly and then call `ingest_constraints_file()` to sync your
   edits back into the database (see Spec 05 in `CLAUDE.md`).

5. Calling `run_bootstrap` again after completion is harmless — it
   short-circuits to `BOOTSTRAP: already_complete`.
<!-- code-brain-mcp:end -->
