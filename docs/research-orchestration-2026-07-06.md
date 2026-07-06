# Research: is a tiered agent-orchestration model sensible? (2026-07-06)

Evidence-based web research pass (background agent, Sonnet) on whether a
hierarchical captain -> first mate -> second mate -> crew model is a sound way
to work, and its token economics. Kept as the evidence behind the
DECISIONS.md 2026-07-06 entry. Findings below; citations inline.

## Verdict

Sensible - but only in a **shallow, task-justified** form. The evidence supports
a **2-level** hierarchy (coordinator -> workers) on genuinely independent,
parallelizable work. It is hostile to deep hierarchies (3+ levels) and to
tightly-coupled work on one shared codebase. For this setup (solo dev, N
independent projects, task agents doing real work) the **second mate per project
-> crew** layer is well-supported. The **first mate** (cross-project coordinator)
is the layer to be skeptical of: justify it by actual cross-project work (shared
learnings, sequencing, resource/rate-limit contention), do NOT run it as a
mandatory relay for routine per-project dispatch. Claude Code's own shipped
"Agent Teams" feature converges on almost exactly this shape and explicitly
**disallows nesting past 2 levels** (teammates can't spawn teammates).

## 1. Effectiveness - helps vs hurts

- **Anthropic multi-agent research system** (orchestrator-worker): beat
  single-agent Opus by **90.2%** on breadth-first research. But explicit
  boundary: domains needing shared context or many inter-agent dependencies are
  a bad fit, and "most coding tasks involve fewer truly parallelizable tasks
  than research." Subagents run synchronously; the lead can't steer mid-flight.
  (anthropic.com/engineering/multi-agent-research-system)
- **Cognition** - the key data point for coding. First argued against parallel
  agents (independent subagents make conflicting implicit decisions - the Flappy
  Bird example: mismatched background + bird the coordinator had to reconcile),
  prescribing single-threaded linear agents. Then reversed: patterns that work =
  **keep writes single-threaded even when multiple agents contribute
  intelligence**; a fresh-context review agent catches ~2 bugs/PR (58% severe)
  precisely because it did NOT inherit the coder's (rotted) context; weak->strong
  escalation works only within a bounded capability gap. (cognition.com/blog -
  "dont-build-multi-agents" then "multi-agents-working")
- **Equal-budget finding (2026 paper):** single-agent can *outperform*
  multi-agent under equal token budget - coordination overhead + redundant
  context eat the budget that would otherwise buy reasoning depth. (arXiv;
  magnitude unverified, direction corroborated.)
- **Claude Code Agent Teams docs:** "add coordination overhead and use
  significantly more tokens... work best when teammates operate independently.
  For sequential tasks, same-file edits, or work with many dependencies, a
  single session or subagents are more effective." Sizing: 3-5 workers, "three
  focused teammates often outperform five scattered ones," **no nested teams.**

Strongest counter-arguments: intent degrades across every layer (late-surfacing
failures, "context rot"); coordination tax compounds with DEPTH not just width;
a single agent wins when work doesn't decompose cleanly (most SWE on one repo).

## 2. Token economics (hardest numbers)

- Anthropic exact: multi-agent uses **~15x** the tokens of a single chat turn; a
  single agent **~4x** -> multi-agent is **~3.75x a single agent**. Token usage
  alone explains **~80%** of performance variance on their benchmark: "multi-agent
  systems work mainly because they help spend enough tokens to solve the problem."
- Drivers: each worker re-pays full context (shared instructions paid per tier);
  coordination/synthesis is pure overhead; one blog estimate puts ~60% of billed
  tokens into unseen orchestration (single-source, order-of-magnitude only).
- Rate limits burn ~N× faster with N parallel workers, before coordination cost.

Levers (by evidence strength): **model tiering** (cheap model for
routing/rollup, capable model only where hard reasoning happens - reported
40-60% savings, directional); **thin scoped context per dispatch** (objective +
output format + tool guidance + boundaries, not full history - Anthropic's
prescription); **ephemeral workers**; **pass artifacts/references, not raw
transcripts**; **cap depth at 2, width at 3-5**.

Bottom line: expect ~**4-15x** a single agent, scaling with depth/width, scaling
down with disciplined scoping. Must be justified by task value.

## 3. Fit for a solo, multi-project dev

Better fit than the median case: independent repos with no shared state IS the
breadth-first/parallelizable shape the pattern needs (opposite of the shared-
context/many-dependencies shape it fails on). The catch is the first-mate layer:
coordination tax with zero decomposition benefit *unless* it's doing real
cross-project work - the parallelism already comes from having N second mates
directly. Rule: **invoke the first mate on-demand for genuine cross-project
synthesis; don't route routine single-project work through it.** You stay the
real top-level integrator; the tooling's job is containing each worker's blast
radius (own repo/worktree/context), not replacing your judgment.

## 4. Practical patterns

1. Bounded dispatch brief, not a context dump (objective + output format + tool
   guidance + boundaries). Highest-leverage single practice.
2. Report-back = structured artifact + reference/pointer, not inline transcript.
3. Single-threaded writes per unit of work (a second mate owns writes in its
   project; crew own disjoint files, never concurrent same-file writes).
4. Fresh-context review, deliberately not chained off the builder's context.
5. Model tiering by ROLE (cheap for routing/rollup, capable for code/hard
   reasoning) - not by hierarchy level.
6. Explicit stale/refresh signal for long-lived coordinators; externalize
   durable state to files a fresh session reads on startup (converging pattern:
   compaction trip-wire ~50%, hard limit ~85%; "can't compact further" = start
   fresh, not push through).
7. Cap depth at 2 levels, width at 3-5 per coordinator (Claude Code's own
   defaults; nesting disallowed outright).

## Flagged unverified

Equal-budget paper's exact magnitude; the "5-10x cost / 2x latency" and "~60%
orchestration overhead" figures (single-source blog estimates, directionally
consistent with Anthropic's 15x, not authoritative); no controlled benchmark
isolating hierarchy DEPTH (2 vs 3 vs 4) alone.
