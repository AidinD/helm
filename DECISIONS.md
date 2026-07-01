# Decisions

Working name: **Maestro** — a personal orchestrator harness over Claude Code
sessions. Placeholder name; cheap to rename before there is git history.

## 2026-07-01 — Stop = kill the child process; interject mid-run deferred

**Decision:** "Stop" kills the in-flight `claude -p` child process directly (no
architecture change needed — the existing one-shot-per-send model already
holds a process handle). "Interject extra info while a turn is running" is
NOT implemented yet.

**What was verified:** `--input-format stream-json` gives the CLI a real
persistent multi-turn mode — spiked in `spike/test-stream-input.mjs`: sent a
first user message, waited for its `result`, then sent a second message on the
SAME process and got a second `result`. Confirms `--resume`-per-send isn't the
only option; a pane COULD hold one long-lived process across a whole
conversation instead of respawning per message.

**Why deferred anyway:** the spike only proves a message can be sent *between*
turns, not injected *while* the model is mid-generation/mid-tool-call, which is
what "interject" actually means. Building UI for unverified behavior risks
shipping something that silently does nothing or breaks. Needs a follow-up
spike that sends a second message before the first `result` arrives and checks
whether the CLI queues it, ignores it, or errors.

## 2026-07-01 — Image paste: tested, not supported this way — deferred

**Decision:** Do not implement paste-image-into-prompt yet.

**What was tested:** sent a `stream-json` input message with a Messages-API-
style content block (`{type:"image", source:{type:"base64",...}}`) alongside a
text block asking the model to confirm it saw an image. Response: it did NOT
see the image (`MAESTRO_NO_IMAGE`). So the CLI's stream-json input does not
accept inline base64 image blocks in that shape.

**What's still open:** `claude --help` lists a `--file file_id:relative_path`
flag ("File resources to download at startup") — suggesting attachments go
through an upload-and-reference flow (a `file_id`, likely from an Anthropic
Files API), not a raw paste. Needs research into that flow before building;
not attempted here to avoid guessing at an unverified upload API on autonomous
unattended time. [[project-maestro]]

## 2026-07-01 — Build a custom harness rather than live within the desktop app

**Decision:** Build a dedicated app that programmatically starts, roots,
resumes, and drives Claude Code sessions, with its own overview/orchestration UI.

**Why:** The desktop app has hard limits we kept hitting: it can't choose a
session's working directory (rooting), a session's cwd is immutable after
creation, and the only in-app way to root a spawned session (`spawn_task` with
`cwd`) forces a git worktree — which conflicts with the captain's "work on main"
default. A harness lets *us* control cwd (real dir, on main, no worktree),
model/effort per task, and context injection.

**Alternatives considered:**
- *Headless service + Session Radar as its UI* — fastest to value, reuses the
  web dashboard. Rejected in favor of a polished dedicated app (the captain's call);
  he already ships Electron apps (Loom, Jot).
- *Extend the Halyard/Northwind Studio wrapper* — shares a codebase but mixes a
  personal tool into a work product. Rejected: this is explicitly private.

## 2026-07-01 — Form factor: standalone Electron app

**Decision:** New standalone Electron + (likely React/TS) desktop app, same
pattern as Loom and Jot.

**Why:** the captain wants a dedicated, polished UI and does not want to start
sessions via VS Code / CLI. Standalone keeps the personal tool separate from
work tools.

## 2026-07-01 — Private project, personal git

**Decision:** Lives at `D:\Repo\Tools\maestro`. When a remote is created it goes
on the captain's *personal* GitHub (not the employer). No remote/push until he asks.

## 2026-07-01 — Bootstrap build happens in the current session, on main

**Decision:** The initial build is done directly (not delegated to a spawned
session), in `D:\Repo\Tools\maestro` on `main`.

**Why:** Bootstrap exception to the "orchestrator is overseer, not worker"
principle — you cannot delegate through a harness that does not exist yet, the
only current handoff tool forces a worktree, and this session holds all the
design context. Session Radar was built the same way without issue. Once Maestro
exists, the overseer/worker split becomes the operating default (but not
dogmatically — small direct edits by the orchestrator are fine).

## 2026-07-01 — Reuse Session Radar's read layer

**Decision:** Port/reuse Session Radar's `lib/sessions.js` (session metadata +
transcript-tail status) and `lib/jot.js` (Jot matching + work scoring) as
Maestro's read layer for the overview.

**Why:** Already built and verified; avoids duplicating the undocumented
session-file parsing. Session Radar's overview UI is effectively Maestro's v0
dashboard.

## Open architectural question (pending Agent SDK verification)

**Do we manage our own SDK sessions, mirror/control the desktop app's sessions,
or both?** SDK-created sessions are likely independent from the desktop app's.
Leaning: Maestro fully manages its own SDK sessions (root on main, model/effort,
context injection, streaming) AND surfaces the desktop app's sessions read-only
in the overview so nothing is lost, with gradual migration of coding work into
Maestro. To be finalized once SDK capabilities are confirmed.

## 2026-07-01 — Phase 0 spike: PASS (wrap the real `claude` CLI)

Ran `spike/run-spike.mjs` spawning the real `claude -p ... --output-format
stream-json --verbose --model claude-sonnet-5` in the session-radar repo dir.
Results:
- **Subscription auth works with zero extra config** — no API key needed; the
  spawned subprocess inherited the logged-in subscription. (The one unconfirmed
  cost risk is now cleared for the current machine.)
- **Rooting works** — it ran in the target repo dir on main, no worktree; it
  even looked for that project's memory/files.
- **Streaming works** — newline-delimited JSON events: `system` (init,
  thinking_tokens, post_turn_summary), `rate_limit_event`, `user`
  (tool_result), `assistant`, `result` (with cost_usd, num_turns). Session id
  captured from the stream.
- **Bonus — quota data source found (point 13):** the stream emits
  `rate_limit_event` with `{ status, resetsAt, rateLimitType: "seven_day",
  utilization, isUsingOverage }`. Point 13 (token/quota view) has a real,
  first-party source — no guessing. (At spike time utilization was 0.89 of the
  seven-day limit.)
- Note: headless `-p` runs the full agent (it executed tool calls and answered
  conversationally rather than echoing the literal token). Expected; the wrapper
  drives real agent turns, not a constrained completion.

Decision: proceed to Phase 1 on the CLI-wrapping approach. Design the wrapper to
parse `rate_limit_event` for the quota view and `result` for per-turn cost.
