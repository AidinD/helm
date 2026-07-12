# Helm's orchestration model - captain, first mate, second mates, crew

The mental model Helm is built around, and how you actually work in it.
Settled with Aidin 2026-07-06 (see DECISIONS.md for the decision + rationale).

> **Evidence check (2026-07-06), resolved.**
> A research pass (`docs/research-orchestration-2026-07-06.md`) supports the
> **second mate -> crew** layer strongly (2-level coordinator->workers on
> independent parallel projects is well-founded) but warned against a first mate
> run as a **standing relay** for routine dispatch (effective agent hierarchies
> cap at ~2 levels; Claude Code's Agent Teams disallows nesting; a cross-project
> coordinator only earns its coordination tax on *genuine* cross-project work).
> Resolution (Aidin): the first mate is exactly NOT a standing relay - it's
> **bookend + on-demand** (morning "what matters today?" -> spins up second
> mates; evening summary; invoked ad hoc for real cross-project synthesis), and
> you talk to second mates directly during the day. That is precisely what the
> research prescribes. Two named first mates (work, private) are cheap because a
> dormant session bills no tokens - it only costs when it takes a turn. So the
> model and the evidence agree; the "avoid a mandatory top-level relay" caution
> is honored by design.

## The tiers

Aidin is the captain of a ship.
He does not do most of the work himself - he delegates, and the delegation has structure.

| Tier | Who | Rooted | Holds (thin) context of | Lifespan |
|------|-----|--------|--------------------------|----------|
| **Captain** | Aidin | - | intent, priorities, decisions | you |
| **First mate** | a cross-project orchestrator, one per life-domain (work, private) - named | meta-home (above all projects) | cross-project priority: what needs attention, what to dispatch, what to report back | durable named *role*; bookend + on-demand, dormant between |
| **Second mate** | one orchestrator per active project | that project's repo | that project's deep state + its own dispatch | ephemeral per assignment |
| **Crew** | agents / Autopilot runs | a worktree | one task | ephemeral |

### Model per tier - by judgment, not by hierarchy level

The naive "higher tier = cheaper model" rule is wrong here; match the model to the
*judgment the tier actually exercises* (this is the research's "model tiering by role,
not level"):
- **First mate → Sonnet.** Pure delegate: prioritize the day, dispatch, summarize. Not
  Haiku - "what matters most today" is real cross-project prioritization judgment, not
  mechanical rollup.
- **Second mate → Opus.** This is the judgment tier: validate the crew's work, check it's
  sensible, review, sometimes bugfix. It's where capability earns its cost. (This is why
  a session doing hands-on build+validation - a second-mate role - wants Opus; the earlier
  "orchestrator = Opus" call was really about this role.)
- **Crew → by task complexity.** The per-prompt model+effort suggestion (Point 9) already
  does this.

The captain talks mostly to the first mate.
The first mate breaks the captain's intent into per-project assignments and hands them to second mates.
Each second mate dispatches crew (agents / Autopilot runs) to do the actual work, and reports progress up.
Small quick things skip the chain - the captain goes straight to a second mate or even an agent.

## The daily loop (AUTHORITATIVE, Aidin 2026-07-12)

This is the canonical intended workflow - the target the phased build (below) is heading for.

1. **Start the day in the first mate.** Prompt it: "what should I work on today? I want to work on A, B and C."
2. **The first mate PROPOSES one assignment per topic and creates the second mate LAZILY.** It lays out A, B, C as per-project assignments; the actual project-rooted Opus session is spun up only when you first ENGAGE that topic (jump in or dispatch), not all three up front. (Refinement 2026-07-12: eager creation would leave two untouched Opus sessions burning context on a day you only work A - lazy creation is the token-honest default, same UX for you.)
   - **Granularity is per PROJECT, not per arbitrary task.** A second mate is keyed by (first mate, project). So "one second mate per topic" holds when A/B/C are different projects; three tasks in the SAME project are one second mate holding three assignments (they'd collide on the repo/worktree otherwise).
3. **Two ways to proceed, the captain's choice** (this dual mode is essential):
   - **Orchestrate via the first mate** - stay in the first mate and drive the second mates through it. Simpler, more orchestratory - but the first mate stays active and relays, so it costs more tokens.
   - **Jump into a second mate and work there directly** - hands-on in the project session. Preferred token-wise: the first mate goes dormant (bills nothing) while you work in the one Opus session that matters.
   Either mode must work; the captain switches freely. **Both modes operate on the SAME second-mate session** (one canonical secondMateId -> sessionId binding) - never two parallel contexts for one topic, or the first mate's view and your direct work diverge.
4. **Ask the first mate for a summary when done.** Go back to the first mate; it aggregates across the second mates into one cross-project wrap-up.
   - This depends on the second mates having **externalized** their state (a report / DECISIONS.md / Jot). In the cheap direct-work mode the first mate is dormant and has NO memory of what you did there - it reconstructs the summary from files, so a second mate that left no durable trace is un-summarizable. Every second mate must leave a trace before retire.
5. **Retire.** The second mates are ephemeral (their continuity is the project's own files); the first mate is a durable role, dormant until tomorrow.

The current build stands at Phase 1 of the phased path (below): the first mate dispatches Autopilot *runs* directly and "second mate" is a derived VIEW, not yet a created session.
Step 2 (first mate *creates* real second-mate sessions) + the first-mate-driven mode of step 3 are the Phase-2 target.

## Durability + resume (REQUIRED on every phase, Aidin 2026-07-12)

The whole tree must survive an interruption - running out of tokens mid-run, or the app closing - and be trivially continuable.
The bar: the captain types **"fortsätt" (continue) on the first mate**, and resumption **propagates all the way down** - first mate -> its second mates -> their in-flight/interrupted Autopilot runs - each picking up where it stopped.

The durable substrate already exists and survives a crash:
- The dispatch queue on disk (`.helm-dispatch/` - requests/acks/reports/fleet-state).
- `goalRunHistory` (every run + status; an interrupted run is already marked `interrupted`).
- Worktrees with their committed progress + `notes.md` (Autopilot continuity is already notes.md-based: each iteration runs fresh and reads notes.md).
- Session transcripts (`~/.claude/projects`, resumable via `--resume`), `mates.json`, second-mate bindings.

What must be BUILT for top-down "fortsätt":
1. **Resumable Autopilot runs** - relaunch `goalOrchestrator` against the EXISTING worktree/branch (continue from notes.md) instead of a fresh one; a run stopped on a quota limit is marked resumable and picks up when quota resets.
2. **Resume-dispatch** - a path to re-attach to an interrupted/quota-stopped run rather than only starting fresh ones.
3. **Top-down cascade** - "fortsätt" on the first mate resumes its session, reads fleet-state/history for anything unfinished, and cascades resumption down the tree (in the Phase-2 model each second mate owns resuming its own crew).

Token-exhaustion and app-crash are the same mechanism: durable per-tier state + a resume that re-hydrates and continues.

## How this maps onto Helm today

The cwd a session is rooted in *is* its tier - this is why orchestrator detection is cwd-based:
- Rooted in the **meta-home** (the coordinator root above every project) = **first mate**.
- Rooted in a **project repo** = **second mate**.
- An **Autopilot run / dispatched agent** in a worktree = **crew**.

Most of the crew machinery already exists: Autopilot (`goalOrchestrator.js`, Point 11) is a lead-that-dispatches-a-crew within a project (the `firstmate` reference tool informed it), and a session can dispatch agents directly.
What that machinery is, in these terms, is the **second-mate -> crew** layer.
Aidin's contribution is the tier on top of it: the cross-project **first mate**.

## The ephemeral-vs-durable tension, resolved by tier

The earlier reorientation (PLAN.md 2026-07-03) pushed toward ephemeral sessions to avoid megasession bloat.
Aidin's first-mate instinct wants continuity.
Both are right, and they don't actually conflict - they apply to different tiers:

- **Crew**: always ephemeral. Spun per task, discarded.
- **Second mates**: ephemeral per assignment. Spun up, do the project work, report, discarded. Their continuity is the project's own files (CLAUDE.md, DECISIONS.md, Jot).
- **First mate**: a durable *role*, but NOT an eternal session. It holds only thin cross-project priority (what needs attention, what to dispatch) - never a project's depth - so it does not bloat even while long-lived. Its memory lives in files it reads (the Jot board, DECISIONS.md, memory), not in the context window. When the session saturates (the context gauge is the signal), it summarizes into files and a fresh session takes the watch - same role, new session, continuity via the logbook.

So "ephemeral" was never wrong; it applies downward.
The first mate is the one deliberate, kept-thin exception.

## Operating rules

**One first mate per life-domain - two, named (work, private).**
Each is the single cross-project seat for its domain (a third would fragment that domain's overview, which is the whole point).
Naming them makes them easy to associate with and labels the two roots of the tree.
Each is a durable *role* backed by a succession of sessions (refreshed on saturation), not an eternal session, and never one per project - all per-project multiplicity lives at the second-mate tier.
They are **bookend + on-demand, dormant between**: active at the start of the day ("what matters today?" -> spin up second mates) and end ("summarize"), or invoked ad hoc for genuine cross-project synthesis - not a standing relay you route routine work through. During the day you work directly with the second mates. A dormant first mate costs no tokens (a session only bills when it takes a turn), so keeping two alive is cheap.

**Direct access is always allowed.**
The hierarchy is the default path, not a gate.
Want to dive into a project with a live second mate? Talk to it directly.
No live second mate for it? Start a fresh project session - it reads the project's files and is instantly briefed, so you never lose the chance; you just get a fresh officer instead of a discarded one.
Direct is often cheaper and faster (fewer hops); the first mate earns its keep on cross-project coordination, not single-project deep dives.

**File-backed continuity is the glue.**
A significant decision made directly with a second mate must leave a trace in files (Jot, DECISIONS.md) - otherwise the first mate's next survey sees a stale picture.
Externalize, don't hoard: this is what lets every tier below the captain be refreshed or discarded without loss.

**When to switch / refresh a first mate:** only on a domain change (work vs personal) or on context saturation (gauge) - never arbitrarily. Otherwise you return to the same one.

## The one capability gap that makes this real

Today a session can dispatch **agents** (the Agent tool), but a first mate cannot tell Helm:
*"launch a project-rooted second mate for Crewline and one for Helm, and stream their reports back to me."*

That is **session/run-spawns-session/run + structured report-back**, and it is the piece that turns this model from a way of thinking into a way of working.
Everything else already exists: rooting = tier, Autopilot crew, Jot as shared memory, summarize-and-carry-over for the first-mate handoff, the context gauge as the saturation signal.

**Phased path (build toward the tier, don't boil the ocean):**
1. **Second mates as ephemeral runs first.** Let the first mate dispatch a project-scoped Autopilot run (or a fresh project session) per assignment, rather than standing up fat live second-mate sessions - the model without the token bleed.
2. **Structured report-back.** A dispatched second mate/run reports a compact result up to the first mate (and the Dashboard) - status, what changed, what needs the captain - instead of the captain having to go read each one.
3. **First-mate-initiated dispatch.** The capability for a first-mate session to launch those project-scoped runs itself (session-spawns-run), so the captain states cross-project intent once and the first mate parallelizes it across projects.
4. **Assign-back to the captain.** Strengthen the path where the first mate hands a decision back to you ("this needs your call") - the Dashboard queue is the start, but it is weak today.
5. **First-mate refresh pipe.** When a first mate's context gauge crosses a threshold, fire an attention notification (reusing the away-from-desk pipe) at a *sensible* moment - idle or a day boundary, never mid-task. One click accepts; the rest is automatic (summarize to files -> brief a fresh session under the same name). Automated except the single decision.
6. **Tree/fleet view.** The Dashboard shows the two named first mates as roots with their second-mate branches and each branch's crew; a branch is one click to go direct. This is how the model becomes *visible* - it depends on the relationship-tracking from steps 2-3, so it comes with them, not before.

**Cross-cutting:** model-per-tier by judgment (first mate Sonnet, second mate Opus, crew by complexity); bounded by design - a known small set of tiers with explicit dispatch, never the unbounded recursive agent fan-out that was rejected earlier (that burned quota with no ceiling).

## Tiered report-back (settled with Aidin 2026-07-11)

A goal/Autopilot run reports its outcome back to **whoever dispatched it**, not
onto one flat global list. The run object already carries `dispatchedBy`, so the
routing data exists - this section is about using it.

- **Mate-dispatched run** -> its report-back row **collects under that mate's
  card** in the DIRECT view. The card is the roll-up: a one-line summary
  ("2 back, 1 needs you") that expands to the individual rows. The dispatching
  mate is the first responder and triages its own crew's output.
- **Captain / Autopilot-initiated run** (`dispatchedBy: null`) -> stays on the
  **Captain Dashboard** REPORT-BACK directly. These have no mate owner.
- **Both, not either** (Aidin's call): the dispatcher **compiles/summarizes**
  the results AND every individual run stays openable, so the captain can drill
  in and micro-analyze when a summary isn't enough.
- **Escalate up:** runs that genuinely need the captain (failed / escalated /
  commits-ready-for-review) **bubble up** to the Dashboard REPORT-BACK even when
  a mate dispatched them. The calm/handled ones stay under the mate. This is the
  "faculty, not a room" rule applied to results: the captain sees what mates
  lift to them, not the whole crew's raw output.

### Mark-as-done + cleanup (required, Aidin 2026-07-11)

- Every report-back row needs a **Done** action. Baseline semantics =
  **acknowledge**: clears the row from the needs-you surfaces, non-destructive,
  modeled on `acknowledgedSessions` (keyed so new activity un-acknowledges it).
- If the run used a **worktree/branch**, Done should also **clean it up**:
  `git worktree remove --force` (NEVER `rm -rf` a worktree that has a
  `node_modules` junction - that follows the junction into the shared package),
  then delete the branch.
- **Gate branch deletion** on a merged-to-main check + explicit confirm. Removing
  the worktree is safe; deleting a branch that still holds unmerged commits loses
  work, so that step is the one destructive action and must be confirmed, never
  automatic.

### The two halves - be honest about which is which

- **Easy half - view routing.** Filter/group the existing report-back rows by
  `dispatchedBy` so they render under the right card + the escalated subset on
  the Dashboard. Pure presentation over data that already exists.
- **Hard half - feed the result back into the mate's session.** Today a
  dispatching session learns *nothing* when its run finishes; the result lives
  only in Helm's `goalRuns`/UI. For a mate to actually triage (not just for the
  UI to group rows under its card), the terminal run's structured result has to
  be delivered back into that mate session's context. This is what makes the
  tiers real rather than cosmetic, and it's the substantive piece of the work.

Tracked as a Jot task extending the shipped flat report-back slice.
