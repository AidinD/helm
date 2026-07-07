# First-mate tier: implementation design (DRAFT)

Status: DECIDED 2026-07-07 (Aidin signed off on all 6 forks - the agent's leans). Building the first slice.

## Decided (2026-07-07) - the 6 forks

1. Report-back: **pull** for the first slice (`maestro_collect_reports`, invoked at the bookend). Push deferred.
2. MCP transport: **A1 - stdio MCP server over an on-disk request/report queue** (no listening socket, per the whisper-server lesson).
3. Width cap: **3** concurrent dispatched runs per first mate (tunable).
4. Self-hosting dispatch: **(b) accept-with-checkpoint** + a loud caveat in the tool description for the Maestro project; full detached-process fix deferred per PLAN.md.
5. `project`: **validated enum** (seeded from known projects) + an escape hatch for an explicit path.
6. Model-per-tier wired into the mechanism: `maestro_dispatch` defaults the dispatched run to **Opus** (second-mate default) unless overridden; the first-mate **session** is launched as **Sonnet**.

---

Original DRAFT below (the analysis behind the decisions).
Grounds in `docs/orchestration-model.md` (the model + capability gap + phased plan), `DECISIONS.md` (2026-07-06), `docs/research-orchestration-2026-07-06.md` (the evidence constraints), and the current code (`goalOrchestrator.js`, `launcher.js`, `main.js`, `preload.cjs`, `renderer.js`).

This designs the one capability gap from `orchestration-model.md`: a running orchestrator session (a first mate) telling Maestro to *launch a project-scoped run and stream its report back* - "session/run-spawns-run + structured report-back". It is a design to react to, not code.

---

## Recommendation up front

Build the dispatch mechanism as **a Maestro-provided MCP tool** that a first-mate session calls (`maestro_dispatch`), plus a **structured report-back file** each dispatched run writes into a shared inbox that the first-mate session polls with a companion MCP tool (`maestro_collect_reports`). The report is a compact artifact + a pointer to the worktree, never a transcript.

Why this over the alternatives (detailed in section 1):

- It is the only option that gives the *session* a first-class, in-context way to both command dispatch and read results back, which is exactly what the model needs ("stream their reports back to me"). A sentinel-file or CLI-endpoint approach can command a dispatch but has no clean in-context return path.
- Maestro already speaks the `--mcp-config` flag (it uses it today in `judge.js`/`orchestratorHelper.js` to *strip* MCP). Injecting a Maestro MCP server on a first-mate launch is the same lever pointed the other way - low architectural risk.
- It respects the research: thin scoped dispatch brief in, structured artifact + reference out, ephemeral workers, model-per-tier. The tool schema *is* the "bounded dispatch brief, not a context dump" contract.
- The dispatched run is the **existing `runGoal` Autopilot machinery**, unchanged in substance. We are adding a *caller* (an MCP tool in the app) and a *report channel*, not a new execution engine. That is the whole reason the first slice is small.

The one genuinely open fork I am **not** quietly deciding: whether report-back is **pull** (first mate calls `maestro_collect_reports` when it wants) or **push** (Maestro injects a follow-up turn into the first-mate session the moment a report lands). I recommend **pull for the first slice** (simpler, no injected-turn plumbing, matches the bookend/on-demand model) and flag push as a phase-3+ enhancement. See Open Questions.

---

## 0. What already exists (so we build the delta, not the base)

The second-mate -> crew layer is essentially built. Confirmed in code:

- **`runGoal` (`goalOrchestrator.js`)** is a project-scoped autonomous run: fresh `claude -p` per iteration in an isolated worktree, RPI phasing, per-iteration structured JSON, one commit per success, rollback per failure, never pushes/merges. This *is* a second-mate-dispatching-crew, in the model's terms (`orchestration-model.md` line 61-62).
- **`main.js` `goal:run`** already: clamps iterations at the trust boundary, tracks the run in `liveGoalRuns` (goalRunId -> `{ cancelToken, currentChild }`), streams `goal:event` (`started`/`iteration`/`escalation`/`done`/`error`) to the renderer, sweeps children on `before-quit`, and persists a compact record via `upsertGoalRunRecord`.
- **`goalRunHistory.js`** persists a compact record per run (`goalRunId`, `goal`, `projectPath`, `status`, `worktreePath`, `branchName`, `commitCount`, `stoppedReason`, `escalation`, `error`, timestamps) to `goal-run-history.json`. Never the transcript - the worktree's `.maestro-goal/notes.md` holds that. This is already "structured artifact + reference, not transcript".
- **`launcher.js` `startSession`** spawns a rooted `claude -p` session; `session:start` in `main.js` wires it, tracks `liveChildren`, streams `session:event`.
- **`orchestrator:info`** already resolves the **meta-home** (the first mate's root) by reading the `@import` target out of `~/.claude/CLAUDE.md`. So Maestro already knows where a first mate is rooted.
- **The Dashboard** renders "in motion" rows including goal runs (`dashboardInMotionRows` mixes `kind:"session"` and `kind:"goalRun"`), and starts fresh sessions via `openFreshDraftInPane` / the "Start orchestrator session" button.
- **`--mcp-config` is already used** (`judge.js:73`, `orchestratorHelper.js:133`) - Maestro knows how to pass MCP config to a spawned `claude`.

So the delta is three things, and only three:
1. A way for a *session* (not the renderer) to invoke `goal:run` -> **an MCP tool**.
2. A way for a dispatched run's compact result to get *back into the first-mate session's context* -> **a report inbox + a collect tool**.
3. Relationship data (which run belongs to which mate) so the Dashboard can draw the tree -> **two fields on the existing record**.

---

## 1. The mechanism: how a running session commands Maestro

A first-mate session is a `claude -p` subprocess. It has **no IPC to the Electron app** and no `window.maestro`. It can only reach the outside world through its tools (Bash, Write, MCP). Three concrete options:

### Option A - Maestro MCP tool (RECOMMENDED)

Maestro runs a small MCP server. When Maestro launches a **first-mate** session (rooted in meta-home), it appends `--mcp-config <maestro-mcp.json>` so the session gets tools like:

- `maestro_dispatch({ project, goal, tier, model, effort, maxIterations, verifyCommand })` -> validates, calls the same code path as `goal:run`, returns `{ dispatchId, goalRunId, status: "started" }`.
- `maestro_collect_reports({ since?, dispatchIds? })` -> returns compact report records for this mate's dispatched runs (status, summary, what-changed, what-needs-captain, worktree pointer).
- `maestro_list_projects()` -> the known projects a mate may dispatch to (so `project` is a validated enum, not a free path).

Transport: two viable sub-options, decide at build:
- **A1 (recommended): a stdio MCP server** - a tiny Node script Maestro ships (e.g. `src/mcp/maestroDispatchServer.js`) that the spawned `claude` launches per the `--mcp-config` entry. It reaches the app not via Electron IPC but via the **same on-disk queue/inbox** the sentinel approach would use (see below) - the MCP server is a thin, well-typed front door over a file handshake, and Maestro's main process watches that queue. This keeps the app as the single dispatch authority while giving the session a typed tool.
- **A2: an HTTP MCP server** hosted by the Electron main process on `127.0.0.1:<port>`, tools call straight into the `goal:run` code. Fewer moving parts conceptually (no file handshake) but adds a listening socket to the app and a port-lifecycle concern (the whisper-server removal in DECISIONS.md 2026-07-05 is the cautionary tale about managed long-lived server processes). 

Tradeoffs: MCP is the *typed, discoverable, in-context* surface - the model sees `maestro_dispatch` as a real tool with a schema, which is exactly the "bounded dispatch brief" the research wants. Cost: an MCP server is real surface to build and maintain, and it only loads for sessions we deliberately launch with the config (fine - only first mates should dispatch).

### Option B - Sentinel file/dir the session writes, Maestro watches

The first-mate session writes a JSON file into a watched inbox dir (e.g. `<meta-home>/.maestro-dispatch/requests/<uuid>.json`) using its ordinary Write/Bash tools. Maestro's main process runs an `fs.watch` on that dir and, on a new file, validates it and calls the `goal:run` path. Results are written back to `<...>/reports/<uuid>.json` which the session reads with Read/Bash.

Tradeoffs: zero new protocol surface, works with tools the session already has, trivially restart-survivable (the queue is on disk). But: it is **untyped and unguided** - the model has to *know* the file schema and path convention from its instructions (prompt-engineering, not a tool contract), which is precisely the fragile "know the magic format" pattern. No discoverability. Report-back is a poll-a-directory chore baked into the mate's instructions rather than a tool. This is the mechanism A1 uses *underneath* an MCP facade - so B is really "A1 without the typed front door".

### Option C - Local command/endpoint (a `maestro` CLI shim or localhost endpoint)

Ship a tiny `maestro-dispatch` command (or a localhost HTTP endpoint) the session calls via Bash: `maestro-dispatch --project crewline --goal "..."`. 

Tradeoffs: familiar (it is how `gh`/`jot` are called from sessions today), no MCP machinery. But a Bash shim is again **untyped from the model's view** (it is just a string it assembles), needs its own arg-parsing/validation, and still needs a separate return path for reports (it would print a dispatchId; collecting reports is another command). It also reintroduces a process/endpoint to own. Strictly worse than A for the return path, roughly equal to B for the send path.

### Verdict

**A1: an MCP tool over an on-disk request/report queue.** It is B's robustness (on-disk, restart-survivable, app stays the single authority) with A's typed, discoverable, in-context tool surface for both *dispatch* and *collect*. Maestro already knows the `--mcp-config` flag. The queue-on-disk core means the Electron app is never a network service and there is no long-lived socket to babysit (heeding the whisper-server lesson).

---

## 2. Report-back: compact structured result up to the first mate + the Dashboard

### The report record (the artifact)

When a dispatched `runGoal` resolves (or escalates), Maestro writes a **report record** - the compact "what the captain/first mate actually needs", derived from data the run already produces. It is NOT the transcript; it points to the worktree, mirroring how `goalRunHistory.js` already stores a compact record and leaves `.maestro-goal/notes.md` on disk.

Report shape (all derivable from `runGoal`'s existing return + record fields):

```
{
  dispatchId, goalRunId,
  project, goal, tier: "second-mate",
  status: "done" | "escalated" | "error" | "interrupted",
  summary,                      // one-line rollup (last implement iteration summary, or escalation detail)
  changed: { commitCount, branchName, worktreePath, filesTouched? },
  needsCaptain: <string|null>,  // the escalation detail, or a "review this worktree" nudge, or null
  stoppedReason,                // reuse runGoal's own stoppedReason
  costUsd, iterations: <count>,
  startedAt, finishedAt
}
```

`needsCaptain` is the load-bearing field for the model tier: it is what turns a raw run result into "here is the one thing that needs your call" (phased-plan step 4, assign-back to the captain). Populate it from the existing `escalation` object when `stoppedReason === "escalated"`, else null (or a soft "N commits ready for review in <branch>").

### Getting it back to the first mate (in-context)

- **Pull (recommended for first slice):** the report is written to `<meta-home>/.maestro-dispatch/reports/<dispatchId>.json`. The first-mate session calls `maestro_collect_reports()` when it next takes a turn (e.g. the evening "summarize" bookend, or when the captain asks "what came back?"). The tool returns the compact records. This matches the bookend/on-demand model exactly - the first mate is dormant between, then sweeps reports when invoked. No injected-turn machinery.
- **Push (later):** Maestro injects a follow-up turn into the live first-mate session the moment a report lands. This needs a way to feed a new prompt into an already-running/idle `-p` session (resume-by-id + a synthetic turn), which is more plumbing and risks interrupting the mate mid-thought. Defer; see Open Questions.

### Surfacing on the Dashboard (reuse, don't reinvent)

- The dispatched run is a normal goal run, so it already flows through `goal:event` -> the renderer's `goalRuns` Map -> `dashboardInMotionRows` (`kind:"goalRun"`). It shows up "in motion" today with **zero new code**.
- Add the relationship fields (section 3) to the persisted record so the Dashboard can *group* a mate's runs under it rather than listing them flat. The "in motion" row already reads `run.goalRunId` / `run.status`; extend the row renderer to show `dispatchedBy` (the mate) and the report's `needsCaptain` when present.

---

## 3. Relationship tracking: the minimal data model additions

The whole tree (first mate -> second mates -> crew) needs only a small amount of new data, all hung off records that already exist.

**On the goal-run record (`goalRunHistory.js` + the `upsertGoalRunRecord` calls in `goal:run`):**
- `dispatchedBy: <mateId>|null` - which first mate dispatched this run (null = launched by the human from the Goal page, i.e. a direct/captain-initiated run). This one field is what lets the Dashboard draw the mate -> second-mate edge.
- `dispatchId: <uuid>|null` - correlates the dispatch request, the run, and the report.
- `tier: "second-mate"` - explicit, so a future third kind of run is distinguishable. (Crew = the iterations inside the run; they need no new record - they are already the run's `iterations[]`.)

**Mate identity (new, tiny):**
- A `mateId` per first-mate session. The model already says two named first mates (work, private). Derive `mateId` from the meta-home root + name at launch, persisted in a small `mates.json` (or folded into config). Enough to key reports and the tree by; nothing more.

**Crew (no new model):** an agent/iteration is already tracked inside its parent run (`iterations[]` on the run, `task_*` events in `launcher.js` for Agent-tool subagents). The tree's leaf layer reads from there. No new table.

That is the full data-model delta: **three fields on the run record + a mateId.** The fleet/tree view (phased step 6) is then a pure render over `goalRunHistory` grouped by `dispatchedBy` - it "comes with" this data, per the model's own note that step 6 depends on steps 2-3.

---

## 4. The minimal first slice (smallest end-to-end proof) + phasing

### First slice: one first mate dispatches ONE project-scoped run and sees its report

Deliberately the thinnest thing that proves the model end to end, mapping to phased steps 1-2:

1. **MCP server with two tools:** `maestro_dispatch` (one run, one project) and `maestro_collect_reports`. Ship `maestro-mcp.json` and wire `--mcp-config` onto first-mate launches only.
2. **`maestro_dispatch` calls the existing `goal:run` code path** with `dispatchedBy`/`dispatchId` stamped on. No new execution engine - reuse `runGoal` verbatim.
3. **On run completion, write the compact report** to the reports inbox (derive from `runGoal`'s existing result).
4. **`maestro_collect_reports` reads the inbox** and returns compact records.
5. **Dashboard shows the dispatched run** in the existing "in motion" list (already works) with a "dispatched by <mate>" tag.

Proof of the model: from a first-mate session, "dispatch a run for Crewline that does X" -> a real Autopilot run appears on the Dashboard -> when it finishes, the first mate calls collect and reports the compact result back to the captain. That is the model turned into a way of working, at width=1.

Explicitly OUT of the first slice: parallel multi-project dispatch, push-report, the tree view, the refresh pipe, escalation UI beyond the `needsCaptain` field.

### Phasing after the slice (mapped to `orchestration-model.md` steps 1-6)

- **Step 1 (second mates as ephemeral runs)** - satisfied by the first slice (dispatch = a `runGoal`, not a fat live session).
- **Step 2 (structured report-back)** - satisfied by the report record + collect tool.
- **Step 3 (first-mate-initiated parallel dispatch)** - let `maestro_dispatch` be called N times in one turn (width 2-5, hard-capped); the app runs them concurrently (`liveGoalRuns` already supports concurrent runs). Add width enforcement here.
- **Step 4 (assign-back to captain)** - promote `needsCaptain` into a real Dashboard "needs you" card and/or a push notification (reuse the away-from-desk pipe already in `attention:notify`).
- **Step 5 (first-mate refresh pipe)** - orthogonal to dispatch; fire an attention notification when the mate's context gauge crosses threshold at an idle/day boundary. Reuses the existing gauge + notify pipe.
- **Step 6 (tree/fleet view)** - pure render over `goalRunHistory` grouped by `dispatchedBy`. Comes free once step 3's data is populated.

---

## 5. Bounds & safety

### 2-level agent-depth cap (second mates can't spawn more mates)

The research caps depth at 2 (`research-...-2026-07-06.md`: "cap depth at 2"; Claude Code Agent Teams disallows nesting). Enforce it **in the mechanism, not by prompt**:

- The `--mcp-config` with the dispatch tools is attached **only to first-mate launches** (sessions rooted in meta-home, detectable via the same cwd-vs-meta-home check `orchestrator:info` already does). A **second-mate run** (a `runGoal` iteration, rooted in a project worktree) does **not** get the dispatch MCP server, so it literally has no `maestro_dispatch` tool to call. Depth is capped structurally: a dispatched run cannot dispatch.
- Belt-and-suspenders: `maestro_dispatch` server-side rejects any request whose `dispatchedBy` chain would exceed depth 2 (a dispatched run has a non-null `dispatchedBy`; a request *from within* such a run is refused). Cheap invariant check at the app's single dispatch authority.

### Avoid the rejected unbounded fan-out

The logged lesson (`feedback_agent_fanout_runaway`, DECISIONS.md 2026-07-04 "~15x") is runaway recursive spawning. Guards, all at the single dispatch authority (the app), never trusting the caller:

- **Width cap:** a first mate may have at most **W concurrent dispatched runs** (start with 3-5, the research's "3-5 workers"). `maestro_dispatch` refuses over the cap and tells the model to wait for a report.
- **Iteration cap:** already enforced (`GOAL_ITERATION_CEILING = 20` clamp in `goal:run`) - dispatched runs inherit it.
- **No recursion:** the depth cap above.
- **Cost visibility:** the report carries `costUsd`; the escalation cost-soft-cap (`detectCostSoftCap`) already exists per run.

### The self-hosting restart wrinkle (PLAN.md)

PLAN.md's known hazard: a dispatched run that **restarts Maestro** (as part of its own boot-test workflow) would kill its own parent - the run is a child of the Electron main process (`liveGoalRuns` children, swept on `before-quit`). This bites specifically when Maestro dispatches work *on Maestro itself*.

Design stance (consistent with PLAN.md's own recommendation - "don't make workers un-killable, make them CHEAP to kill"):
- The dispatched run is already git-commit-checkpointed per iteration (`commitIteration`) with continuity in `.maestro-goal/notes.md`. An untimely restart costs at most the current in-flight iteration, resumable from the last commit + notes - not the whole task.
- **Flag `restartsMaestro`-class projects:** when the dispatch `project` is Maestro itself (self-hosting), the app can (a) warn/refuse the specific `restart-dev.sh`-style verify step, or (b) accept the risk knowing the checkpoint makes it cheap. Recommend surfacing this as a known caveat in the mate's dispatch tool description for the Maestro project, not building full process-detachment now (PLAN.md defers the tmux-equivalent detachment as "meaningfully more work... until a lost iteration actually proves costly").
- Full fix (deferred, flagged): spawn dispatched runs **detached** from the Electron main process (Windows equivalent of firstmate's tmux-pane independence) so a restart of the app-under-test never touches the dispatcher's own runs. Out of scope for the first slice; note it as the real fix if self-hosting dispatch becomes routine.

---

## 6. What existing code changes (a sketch, not the code)

**New files:**
- `src/mcp/maestroDispatchServer.js` - the stdio MCP server exposing `maestro_dispatch`, `maestro_collect_reports`, `maestro_list_projects`. Thin front door over the on-disk request/report queue.
- `maestro-mcp.json` (or generated at launch) - the `--mcp-config` payload naming the server above.
- `src/lib/dispatchQueue.js` - read/write the request inbox + report inbox under `<meta-home>/.maestro-dispatch/`, mirroring `goalRunHistory.js`'s plain-JSON-file pattern (atomic writes, tolerant reads).
- `src/lib/mates.js` - resolve/persist `mateId` for a first-mate root (tiny; could fold into config).

**`src/main.js`:**
- On the first-mate launch path (the "Start orchestrator session" flow), append `--mcp-config <maestro-mcp.json>` to the `startSession` args **only** when the session is rooted in meta-home. (The launch itself already exists; this is one conditional arg addition, parallel to how `judge.js` already adds `--mcp-config`.)
- Add an `fs.watch` (or poll) on the request inbox; on a new request, run the same validation + `runGoal` call the `goal:run` handler already does, stamping `dispatchedBy`/`dispatchId`/`tier`. Factor the shared body of today's `goal:run` handler into a `startGoalRun(opts)` helper so both the IPC handler and the dispatch watcher call it (no duplication).
- On run completion, write the compact report to the report inbox (derive from the `runGoal` result already in hand at the `.then`).
- Enforce width + depth caps at this single authority.

**`src/lib/goalOrchestrator.js`:** no change to the run engine. Optionally thread `dispatchId`/`dispatchedBy` through as pass-through metadata so they land on `onIteration` records; the run logic itself is untouched.

**`src/lib/goalRunHistory.js`:** add `dispatchedBy`, `dispatchId`, `tier` to the record shape (it is a `{...spread}` upsert, so this is additive - old records just have them undefined).

**`src/preload.cjs` / `src/renderer/renderer.js`:** no change required for the first slice (the dispatched run already streams over `goal:event` and renders in `dashboardInMotionRows`). Phase 6 adds a tree render grouped by `dispatchedBy`; phase 4 promotes `needsCaptain` into a Dashboard card and reuses `attention:notify`.

**Net:** the run engine and the renderer are essentially untouched for the first slice. The new surface is one MCP server + one on-disk queue + three record fields + one conditional launch arg + one shared `startGoalRun` extraction. That is the delta that turns the model from a way of thinking into a way of working.

---

## Open questions for Aidin (real forks, not quietly decided)

1. **Pull vs push report-back.** I recommend **pull** for the first slice (collect tool, invoked at the bookend) - simplest, matches "bookend + on-demand, dormant between". Push (inject a turn into the live mate) is more powerful but needs resume-and-inject plumbing and can interrupt the mate mid-thought. Confirm pull-first?
2. **MCP transport: stdio-over-queue (A1) vs localhost HTTP (A2).** I lean A1 (no listening socket, no port lifecycle - the whisper-server removal taught us to avoid managed long-lived server processes). A2 is conceptually simpler (tools call straight into the app) at the cost of a socket. Your call on which risk you prefer.
3. **Width cap value.** Research says 3-5 concurrent workers per coordinator. Start at 3? 5?
4. **Self-hosting dispatch policy.** For dispatching work *on Maestro itself*, do we (a) refuse the restart-style verify step, (b) accept-with-checkpoint, or (c) prioritize the full detached-process fix sooner than PLAN.md defers it? I lean (b) for now with a loud caveat in the tool description.
5. **`project` as a validated enum vs free path.** `maestro_list_projects` implies a known set. Do we seed it from registered domains + recent session cwds, or let a mate dispatch to any git repo path? I lean validated-enum (safer, and it makes the tool's brief tighter) with an escape hatch for an explicit path.
6. **Model-per-tier wiring.** The model says first mate -> Sonnet, second mate -> Opus, crew by complexity. Should `maestro_dispatch` default the dispatched run's model to Opus (second-mate default) unless the mate overrides, and should the first-mate *session* itself be launched as Sonnet? I lean yes to both - it encodes the model-per-tier decision in the mechanism rather than leaving it to per-call judgment.
