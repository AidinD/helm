# Maestro — Build Plan

A personal wrapper around the real Claude Code CLI that adds overview, rooting,
context flow, and (later) orchestration — without removing any Claude feature.
Built by wrapping the real `claude` binary headlessly (stream-json), so all
skills, CLAUDE.md, settings, permissions, and MCP are preserved.

## The captain's vision (14 points) → where each lands

| # | Want | Phase |
|---|------|-------|
| 1 | Better overview | 1 |
| 2 | Dynamic to my needs (my grouping/sorting/filters) | 1 |
| 3 | Easily move context + archive | 2 |
| 4 | Easy rooting | 1 |
| 5 | Skills/rules that make it easy to work how I do | 1 (preserved) + 3 (coach) |
| 6 | Reuse all my existing skills | 1 (preserved by design) |
| 7 | Integrated with my Jot | 1 |
| 8 | Help split work + prioritize focus | 3 |
| 9 | Suggest model + effort | 1 |
| 10 | I choose model + effort | 1 |
| 11 | Real orchestration | 3 |
| 12 | Coach me: feedback on how I work, slow me down if I context-switch too much | 3 |
| 13 | See my token/quota | 1 (investigate source) |
| 14 | More later | reserved |

## Phase 0 — Spike (de-risk before any UI)

Prove the foundation with a throwaway script, no Electron yet:
- Start a `claude` session rooted in a real repo folder **on main, no worktree**.
- Set model + effort (thinking budget) per run.
- Stream output live (stream-json) and parse events.
- Run on the **subscription** — confirm zero-config auth inheritance in a
  spawned subprocess (the one unconfirmed cost item), else wire
  `claude setup-token`.
- Test **resuming an existing session** by id (its transcript is in
  `~/.claude/projects`) — confirms whether Maestro can pick up desktop-app
  threads.
- Confirm a skill (e.g. `/kickoff`) is invokable in headless mode.

Gate: if auth + streaming + rooting work, proceed to Phase 1. If subscription
auth doesn't hold, pause and reassess cost before building UI.

## Phase 1 — Overview harness (the product; solves the real pain)

Electron app, **reusing Session Radar's read layer** (`lib/sessions.js`,
`lib/jot.js`). Delivers points 1, 2, 4, 5, 6, 7, 9, 10, 13:
- **Overview board** of all sessions with status + attention spotlight (1).
- **My structure**: custom groups, sorting, filters I control (2).
- **Jot integration** carried over from Session Radar (7).
- **Start a rooted session**: pick a project → new session in that repo folder,
  on main (4). All skills + CLAUDE.md + rules load because we wrap the real CLI
  (5, 6).
- **Model + effort**: recommended per task, chosen by me at start (9, 10).
  (Addresses Jot task "Bestämma/föreslå modell och effort?".)
- **Token/quota view** (13): investigate a reliable source (usage endpoint /
  local logs) before promising; may land as a stretch item.

## Phase 2 — Context flow & archiving (point 3)

- **"Summarize & carry over"**: lift a session's context into a fresh one so
  archiving no longer means losing the thread — this is what unlocks aggressive
  archiving (the captain's key insight).
- In-app **archive** controls; likely **resume** existing sessions (pending
  Phase 0 confirmation).

## Phase 3 — Orchestration & coaching (the learning experiment; points 8, 11, 12)

Lower stakes, added once the base stands. The captain's goal here is to become a
poweruser, not to solve a present pain.

### What "orchestrator" actually means here (2026-07-02 discussion)

Before building anything, we worked out what an orchestrator's job actually
is, distinct from a worker's — this is the frame every Fas 3 feature below
should map back to:

1. **Decomposition + routing** — break a goal into scoped units, decide who/
   what does which piece, sequential vs parallel.
2. **Context management** — each worker gets exactly what it needs; the
   orchestrator holds the big picture so workers don't have to.
3. **Resource selection** — right model/effort per sub-task, continuously
   re-graded (the model-fit judge + Suggestion-accuracy report already do
   this for single runs; Fas 3 extends it to whole-session/whole-goal
   decisions).
4. **Progress + recovery** — what's in flight, what's stuck, what failed, and
   whether to retry/escalate/abandon.
5. **Quality control** — output gets checked by something other than the
   thing that produced it (the adversarial-review pattern used all through
   tonight's fix-the-review-findings arc is the template — Fas 3 should make
   this an on-demand Maestro action, not just something I do ad hoc in chat).
6. **Continuity across boundaries** — Fas 2's summarize-and-carry-over already
   covers session-to-session; Fas 3 extends this to goal-to-goal (a whole
   piece of work spanning several sessions/days).
7. **Human gating scaled to blast radius** — the archive-suggestion pattern
   (propose via a UI affordance, a click is the approval) is the template for
   every other "the orchestrator noticed something, you decide" surface Fas 3
   adds — never fully autonomous for anything that mutates state a human
   would want to review.

The distinguishing trait vs. a worker: the orchestrator holds the
**continuous thread** of the overall goal and can explain *why*, not just
*what*; workers are ephemeral and scoped. And orchestration overhead has to
be weighed against task size — not every sub-task deserves a full
delegation; scale involvement to the work (this session itself did this:
diagnosis was Opus-shaped, the localized fixes were Sonnet-shaped).

### Concrete features (mapped to the 3 vision points)

- **Point 11 — Run several sessions in parallel, watch live, approve tool
  prompts centrally.** Builds directly on the Background Tasks panel
  (subagent visibility, already shipped) and the mid-turn-interjection spike
  (confirmed working, architecture not yet built — see DECISIONS.md
  2026-07-02). A "control room" view: several sessions' live status in one
  place, a single place to answer a permission prompt regardless of which
  session raised it.
- **Point 8 — Split work + prioritize focus.** A goal-to-tasks breakdown
  view, backed by Jot (which already tracks tasks) rather than a second
  parallel task system. Session-level "needs attention" scoring already
  exists (`attentionScore`); this extends it to "which of my several active
  goals should I actually be looking at right now."
- **Point 12 — Coach: notice context-switching, suggest better patterns.**
  This is where the "En liten orkestrator helper kanske?" Jot idea (a
  cheap-model background process on a timer/hook, inspecting every session's
  phase, inferring next-step-or-done, cross-checking Jot) becomes the
  concrete mechanism — it's the sensor Fas 3's coaching needs. Output is a
  proposal (per the human-gating principle above), e.g. "6 of your 10 open
  sessions haven't moved in 3+ days — archive candidates?" or "you've
  touched 4 different projects in the last hour — intentional, or drifting?"
  Never auto-acts; surfaces and lets the captain decide.
- **Multi-model** — bring in Gemini when it fits (Jot task "Gemini vid
  behov?"), gated on the existing Antigravity-backend scaffolding
  ([[project-gemini-artist-mode]]) rather than a fresh integration.

### Skills investigation (the captain's ask: do we need new skills for this, not just app features?)

Some of Fas 3's job is better solved as a **skill** (runs inside a normal
Claude Code session, reusable outside Maestro too) than as Maestro app code.
Candidates to properly scope when Fas 3 starts, not built yet:

- **`/triage`** — already identified as a real gap in an earlier usage-
  analysis pass (before tonight): list idle sessions + stale Jot items,
  propose an archive/close batch. This is the most concrete, most-requested
  candidate — directly serves the "orchestrator helper" idea above and could
  ship well before the rest of Fas 3's app-level UI.
- **`/review`** (or similar) — formalize tonight's manual pattern (implement
  → independent adversarial review agent → real fixes → re-verify) into an
  invokable skill, so "review this session's recent changes" doesn't require
  hand-building a review prompt each time.
- **A handoff skill** — lift Fas 2's summarize-and-carry-over out of
  Maestro-only UI into something a session can trigger on itself (e.g. when
  it notices its own context getting long), not just something the captain
  triggers from the sidebar.
- **A coach/report skill** — pattern after the existing `health-coach` skill
  (evidence-based, push back, no fluff) but for work patterns: reads recent
  Jot + session activity, gives a structured "here's how you're working,
  here's what's worth reconsidering" — the human-facing half of the
  orchestrator-helper's sensing.
- **`kickoff` may need to evolve, not stay separate.** It currently hands off
  via `spawn_task` (forces a git worktree) specifically because no better
  rooting mechanism existed. Once Maestro is the captain's primary way of starting
  sessions, `kickoff` routing through Maestro (root on main, no worktree,
  same brief/model/effort logic) removes its main caveat — worth revisiting
  whether it becomes a Maestro action instead of a standalone skill, or stays
  a skill that CALLS Maestro.

None of the above is committed to build yet — this is the scoping the captain
asked for when Fas 3 actually starts, not a build queue.

## Open risks / to confirm

- Subscription auth inheritance in a spawned subprocess (Phase 0).
- Billing-policy risk: the SDK/wrapper subscription-billing split was announced
  then paused (2026-06-15) — could return and meter heavy/parallel use.
- Token/quota data source for point 13 is unproven.
- Resuming desktop-app sessions is likely but unconfirmed.

## Principles

- Wrap the real CLI (Approach B) — never re-implement Claude; never strip
  features.
- Reuse Session Radar's read layer; don't duplicate the file-parsing.
- Thin wrapper by default — added "smart" layers cost extra tokens, so they are
  deliberate choices, not defaults.
- Private project; personal git remote only when asked.
