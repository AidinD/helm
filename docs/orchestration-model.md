# Helm's orchestration model - captain, first mate, second mates, crew

The mental model Helm is built around, and how you actually work in it.
Settled with the captain 2026-07-06 (see DECISIONS.md for the decision + rationale).

> **Evidence check (2026-07-06), resolved.**
> A research pass (`docs/research-orchestration-2026-07-06.md`) supports the
> **second mate -> crew** layer strongly (2-level coordinator->workers on
> independent parallel projects is well-founded) but warned against a first mate
> run as a **standing relay** for routine dispatch (effective agent hierarchies
> cap at ~2 levels; Claude Code's Agent Teams disallows nesting; a cross-project
> coordinator only earns its coordination tax on *genuine* cross-project work).
> Resolution (the captain): the first mate is exactly NOT a standing relay - it's
> **bookend + on-demand** (morning "what matters today?" -> spins up second
> mates; evening summary; invoked ad hoc for real cross-project synthesis), and
> you talk to second mates directly during the day. That is precisely what the
> research prescribes. Two named first mates (work, private) are cheap because a
> dormant session bills no tokens - it only costs when it takes a turn. So the
> model and the evidence agree; the "avoid a mandatory top-level relay" caution
> is honored by design.

## The tiers

The captain is the captain of a ship.
He does not do most of the work himself - he delegates, and the delegation has structure.

| Tier | Who | Rooted | Holds (thin) context of | Lifespan |
|------|-----|--------|--------------------------|----------|
| **Captain** | the captain | - | intent, priorities, decisions | you |
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
