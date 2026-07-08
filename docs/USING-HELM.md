# Using Helm - a guided walkthrough

This is both the agenda for our live walkthrough and a reference to keep.
It is written for how Aidin actually works today, not for a generic user.

## How this walkthrough works

You do not learn a tool like this from a feature tour.
You learn it by running one real piece of your own work through it, once, with the "why" narrated at each step.
So the plan is: we take a real task from your Jot board tomorrow and drive it through the full loop together - dispatch, oversee, review - and I tie each move back to how you and I already work in plain Claude Code.
No slides, no toy task.
By the end you will have shipped one real thing through Helm and know which surface to reach for next time without thinking about it.

## The one mental shift

Plain Claude Code is a chat you drive turn by turn.
Helm is a workspace you oversee.

The front door is the Dashboard - live state, "what needs you right now" - not a prompt box.
You are not meant to sit inside one long conversation.
You are meant to spin up a focused session or an autonomous run, step away, and come back when it needs you.

This is the ephemeral-sessions philosophy you already committed to (PLAN.md, 2026-07-03): one session per feature/task, not one per project, and definitely not one megasession that lives for months.
Durable knowledge lives in files (CLAUDE.md, DECISIONS.md, memory, your Jot board), not in keeping a conversation alive.
That is why throwing a session away is safe - nothing important lived only in it.

## The daily loop

This is the rhythm to internalize.

1. Open Helm. You land on the Dashboard.
2. Read "Needs you & in motion" - the single prioritized queue. Waiting sessions and archive proposals (things that need a click) sort above active runs (just visibility).
3. Act on what needs you - answer a waiting session, approve/dismiss a proposal.
4. Dispatch new work - a fresh session, a project-rooted session, an orchestrator session, or an Autopilot goal (decision guide below).
5. Step away. You do not babysit. When something needs you or errors while you are away, Helm fires an OS notification and a taskbar badge (toggle in Settings: "Notify when something needs you").
6. Come back, review the result - read the diff, read Autopilot's captured contract + verify evidence, decide.
7. Finish and discard the session. The knowledge is already in files and Jot.

## Decision guide: which surface for which work

The nav is deliberately lean - Dashboard is the only primary tab; Chat and Plan are quieter secondary detours.
Here is when to reach for each.

- **A fresh Chat session** - hands-on work where you want to drive turn by turn, or intervene in something specific. This is closest to plain Claude Code. Reach for it when you genuinely want to be in the loop every turn.
- **A project-rooted session** - the same, but started already pointed at a repo (via the project entities in the command palette, or the launcher). Use it when the work clearly belongs to one codebase and you want its CLAUDE.md/skills in context from turn one.
- **An orchestrator session** - a session rooted in the Claude meta-home, above any one project, with your global rules and memory in context. It coordinates and dispatches rather than doing hands-on code work in its own cwd. Reach for it when you are not sure what to do next and want a survey + a plan of what to dispatch. This is the "tell me what needs attention" entry point.
- **An Autopilot goal** - autonomous, multi-iteration work in an isolated git worktree, committing per iteration, gated by a verify command, escalating to you instead of thrashing. Reach for it when the task is well-defined, verifiable, and you would rather review a finished result than drive it. This is the one that most changes how you work - it is delegation with a safety rail, not a chat.

Rule of thumb: if you want to watch every turn, use Chat. If you want to review a finished result, use Autopilot. If you do not yet know what the work even is, start with an orchestrator session.

## The keyboard + attention layer (the power-user parts)

- **Command palette - Cmd/Ctrl+K.** One keystroke reaches everything: every page, the core actions (new chat, new orchestrator session, toggle split, background tasks), every open session (jump to it), and every project you have touched (start fresh there). Fuzzy - type "dash", "auto", part of a session title. This is meant to replace clicking around. Learn this first; it makes the lean nav a feature, not a limitation.
- **Attention notifications.** You are supposed to step away. The OS notification + taskbar badge is what makes that safe - you are pulled back exactly when a run errors, escalates, or a session starts waiting on you. If it is too noisy or too quiet, the Settings toggle is the dial.
- **Autopilot evidence.** A green iteration is not a bare "trust me". Expand it to see the exact contract (the prompt the iteration was given, copyable) and the verify evidence (the command that ran and its captured output behind the pass/fail badge). Each run also states plainly that iterations run in fresh context, continuity via notes.md - so you know what the delegate did and did not carry.

## Why ephemeral sessions are safe (the thing that makes the loop work)

The instinct to keep one big session alive comes from fear of losing context.
Helm removes that fear by making the durable layer explicit.

- Rules and how-you-work live in CLAUDE.md (global + per project).
- Decisions and their rationale live in DECISIONS.md.
- Cross-session facts live in memory.
- Work and priorities live in your Jot board, which Helm reads.

So a fresh session is cheap to start and already well-fed, and a finished session is safe to discard.
The unit you organize is work/goals (in Jot), not sessions.
That is why session-list curation matters less over time, not more.

## Tomorrow's live agenda

Roughly 30-40 minutes, on real work.

1. Orientation on the Dashboard - read the queue together, I explain each row kind (2 min).
2. Cmd/Ctrl+K tour - we navigate the whole app from the keyboard, no clicking (3 min).
3. Pick one real, well-defined task from your Helm or another Jot category (2 min).
4. Run it through Autopilot - set the goal + verify command, launch, and I narrate what it is doing in the worktree while it runs (10 min).
5. While it runs, we start a second, hands-on piece in a Chat session - so you feel the difference between overseeing and driving (5 min).
6. Review Autopilot's result - read the diff, the contract, the verify evidence, decide accept or not (5 min).
7. Debrief - which surface felt right for which, what was awkward, what to change. That awkwardness is the real backlog. (5 min)

## Where it is still rough (so you are not surprised)

Being honest, not selling.

- The fleet is split: Autopilot runs live on the Autopilot page, hands-on sessions in the Dashboard queue. There is no single "everything that is running" view yet.
- No cost/token visibility on the fleet view yet - you cannot see spend per run at a glance.
- The palette omits Jot goals and domains as entities (they are async; kept out to keep it instant). If you miss them, that is the first thing to add.
- Multi-worker fan-out under one Autopilot run and a timeline scrubber are noted but not built.

The plan after tomorrow is: use it as your daily driver for a week or two, and let the real friction - not my guesses - drive the next round.
Two follow-on ideas are already parked for exactly that point: local usage-analytics (what you actually use and which paths you take) and a read-only MCP so I can follow your real flow and coach it.
Both are best built after there is a real flow to analyze, not before.
