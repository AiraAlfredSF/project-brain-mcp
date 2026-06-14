<!-- code-brain-mcp:start -->
# code-brain-mcp — Bootstrap Dependency Chain (Spec 04)

When you start work on a project wired up with `code-brain-mcp` for the first
time, walk this chain before doing anything else. Each step unlocks the next
— do not skip ahead.

1. Call `get_bootstrap_status()`. Its result tells you which step to do next:
   - `BOOTSTRAP: complete modules=N intents=N` — bootstrap already ran, which
     means `constraints.md` already exists. Skip to step 4, then proceed with
     your task normally.
   - `BOOTSTRAP: incomplete modules=N intents=M` — bootstrap was started but
     not finished. Go to step 2.
   - `BOOTSTRAP: never_run` — go to step 2.

2. Call `run_bootstrap(path)` (omit `path` to use the project root). This
   returns one of two things, which determines what you do next:
   - `BOOTSTRAP: in_progress next_module=<path> progress=<covered>/<total>` —
     this hands you a module to read. Read `<path>`, then call
     `log_module_intent(module, intent, constraints, caveats)` with:
     - `intent`: the module's purpose, in your own words.
     - `constraints`: any hard rules this module's code implies (e.g. "must
       not import from X", "all writes go through Y").
     - `caveats`: anything surprising, fragile, or worth flagging for a future
       agent.
     Logging this intent is what enables `run_bootstrap` to hand you the next
     module — call `run_bootstrap(path)` again, and repeat this step for each
     `next_module` it returns.
   - `BOOTSTRAP: complete modules_processed=N constraints_written=M draft:
     constraints.md` — every module has been processed. This automatically
     regenerates `constraints.md` for you. Go to step 3.

3. Once you have `BOOTSTRAP: complete`, `constraints.md` exists at the project
   root, generated from all the `log_module_intent` calls in step 2.

4. Review `constraints.md`. It contains `## Architectural Boundaries` and
   `## Technology Constraints` sections. If anything looks wrong, edit the
   file directly — but editing it is only half the chain: you must then call
   `ingest_constraints_file()` to sync your edits back into the database
   before the next `list_constraints()` call will reflect them (see Spec 05
   in `.clinerules`).

5. Calling `run_bootstrap` again after completion is harmless — it
   short-circuits to `BOOTSTRAP: already_complete` and does not re-trigger
   steps 2-3.
<!-- code-brain-mcp:end -->
