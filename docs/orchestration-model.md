# Maestro's orchestration model - captain, first mate, second mates, crew

The mental model Maestro is built around, and how you actually work in it.
Settled with Aidin 2026-07-06 (see DECISIONS.md for the decision + rationale).

## The tiers

Aidin is the captain of a ship.
He does not do most of the work himself - he delegates, and the delegation has structure.

| Tier | Who | Rooted | Holds (thin) context of | Lifespan |
|------|-----|--------|--------------------------|----------|
| **Captain** | Aidin | - | intent, priorities, decisions | you |
| **First mate** | one cross-project orchestrator | meta-home (above all projects) | cross-project priority: what needs attention, what to dispatch, what to report back | durable *role*, refreshed sessions |
| **Second mate** | one orchestrator per active project | that project's repo | that project's deep state + its own dispatch | ephemeral per assignment |
| **Crew** | agents / Autopilot runs | a worktree | one task | ephemeral |

The captain talks mostly to the first mate.
The first mate breaks the captain's intent into per-project assignments and hands them to second mates.
Each second mate dispatches crew (agents / Autopilot runs) to do the actual work, and reports progress up.
Small quick things skip the chain - the captain goes straight to a second mate or even an agent.

## How this maps onto Maestro today

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

**One active first mate at a time.**
Two would fragment the single cross-project overview that is the whole point.
It is one *role* backed by a succession of sessions (refreshed on saturation), one alive at once - not one eternal session, and not one per project.
The only legitimate reason for more than one concurrently is genuinely firewalled life-domains (work vs personal) - a domain split, not a per-project split.
All per-project multiplicity lives at the second-mate tier.

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

Today a session can dispatch **agents** (the Agent tool), but a first mate cannot tell Maestro:
*"launch a project-rooted second mate for Crewline and one for Maestro, and stream their reports back to me."*

That is **session/run-spawns-session/run + structured report-back**, and it is the piece that turns this model from a way of thinking into a way of working.
Everything else already exists: rooting = tier, Autopilot crew, Jot as shared memory, summarize-and-carry-over for the first-mate handoff, the context gauge as the saturation signal.

**Phased path (build toward the tier, don't boil the ocean):**
1. **Second mates as ephemeral runs first.** Let the first mate dispatch a project-scoped Autopilot run (or a fresh project session) per assignment, rather than standing up fat live second-mate sessions - the model without the token bleed.
2. **Structured report-back.** A dispatched second mate/run reports a compact result up to the first mate (and the Dashboard) - status, what changed, what needs the captain - instead of the captain having to go read each one.
3. **First-mate-initiated dispatch.** The capability for a first-mate session to launch those project-scoped runs itself (session-spawns-run), so the captain states cross-project intent once and the first mate parallelizes it across projects.
4. **Assign-back to the captain.** Strengthen the path where the first mate hands a decision back to you ("this needs your call") - the Dashboard queue is the start, but it is weak today.

Bounded by design, not the unbounded recursive agent fan-out that was rejected earlier (that burned quota with no ceiling; this is a known, small set of tiers with explicit dispatch).
