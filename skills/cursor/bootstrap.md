<!-- code-brain-mcp:start -->
# code-brain-mcp — Bootstrap Checklist (Spec 04)

When you start work on a project wired up with `code-brain-mcp` for the first
time, work through this checklist before anything else:

- [ ] Call `get_bootstrap_status()`.
  - `BOOTSTRAP: complete modules=N intents=N` — bootstrap already ran. Skip to
    the "Review" checklist item below.
  - `BOOTSTRAP: incomplete modules=N intents=M` — bootstrap was started but
    not finished. Continue with the next item.
  - `BOOTSTRAP: never_run` — continue with the next item.

- [ ] Call `run_bootstrap(path)` (omit `path` to use the project root).
  - If it returns `BOOTSTRAP: in_progress next_module=<path>
    progress=<covered>/<total>`, read `<path>` and call
    `log_module_intent(module, intent, constraints, caveats)`:
    - `intent`: the module's purpose, in your own words.
    - `constraints`: any hard rules this module's code implies (e.g. "must
      not import from X", "all writes go through Y").
    - `caveats`: anything surprising, fragile, or worth flagging for a future
      agent.
  - Call `run_bootstrap(path)` again, and repeat for each `next_module`.

- [ ] When `run_bootstrap` returns `BOOTSTRAP: complete
  modules_processed=N constraints_written=M draft: constraints.md`,
  bootstrap is done — `constraints.md` has already been regenerated.

- [ ] Review the generated `constraints.md` at the project root. It contains
  `## Architectural Boundaries` and `## Technology Constraints` sections
  derived from your `log_module_intent` calls. If anything looks wrong, edit
  the file directly and then call `ingest_constraints_file()` to sync your
  edits back into the database (see Spec 05 in `.cursorrules`).

- [ ] Note: calling `run_bootstrap` again after completion is harmless — it
  short-circuits to `BOOTSTRAP: already_complete`.
<!-- code-brain-mcp:end -->
