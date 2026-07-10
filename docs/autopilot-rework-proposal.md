# Autopilot rework - proposal (for a direction decision)

Status: research + proposal for Jot p4 cb5d6847. Not built - this is the
"prepare a concrete proposal so the captain can decide the direction" deliverable.

## What Autopilot is today

The Autopilot page (`renderGoalPage`, backed by `goalOrchestrator.js`) is a form
the captain fills in directly:

- **Goal** (free text)
- **Project folder**
- **Max iterations** (a number, default 5)
- **Model / effort** (dropdowns)
- **Verify command** (auto-suggested from package.json, but still a text field)
- **Escalate on trouble** (checkbox)

It's explicitly labelled *"Draft / first pass ... the point is to make the
orchestrator testable, not to design its permanent UX."*

## The mismatch (the captain's insight, 2026-07-07)

The captain would never fill this in by hand - he doesn't know, off the top of his
head, what to set "max iterations" or "verify command" to for a given project.
Those aren't captain-level knobs.

The orchestration model (`orchestration-model.md`) names exactly why:
> Autopilot (goalOrchestrator.js) is a lead-that-dispatches-a-crew within a
> project. What that machinery is, in these terms, is the **second-mate → crew**
> layer.

So the Autopilot form is the **crew-dispatch PRIMITIVE**. Configuring it -
picking iterations, detecting how to verify, choosing model/effort - is
**second-mate work** (the tier that is *rooted in the project* and therefore
*knows* it). The captain's job is **intent + priorities**, not crew knobs.
Exposing the primitive as the captain's front door is the tier confusion.

## Proposed reframe

Keep the primitive; change who drives it.

1. **Primary interface = intent.** The captain says *what* and *where* -
   "get the logo task done in dinghy", or picks a Jot task - and nothing
   else. No iterations, no verify field, no model choice up front.
2. **A second mate translates intent → a crew dispatch.** Because it's rooted
   in the project, it can: detect how to verify (extend the existing
   `suggestVerifyCommand` into real project detection - test/build/lint), pick
   sane iterations + model/effort for the task, decide escalation. This IS the
   model's "second mate dispatches crew".
3. **The raw form is demoted to "Advanced".** The current knobs stay reachable
   (power use + testing the orchestrator) but behind an advanced toggle - not
   removed, just no longer the front door.
4. **Verify is never a captain field again** - it's auto-detected by the
   project-aware tier.

This makes Autopilot read as: *the captain describes what; the tier below
figures out how* - which is the whole orchestration philosophy.

## The decisions this needs from you

**A. How smart is the "intent → dispatch config" step?**
- **A1 - Deterministic heuristic.** Detect verify from the repo (package.json
  scripts, etc.), default iterations, pick model by a simple rule. Instant, no
  token cost, but dumb (no understanding of the goal).
- **A2 - A real second-mate step.** A short project-rooted `claude` call reads
  the repo + the goal and proposes the config (and could sketch a plan). Smart,
  faithfully realizes the model ("second mate translates intent"), but adds a
  step + tokens + a few seconds before the crew run starts.
- *My lean:* A2, but lightweight - the second-mate step proposes, and you see
  the config before it runs (see B). It's also the natural on-ramp to the
  model's phases 2-3 (structured report-back, first-mate-initiated dispatch).

**B. Hands-off, or approve-first?**
- Show the auto-config once ("verify = `npm test`, 5 iterations, escalate on -
  Go?") for a one-click approve, or fire fully blind.
- *My lean:* approve-first. Cheap, keeps you in the loop, matches Helm's
  "propose, never auto-act" posture. Becomes hands-off later if you want.

**C. Scope of the first pass.**
- **C1 - Reframe only (small).** Demote the raw form to Advanced; add an
  intent box that auto-fills the config via A1 (deterministic detect) + shows
  it for approval (B). Delivers "captain gives intent, not knobs" WITHOUT
  building the session-spawns-session dispatch yet.
- **C2 - Full second-mate dispatch (big).** A2 + the model's "one capability
  gap": a session/run that spawns the project-rooted dispatch and reports back.
  This is a real chunk and overlaps orchestration-model phases 1-3.
- *My lean:* C1 now (it captures the insight cheaply and de-risks), C2 as the
  follow-on once the intent-first shape feels right.

## Recommendation in one line

Reframe Autopilot so the captain gives **intent**, a **project-aware step**
fills in the crew knobs (verify auto-detected), and you **approve** before the
crew run - built as the small C1 pass first, C2 later. Decide A / B / C and I'll
build to it.
