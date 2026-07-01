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
- **Run several sessions in parallel**, watch live, approve tool prompts
  centrally (11).
- **Split work + prioritize focus** — help break a goal into tasks and sequence
  them (8).
- **Coach**: notice excessive context-switching, suggest better patterns, slow
  the captain down when he's spreading too thin (12).
- **Multi-model** — bring in Gemini when it fits (Jot task "Gemini vid behov?").

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
