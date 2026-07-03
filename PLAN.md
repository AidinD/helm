# Maestro — Build Plan

A personal wrapper around the real Claude Code CLI that adds overview, rooting,
context flow, and (later) orchestration — without removing any Claude feature.
Built by wrapping the real `claude` binary headlessly (stream-json), so all
skills, CLAUDE.md, settings, permissions, and MCP are preserved.

## Aidin's vision (14 points) → where each lands

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

## Strategic reorientation (2026-07-03): ephemeral sessions, not a durable fleet

Aidin's realization: he's been working in long-lived sessions, roughly one
per PROJECT, when the actual unit should be one per FEATURE/task (or
smaller) — a session should carry only the context relevant to what's
happening now, not months of unrelated history. This isn't just a cost
optimization; it's a quality one. A session stuffed with unrelated history
dilutes signal (the model wades through noise to find what matters) — the
same instinct behind Kun Chen's "fresh context per step" (Phase 4). Durable
continuity should live in FILES (CLAUDE.md, DECISIONS.md, memory), not in
keeping one session alive indefinitely — externalize, don't hoard.

This reframes several things already built or planned tonight:

- **Auto-compact is a partial anti-pattern.** The CLI's own built-in
  auto-compact-at-the-limit stays essential (a safety net for a genuinely
  long single task). But Fas 3's PROACTIVE auto-compact of idle sessions
  props up the exact pattern this reorientation moves away from — it keeps
  a megasession alive-and-lean instead of prompting Aidin to actually wrap
  up and start fresh. The context gauge (built the same night) is the
  pro-pattern tool: it nudges toward ending a session; auto-compact is a
  crutch for avoiding that. Not ripped out (it's shipped, opt-in, genuinely
  useful for the "one legitimately long task" case) — just de-prioritized
  as a strategy, and not something to lean on further.
- **Session-list curation (drag-sort, categories, deadline-sort) is also
  partly an anti-pattern.** Careful manual organization of many sessions
  assumes sessions are durable objects worth tending — the opposite of
  "spin up, finish, discard." The unit worth organizing isn't sessions, it's
  WORK/GOALS — which already live in Jot. Lists aren't being removed (they
  still serve however many durable sessions remain during the transition);
  their importance should fade naturally as ephemeral sessions become the
  norm, not be surgically cut now.
- **Re-ranks Fas 3/4 priority toward "on-ramp" tooling** — whatever makes a
  FRESH session cheap to start and cheap to feed context into matters more,
  right now, than features that make megasessions more pleasant to live in.
  This already-planned work moves up: kickoff/rooting (Phase 1, done), the
  CLAUDE.md/skills consolidation (done 2026-07-03 — see the import-stub
  fix), Fas 2's handoff/summarize-and-carry-over, DECISIONS.md + memory as
  context carriers (already the established discipline), and from Phase 4:
  treehouse (instant pre-warmed worktree), the `/triage` skill, and the
  handoff skill. The live-status surfaces (Background Tasks panel, the
  needs-attention spotlight) remain valid regardless — that's "what's in
  motion right now," not curation of a durable list.
- **Same fork as the firstmate strategic question (Phase 4).** Firstmate has
  no session list to curate at all — a crew you supervise plus disposable
  worktrees, oriented around dispatch and goals, not session management.
  Both threads point the same direction.

Not a rip-and-replace — a gradual shift in what gets built next and what
Aidin actually reaches for day to day, tracked here so future scoping
weighs it.

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
  archiving (Aidin's key insight).
- In-app **archive** controls; likely **resume** existing sessions (pending
  Phase 0 confirmation).

## Phase 3 — Orchestration & coaching (the learning experiment; points 8, 11, 12)

Lower stakes, added once the base stands. Aidin's goal here is to become a
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
  prompts centrally.** Builds on the Background Tasks panel (subagent
  visibility, already shipped). NOTE: a 2026-07-03 spike found headless `-p`
  mode has no pause-and-ask primitive at all — a permission decision is
  either allowed or denied synchronously by flags, never a live round-trip,
  and a persistent process doesn't change that (see DECISIONS.md
  2026-07-03). So "approve tool prompts centrally" can't mean answering a
  live blocking prompt the way Claude Desktop does — it has to mean
  something else (e.g. pre-setting permission modes/allowed-tools per
  session before launch, or reviewing what already ran). Needs rethinking
  before this point is built, not just architecture.
- **Point 8 — Split work + prioritize focus.** A goal-to-tasks breakdown
  view, backed by Jot (which already tracks tasks) rather than a second
  parallel task system. Session-level "needs attention" scoring already
  exists (`attentionScore`); this extends it to "which of my several active
  goals should I actually be looking at right now."
- **Point 12 — Coach: notice context-switching, suggest better patterns.**
  This is where the "En liten orkestrator helper kanske?" Jot idea becomes
  the concrete mechanism — it's the sensor Fas 3's coaching needs. Settled
  the architecture in a 2026-07-02 discussion, deliberately NOT what Aidin
  first proposed (a persistent "helper session" hooked into every other
  session) — pushed back toward something cheaper and simpler:
  - **A periodic batch classifier, not a session.** Each check is stateless
    ("given this session's recent messages + its Jot task, what's its
    status?") — no conversational continuity needed. Reuses the model-fit
    judge's already-proven, already-cost-optimized recipe (`--allowed-tools
    ""` + empty `--strict-mcp-config`, ~$0.015/call), just applied per
    session on a timer instead of per completed prompt.
  - **No Claude Code hooks needed.** Maestro's main process already has
    direct file-system visibility into every session's transcript (the same
    access `sessions.js`'s status derivation already uses) — this extends
    the existing `refresh()` poll loop, it doesn't need a new triggering
    mechanism.
  - **Output is a status tag per session** (e.g. `waiting_for_input` /
    `stuck` / `done_not_archived` / `blocked_external`), which feeds INTO
    the existing `attentionScore` sorting and sharpens the archive-suggestion
    pill (today it's a blunt "idle + no open Jot work" proxy for "actually
    done" — this replaces the proxy with something that's actually read the
    content).
  - **Urgency is the weak link.** No deadline data exists today outside Jot
    task priority, so urgency-inference is only as good as that data —
    ties directly to the open Jot item "använda jot deadline för smartare
    sortering," worth building together rather than separately.
  - Output is always a proposal (per the human-gating principle above), e.g.
    "6 of your 10 open sessions haven't moved in 3+ days — archive
    candidates?" or "you've touched 4 different projects in the last hour —
    intentional, or drifting?" Never auto-acts; surfaces and lets Aidin
    decide.
  - **Aidin wants a visualizer for how this helper is working** — not
    specified yet (neither the mechanism nor the look), genuinely open.
    Worth drawing out in its own discussion once the classifier itself
    exists and there's real behavior to visualize, rather than designing a
    UI for data that doesn't exist yet. Candidate angles to raise then: a
    live per-session "what did the helper conclude and why" trace (so its
    judgment is auditable, not a black box), a timeline of status changes
    per session, or just a debug view during early development before
    deciding it's worth a permanent UI surface at all.
  - **Two more periodic checks folded in here rather than getting their own
    mechanism** (2026-07-02 decision — avoid a third separate loop when this
    one already sweeps every session): auto-`/compact` when a session is
    active but idle and has used more than X context (feasibility not yet
    verified — does headless `-p` even support invoking the CLI's built-in
    `/compact` the way it expands skill slash-commands? needs a spike before
    committing to this); and the model/effort suggestion-accuracy review
    (the on-demand "Suggestion accuracy" report on the Analysis page already
    covers checking this manually — this is specifically about making it
    proactive instead of pull-based).
- **Multi-model** — bring in Gemini when it fits (Jot task "Gemini vid
  behov?"), gated on the existing Antigravity-backend scaffolding
  ([[project-gemini-artist-mode]]) rather than a fresh integration.

### Skills investigation (Aidin's ask: do we need new skills for this, not just app features?)

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
  it notices its own context getting long), not just something Aidin
  triggers from the sidebar.
- **A coach/report skill** — pattern after the existing `health-coach` skill
  (evidence-based, push back, no fluff) but for work patterns: reads recent
  Jot + session activity, gives a structured "here's how you're working,
  here's what's worth reconsidering" — the human-facing half of the
  orchestrator-helper's sensing.
- **`kickoff` may need to evolve, not stay separate.** It currently hands off
  via `spawn_task` (forces a git worktree) specifically because no better
  rooting mechanism existed. Once Maestro is Aidin's primary way of starting
  sessions, `kickoff` routing through Maestro (root on main, no worktree,
  same brief/model/effort logic) removes its main caveat — worth revisiting
  whether it becomes a Maestro action instead of a standalone skill, or stays
  a skill that CALLS Maestro.

None of the above is committed to build yet — this is the scoping Aidin
asked for when Fas 3 actually starts, not a build queue.

## Phase 4 — Ideas from Kun Chen's agentic workflow (candidate pool, 2026-07-03)

Source: Kun Chen's (ex-Meta L8) "Agentic Engineering Workflow" video +
his open-source tools (github.com/kunchenguid). Aidin flagged 8 items to
work into Maestro. NONE committed yet — this is the analyzed candidate pool.
They sort into three kinds: (A) validates/extends existing Maestro direction,
(B) concrete new features Maestro lacks, (C) principles to apply, not build.

**The one strategic question that gates the rest: what is Maestro's
relationship to `firstmate`?** Firstmate ("Talk to one agent. Ship with a
crew.") is a CLI/tmux tool that does *substantially what Maestro's Fas 3
Point 11 wants to become* — a lead agent that dispatches a crew of
sub-agents, each in an isolated git worktree, with event-driven zero-token
supervision (sleeps until something needs attention, then wakes the lead),
ship-vs-scout task typing, escalate-only-real-decisions, `/afk` away-mode,
restart-proof on-disk state. Notably it went the *persistent-orchestrator-
agent* route Aidin originally proposed for the helper — the opposite of the
stateless batch-classifier Maestro chose (see 2026-07-02). Those aren't in
conflict: firstmate is about DISPATCHING work; Maestro's classifier is about
SENSING status — a Maestro-with-firstmate-inside is coherent. The real fork
is: does Maestro (a) take inspiration and build its own GUI-native dispatch,
(b) wrap/embed firstmate as its dispatch engine while Maestro owns the GUI +
sensing/coaching, or (c) treat firstmate as a separate tool and NOT
reinvent it? This is a decision for Aidin, not something to presume.

**2026-07-03 — source-level findings (both repos actually cloned and read
line-by-line, not just READMEs or a skim — see DECISIONS.md for the full
incident notes and per-repo file citations):**
- **Firstmate only runs on macOS/Linux** (hard `tmux` + POSIX `stat`/`ps`
  dependency throughout, no Windows path) — a hard blocker on Aidin's actual
  machine, not a "worse fit." It also isn't a CLI or program in any
  importable sense: there's no `package.json`, no binary, no process
  boundary. It's a 938-line prompt file (`AGENTS.md`, symlinked as
  `CLAUDE.md`) plus ~46 bash helper scripts, meant to be *interpreted* by an
  already-agentic terminal CLI (Claude Code, Codex, opencode...) that's
  given shell access — the README says so explicitly ("This is not... a
  CLI"). It also has a hard, unvendored dependency on a whole sibling-tool
  ecosystem (treehouse, no-mistakes, tasks-axi, gh-axi, chrome-devtools-axi,
  lavish-axi), each separately `npm install -g`'d.
- Firstmate's "zero-token supervision" is real but narrower than the
  README's framing: `bin/fm-watch.sh` is a plain bash polling loop
  (`sleep 15`, forever) that pattern-matches pane/process state and only
  costs an LLM turn when something is genuinely actionable — zero *token*
  cost while idle, but a real always-on background OS process, and it
  depends on the host CLI supporting a background-task/wake primitive.
  "Escalate only real decisions" is mostly **pure prompt engineering, not
  code** — `AGENTS.md` repeats "anything destructive, irreversible, or
  security-sensitive escalates" three times in prose; the only actual code
  gate is a refusal in `fm-pr-merge.sh`/`fm-teardown.sh` against specific
  destructive git ops. Its own lead-agent conversation has NO
  compaction/reset logic of its own either — it leans entirely on the host
  CLI's native auto-compaction plus an advisory (not enforced) `/stow`
  ritual that sweeps durable knowledge to disk before an anticipated reset.
- gnhf's "fresh context per step" is real for its CLI-subprocess agent
  family (Claude, Codex, Copilot, Rovodev, Pi) — confirmed: each iteration
  is a brand-new `claude -p --output-format stream-json` subprocess (the
  SAME mechanism Maestro's own `launcher.js` already uses), with only a
  `notes.md` file carried forward. **Exception: its ACP agent family (e.g.
  Gemini) explicitly keeps a persistent session across iterations** —
  contradicts the tool's own headline claim for that one agent type.
- gnhf has **zero exported library API** (no `main`/`exports`/`.d.ts` in
  `package.json`) despite an internally clean, decoupled `Orchestrator`
  EventEmitter class — "embed" in practice means vendoring the relevant
  `src/core/*.ts` files into Maestro's own codebase (unversioned, no
  upstream contract), not adding a dependency. Its worktree support is also
  thinner than assumed: worktrees are opt-in (default mode runs on a branch
  in the main repo), one worktree per run with no pooling, and **no
  dependency-install or `.env`-sync into a fresh worktree at all** — a new
  worktree only has tracked files, so the first iteration has to notice and
  fix missing `node_modules`/secrets itself. Failure detection is agent
  self-report (`success: false`) + process exit code only, no independent
  build/test verification gate. The repo's own git history stops at
  2026-06-09 (single author, ~1 month stale relative to today) — a frozen
  snapshot to adapt from, not a live dependency to track.
- Worktrees: firstmate itself delegates this entirely to the sibling tool
  `treehouse` — independently confirms treehouse is the right prerequisite
  regardless of how the rest of this question resolves.

**DECIDED (2026-07-03, Aidin confirmed):** firstmate → pattern only (option
a) — there was never really a wrap/embed option on the table given the OS
incompatibility and the total absence of a program boundary; take the
bash-triage-before-LLM-call idea, the wake-classification-regex approach,
and the stow-before-reset ritual, not the code. gnhf → vendor/adapt its
`Orchestrator` source directly into Maestro's own codebase rather than
treat it as a live dependency (no package boundary exists to depend on
cleanly, and the project is stalled anyway) — go in aware of the ACP
persistent-session exception, the worktree/env-install gap, and the weak
agent-self-report-only failure detection. treehouse → build/adopt
regardless, confirmed as its own prerequisite even inside firstmate. "Reuse
the code" for firstmate specifically means reuse it AS REFERENCE (we now
have source-level knowledge of exactly how it solved wake-classification,
escalation, and worktree hand-off, so Maestro's own Windows/Electron-native
version doesn't have to guess) — not literally running or porting its bash.

**Worktree note (resolves a question Aidin raised: does Maestro's own
orchestrator need to be "rooted" in a project to create a worktree for
it?):** No — that constraint only applies to Claude Code's own Agent-tool
worktree-isolation convenience feature (which infers the target repo from
the calling session's own cwd), not to how git worktrees work in general.
Confirmed directly in both repos' source: neither firstmate nor gnhf relies
on their own cwd — `treehouse get` takes an explicit project reference,
and gnhf's `createWorktree` (`git.ts`) takes an explicit repo/path
argument. Maestro's own future orchestrator already knows which project
each session belongs to (`session.cwd` is tracked per session today), so it
can issue `git -C <projectPath> worktree add <worktreePath> -b <branch>`
directly against the right repo regardless of where the orchestrator
process itself runs from — it doesn't need to be rooted anywhere.

### (A) Validates / extends existing Maestro direction
- **firstmate** — the reference architecture for Point 11 (which PLAN
  currently marks "needs rethinking" after the no-live-approval spike).
  Firstmate's answer to that same constraint: don't try to answer a live
  blocking prompt — instead pre-set project modes (`no-mistakes` /
  `direct-PR` / `local-only`, optional `+yolo`) per project before launch,
  and escalate only real decisions via an event watcher. That may be exactly
  the missing piece. Source studied 2026-07-03 (see finding above) — the
  actual implementation is a bash/tmux daemon, not something to embed
  directly, but the escalation design is sound and worth reproducing.

### (B) Concrete new features Maestro lacks
- **treehouse** (worktree pool automation) — "manage worktrees without
  managing worktrees": drop into a ready worktree, deps installed, build
  cache warm, env files synced. Maestro has ZERO worktree support today.
  This is arguably the PREREQUISITE for safe parallel dispatch (can't run N
  agents on one repo without it) — so it likely comes before any
  firstmate/gnhf-style work regardless of the strategic answer.
- **gnhf** ("good night, have fun") — long-running goal orchestrator:
  decomposes a goal into steps, runs each in a FRESH context window,
  auto-rolls-back failures, generates organized commits. Maps to Point 8
  (split work) + the autonomous-stretch capability. Depends on the firstmate
  decision + worktrees.
- **no-mistakes** — automated review+git pipeline in fresh context: commit →
  rebase onto main → peer-review agent in a fresh window → forced E2E test
  with photographic evidence → auto-fix obvious, escalate ambiguous → lint/
  docs → push → open PR → babysit CI. This AUTOMATES the exact manual pattern
  we've run all night (implement → adversarial review agent → fix → commit).
  Kun's stat: "68% of changes I pushed through no-mistakes had bugs." Strong
  fit; overlaps with the `/review` skill already scoped in Fas 3 above.
- **Lavish** (lavish-axi) — interactive HTML plans instead of markdown: the
  agent renders a UI mockup in the project's own visual style, you click an
  element and type feedback ON it ("make this a floating overlay") instead
  of describing it in prose. Maestro shows plans as plain text today. Distinct
  planning-phase UX feature.
- **Voice input (OpenSuperWhisper / local Whisper)** — voice as the primary
  prompt-composition method. Standalone, no architecture dependency, fastest
  of everything here to prototype. Best first experiment.

### (C) Principles to apply, not features to build
- **AXI (Agent eXperience Interface)** — design agent-facing tools as
  deliberately as human UIs: token-budget as a first-class constraint,
  compact output, composable, chainable, higher accuracy + lower cost than
  MCP or plain CLI. A LENS, not a build item — relevant if/when Maestro ever
  exposes its own tools to agents (and worth remembering the cheap-utility-
  call recipe already used by the judge/classifier is the same instinct).
- **CLAUDE.md trim → skills** — keep CLAUDE.md lean; move situational/rarely-
  needed instructions into skills (loaded on demand, shareable across
  agents). Actionable as a one-off housekeeping audit of Aidin's global +
  project CLAUDE.md files, NOT a Maestro feature.

**Rough sequencing (pending Aidin's questions + the firstmate decision):**
1. Voice input (independent, quick, high daily value).
2. CLAUDE.md-trim audit (independent, cheap, improves everything else).
3. Answer the firstmate strategic question (gates 4-6).
4. Worktree automation (treehouse-style) — prerequisite for parallelism.
5. no-mistakes-style review automation (builds on tonight's proven manual
   pattern; overlaps the `/review` skill).
6. gnhf-style long-running orchestration (needs 3 + 4).
7. Lavish-style interactive plans (independent but larger UX lift; later).

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
