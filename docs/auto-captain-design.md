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

### Implementation refinement (2026-07-18): tag-based trigger, not a new status

Building this, the trigger is a TAG named "auto" (case-insensitive), not a new Jot
lifecycle status/lane. Adding a lane means making TodoStatus dynamic per list,
which touches sorting + the board + the review flow (parked as thorny - Jot task
ed4291d2). A tag is just as explicit an opt-in ("AI, take this") without that
surgery. A visual "Auto" lane/view can be layered later (a filtered view over the
tag); the tag is the durable trigger. State tags (needs-clarification, auto-running)
carry status, matched by name so no Jot schema change is needed.

Build status (2026-08-02): BUILT END TO END, still OFF by default.

What exists now:
- `src/lib/autoCaptain.js` - the pure brain: selection, project resolution from the
  list's folder binding, the concurrency cap, the re-triage guard, and the wording of
  what gets written back to the board.
- `triageAutoTask` in `orchestratorHelper.js` - the live Haiku gate. No tools, no MCP
  servers, its own transcript deleted. A null answer counts as "don't fire".
- `autoCaptainTick` in `main.js` - one pass over the board, on a one-minute timer.
  The timer always runs; the TICK checks the toggle, so turning it on takes effect
  without a restart. No catch-up pass at startup, deliberately: an Auto card is a
  standing instruction, and firing a burst of them the moment Helm opens is exactly
  the surprise this must not produce.
- Dispatch reuses `runRelayTurn`, the same path a first mate's relay uses, with
  `allowDirect` for the deliberate captain -> second-mate route. One mechanism, so
  the auto path can't drift into a less careful copy of the locking and binding.
- The Auto widget now has the on/off switch and a "Run one pass" button. The switch
  lives THERE rather than in Settings: you cannot turn it on without seeing what it
  has started, and you cannot look at what it started without seeing that it is on.
- `startedBy: "auto"` is stamped on the session record and carried through to the
  Fleet node. Before this the Auto column filtered on a field nothing ever wrote,
  so it could never have shown anything.

Two things that emerged while building, both worth keeping:
1. **A card judged unclear is not re-judged until the card CHANGES.** Otherwise the
   triage re-runs every minute against the same words forever. The fingerprint
   STRIPS the auto-captain's own notes first - without that, appending the
   hold-back note changed the card, which made it look edited, which triggered
   another judgement and another note. Caught by the gate test on its first run.
2. **An unbound list is a first-class refusal, not a triage verdict.** A Jot list
   with no folder binding gives no trustworthy answer to "where does this run", and
   guessing from the list name would mean occasionally starting real work in the
   wrong repo. The card is held with a reason that says how to fix it.

NOT verified, on purpose: the live triage call and an actual dispatch have never
been run. Every test reaches its decision without a model call or a spawned session,
because a suite that fires real work would cost money each run. That last step is
"Run one pass" with Aidin watching, which is what this doc asked for.

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

## Prerequisite decision (DECIDED 2026-07-18)

The feature needs Helm to write to the board and react to board changes live, and a shared todos.json with two writers races on the Dropbox-synced data dir.
Decision: keep Jot and Helm as SEPARATE products, but with a stronger seam AND an embedded Jot tab in Helm - framed as "one Jot, two mounts", NOT two Jots.
See DECISIONS.md "Jot and Helm: one Jot, two mounts".

### One Jot, two mounts

Jot is split into a **Jot-core** (data + logic + events) and a **Jot-UI component**, and both shells mount the same two:

- Standalone Jot = Jot-core + Jot-UI in its own Electron shell (stays lightweight; fast capture never needs Helm running).
- Helm's Jot tab = the SAME Jot-core + the SAME Jot-UI, mounted inside Helm.

There is only ONE implementation, so features can't drift between "the two Jots" - there aren't two, just two mounts of one.
The user picks whichever is convenient (fast standalone, or from within Helm), and Helm can ship independently of the standalone app because it bundles its own core.
Do NOT reimplement Jot's UI inside Helm - that fork is the exact trap this avoids.

**Mount mechanism (decided 2026-07-18, after inspecting Helm):** Helm's renderer is plain vanilla JS - no React, no build step. So Jot-UI is NOT shipped as an importable React component (that would force React + a bundler into Helm). Instead:

- `@jot/core` (the electron-free data+logic module) IS a real importable package - Helm's main imports it directly. Proven 2026-07-18: the compiled core is cleanly consumed by an external shell (reads data another shell wrote, mutates, fires change events, persists to the shared todos.json). This is the crux the whole architecture rests on, and it works.
- Jot-UI is shared as Jot's BUILT RENDERER, which Helm embeds in a WebContentsView / `<webview>` (loading Jot's built index.html). The embed's preload wires its `window.jot` to a `@jot/core` instance (host in Helm, or client to a standalone host). So "one UI, two mounts" is: the same built renderer, loaded by the standalone BrowserWindow and by Helm's embedded view.

This eliminates the fiddliest part originally feared (a buildable React-component UI package) - it isn't needed. Only `@jot/core` needs packaging.
Open packaging detail: module format. Jot is `type: module` (ESM); `@jot/core` should match (ESM), which needs a bundled/extension-correct build (extensionless TS imports don't resolve as raw Node ESM) - decided at the packaging step.

### Data sync: one runtime writer (host/client)

To kill the two-writer race, Jot-core runs in one of two modes:

- host: owns todos.json, writes it, emits change events.
- client: discovers a running host and connects to it (local socket) instead of writing the file itself.

At runtime there is always exactly one writer: only-Helm -> Helm's core is host; only-standalone -> it's host; both running -> one host, the other client.
This also gives "ship Helm independently" for free (Helm's bundled core runs host when the standalone app isn't present).
Bonus: it makes auto-start cleaner - when Helm hosts, the auto-captain talks to the same in-process core, so setting `needs-clarification` / moving a lane is a direct core call, not a file write.

### Real costs (accepted)

1. Refactor Jot into core + UI component (Jot-side work; the real job, worth it - one implementation, no diverging clones).
2. Host/client coordination plumbing (host discovery, local socket, event bus) - the proper fix for the Dropbox multi-writer problem, not a patch.

### Where to start

The Jot core/UI split is the foundation everything else sits on, so it goes first.
Tracked as a task in the Jot category.

## Cross-cutting notes

- This feature spans Helm + Jot. The Auto lane, its settings toggle, and the tags are Jot-side work; the triage, auto-captain, and orchestration are Helm-side.
- Mock/plan-first: before building, produce a mock of the auto-captain column + the Auto lane so the shape is agreed cheaply.
