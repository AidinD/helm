# Helm's orchestration model - captain, first mates, crew

The mental model Helm is built around, and how you actually work in it.

> **DECIDED IS NOT BUILT, and this page has now got that wrong in both directions.** A layer
> was removed on 2026-09-04 - see DECISIONS.md, "A tier that gets routed around is not a tier".
> For five days this file kept teaching the four-tier model it replaced, and two sessions read
> it, built to it and reported the wrong thing back. The repair then overcorrected and wrote the
> decision in the present tense, as though the code had caught up. It has not, and the review
> gate caught that on the way in.
>
> So the sections below say which is which, and **anything that says a tier is gone means gone
> from the DESIGN**. What is actually built is under "What is not built yet". CLAUDE.md points
> every session here before any orchestration work, so a wrong page here is not a wrong page:
> it is instructions.
>
> **DECISIONS.md is the authority on what was decided. The code is the authority on what runs.**
> Where this file disagrees with either, this file is the bug.

## The tiers

The captain is the captain of a ship. He does not do most of the work himself - he delegates,
and the delegation has structure. There are three working tiers, and one standing seat beside
them rather than above them.

| Tier | Who | Rooted | Holds (thin) context of | Lifespan |
|------|-----|--------|--------------------------|----------|
| **Captain** | the captain | - | intent, priorities, decisions | you |
| **First mate** | one per active project | that project's repo | that project's deep state + its own dispatch | ephemeral per assignment |
| **Crew** | agents / Autopilot runs | a worktree | one task | ephemeral |
| *Standing seat* | *the assistant, one of them* | *meta-home* | *the irreplaceable half: goals, people, what was decided and why* | *durable, and occasional by design* |

**The first mate is the project seat.** That is the merge the layer removal performed, and it
is three things being merged rather than two: the **name** comes from the tier above, the
**permissions** from the tier below, and the **identity** is `mate_`.

The identity fork was the hard one and it is decided, not open - see DECISIONS.md, the same
entry, under "Six forks the decision did not cover, settled the same evening". A `mate_`
carries a slot, a pooled name, a persona and a retire path, none of which have substitutes; the
alternative `sm_<hash>` carries one property, being derivable, which a seat with a store record
no longer needs.

That entry also predicted the shape of the consequence - `secondMateId`'s dispatcher parameter
collapsing into `autoNodeId(projectPath)`. **That function does not exist.** What was built
instead is `secondMateId(lane, projectPath)` with exactly two permitted lanes, `PROJECT_LANE`
and `AUTO_LANE`, enforced by `laneOrThrow`. The property the prediction was after - no second
identity left to collide with - is what the enum delivers; the name in the entry was a sketch,
not a spec, and reading it as one is how this paragraph came to describe a function nobody
wrote.

**Where a project seat escalates: the captain's queue, not the standing seat.** The standing
seat is not in the chain of command for a project's work - it holds goals and people, not a
work queue - and escalation is the *common* event, so routing the most frequent thing through
the seat that re-reads its whole context every turn is the exact pattern this model exists to
avoid. The cross-project tools are the standing seat's alone: a project seat opening another
project's seat is the removed tier growing back from below.

**The standing seat is not a relay.** Talking to a project seat directly is the default;
routing through the standing seat is a deliberate choice for the times a view across projects
is worth paying for. That is measured, not felt: over 1588 turns an orchestrating seat read 731
million cached context tokens and a single turn reached 670k, because the whole context is
re-read every turn. The cost of an action in a standing seat is its context size, not the
action - relaying one instruction costs the same as reading a file. It earns that cost when
what it holds is irreplaceable, and not when what it holds is a work queue, which a board holds
better and can be re-read for nothing.

**Slots are unlimited and the board degrades as they multiply, on purpose.** Two project seats
is the intended working number. The friction of a crowded board is the governor on concurrency:
the real cost of another parallel session is attention, and a UI that hides that cost encourages
the thing being guarded against. Anyone tempted to tidy this away should read this paragraph
first.

### Model per tier - by judgment, not by hierarchy level

Match the model to the *judgment the tier actually exercises*, not to its height:

- **First mate (the project seat) → Opus.** This is the judgment tier: validate the crew's
  work, check it is sensible, review, sometimes fix. It is where capability earns its cost.
  Verified in code rather than asserted here: `defaultModelForTier` returns
  `claude-opus-4-8` for the tier a project seat launches on.
- **Crew → by task complexity.** The per-prompt model+effort suggestion already does this.

The Sonnet delegate tier that sat above this goes with the layer it belonged to - in the
design. See below for what still creates one.

## What is not built yet

**The cross-project seat is still creatable, today, in one click.** "Add widget" offers
"New first mate…", which calls `mates:add`, which calls `ensureMates(resolveMetaHome(), …)` -
a seat rooted at the META-HOME, which is the removed tier. Nothing about that path is broken;
it is the old path, left standing on purpose while the migration ran additively beside it (see
the epic's step 3, "seats are created by opening a project, additively alongside today's
paths"). Removing it is a decision about when, not a bug to fix quietly.

So: if you open Helm and make a first mate from the widget menu, you get the tier this page
says is gone. That sentence is the honest state of the migration, and it belongs here rather
than in a card nobody reads before doing dispatch work.

**The tier constants have not been renamed either** - see the vocabulary note below.

## A NOTE ON VOCABULARY, because parts of the code have caught up and parts have not

**The tools were renamed on 2026-09-05.** They are `helm_open_project` and
`helm_relay_to_project`. `helm_create_second_mate` and `helm_relay_to_second_mate` remain as
entries in `LEGACY_TOOL_ALIASES`, recorded through `recordLegacyToolCall` and tracked for
removal.

The first version of this paragraph said they survive "only so a running seat mid-session does
not break". That was wrong in a way worth keeping on the page: until 2026-09-10 the tier
guard's own denial text told every seat it refused to call `helm_create_second_mate`, so the
app was teaching the deprecated names to brand-new sessions and the aliases could never have
been retired by attrition. The guard names the current tools now.

**The tier CONSTANTS have not been renamed.** A project seat still launches on
`TIER_SECOND_MATE`. The behaviour is the new model; that word is the old one, and it is card
cc5cd531's 2189 references - renaming across a live dispatch path is its own change with its own
risk, which is why it is named here rather than half-done.

The first version of this section had the tool names wrong: it presented the legacy aliases as
the live names, in the document being repaired for exactly that kind of staleness, and the
review gate caught it. It is worth leaving that on the record, because the DECISIONS entry this
page rests on ends with the same correction about itself - a claim that something had never been
written down, eleven lines above where it was.

**Everything below this line predates the layer removal.** It has not been re-verified against
the current model, so where it says "second mate" for a coordinating layer above projects, that
layer no longer exists. It is kept because the reasoning about durability, resume, report-back
and the capability gap is still the reasoning Helm runs on - but read it knowing which parts
describe a tier that is gone.

## The daily loop (SUPERSEDED - written 2026-07-12, for the four-tier model)

> **Read the vocabulary before the steps.** Here "first mate" means the cross-project seat that
> was removed, and "second mate" means the project seat that is now called the first mate. Under
> today's names the steps below invert: step 1 starts the day in a seat that no longer exists,
> and every "second mate" is what you would now open as a first mate.
>
> It is kept, and kept unrewritten, for one reason: what the NEW daily loop is has not been
> settled with the captain. The layer-removal decision records that details of the conversation
> were lost and says explicitly that they must not be filled in by someone guessing. Rewriting
> these five steps would be exactly that. What survives translation is the reasoning - lazy
> creation over eager, one canonical session per topic rather than two views of it, and a seat
> that leaves no durable trace being un-summarizable.

This was the canonical intended workflow for the model as it stood.

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

## Durability + resume (REQUIRED on every phase, the captain 2026-07-12)

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
The captain's contribution is the tier on top of it: the cross-project **first mate**.

## The ephemeral-vs-durable tension, resolved by tier

The earlier reorientation (PLAN.md 2026-07-03) pushed toward ephemeral sessions to avoid megasession bloat.
The captain's first-mate instinct wants continuity.
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
*"launch a project-rooted second mate for Skiff and one for Helm, and stream their reports back to me."*

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

## Tiered report-back (settled with the captain 2026-07-11)

A goal/Autopilot run reports its outcome back to **whoever dispatched it**, not
onto one flat global list. The run object already carries `dispatchedBy`, so the
routing data exists - this section is about using it.

- **Mate-dispatched run** -> its report-back row **collects under that mate's
  card** in the DIRECT view. The card is the roll-up: a one-line summary
  ("2 back, 1 needs you") that expands to the individual rows. The dispatching
  mate is the first responder and triages its own crew's output.
- **Captain / Autopilot-initiated run** (`dispatchedBy: null`) -> stays on the
  **Captain Dashboard** REPORT-BACK directly. These have no mate owner.
- **Both, not either** (the captain's call): the dispatcher **compiles/summarizes**
  the results AND every individual run stays openable, so the captain can drill
  in and micro-analyze when a summary isn't enough.
- **Escalate up:** runs that genuinely need the captain (failed / escalated /
  commits-ready-for-review) **bubble up** to the Dashboard REPORT-BACK even when
  a mate dispatched them. The calm/handled ones stay under the mate. This is the
  "faculty, not a room" rule applied to results: the captain sees what mates
  lift to them, not the whole crew's raw output.

### Mark-as-done + cleanup (required, the captain 2026-07-11)

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
