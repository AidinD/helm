# Orchestration flow: current status + Phase-2 build plan

Updated 2026-07-12 after Aidin corrected the framing.
The AUTHORITATIVE workflow now lives in `orchestration-model.md` ("The daily loop") - this doc is the current-status + gap + concrete build plan for getting there.

## Framing correction (important)

An earlier version of this doc framed the choice as "Option A (keep the derived second mate) vs Option B (real second-mate agent)".
That was wrong: **A is not an alternative to B - it is Phase 1 of the phased path toward B** that `orchestration-model.md` itself lays out (§"How this maps... Phased path": "Second mates as ephemeral runs first ... the model without the token bleed").
So we are not choosing between two end-states; we are building B, and we are standing at Phase 1.
The canonical design has always been B: first mate (Sonnet) -> second mate (Opus, the judgment tier that dispatches crew + reports up) -> crew (by complexity).

## Where we stand (Phase 1, built)

- The first mate dispatches Autopilot **runs** directly; "second mate" is a DERIVED per-project view over those runs, with no session of its own until you jump in.
- Report-back is pull: the captain jumps into a mate to consume reports (`pendingTriageNudge` / `pendingSecondMateReviewNudge`).
- The Opus tier currently lands on the dispatched Autopilot runs, not on an active second-mate session.
- 2026-07-12 polish already shipped so Phase 1 doesn't feel broken: jump-in seeds a review nudge (not blank), reports surface immediately (`dispatch:report` push), cross-instance dispatch is ownership-scoped, Done no longer traps.

## The gap to the authoritative daily loop

The daily loop (orchestration-model.md) needs two things Phase 1 doesn't have:
1. **Step 2 - the first mate CREATES a real second-mate session per topic** (A/B/C), Opus-rooted in each project, existing + jumpable up front - not a derived view of headless runs.
2. **Step 3 mode 1 - drive those second mates THROUGH the first mate** (the relay), as an alternative to jumping in directly.

## Phase-2 build plan (proposed - not yet built)

Guardrails first, because this is the tier that can run away (the rejected unbounded fan-out lesson):
- **Hard width/depth caps** (already have `dispatchCaps.js` - extend to the second-mate tier).
- **A token budget ceiling** per orchestration + a visible **kill switch** (stop the whole tree).
- Bounded, explicit dispatch only - never recursive self-spawn.

Then:
1. **`helm_create_second_mate(project, brief)`** - a first-mate tool that spawns a project-rooted Opus session, binds it (second-mate binding already exists), and seeds it with the brief. One per A/B/C.
2. **Second mate dispatches its own crew** - give the second-mate session the crew-dispatch capability (Autopilot runs within its project), depth-capped so crew can't re-dispatch.
3. **Report UP the chain** - second mate aggregates its crew's reports and reports to the first mate; first mate aggregates across second mates for the captain (step 4). Extends the existing `dispatch:report` + report-queue plumbing one tier.
4. **First-mate-driven mode** - the relay so the captain can steer a second mate through the first mate (step 3 mode 1), not only by jumping in.
5. **Model-per-tier wiring** - first mate Sonnet (already), created second mate Opus, crew by complexity.

## Durability + resume (REQUIRED, cross-cutting - see orchestration-model.md)

"fortsätt" on the first mate must cascade resumption down to interrupted/quota-stopped Autopilot runs.
Build items: resumable runs (relaunch goalOrchestrator against the existing worktree, continue from notes.md), a resume-dispatch path, and the top-down cascade.
This is designed into Phase 2 from the start, not bolted on - each second mate owns resuming its own crew.

## Bug 9c0c7209 - "first mate needs you when it's just waiting on second mates"

Under the Phase-2 model the first mate wouldn't surface to the captain until the second mate had rolled its crew up - so this largely dissolves.
Interim (Phase 1) fix, still needing Aidin's wording call: add a **"reports ready"** state (crew done, nothing errored) distinct from the alarm-amber **"needs you"** (reserve that for a genuinely errored/escalated run, matching `runNeedsCaptain`).

## Status of the 2026-07-12 p0 batch
All in Jot "review" except 9c0c7209 (deferred to the wording call above): 9f957394, 7bacc349, 36dda656, ca32567c, c717be73, 6ed0b09e - done.
