# Orchestration flow: expected vs actual, and how to close the gap

Written 2026-07-12 for Aidin's review (he flagged the flow as "strange and far too manual").
This is a DESIGN decision doc - the fix touches core orchestration, so it's written up for a call rather than implemented blind while he was away.

## The mismatch he described

**Expected:**
1. Give 1st mate a task.
2. 1st mate hands over to 2nd mate.
3. 2nd mate spins up autopilots.
4. 2nd mate collects the results.
5. 2nd mate reports back to 1st mate.

**What actually happens:**
1. Give 1st mate a task.
2. 2nd mate does nothing.
3. Autopilots spin up (dispatched by the 1st mate directly).
4. You jump into the 2nd mate and get an auto-prompt (should be automatic or a button).
5. The 2nd mate reviews the work.
6. No reporting back to the 1st mate.
7. Manual cleanup of the autopilots.

## Why it works the way it does today (the current design)

The "2nd mate" is NOT an active agent in the current build - it is a DERIVED grouping node.
`deriveSecondMates` (lib/secondMates.js) creates one per distinct `(dispatchedBy, projectPath)` straight from the goal-run history; it has no session of its own until you jump in.
The 1st mate holds the `helm_*` dispatch tools and dispatches the autopilot runs DIRECTLY (see launcher.js: only first mates get the dispatch tools; a dispatched run is depth-capped and cannot itself dispatch).
Report-back is a PULL model: finished runs write reports to the dispatch queue, and the 1st mate only consumes them on its NEXT turn via `helm_collect_reports` - it does not get re-woken automatically.
The 1st mate is deliberately DORMANT between turns ("a dormant session bills no tokens", first-mate-instructions.md) - which is why nothing auto-aggregates.

So today's tiers are really: **1st mate (agent) -> autopilot crew (runs)**, with "2nd mate" as a per-project VIEW over the crew, and the captain as the thing that re-engages the loop.
That was a deliberate trade (cheap, oversight-preserving) - but it does NOT match the mental model of a genuine 2nd-mate agent that owns a project, spins its own crew, and reports up.

## The decision: which model do we want?

### Option A - Keep the derived 2nd mate, just make the CURRENT flow feel automatic (low risk)
Close the specific rough edges without changing the tier structure:
- Auto-open the 2nd-mate review with its nudge already seeded (DONE 2026-07-12 - jump-in now seeds `pendingSecondMateReviewNudge` instead of a blank session).
- Auto-surface reports the moment they land (DONE - `dispatch:report` push + forced fleet refresh).
- Fix the status semantics so a 1st mate awaiting crew reads "waiting on crew", and once crew is done + reports are back it reads "reports ready", NOT the alarming "needs you" (bug 9c0c7209 - see below).
- Optional: auto-acknowledge a run once its branch is merged, so "Done" mostly takes care of itself.
- The captain still drives the re-engagement (jump in to aggregate), which keeps oversight and costs nothing while idle.
This is the pragmatic path: the flow stops feeling broken, but the 2nd mate stays a view, not an agent.

### Option B - Make the 2nd mate a REAL agent tier (matches his expected model, higher risk)
The 1st mate delegates a project brief to a spawned 2nd-mate SESSION; that 2nd-mate agent spins its own autopilot crew, waits for + aggregates their reports, and reports UP to the 1st mate; the 1st mate aggregates across 2nd mates for the captain.
This is a genuine 3-level autonomous loop.
Cost/risk: it re-introduces the depth the current design deliberately caps (a dispatched tier that itself dispatches), multiplies token spend (three live agent tiers instead of one), and is exactly the shape that can run away (see the "agent fan-out runaway" lesson) - it needs hard width/depth caps, a budget ceiling, and a kill switch before it's safe to run unattended.
It also needs an auto-report-UP mechanism (2nd mate -> 1st mate) and an auto-re-wake of the dormant 1st mate, which is the piece the dormancy model intentionally omitted.

### Recommendation
Ship **Option A** now (most of it is already done as of 2026-07-12) - it removes the "strange and too manual" feel with low risk and preserves oversight/cost.
Treat **Option B** as a separate, explicitly-scoped project with caps + budget + kill switch designed in from the start, only if the derived-2nd-mate model still feels too manual after living with Option A.
The two are compatible: Option A is the same flow Option B would automate, so nothing done now is wasted.

## Bug 9c0c7209 - "1st mate needs you when it's really just waiting on 2nd mates"

Root: the `waitingOnCrew` badge (mateHasLiveCrew) only suppresses "needs you" while crew is still RUNNING.
Once the crew finishes and reports are back, `mateHasLiveCrew` is false, so the mate flips to "needs you" - which is technically correct (reports need triage) but reads as "the mate is stuck on me" rather than "your crew is done, here are the results".
Under his expected model (auto-aggregation) the 1st mate wouldn't surface to him at all until the 2nd mate had rolled things up.

Fix direction (part of Option A, NOT yet implemented - needs his call on wording):
- Add a third state between "working/waiting on crew" and "needs you": **"reports ready"** (crew done, nothing errored/escalated) - informational, not an alarm-amber "needs you".
- Reserve "needs you" for a run that actually errored or escalated (a real decision), matching how the crew rows already distinguish `runNeedsCaptain`.
- With auto-report-up (Option B) this state would instead be the 1st mate's own aggregated summary turn.

## Status of the surrounding p0 fixes (all 2026-07-12, in Jot "review")
- 9f957394 - 2nd-mate box click routing + rows deep-link into the autopilot. DONE.
- 7bacc349 - animated running indicator. DONE.
- 36dda656 - tree no longer collapses on Done. DONE.
- ca32567c - simpler mobile glyph. DONE.
- c717be73 - bigger chevron hit target. DONE.
- 6ed0b09e - quota on dashboard. DONE.
- 9c0c7209 - waiting-vs-needs-you semantics. DEFERRED to this doc (needs the wording/behaviour call above).
