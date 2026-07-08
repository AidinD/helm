# Helm — Build Plan

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

## Superseded framing → see the tiered orchestration model (2026-07-06)

The reorientation below (2026-07-03) was refined into the tiered
captain / first mate / second mate / crew model — ephemeral applies *by tier*
(crew + second mates), while a thin, file-backed, cross-project **first mate**
is the deliberate durable exception. Read `docs/orchestration-model.md` for the
current model and DECISIONS.md (2026-07-06) for why. The text below is kept for
history; where it reads as "pure ephemeral", substitute "ephemeral by tier".

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

**2026-07-08 refinement - renewal = faithful transfer, and it is only as safe
as the transfer is faithful.** A concrete case forced this nuance. A fresh
spawned session diagnosed a bug well but proposed the naive fix; a context-rich
long session proposed a materially better one, because it carried gotchas the
fresh one lacked (the %APPDATA% MSIX sandbox-overlay trap, that config.json is
on D:\, an archive follow-on bug). The lesson is NOT "keep megasessions" - it is
that "durable continuity lives in files" only pays off if the files actually
carry what the fresh session needs. Here they did not: (1) DECISIONS/PLAN are
NOT auto-loaded (only the repo-root CLAUDE.md is), so a fresh session never read
them; (2) the load-bearing traps were not even in DECISIONS - they lived in the
orchestrator's personal memory + the code; (3) auto-memory recall is
relevance-matched, not guaranteed for a project-scoped worker. So the strategy:

- **Trigger renewal on saturation OR (drained AND topic-shift)**, not context-%
  alone. A drained-but-not-saturated session mid-topic is not force-renewed.
- **The transfer bar for judgment-heavy work:** before renewing, the outgoing
  session emits a handoff capturing the durable decisions + WHY, the traps
  learned this session, and the live task state - to the bar "would this let a
  fresh session reach the GOOD answer, not just a working one?"
- **Scale by work type:** mechanical work renews freely/ephemeral; judgment-heavy
  work (design, architecture, adversarial review) stays in a context-rich session
  longer and renews only at genuine topic boundaries, after a faithful handoff.
- **Load-bearing gotchas belong in the ALWAYS-loaded surface** (repo-root
  CLAUDE.md), not buried in DECISIONS or personal memory.
- **"Summarize & carry over" must inject the durable stores** (DECISIONS/CLAUDE.md/
  PLAN/relevant memory) into the fresh session's system context, not just
  summarize the transcript - a transcript summary would have missed the traps too.
- When Helm drives Helm, this transfer (context injection at spawn) is
  load-bearing infrastructure, not a nicety.
- **Producer side (2026-07-08 extension):** the second mate documents the
  durable layer ON THE GO - decision+WHY when it lands, gotcha when learned, a
  short running state-of-play - not at renewal time. It is the only thing that
  survives an ABRUPT handoff (crash / sudden context-limit / quota cut, where no
  end-of-session summary runs), and keeps the stores faithful so carry-over has
  something faithful to inject. Capture the RIGHT layer (decisions/traps/state),
  not the step-by-step (git + transcript hold that); keep it a one-click
  affordance so it doesn't fight "stay thin".

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

## Target UI (the 2026-07-04 mock) + practitioner research

**Target UI vision:** the interactive mock at
https://claude.ai/code/artifact/9bded7e6-64b8-409b-9b01-e6b896e34676 is the
shape Helm is being rebuilt toward — lands on a dashboard (not a
privileged orchestrator session), organized around GOALS not a durable
session list, with "In motion" (ephemeral running work), "Orchestrator
proposes" (human-gated cards), and "New session" (fresh context loaded from
files). Aidin confirmed it gave him a much clearer picture and wants
mock-first used more often (now a global CLAUDE.md rule). The rebuild toward
this is a GATED epic in Jot ("bygg om Helm..."), gated on the practitioner
research below, which is now done.

**Practitioner research (2026-07-04):** surveyed 8 agentic-engineering
practitioners + Anthropic's orchestrator-worker doc (full findings + sources
in DECISIONS.md). Headline: Helm's primitives (ephemeral sessions,
files-as-memory, orchestrator dispatching workers into isolated worktrees,
token-efficiency) are the consensus these practitioners independently
converged on — the direction is validated; the value is in their specific
mechanisms.

Adopt (candidates, tracked as a Jot epic — not yet built):
- **RPI phasing (Dex Horthy):** make each per-feature session a
  Research -> Plan(artifact) -> Worktree -> Implement pipeline; the plan
  artifact is itself durable file-memory.
- **~40% context-fill "dumb zone" budget (Horthy):** model recall degrades
  in the middle of a large window; keep each worker under ~40% fill — turns
  "token-efficiency first" into a surfaceable per-worker KPI.
- **Files-as-memory triad, Ralph-style (Geoffrey Huntley):** fix_plan.md +
  AGENT.md/CLAUDE.md + specs/ + git-as-narrative, re-read fresh each session;
  plus his "serialize the validation step to one worker" orchestration rule.
- **Verification gate before "done" (Simon Willison + Aidin's own rule):** a
  worker's worktree isn't done until a green test/verification signal exists.
- **Repo-map context priming (Paul Gauthier/aider):** prime workers with
  tree-sitter signatures, not raw file dumps — token-efficient whole-repo
  awareness inside a small worktree context.
- Reference architecture: **Anthropic's orchestrator-worker** — orchestrator
  owns all next-step decisions, workers are isolated and never talk.

Avoid / boundary conditions:
- **Yegge's AI-supervisor "fleets"** — defer; an agent-of-agents layer fights
  files-as-memory + solo human-in-control. Stay at the "cluster" stage.
- **Full autonomy for cared-about code (Ronacher/Karpathy):** make the
  human-review checkpoint a first-class, easy-to-invoke state automation
  can't quietly bypass.
- **Huntley's re-read-the-whole-spec-every-loop** trades tokens for
  reliability — fine for cheap models; for expensive ones use repo-map +
  the <40% budget instead of re-stuffing. Cost it, don't cargo-cult it.
- **Anthropic's ~15x token multiplier for multi-agent fan-out** — constrain
  fan-out width in the orchestrator from day one (echoes the logged
  agent-fan-out-runaway lesson).

## Phase 0 — Spike (de-risk before any UI)

Prove the foundation with a throwaway script, no Electron yet:
- Start a `claude` session rooted in a real repo folder **on main, no worktree**.
- Set model + effort (thinking budget) per run.
- Stream output live (stream-json) and parse events.
- Run on the **subscription** — confirm zero-config auth inheritance in a
  spawned subprocess (the one unconfirmed cost item), else wire
  `claude setup-token`.
- Test **resuming an existing session** by id (its transcript is in
  `~/.claude/projects`) — confirms whether Helm can pick up desktop-app
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

### Orchestrator-lifespan redesign (2026-07-03): no privileged "the orchestrator" session

The original UI made two choices — **app opens directly onto "the
orchestrator"**, and **any session can be assigned to be "the
orchestrator"** — both made before the ephemeral-sessions philosophy landed.
They treat the orchestrator as ONE durable session-identity: a specific,
recurring conversation you accumulate history in. That's the exact
megasession anti-pattern the strategic reorientation moves away from, just
applied to the orchestrator instead of to a project. It also contradicts an
architecture decision already made: the classifier is deliberately STATELESS
(2026-07-02 — a periodic batch check, not a persistent helper session). The
UI simply hadn't caught up to that.

This very session is the proof: it acted as an orchestrator in practice
(dispatching, reviewing, deciding) and became precisely the long,
everything-accumulating session we wanted to avoid. Orchestrator-work-in-a-
chat isn't the wrong idea — doing it in the SAME session every time is.

**Redesign:**
1. **Remove "assign a session to the orchestrator."** There is no privileged
   session that *is* the orchestrator. The orchestrator's real work (the
   sensor/sweep, and eventually dispatch) already runs in Helm's main
   process, headless — not in a chat pane.
2. **App lands on an overview/dashboard, not a specific chat** — which is
   already Phase 1's original vision (session list + status + attention
   spotlight). The orchestrator is a background faculty of the app, not a
   room you enter.
3. **Replace "open the orchestrator" with "start a NEW orchestrator
   session"** — a fresh session each time, pre-loaded with a pointer to
   `orchestrator-instructions.md` plus a quick current-state brief (Jot,
   PLAN.md), never resumed history. This is the SAME handoff mechanism
   already planned for Phase 2 (summarize-and-carry-over), applied to
   orchestrator work specifically: durable knowledge lives in the files it
   reads, not in keeping one orchestrator conversation alive.
4. Consistent with the self-hosting-hazard and worktree notes above: the
   orchestrator is defined by the instructions it loads and the state files
   it reads/writes, not by a long-lived process or conversation.

Not urgent to rip out today (the current default-to-orchestrator still
works), but this is the confirmed direction — new orchestrator UI work
should build toward the dashboard-plus-fresh-session model, not deepen the
privileged-session one.

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
   this an on-demand Helm action, not just something I do ad hoc in chat).
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
  - **No Claude Code hooks needed.** Helm's main process already has
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
    active but idle and has used more than X context — **shipped** (see
    DECISIONS.md 2026-07-03, "Fas 3 auto-compact shipped"); and the
    model/effort suggestion-accuracy review, i.e. making the existing
    on-demand "Suggestion accuracy" report on the Analysis page proactive
    instead of pull-based — **shipped** (see DECISIONS.md 2026-07-03,
    "Model/effort suggestion-accuracy check made proactive"): the sweep now
    periodically re-checks the SAME metric the on-demand report already
    computes (reused, not reinvented) and surfaces a dismissible finding on
    the Analysis page when overriding the suggestion has been judged
    "appropriate" meaningfully more often than following it. Sensing +
    surfacing only — it never changes `suggest.js`'s heuristic itself; doing
    that automatically would be a bigger, separate follow-up.
- **Multi-model** — bring in Gemini when it fits (Jot task "Gemini vid
  behov?"), gated on the existing Antigravity-backend scaffolding
  ([[project-gemini-artist-mode]]) rather than a fresh integration.

### Skills investigation (Aidin's ask: do we need new skills for this, not just app features?)

Some of Fas 3's job is better solved as a **skill** (runs inside a normal
Claude Code session, reusable outside Helm too) than as Helm app code.
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
  Helm-only UI into something a session can trigger on itself (e.g. when
  it notices its own context getting long), not just something Aidin
  triggers from the sidebar.
- **A coach/report skill** — pattern after the existing `health-coach` skill
  (evidence-based, push back, no fluff) but for work patterns: reads recent
  Jot + session activity, gives a structured "here's how you're working,
  here's what's worth reconsidering" — the human-facing half of the
  orchestrator-helper's sensing.
- **`kickoff` may need to evolve, not stay separate.** It currently hands off
  via `spawn_task` (forces a git worktree) specifically because no better
  rooting mechanism existed. Once Helm is Aidin's primary way of starting
  sessions, `kickoff` routing through Helm (root on main, no worktree,
  same brief/model/effort logic) removes its main caveat — worth revisiting
  whether it becomes a Helm action instead of a standalone skill, or stays
  a skill that CALLS Helm.

None of the above is committed to build yet — this is the scoping Aidin
asked for when Fas 3 actually starts, not a build queue.

## Phase 4 — Ideas from Kun Chen's agentic workflow (candidate pool, 2026-07-03)

Source: Kun Chen's (ex-Meta L8) "Agentic Engineering Workflow" video +
his open-source tools (github.com/kunchenguid). Aidin flagged 8 items to
work into Helm. NONE committed yet — this is the analyzed candidate pool.
They sort into three kinds: (A) validates/extends existing Helm direction,
(B) concrete new features Helm lacks, (C) principles to apply, not build.

**The one strategic question that gates the rest: what is Helm's
relationship to `firstmate`?** Firstmate ("Talk to one agent. Ship with a
crew.") is a CLI/tmux tool that does *substantially what Helm's Fas 3
Point 11 wants to become* — a lead agent that dispatches a crew of
sub-agents, each in an isolated git worktree, with event-driven zero-token
supervision (sleeps until something needs attention, then wakes the lead),
ship-vs-scout task typing, escalate-only-real-decisions, `/afk` away-mode,
restart-proof on-disk state. Notably it went the *persistent-orchestrator-
agent* route Aidin originally proposed for the helper — the opposite of the
stateless batch-classifier Helm chose (see 2026-07-02). Those aren't in
conflict: firstmate is about DISPATCHING work; Helm's classifier is about
SENSING status — a Helm-with-firstmate-inside is coherent. The real fork
is: does Helm (a) take inspiration and build its own GUI-native dispatch,
(b) wrap/embed firstmate as its dispatch engine while Helm owns the GUI +
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
  SAME mechanism Helm's own `launcher.js` already uses), with only a
  `notes.md` file carried forward. **Exception: its ACP agent family (e.g.
  Gemini) explicitly keeps a persistent session across iterations** —
  contradicts the tool's own headline claim for that one agent type.
- gnhf has **zero exported library API** (no `main`/`exports`/`.d.ts` in
  `package.json`) despite an internally clean, decoupled `Orchestrator`
  EventEmitter class — "embed" in practice means vendoring the relevant
  `src/core/*.ts` files into Helm's own codebase (unversioned, no
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
`Orchestrator` source directly into Helm's own codebase rather than
treat it as a live dependency (no package boundary exists to depend on
cleanly, and the project is stalled anyway) — go in aware of the ACP
persistent-session exception, the worktree/env-install gap, and the weak
agent-self-report-only failure detection. treehouse → build/adopt
regardless, confirmed as its own prerequisite even inside firstmate. "Reuse
the code" for firstmate specifically means reuse it AS REFERENCE (we now
have source-level knowledge of exactly how it solved wake-classification,
escalation, and worktree hand-off, so Helm's own Windows/Electron-native
version doesn't have to guess) — not literally running or porting its bash.

**Worktree note (resolves a question Aidin raised: does Helm's own
orchestrator need to be "rooted" in a project to create a worktree for
it?):** No — that constraint only applies to Claude Code's own Agent-tool
worktree-isolation convenience feature (which infers the target repo from
the calling session's own cwd), not to how git worktrees work in general.
Confirmed directly in both repos' source: neither firstmate nor gnhf relies
on their own cwd — `treehouse get` takes an explicit project reference,
and gnhf's `createWorktree` (`git.ts`) takes an explicit repo/path
argument. Helm's own future orchestrator already knows which project
each session belongs to (`session.cwd` is tracked per session today), so it
can issue `git -C <projectPath> worktree add <worktreePath> -b <branch>`
directly against the right repo regardless of where the orchestrator
process itself runs from — it doesn't need to be rooted anywhere.

**Self-hosting hazard (Aidin raised this, worth designing around before
dispatch is built, not after): a dispatched worker must not be a child
process of Helm's own Electron main process.** Today every `claude`
session Helm launches IS a direct child of the Electron main process
(the same architecture behind the earlier "quit sweep kills children"
fix). That's fine for tonight's actual dev workflow — agents developing
Helm run as ordinary Claude Code CLI processes, completely independent
of the Helm-app-under-test's own process tree, so restarting that app
under test never touches the process doing the work. But once Helm's
own first-mate-style dispatch exists and gets used to develop Helm
itself, a dispatched worker that restarts Helm (as part of its own
boot-test workflow) would kill its own parent process — and therefore
itself — mid-task. Same self-referential category as the earlier
auto-mode-classifier block on switching this very session's own root
folder. Firstmate avoids this by running crewmates in detached tmux panes,
never as children of its own process — Windows has no tmux equivalent to
copy directly. Recommended near-term fix, consistent with tonight's
file-over-process-state theme: don't make workers un-killable, make them
CHEAP to kill — keep dispatched work units small and git-commit-
checkpointed (gnhf's own iteration model), so an untimely restart only
costs the current small step, resumable from the last commit, not the
whole task. Full process-detachment (a real Windows equivalent of
firstmate's tmux-pane independence) is the fuller fix but meaningfully
more work — worth deferring until a lost iteration actually proves costly
in practice, not building preemptively.

### (A) Validates / extends existing Helm direction
- **firstmate** — the reference architecture for Point 11 (which PLAN
  currently marks "needs rethinking" after the no-live-approval spike).
  Firstmate's answer to that same constraint: don't try to answer a live
  blocking prompt — instead pre-set project modes (`no-mistakes` /
  `direct-PR` / `local-only`, optional `+yolo`) per project before launch,
  and escalate only real decisions via an event watcher. That may be exactly
  the missing piece. Source studied 2026-07-03 (see finding above) — the
  actual implementation is a bash/tmux daemon, not something to embed
  directly, but the escalation design is sound and worth reproducing.

### (B) Concrete new features Helm lacks
- **treehouse** (worktree pool automation) — "manage worktrees without
  managing worktrees": drop into a ready worktree, deps installed, build
  cache warm, env files synced. Helm has ZERO worktree support today.
  This is arguably the PREREQUISITE for safe parallel dispatch (can't run N
  agents on one repo without it) — so it likely comes before any
  firstmate/gnhf-style work regardless of the strategic answer.
- **gnhf** ("good night, have fun") — long-running goal orchestrator:
  decomposes a goal into steps, runs each in a FRESH context window,
  auto-rolls-back failures, generates organized commits. Maps to Point 8
  (split work) + the autonomous-stretch capability. Depended on the firstmate
  decision + worktrees — both now resolved (firstmate → reference only;
  worktrees → `worktree.js`, built 2026-07-03).
  **A v1 backend module now exists** (`src/lib/goalOrchestrator.js`,
  2026-07-04 — see DECISIONS.md): `runGoal({ projectPath, goal,
  maxIterations, ... })` runs fresh `claude -p` subprocess iterations (no
  `--resume`, matching gnhf's actual verified architecture) in an isolated
  worktree, with continuity via a `.helm-goal/notes.md` file the
  orchestrator itself writes/reads (gnhf's real mechanism, not an invention),
  structured JSON output per iteration, one orchestrator-authored commit per
  success, and a `reset --hard`/`clean -fd` rollback per failure — verified
  end-to-end with a real spike against a live `claude` subprocess
  (`spike/test-goal-orchestrator.mjs`), not mocked.
  **A minimal FIRST-PASS UI now exists too** (`goalOrchestrator.js` is no
  longer backend-only — 2026-07-04, see DECISIONS.md): a new "Goal" page
  (`renderGoalPage` in `renderer.js`) with a goal textarea, project-folder
  picker, max-iterations input, Start + Cancel buttons, live per-iteration
  progress, and a final summary card that states the work is in an isolated
  worktree and was NOT pushed/merged. Wired via a `goal:run`/`goal:cancel`
  IPC pair (`main.js`) that forwards `onIteration` over a dedicated
  `goal:event` channel (parallel to `session:event`) and holds the
  `cancelToken`; `preload.cjs` exposes `runGoal`/`cancelGoal`/`onGoalEvent`.
  It is USER-TRIGGERED ONLY (a click) and has no push/merge affordance. This
  UI is explicitly a DRAFT for Aidin to react to, verified by wiring
  inspection + live CDP (not a full autonomous run) — the UX is open, not
  finalized.
  Still NOT the whole of Point 11 — Point 11 remains IN PROGRESS, not done:
  no coach/escalation layer (Point 12's framing — the module has no judgment
  about WHEN to escalate to Aidin, only fixed stop conditions), single
  concurrent run only, no independent build/test verification of an
  iteration's own self-reported success (same documented weak spot as gnhf
  itself), and no dependency-install into the worktree (same gap
  `worktree.js`'s own `createWorktree` already defers).
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
  of describing it in prose. Helm shows plans as plain text today. Distinct
  planning-phase UX feature.
  **A FIRST-PASS v1 loop now exists** (2026-07-04 — see DECISIONS.md): a new
  "Plan" page (`renderLavishPage` in `renderer.js`) renders an HTML mockup
  (pasted or loaded by path) in a sandboxed `data:`-URL iframe with an
  annotation SDK injected. The SDK is LIFTED from lavish-axi's
  `src/artifact-sdk.js` (MIT) — its `selector`/`context`/`snapshot` helpers +
  the shadow-DOM annotation-card overlay + hover/click capture — trimmed into
  `src/lib/lavishSdk.js`, with all of lavish-axi's Express/long-poll/state.json
  transport COLLAPSED away (unnecessary and Windows-incompatible): the SDK posts
  each annotation to `window.parent`, the renderer host collects it, and a pure
  formatter turns `{prompts, dom_snapshot}` into an agent-ready text block that
  "Send to composer" / "Copy feedback" hand off. Improvement over lavish: a
  stable `data-lavish-id` on a mockup element is recorded and preferred as the
  anchor over a recomputed selector. Verified end-to-end via live CDP (show ->
  annotate -> structured feedback -> formatted text) + a standalone unit test.
  Still FIRST-PASS: artifact GENERATION during planning (an agent producing the
  mockup in the project's visual style) is the noted NEXT step; also deferred:
  the deep "start a fresh session with this feedback as prompt" wiring (v1 drops
  it into the composer), Mermaid/text-range/layout-audit parity, and running
  artifact-authored scripts.
- **Voice input (OpenSuperWhisper / local Whisper)** — voice as the primary
  prompt-composition method. Standalone, no architecture dependency, fastest
  of everything here to prototype. Best first experiment.

### (C) Principles to apply, not features to build
- **AXI (Agent eXperience Interface)** — design agent-facing tools as
  deliberately as human UIs: token-budget as a first-class constraint,
  compact output, composable, chainable, higher accuracy + lower cost than
  MCP or plain CLI. A LENS, not a build item — relevant if/when Helm ever
  exposes its own tools to agents (and worth remembering the cheap-utility-
  call recipe already used by the judge/classifier is the same instinct).
- **CLAUDE.md trim → skills** — keep CLAUDE.md lean; move situational/rarely-
  needed instructions into skills (loaded on demand, shareable across
  agents). Actionable as a one-off housekeeping audit of Aidin's global +
  project CLAUDE.md files, NOT a Helm feature.

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
