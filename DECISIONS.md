# Decisions

## 2026-07-02 — Real archiving: manual (context menu) + "orchestrator proposes, you approve" (opt-in sidebar pill)

**Decision:** Two paths, both requiring an explicit click every time:
1. **Manual** — right-click a session -> "Archive session" -> two-step
   confirm (same pattern as "Delete category"; no native `window.confirm()`,
   unreliable in this build) -> writes `isArchived: true` to that session's
   own `local_*.json` in the desktop app's session-metadata folder.
2. **Suggested** — a new, default-OFF setting
   (`config.archiveSuggestions.enabled`). When on, idle sessions with no open
   Jot review/in-progress/open work get a small "Archive?" pill in the
   sidebar row. Clicking it archives immediately — the pill IS the proposal,
   the click IS the approval. Never suggested for the Maestro-building
   session itself (idle between long autonomous stretches isn't "done").

Neither path ever archives without a click in the moment. There is no
background timer or heuristic that archives on its own — matches the captain's
"föreslå och så godkänner jag" (propose, and I approve), read literally: the
proposal is a UI affordance, not an autonomous action needing a separate
approval round-trip.

**Implementation:** `setSessionArchived()` in `src/lib/sessions.js` — scans
the session-metadata dir for the file whose `sessionId` matches, flips
`isArchived`, and writes back with `JSON.stringify(meta)` (no pretty-print)
to match the app's own compact format instead of needlessly reformatting a
file another app owns. New `session:archive` IPC handler + preload bridge.

**Known, NOT-yet-verified risk — flagging per the "verify before theorizing"
lesson from earlier tonight:** this write goes through `%APPDATA%`, and every
time Maestro has been rebooted for testing *tonight* it was launched via a
`npm start` spawned from this chat session's own Bash tool. If Claude Code's
own process is MSIX-sandboxed on this machine (a real, previously-confirmed
gotcha — see `feedback_verify_before_theory.md`), a write from a
Claude-spawned Maestro instance could land in an invisible sandbox overlay
copy of that `%APPDATA%` path instead of the real file the desktop app reads
— meaning archiving could report success while doing nothing the real app
ever sees. **I did not test the actual write against real session state
tonight, because doing so through a Claude-spawned Maestro instance would not
be a trustworthy test** (my own tool round-tripping with itself is exactly
the false-positive pattern that lesson warns about). Boot-tested for crashes
only. **Needs the captain to verify once**: launch Maestro normally (not through a
Claude Code session), archive a real disposable/old session, and confirm it
actually disappears from the *desktop app's own* sidebar — not just
Maestro's.

## 2026-07-02 — Image paste: shipped via file-path reference, not base64-in-stream-json

**Decision:** Paste an image into the composer -> it's saved to
`pasted-images/` (repo-local, gitignored) and its absolute path is prepended
to the prompt as `[Attached image: <path>]`. No other change to the
architecture: still the same `-p`/`--resume` CLI-wrapping flow, same
subscription auth, same model-fit judge.

**Why this works:** Claude Code's own `Read` tool already reads image files
given a path — the agent loop naturally opens an attached screenshot the same
way it would open one you mentioned by hand. Verified empirically before
building anything (`spike/test-image-via-path.mjs`): pointed a fresh `claude
-p` call at a real Maestro screenshot with unpredictable content (a dropdown
mid-interaction) and asked it to name the highlighted option and list the
others in order. It called `Read` on the exact path and answered correctly
("Auto mode" highlighted, all 5 options in the right order) — not a guessable
answer, so this wasn't the model coincidentally describing something
plausible.

**Why not the earlier `stream-json` base64-block approach:** already tested
2026-07-01 (see the now-superseded entry below) — the CLI's stream-json input
does not accept inline image content blocks; the model reported
`MAESTRO_NO_IMAGE`. The `--file file_id:relative_path` flag hinted at an
upload-and-reference flow, but never needed investigating further once the
much simpler "just save it and mention the path" approach was confirmed to
work with zero new surface area.

**Why not the Agent SDK (`query()`) route, mirroring how Halyard does image
paste:** would mean a second, parallel code path with its own auth
verification, skill/CLAUDE.md loading config, and resume semantics — real
migration cost for a problem the file-path trick already solves with the
existing, already-hardened wrapper. Revisit only if some future need (e.g.
truly ephemeral images that must never touch disk) makes the file-path
approach unworkable.

**Implementation:** `src/lib/images.js` (`savePastedImage`,
`prunePastedImages` — 7-day cleanup on app start, since these are throwaway
clipboard pastes that can contain anything on screen), new `image:save` IPC
handler, composer `paste` listener + attachment chips in
`src/renderer/renderer.js`.

## 2026-07-02 — Fas 2 core built: "Summarize & carry over," real archiving deliberately NOT touched

**Decision:** Built the context-flow half of Fas 2 (right-click a session ->
"Summarize & carry over to new chat") — resumes the session once with a hidden
handoff-summary prompt, captures the reply, and pre-fills a fresh session's
composer with it. Verified end-to-end on a throwaway test conversation before
shipping: the summary was genuinely well-structured and even pulled in
ambient repo context (git branch, uncommitted files) beyond the literal
chat history.

**Deliberately did NOT build:** an in-Maestro "Archive" action. Real archiving
means flipping `isArchived` in the desktop app's own `local_*.json` session
file — writing to another app's live state, which is exactly the kind of
action flagged as needing explicit confirmation, not something to do
autonomously while the captain is away. Maestro's existing "Remove from Maestro"
(hides via config.json only) remains the only session-hiding mechanism until
real archiving is explicitly requested and scoped carefully.

**Why this order:** the context-flow half directly unblocks the captain's stated
goal ("archive more aggressively once I don't lose the thread") without
touching anything outside Maestro's own repo — pure upside, no destructive
risk. Real archiving is a separate, smaller, but riskier follow-up.

## 2026-07-02 — Model-fit judge: Haiku, non-bare, cost reduced ~78% by stripping tools/MCP

**Decision:** After every completed prompt, fire a separate cheap `claude -p`
call (Haiku, effort low) that judges whether the model/effort choice was
`too_weak` / `appropriate` / `too_strong`, using `--json-schema` for a
structured verdict. Fire-and-forget — never delays the real response, and
skipped if the run was stopped early (nothing meaningful to judge).

**Cost investigation (measured, not assumed):**
- Naive non-bare Haiku call: **$0.068/call** (~32k cache-creation tokens).
- `--bare` would cut this further but was rejected outright: it hard-codes
  `ANTHROPIC_API_KEY`-only auth, bypassing the subscription entirely — not
  worth it for a background feature.
- `--system-prompt` (replacing the default system prompt, still non-bare):
  $0.068 → $0.053 (~22% cut). CLAUDE.md/default-prompt bulk wasn't the main
  cost.
- Adding `--allowed-tools ""` + `--mcp-config '{"mcpServers":{}}'
  --strict-mcp-config` (the judge needs zero tools — it only emits JSON): **
  $0.068 → $0.015, a 78% cut.** The bulk of the cost was tool/MCP-server
  schema definitions (the captain has several MCP servers configured) being sent on
  every non-bare invocation regardless of system prompt size — not CLAUDE.md.

**Why this matters beyond this feature:** any future "small utility call"
(judge, classifier, summarizer) that doesn't need tools should use this same
recipe (`--system-prompt` + empty `--allowed-tools` + empty
`--strict-mcp-config`) to stay cheap without giving up subscription auth.

**Toggle:** `config.json`'s `modelFitJudge.enabled` (default `true`, per
The captain's explicit request "efter varje färdig prompt"). Set `false` to disable
if the recurring cost isn't worth it later.

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

**Superseded 2026-07-02** — see "Image paste: shipped via file-path
reference" above. This entry is kept for the record of what was tried and
ruled out first.

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

## 2026-07-02 — Correction: the Phase 0 spike's "PASS" never actually checked prompt fidelity, and it was silently broken

**What happened:** after shipping several features, the captain reported real prompts
got "cut to the first word." Root cause: `spawn("claude", args, { shell: true
})` on Windows does NOT quote array arguments before handing them to `cmd.exe`
— it just concatenates them with spaces. Any prompt containing a space (i.e.
every real prompt) was silently split into multiple shell tokens, so only the
first word ever reached `-p`. Verified directly: a 5-word prompt sent through
the old `shell:true` spawn produced a response proving the model never saw
anything past word one; the identical prompt sent via a directly-resolved
`claude.exe` (no shell) came back byte-for-byte correct.

**This means the original Phase 0 "SPIKE PASS" was invalid on this specific
point.** Its own test prompt ("Respond with exactly this token...") almost
certainly hit the same bug — the model's reply was conversational rather than
the literal token, which I should have treated as a red flag instead of
counting the run as a pass because a `result` event arrived with exit code 0.
The auth/rooting/streaming conclusions from that spike still hold (they don't
depend on prompt content), but the prompt-fidelity assumption was wrong from
the start and went unnoticed through several feature batches because no test
prompt used since then happened to get manually diffed against the reply.

**Fix:** `launcher.js` now resolves the actual `claude.exe` path once (via
`where claude`, preferring a `.exe` over a `.cmd` shim) and spawns it directly
— no shell — so Node's own correct Windows argv escaping applies. `shell` only
falls back to `true` if no real binary could be resolved.

**Lesson:** "the process exited 0 and said something plausible" is not
verification that it received the actual input. A real check needs the
model to echo back something that could ONLY come from the full prompt (as
the later re-test did), not just any coherent-sounding reply.
