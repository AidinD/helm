# Auto-captain / auto-start tasks - design

Status: DESIGN CAPTURED, not building yet.
Blocked on one strategic decision (see "Prerequisite decision" below) that shapes how the board interaction is wired.
Jot task: ea0546d1 (Helm category).

## The idea

An automated dispatcher that starts work on tasks the user hands it, so the board (intent) drives execution without the user opening a session and prompting each time.
It is a SECOND captain - a peer at the existing captain tier, shown as its own "auto-captain" column next to the human captain - NOT a new tier below.
Its whole job is to route: take a handed-off task, make sure the project's second mate exists (spin one up if none is live), and hand it the task.
The second mate then dispatches crew as normal.

## Agreed shape

### The auto-captain is a thin dispatcher, not a live idling session

It holds no deep context and is not something you converse with.
Per task it runs a cheap triage, then ensures/spins up the project's second mate and hands off.
A persistent captain-level session sitting idle between tasks would burn tokens and be one more thing to keep alive (runaway risk), so the auto-captain is a dispatch rule; the "auto-captain" column is only the visual home for its runs.
(If we ever want to give the auto-captain standing instructions we can talk to, it becomes a live session - but then it should be Sonnet and sleep fully between triggers. Not the plan for v1.)

### It routes DIRECT to second mates, skipping first mates

A handed-off task already names its project, so it needs none of the first mate's cross-project prioritisation.
The auto-captain goes captain -> second-mate directly (the existing "Direct" path), which is cleaner and cheaper than routing through a first mate.

## 1. Trigger

- The "Auto" lane is the trigger (intent). Dragging a card there means "AI, take this" - unambiguous, and it gives the visual separation of auto work from manual work.
- A global toggle in Helm is the master on/off for the whole auto system (like the fleet kill-switch), so it can be paused without touching the board.
- Tags carry STATUS, not the trigger. The triage verdict and run state ride on tags, never the trigger.

Rejected: tag-as-trigger (reintroduces "when does it fire?" ambiguity) and per-category auto (too coarse; the "I'm working on this myself" collision remains inside that category).

Card lifecycle: Open -> Auto (queued) -> In-progress [auto-running] -> Review.
The manual flow (Open -> In-progress by the user) is untouched.
Never auto -> Done.

### The Auto lane itself is behind a Jot-settings toggle

The Auto lane only means anything when Helm's auto-captain is watching, and not everyone wants it.
So the lane is opt-in: a toggle in Jot settings shows/hides it.
Off by default keeps the board clean for anyone not using the automation.

## 2. Triage (Haiku) + tags + surfacing

When a card lands in Auto, the auto-captain runs a cheap Haiku triage over the card (title + description + images) and the project (CLAUDE.md / files):

- Well-defined -> dispatch (section 3); card -> In-progress [auto-running].
- Not clear -> Haiku writes a `needs-clarification` tag AND a short note on WHY (in the card description, so the user knows what to add - not just "not clear"), leaves the card in Auto (does not fire), and Helm surfaces it in its task list as a needs-you.
  The user sees it in two places: the tag on the board and the needs-you in Helm.
  The user clarifies -> it re-triages.

Reuse existing Jot tags where they map; add only the few we need (`needs-clarification`, `auto-running`).

## 3. Auto-captain (resolved)

A second captain column, thin dispatcher, routes direct to second mates (spins up per project when none is live), no new tier.
The column is the visual home for auto-started runs, separated from the user's Captain / Direct work.
This answers "who runs it if no second mate is up?": the auto-captain ensures one exists.

## 4. Control / reversibility

- Auto-START only, never auto-complete. Results land in Review; the user verifies and moves to Done themselves (the joint-decision rule).
- Everything auto-started is visible under the auto-captain column and flagged on the board (`auto-running`).
- Easy to stop: the global toggle and the existing fleet kill-switch cancel live auto-runs.
- Crew never pushes/merges (already true) and works in isolated worktrees.
- Concurrency is capped (DISPATCH_WIDTH_CAP = 3): dragging 10 cards to Auto does not fire 10 at once - the rest queue.
- Order within Auto follows Jot priority (lower number = more urgent).

## End-to-end flow

1. User drags a card to the Auto lane (global auto-toggle on; the lane is enabled in Jot settings).
2. Auto-captain triage (Haiku): well-defined?
   - No -> `needs-clarification` + a why-note; needs-you in Helm; card stays in Auto. User clarifies -> re-triage.
   - Yes -> ensure the project's second mate (reuse or spin up), hand off the task; card -> In-progress [auto-running] under the auto-captain column; second mate dispatches crew under the caps.
3. Work completes -> card -> Review. User verifies -> Done.
4. Any time: global toggle off, or the fleet kill-switch, stops it.

## Prerequisite decision (blocks build)

This feature needs Helm to WRITE to the board (tags, lane moves) and REACT to board changes live.
A shared todos.json with two writers is racy, especially on the Dropbox-synced data dir.
So before building we must decide the Helm <-> Jot relationship:

- Keep separate + upgrade the seam (Jot stays the standalone source of truth and sole writer, exposing a small local API/events; Helm is a client that sends intents and subscribes). Preserves Jot's public/standalone identity; no write-race; more upfront plumbing.
- Build Jot into Helm (Helm owns the board data + UI; standalone Jot becomes a thin view or is retired). Simplest for this feature and the tightest loop; absorbs a public standalone product.
- Keep separate + shared file (both read/write todos.json, Helm file-watches). Least upfront work; two writers race on a Dropbox-synced file - a real risk.

See DECISIONS.md once this is decided.

## Cross-cutting notes

- This feature spans Helm + Jot. The Auto lane, its settings toggle, and the tags are Jot-side work; the triage, auto-captain, and orchestration are Helm-side.
- Mock/plan-first: before building, produce a mock of the auto-captain column + the Auto lane so the shape is agreed cheaply.
