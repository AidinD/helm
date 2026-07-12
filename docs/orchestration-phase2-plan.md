# Phase-2 build spec - real second-mate agents (code-grounded)

Written 2026-07-12. This is the actionable build spec for the daily loop in orchestration-model.md.
Ordered smallest-shippable-first; guardrails first. Each slice is independently verifiable.
Grounded in a read of the actual code (dispatch watcher, secondMates, goalOrchestrator, launcher, helmDispatchServer, main.js session:start).

## Ground truth the build stands on
- Tier = cwd. `isMetaHomeRoot(cwd)` (main.js) is the ONLY thing that makes a launch a first mate: it triggers `buildFirstMateMcpConfig` + `FIRST_MATE_ALLOWED_TOOLS` + `strictMcpConfig` in `session:start`. A project-rooted session today gets the full MCP set and NO dispatch tools.
- Second mates are DERIVED, not created. `deriveSecondMates(runHistory, bindings)` builds them from goal-run records; a second mate with no crew doesn't exist. Only persisted state: `second-mates.json` = `{ [secondMateId]: { sessionId, name } }`. `secondMateId(firstMateId, projectPath)` is already per-project - reuse verbatim.
- Dispatch = one on-disk queue under `<metaHome>/.helm-dispatch/` (dispatchQueue.js). Requests carry a payload + `dispatchedBy` (a mateId).
- The watcher `processDispatchRequests(metaHome)` is the single authority: `isForeignDispatch` ownership scope, project validate, `depthCapExceeded`/`widthCapExceeded`, then `startGoalRun`.
- Crew = `runGoal` (goalOrchestrator.js): fresh-subprocess-per-iteration in an always-freshly-created worktree; continuity via notes.md/phase.json/plan.md; never uses startSession, so crew has no tools (the current depth cap).
- Resume today is display-only: `goal:history` relabels a dead `running` record `interrupted`. No path relaunches runGoal against an existing worktree. `--resume` is only for interactive panes.

## Build status (2026-07-12)
- **Slice 0 - guardrails: DONE + verified + reviewed + committed.** orchestrationBudget.js (per-meta-home cost ceiling + kill switch) + unit test; depth cap rejects callerTier==='crew'; processDispatchRequests rejects when killed/over-budget + counts costUsd + owns second-mate ids; kill/resume/budget IPC + Dashboard chip.
- **Slice 1 - lazy proposed/created second mates: DONE + verified + reviewed + committed.** bindings carry status/brief/firstMateId/projectPath; deriveSecondMates unions proposed; proposeSecondMate/markSecondMateCreated; bind flips proposed->created; secondMates:propose IPC; Fleet renders proposed distinctly. Unit test.
- **Slice 2 - second mate dispatches its own crew: DONE + verified + reviewed + committed.** buildDispatchMcpConfig(callerId, callerTier); session:start attaches crew tools to a secondMateId pane (non-strict) + resolves the id from the durable binding on RESUME (review fix); MCP stamps callerTier; server-side bind on session event closes the orphan window (review fix).
- **Slice 3 - report up: DONE + verified + reviewed + committed.** helm_report_up (second mates only) writes a roll-up addressed to the parent first mate (parent resolved from deriveSecondMates - review fix - and 'direct' is top-of-chain, no dead-letter); first mate's helm_collect_reports surfaces it.
- **Slices 4-6: NOT STARTED (deliberate pause).** Slice 4 (canonical session + relay, needs a per-sessionId mutex vs concurrent --resume) and Slice 5 (resumable runs, worktree/node_modules reuse) are the two flagged HAZARDS. Build them in a fresh focused pass, not at the tail of a long build - a subtle bug here corrupts a transcript or deletes the shared node_modules. Slice 6 (fortsätt cascade) depends on 5.

### Each slice's review round found + fixed real bugs (per Aidin's request)
- Slice 2: a RESUMED second mate silently lost its crew tools (pane-tag keying); a first crew dispatch could be orphaned if the renderer bind was missed. Both fixed (durable-binding keying + server-side bind).
- Slice 3: report-up was dead on arrival (parent read from a never-populated binding field); 'direct' would dead-letter. Both fixed (derive parent; 'direct' = top-of-chain).

## Slices (build in order)

### Slice 0 - Guardrails first (pure, unit-testable)
- dispatchCaps.js: add `callerTier` to the request contract; keep `widthCapExceeded` (keys on the dispatchedBy string, so a secondMateId works); extend `depthCapExceeded` to reject `callerTier === "crew"`; **fix `isForeignDispatch`** - it only knows mateIds, so a crew dispatch whose `dispatchedBy` is a secondMateId would be treated foreign and NEVER claimed (crew silently never runs). Ownership set must include this instance's second-mate ids.
- New `src/lib/orchestrationBudget.js`: persisted per-orchestration token/USD ceiling in `<metaHome>/.helm-dispatch/budget.json` (atomic writes like dispatchQueue.js); ceiling default in config.json. `addSpend/isOverBudget/setKilled/isKilled`. Fed from the `costUsd` already in `buildDispatchReport`.
- processDispatchRequests: reject when over budget or killed.
- Kill switch: IPC `orchestration:killTree` + MCP `helm_stop_tree` - flip cancelToken + killChildTree for every liveGoalRuns entry (reuse goal:cancel's mechanism).

### Slice 1 - Persisted proposed/created second mates (lazy)
- secondMates.js: widen binding to `{ sessionId, name, status: proposed|created|retired, brief, model, firstMateId, assignments[] }`; `deriveSecondMates` UNIONs binding-only (proposed, no crew) with history-derived; add `proposeSecondMate(...)` + `markSecondMateCreated(...)`.
- main.js: IPC `secondMates:propose`; extend `secondMates:list`.
- renderer: `fleetSecondMateEl` renders a proposed (session-less) SM distinctly; clicking it is "first engagement" -> triggers creation.

### Slice 2 - Second mate dispatches its own crew (depth-capped)
- main.js: generalize `buildFirstMateMcpConfig` -> `buildDispatchMcpConfig({ metaHome, callerId, callerTier })`; set env HELM_MATE_ID + HELM_CALLER_TIER; in session:start attach it when the pane carries a `secondMateId` (callerTier="second-mate"). Thread `secondMateId` through the session:start payload + the renderer send (currently only mateId is passed) + preload.
- New `src/lib/second-mate-instructions.md` + `secondMateInstructions()` loader (mirror firstMateInstructions), appended via --append-system-prompt on a fresh second-mate turn.
- helmDispatchServer.js: stamp dispatchedBy = HELM_MATE_ID (now a secondMateId) + callerTier; crew run stays a tool-less runGoal.
- Reports route down for free: `helm_collect_reports` already filters by dispatchedBy.

### Slice 3 - Report up the chain + mandatory retire trace
- helmDispatchServer.js: new `helm_report_up({ summary, needsCaptain, project })` - writes a report addressed to the parent first mate (dispatchedBy = firstMateId from the SM binding). The first mate's existing helm_collect_reports then sees the roll-up.
- Retire trace gate: `secondMates:retire` / `helm_retire_second_mate` refuses unless a durable trace exists (a written report, or a DECISIONS.md/Jot edit). Second-mate manual instructs "externalize before retire".

### Slice 4 - Canonical session + first-mate-driven relay
- One `secondMateId -> sessionId` is authoritative (bindSecondMateSession already clears the id from any other SM).
- `helm_create_second_mate({ project, brief })` + `helm_relay_to_second_mate({ project, message })` (queue, new request `kind`): processDispatchRequests branches on kind; runs an internal startSession turn rooted in the project (Opus, Slice-2 crew MCP config, resumeSessionId = bound SM session on relays), captures final text + sessionId, binds, writes back as ack/report.
- Direct jump-in resumes the SAME bound sessionId -> both modes share one context.

### Slice 5 - Resumable Autopilot runs
- goalOrchestrator.js: `runGoal({ resume: { worktreePath, branchName, baseCommit } })` - SKIP createWorktree (throws on existing path) + SKIP provisionDeps (junction already exists); read phase/notes/plan in place; reuse baseCommit so commit count stays cumulative. Exclude a resumed/quota worktree from the zero-commit auto-clean (alongside the escalated exception).
- Quota detection in runIteration close handler: rate-limit result -> stoppedReason="quota_exhausted", mark record resumable, no auto-clean.
- main.js: persist worktreePath/branchName/baseCommit on the running record; IPC `goal:resume` + a startGoalRun resume mode; watcher can re-accept `helm_resume_dispatch(dispatchId)`.

### Slice 6 - Top-down "fortsätt" cascade
- `helm_resume_fleet` (MCP)/app cascade: scan goalRunHistory for interrupted/quota_exhausted/escalated under this first mate (and, by dispatchedBy=secondMateId, its second mates); resume each via Slice 5. Each second mate owns resuming its own crew (re-attach by bound sessionId via --resume). First-mate manual maps the captain's "fortsätt" turn onto this.

## The 3 places most likely to go wrong (design these carefully)
1. **Concurrent `--resume` on one canonical session (Slice 4).** The pane, the relay, and internal create/relay turns all drive the SAME sessionId; --resume appends turns, so two concurrent turns interleave/corrupt the transcript. Needs a per-sessionId MUTEX in main.js + a rule that a relay is refused while the pane is busy (and vice-versa). Single biggest hazard.
2. **Worktree reuse (Slice 5).** Three traps: createWorktree throws on an existing path; provisionDeps("junction") throws because node_modules exists; baseCommit re-capture zeroes cumulative commitCount. All must be short-circuited on resume, and the zero-commit auto-clean must never delete a resumable/escalated worktree.
3. **Two-tier cap/ownership (Slices 0 + 2).** isForeignDispatch only knows mateIds today, so a second mate's crew dispatch (dispatchedBy=secondMateId) is treated foreign and NEVER claimed - crew silently never runs. Ownership must include this instance's second mates; width per-caller; a global tree ceiling + token budget so N second mates x M crew can't blow quota with no ceiling.

## Critical files
- src/main.js (dispatch watcher, startGoalRun, session:start MCP assembly, budget/kill/resume IPC)
- src/lib/secondMates.js (proposed/created status, deriveSecondMates union, canonical binding)
- src/lib/goalOrchestrator.js (runGoal resume-worktree mode, quota detection, no-auto-clean)
- src/mcp/helmDispatchServer.js (new tools: helm_propose_assignments, helm_create_second_mate, helm_relay_to_second_mate, helm_report_up, helm_stop_tree, helm_resume_fleet; callerTier)
- src/lib/dispatchCaps.js (tier-2 depth/width caps, ownership fix) + new src/lib/orchestrationBudget.js
