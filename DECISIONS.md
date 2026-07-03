# Decisions

## 2026-07-03 — Thinking indicator + per-reply time/token readout; verified the Done-checkmark bug stays fixed

**Built two small UI additions, both hooked into existing state rather than
inventing new tracking:**

1. **"Thinking" pulsing dot** — `.pane-status-icon` (style.css), a small
   animated dot shown next to the pane's status text while `pane.busy` is
   true. Wired into `setPaneBusyUI` (the one existing chokepoint that already
   toggles the send/stop button between "➤"/"■") and the composer's
   initial-render busy branch, so it can never drift out of sync with the
   button it sits beside. Dropped the literal `"● "` bullet character that
   used to prefix status strings ("● Working…", "● Working — ToolName", "●
   Stopping…") — redundant now that a real animated dot renders the same
   meaning.
2. **"12.3s · 1.2k tokens" readout** on the reply that just completed
   (`.turn-stats`, appended to the same `.turn-actions` row Copy/Done already
   live in). Sourced from data already flowing through the app: `launcher.js`
   now also extracts `duration_ms` and a summed token count (input + output +
   cache create/read) from the CLI's own `result` event, alongside the
   `costUsd`/`numTurns` it already pulled from the same event for the usage
   log. `main.js` rides these along on the existing `"done"` event's
   `summary` object (previously `costUsd`/`numTurns` stayed main-process-only,
   never reaching the renderer) — no new IPC channel. Only shown for the
   reply belonging to the run that JUST finished in that pane; a reloaded/
   reopened session shows no stats line, since per-turn usage isn't parsed
   out of historical transcripts (`transcript.js` doesn't extract `usage`
   today, and doing so was out of scope for this pass).

**Bug caught and fixed before shipping (self-review, not live testing —
caught by tracing the code, not by reproducing it):** the first version
nulled `pane.lastTurnStats` out the instant `wireTurnStatsOnLastReply` read
it, mirroring the (unrelated) single-consume shape of nothing else in this
file. That broke under one real sequence: a queued prompt firing
immediately after "done" triggers `sendFromPane`'s own synchronous
`renderPane()` call BEFORE the "done" handler's own `loadTranscriptInto(...)
.then(refresh)` resolves — so the stats got consumed (and their DOM span
drawn) on that intermediate render, then silently lost when the reload's own
`renderPane` call rebuilt the scroll area from scratch
(`scroll.innerHTML=""` on every call) with nothing left to reattach. Fixed by
making the function non-destructive — it recomputes on every render, the
same pattern `wireDoneButtonOnLastReply`'s `isAcked` check already uses —
and instead clearing `pane.lastTurnStats` explicitly in `sendFromPane` the
moment a genuinely NEW turn starts (the point where "the reply that just
completed" is no longer the last one).

**Verification:** `node --check` on all three edited JS files, a CSS
brace-balance check, and a full boot-test via `scripts/restart-dev.sh` (clean
log, confirmed via `Get-Process` that only Maestro's own PIDs were recycled —
the pre-existing Reinmaker instance's PIDs were untouched, consistent with
the documented safe-restart behavior). No live click-through was possible
beyond that — this is a native Electron app, not a browser-servable dev
server, so the usual preview tooling doesn't apply; Aidin will confirm
visually.

**Third ask — re-verified the "Done checkmark follows along" bug (2026-07-02
entries) stays fixed, no code change:** traced every path that pushes new
assistant content into a pane against `wireDoneButtonOnLastReply`'s
`isAcked` check. All five paths that push a new assistant-role turn
(`"assistant"` stream event, `"error"` event, the switch-folder failure, the
start failure, and the "Stopped" path) call `bumpSessionActivity` before
`renderPane()`, keeping `state.sessions`' `lastActivityAt` fresh at render
time. The one path that does NOT call it — the normal successful completion,
which just does `loadTranscriptInto(index).then(refresh)` — doesn't need to:
`launcher.js` always emits the reply's actual text via a separate
`"assistant"` stream event before the CLI process exits and `"done"` fires
(confirmed by re-reading `launcher.js`'s stdout-line handler), so
`bumpSessionActivity` has already run for that exact content by the time the
success branch's reload happens. No remaining gap; nothing changed here.

**Context:** Aidin asked me to act as orchestrator and dispatch agents
against the open Maestro backlog rather than build everything inline in
this one long session. Triaged the open Jot items first (see the entry
below) into safe-to-dispatch vs. stale vs. gated-on-a-decision, then
launched two agents: a background research agent to study firstmate +
gnhf SOURCE (the task PLAN.md's Phase 4 section had been flagging since
the video-summary pass), and a worktree-isolated coding agent for a small
UI-polish bundle.

**Incident:** The research agent, asked to "clone both repos and read
their source," repeatedly interpreted that as a delegation task instead of
doing the work itself: it spawned a sub-agent and reported "completed"
with no findings, five times in a row (each generation's own result was
some variant of "I've launched an agent to do this, I'll report back" —
one generation even fanned out to 2 parallel children instead of 1,
widening rather than just chaining). `TaskStop` against each completed
generation's id correctly reported "not running" — there is no way to
reach into a chain like this and kill a live but not-yet-surfaced
descendant, matching the standing memory note on agent-fanout risk. Total
cost across the misfire: roughly 435k combined subagent output tokens
before real work appeared, against a task that should have been a single
well-scoped call.

**Resolution:** Rather than send a 6th corrective message into an already
overgrown tree, abandoned that lineage entirely (any further orphaned
notifications from it are harmless — wasted tokens, no destructive action)
and did the research directly in the main conversation via `gh api`
(reading key files from both repos without cloning) — got a solid,
directionally-correct recommendation from that alone. The two orphaned
generations 5/6 THEN separately reported back with real, deeply-read
findings (they had, it turned out, actually done the work — just five
generations later than they should have and at enormous token cost). Their
findings were meaningfully more thorough than the direct `gh api` pass
(full grep sweeps, git history, exact line citations, and two decision-
relevant facts the quick pass missed entirely: firstmate is macOS/Linux-
only, and gnhf has zero exported library API) — folded into PLAN.md's
Phase 4 section, superseding the faster first-pass findings.

**Lesson for future research-style dispatches:** the failure mode was
specific and repeatable — a general-purpose agent given a multi-repo
"clone and deeply read" task defaults to delegating rather than executing.
Next time, state explicitly in the prompt: "do this yourself in this turn
using Bash/gh directly — do not call the Agent tool or delegate to another
agent." Cheap insurance against a 400k-token misfire for what should be a
single agent's work.

## 2026-07-03 — Jot triage before dispatch: most of the open backlog wasn't
## actually ready for blind agent fan-out

**Decision:** Before dispatching any agents against the ~20 open Maestro
Jot items, read each one against DECISIONS.md's own history rather than
assume "open in Jot" means "ready to build." Found four real buckets:
already-resolved-but-not-closed (2 items — a duplicate of an already-
`done` model/effort-analysis decision, and the mid-turn-input-box question
already conclusively answered negative by the 2026-07-03 persistent-
process spike), too-vague-to-delegate (advanced-view redesign, "Routines
section?" — need Aidin's specifics first), gated-on-the-firstmate-decision
(gnhf, no-mistakes, half of worktree-automation — building these before
the strategic question above is answered would bypass the very human-
gating principle PLAN.md itself calls for), and genuinely-safe-to-dispatch
(a thinking-indicator icon, a time/tokens chat readout, re-verifying an
old checkmark bug, plus the firstmate/gnhf research above). Closed the two
stale duplicates with a note pointing at the superseding decision, left
the vague ones untouched, and only dispatched agents against the last
bucket. This triage-before-dispatch step is itself an orchestrator
behavior (per PLAN.md's own "orchestrator vs. worker" framing) — sensing
and routing before delegating, not fan-out as a default.

## 2026-07-03 — Added a repo-root CLAUDE.md, closing the "on-ramp" gap for this repo

**Decision:** Direct follow-through on the strategic reorientation below -
a fresh short-lived session needs a cheap way to bootstrap "what is this
project, what's the current phase, what's already been decided" without
the user re-explaining it. `PLAN.md`/`DECISIONS.md` already held that
content, but neither auto-loads the way a repo-root `CLAUDE.md` does, so a
new session had no path to them unless told. Added `CLAUDE.md` (repo root):
a short pointer to both files plus the one genuinely repo-specific footgun
(the `taskkill /IM electron.exe` / Reinmaker collision, see the 2026-07-02
entry below) - deliberately NOT duplicating anything already covered by
Aidin's global personal `CLAUDE.md` (git conventions, testing discipline,
etc.). Also closes the Jot tasks "länk till personlig och projekt claude.md"
and "CLAUDE.md-trim -> skills" (the trim/skills side was done tonight on the
global file - see that file's own history for the Jot-section-to-skill
move) and directly answers "fix a better claude.md" and "Bryter vår auto
compact mot kortlivade sessioner filosofin?" (answered in the reorientation
entry immediately below - kept, de-prioritized as a strategy, not removed).

## 2026-07-03 — Strategic reorientation: ephemeral sessions, not a durable fleet

**Decision:** Aidin realized he's been working wrong — long-lived sessions,
roughly one per PROJECT, when the real unit should be one per FEATURE/task.
A session should carry only context relevant to what's happening now; durable
knowledge belongs in files (CLAUDE.md, DECISIONS.md, memory), not in an
indefinitely-kept-alive session. Full reasoning in PLAN.md's new "Strategic
reorientation" section (placed right after the vision table, since it
reprioritizes work across Phase 3/4, not just a footnote).

Three concrete implications, discussed and agreed:
1. **Auto-compact (Fas 3's proactive idle-session version) is a partial
   anti-pattern** — it keeps a megasession alive-and-lean instead of
   prompting an actual wrap-up. The context gauge is the pro-pattern tool
   (nudges toward ending); auto-compact is a crutch for avoiding that.
   Not removed (shipped, opt-in, genuinely useful for one legitimately long
   task) — de-prioritized as a strategy going forward.
2. **Session-list curation (drag-sort, categories, deadline-sort) is also
   partly an anti-pattern** — it organizes sessions as durable objects worth
   tending, when the real unit worth organizing is work/goals (already in
   Jot). Not ripped out; let its importance fade as ephemeral sessions
   become the norm rather than cutting it surgically now.
3. **Re-ranks priority toward "on-ramp" tooling** — whatever makes a fresh
   session cheap to start and cheap to feed context into (CLAUDE.md/skills,
   Fas 2 handoff, DECISIONS.md/memory discipline, and from Phase 4:
   treehouse, `/triage`, the handoff skill) now matters more than features
   that make megasessions more pleasant to live in.

Same fork as the already-flagged firstmate strategic question (Phase 4) —
firstmate has no session list at all, just a crew + disposable worktrees,
oriented around dispatch and goals. Both threads point the same direction.

This session (this very transcript) is itself the illustrating example: a
single "Maestro project" megasession spanning the classifier, auto-compact,
context gauge, root-folder-switch debugging, CLAUDE.md consolidation, and
this Phase 4 planning — already auto-compacted multiple times, expensive per
turn. Split into per-feature sessions, each would have been sharp, cheap,
and left a clean topical transcript.

## 2026-07-03 — Root-folder switch didn't stick: session.cwd lives in a file the switch never touched

**Bug (the real one, found via two rounds of live testing):** Aidin tested
the switch feature twice. First test: pick a new folder, navigate away and
back — folder reverted (fixed below by preserving pane state — but that
fix alone didn't solve it). Second test: pick a new folder, send a real
message, WAIT for the reply, then navigate away and back — folder STILL
reverted. That ruled out the pane-state theory as the root cause.

Root cause: `session.cwd` — read by literally every part of the app that
shows or reuses a session's folder (sidebar rows, pane header, the
composer's cwd field on open) — comes from `buildSession`'s `cwd: meta.cwd`,
where `meta` is the DESKTOP APP'S OWN `local_<uuid>.json` sidecar metadata
file. `switchSessionRootFolder` only ever copied the `.jsonl` transcript; it
never touched that sidecar. So the switch worked for exactly one immediate
`--resume`, but the moment the session was reopened, Maestro re-read the
still-stale old `cwd` from the sidecar and the switch silently evaporated —
regardless of how many real turns had run from the new folder.

**Fix:** extracted `setSessionArchived`'s existing careful mutation pattern
(find the sidecar by sessionId, re-read fresh right before writing to
shrink the race window against the desktop app's own concurrent writes,
patch one field, write via temp-file + atomic rename) into a shared
`patchSessionMeta(sessionId, patchFn)` helper — `setSessionArchived` is now
a one-line wrapper over it. `switchSessionRootFolder` calls
`patchSessionMeta(sessionId, meta => { meta.cwd = newCwd })` on every
invocation (not just when the transcript copy was needed — an earlier
attempt, made before this fix existed, could leave a correctly-placed
transcript with still-stale metadata). Verified live against a real session
(Jot): `session.cwd` now updates immediately after the switch call, with no
new turn needing to run. Review came back fully clean (setSessionArchived
behaviorally identical post-refactor, no race with the CLI process since the
switch is awaited before `startSession` spawns anything, double-switching an
already-broken session is safe). Re-ran the fixed switch for all 14 sessions
touched tonight (13 + this session's own) so they're now genuinely durable,
not just transcript-copied. Aidin confirmed live: "nu verkar det fungera!"

## 2026-07-03 — Pane header's folder path never updated live

**Bug:** Aidin: "vi borde fixa pathen vid titeln" — after picking a new
folder or completing a root-folder switch, the path shown next to the pane
title never changed. Root cause: `paneHeaderEl()` builds `.pane-sub` (the
path span) ONCE at pane-construction time; `renderPane()` (called on every
send/turn) only ever rebuilds the `.pane-scroll` area, never the header. So
`.pane-sub` was permanently stale from the moment the pane was first
rendered, regardless of how `pane.cwd` changed afterward.

**Fix:** `updatePaneSubText(index, cwd)` queries the live DOM for that
pane's header and updates/creates/removes its `.pane-sub` span directly,
without rebuilding anything else. Called from all three places `pane.cwd`
changes: typing in the cwd input, picking a folder via "…", and
`sendFromPane`'s own `pane.cwd = cwd` assignment.

**Separately surfaced while diagnosing this**: Aidin's actual "switch root
folder" confusion (a session's root flip-flopping between two folders across
messages) turned out to be unrelated to Maestro at all — both turns carried
`"entrypoint":"claude-desktop"`, meaning he was sending via the real Claude
Desktop app on the same session, not Maestro's own composer. Desktop has its
own, separate session-resume resolution that Maestro's switch/mtime-based
`findTranscriptPath` fix has no influence over — using Desktop and Maestro
interchangeably on the same session can pick either transcript copy
unpredictably. Not a Maestro bug; a real limitation of mixing the two front
ends on one session, worth remembering if it comes up again.

## 2026-07-03 — "Switch root folder" + stop silently dropping CLI failures

**Decision:** Aidin noticed the "…" folder-picker is always clickable, even
on an already-resumed session, and asked what it actually does there ("kan
en session byta root folder? diskussion"). Investigated rather than
guessing: `claude --resume` scopes its own session lookup by cwd — spiked
resuming from a different folder and got "No conversation found with
session ID" outright. Worse: Maestro had NO handling anywhere for CLI
stderr — the error vanished completely (no case in the renderer's event
switch), so picking a new folder on an existing session and sending
silently ate the message with the pane just going back to idle. Chose to
build the real feature (verified buildable — copying the transcript into the
target folder's own project dir first, same trick as rewind-to-here) rather
than just closing the trap.

**Built:**
- `stderrText` now flows through launcher.js's `done` summary; the renderer's
  `"done"` handler gained a branch for genuine failures
  (`!sawResult && code !== 0`) that surfaces a visible `⚠` error turn instead
  of silently reloading an unchanged transcript. This is a general safety
  net, not just for this one failure mode.
- `switchSessionRootFolder()` (sessions.js): copies (never moves) the
  transcript into `newCwd`'s own encoded project dir
  (`paths.js`'s new `encodeProjectDir`, mirroring the CLI's own naming).
  `sendFromPane` calls this first when a resumed pane's folder was changed,
  before `startSession`.
- `findTranscriptPath` changed from "first directory match" to "most
  recently modified match" — after a switch, the same session id briefly
  exists in two project dirs, and directory-enumeration order isn't
  meaningfully "correct."
- **Bug caught by a standalone test before shipping**: `fs.copyFileSync`
  PRESERVES the source's mtime on Windows — without an explicit
  `fs.utimesSync` bump on the copy, the new mtime-based tie-break sometimes
  still resolved to the STALE pre-switch copy. Fixed; re-verified 4/4 checks
  (switch succeeds, resolves to the fresh copy, `--resume` works from the
  new folder, still resolves correctly after a real new turn).
- **Review caught two more before shipping**: (1) the switch-success path was
  missing the `panes[index] === pane` identity guard every other await
  boundary in `sendFromPane` uses — added for consistency (pane could've
  been reset/reassigned during the switch's await). (2) A spawn-level
  failure (binary not found) resolves with `{error: err.message}` and no
  `stderrText` — the new error branch now falls back to `evt.summary?.error`
  instead of dropping that message for a generic "exit code -1" text.

**Where a session's context/CLAUDE.md/settings get enforced after a
switch**: same as any Maestro-launched session — resolved per-invocation
from the CLI process's cwd, not baked in at session creation. So yes,
switching folders and sending genuinely changes which project's CLAUDE.md,
settings, and skills apply going forward — not something Maestro implements
itself, just a consequence of how `-p` already works for every session.

## 2026-07-03 — Merge suggest-hint and context gauge onto one row

**Decision:** Aidin: "kan du lägga dessa på samma rad" (screenshot showing
the model-suggestion hint on its own line and the context gauge stacked
below it). Wrapped both in a new `.composer-meta-row` flex row instead of
two separate full-width lines. `.composer-context` keeps `margin-left: auto`
(not `justify-content: space-between` on the row) specifically so it still
pins to the right when `.suggest-hint` is empty and `display:none` removes
it from the row — space-between would have left it sitting at the start
with nothing to space between.

## 2026-07-03 — Learn real context-window per model from the CLI (not a hardcoded max)

**Decision:** Aidin: "går det inte att få ut kontext size från modell-
informationen?" Yes. The CLI's `result` event reports each model's real
context window at `evt.modelUsage[model].contextWindow` (verified live:
claude-haiku-4-5 → 200000). So instead of the hardcoded 1M guess for the
gauge's %, Maestro now LEARNS the true window per model: the launcher
extracts `contextWindows` from every result event, and the launch's done
handler merges any new model→window into `config.modelContextWindows`
(persisted; a no-op write once steady). Done even for internal launches
(they run real models). The gauge's `contextWindowForPane()` prefers the
learned window for the session's model and falls back to
`config.contextWindowTokens` only for a model not yet seen.

Self-correcting and authoritative: as Aidin runs each model through Maestro
once, its window becomes exact. The 1M fallback just covers the gap until
then (and for sessions only ever run outside Maestro, whose interactive
transcripts carry no contextWindow field).

## 2026-07-03 — Context gauge → bar+% with a click-to-open context+quota popover

**Decision:** Iterated the context gauge per Aidin's feedback (referencing
Claude Code's combined readout): make it a bar + percentage, and fold the
quota into a popover you get by clicking it — "de visar en mätare av
kontexten och när man trycker på den ser man både kontext och kvot."

- The gauge (in the composer, under the model/effort row) is now a clickable
  bar + "%" instead of a plain token count.
- Clicking opens a `.context-popover` (anchored above it) showing a Context
  window row (Nk / max (X%) + bar) and a Quota row (utilization % + bar).
  Closes on second click / outside click / Escape (wired alongside
  closeContextMenu).
- Quota MOVED out of the top-header `#quota` span into this popover
  ("flytta ner quota menyn dit också"). `renderQuota` is now a no-op;
  `state.quota` still flows via refresh() and the popover reads it live.

**The % needs a max, which isn't reliably readable per session** (the
interactive transcript has no `contextWindow` field; it varies by model —
200k / 1M). Added `config.contextWindowTokens`, defaulted to 1000000 to match
Aidin's current environment (his own Claude Code shows "/ 1.0M"). The gauge
still shows the absolute token count in the popover, so a wrong max only
skews the %/bar, never hides the real number — and it's one config value to
correct. A real per-model window lookup is a future refinement.

## 2026-07-03 — Per-session context-size gauge in the pane header

**Decision:** Aidin's ask (with a Claude-Desktop screenshot showing "Context
window 429.1k / 1.0M (43%)"): a context-usage readout. Added a "◱ Nk ctx"
chip to the pane header for the open session, reusing
`estimateSessionContextTokens` (the same proxy auto-compact keys off — so the
gauge and auto-compact stay consistent). `transcript:get` now also returns
`contextTokens`; the pane stores it and the header renders it.

Deliberately absolute tokens, NOT a percentage/bar like the reference: the %
needs the model's context-window size (200k / 1M / …), which varies and isn't
reliably known per session here — a made-up denominator would mislead. The
honest absolute number ships now; a real %/bar is a refinement for if/when
the window size is reliably readable (the transcript's `result` events carry
`contextWindow`, but not in every format — left for later). Distinct from the
compaction pill (which marks WHERE a compaction happened); this is the
live "how full right now" readout.

## 2026-07-03 — Fas 3 auto-compact shipped + a compaction pill in the chat

**Built** the auto-compact feature (Aidin chose automatic-not-propose):
- `estimateSessionContextTokens()` — transcript-tail proxy for current
  context size (last usage block's input+cache_creation+cache_read).
  Verified within ~1% of the CLI's own pre_tokens on a real compaction.
- `compactSession()` — `--resume -p "/compact"`, confirms via the
  `compact_boundary` event. Verified end-to-end (ok, pre 33132 → post 2125).
- Folded into the periodic sweep, own `autoCompact.enabled` toggle (off by
  default) + `thresholdTokens` (150k default). Re-compaction guard keyed on
  transcript BYTE SIZE (not lastActivityAt, not the token estimate — a
  /compact-only run writes no fresh low-token usage block, so the estimate
  stays stale-high; and compaction may bump lastActivityAt): a session is
  re-eligible only once its transcript grows past the size sampled right
  after its last compaction. A small "⊟ Auto-compacted (X→Y)" row note
  surfaces it (Aidin's concern about silent compaction).

**Review was fully clean** on all six probes; applied its two minor notes:
compaction is now restricted to `idle` sessions only (not `waiting` — the
one status that could be a session streaming a turn OUTSIDE Maestro; also
matches Aidin's "aktiv men idle" framing), and `enrichWithJot` now runs only
in the classify branch (the compaction pass never reads Jot).

**Q: does the CLI's own auto-compact-when-full still work in Maestro
sessions?** Yes — verified this session's transcript carries 2
`trigger:"auto"` compact_boundary events. Maestro never touches context
management, so the built-in fires normally near the limit; Fas 3
auto-compact is a separate, earlier proactive trigger (`trigger:"manual"`,
150k, idle). They coexist.

**Compaction pill in the chat** (Aidin's ask "skriv även ut i chatten med en
pill att compacting skett"): `transcript.js` now emits a `compact_boundary`
marker turn wherever the transcript has one, and the renderer draws a
centered divider pill "⊟ Context compacted (auto/manual · X→Y tokens)".
Works for ALL triggers uniformly (CLI built-in, Fas 3 auto, manual). Handles
BOTH transcript formats — headless stream-json (`compact_metadata`,
snake_case) and interactive desktop (`compactMetadata`, camelCase) — since
Maestro reads sessions from both. Verified parsing against a real transcript
(trigger:"auto", pre 917979 → post 53922).

## 2026-07-03 — Spike: headless /compact works (auto-compact is buildable)

**Decision:** Before building the Fas 3 auto-compact feature, spiked whether
headless `-p` can even trigger the CLI's built-in `/compact`
(`spike/test-compact-headless.mjs`). Result: definitively YES.
`--resume <session> -p "/compact"` emits a clean event sequence —
`system/status status:"compacting"` → `status:null compact_result:"success"`
→ a `system/compact_boundary` event carrying
`compact_metadata: { trigger:"manual", pre_tokens, post_tokens, duration_ms,
preserved_segment }`. In the test: pre_tokens 32989 → post_tokens 2261
(~93% reduction), and context genuinely survived (recalled a fact planted
before the compaction).

Notable gotcha for whoever builds the "did it work" detection: compaction
does NOT shrink the transcript `.jsonl` on disk (it's append-only) — it
APPENDS a summary user-turn + the `compact_boundary` marker, so line/byte
count goes UP (24 → 36 in the test), not down. The authoritative success
signal is the `compact_boundary` event's `compact_metadata` (and its
pre/post token counts), never file size.

Also learned: the `compact_boundary.compact_metadata.pre_tokens` is exactly
the "how much context was in use" number — but it's only available AFTER a
compact. To decide WHEN to auto-compact, the pre-compaction context size has
to come from elsewhere (the last `result` event's `usage` in the transcript
tail — cache_read + input tokens — is the readable proxy). That "when to
fire" logic + the propose-vs-act gating decision is the actual build, now
unblocked. The "can we fire it at all" question is closed.

## 2026-07-03 — Fas 3 first slice: the orchestrator-helper classifier

**Decision:** Aidin approved starting Fas 3 ("börja bygga nu"), scoped down
per his own preference to the smallest self-contained first slice: just the
periodic session-status classifier (the "sensor"), NOT auto-compact, NOT the
model/effort-accuracy loop, NOT the visualizer — those stay for later passes
per PLAN.md's own framing.

**Built:** `src/lib/orchestratorHelper.js` — `classifySessionStatus()`,
mirroring `judge.js`'s cost-optimized recipe almost line for line (same
`--system-prompt` + `--allowed-tools ""` + empty `--strict-mcp-config`,
Haiku, structured JSON schema output). Reads the last 6 turns of a session's
transcript + its Jot task summary, classifies into
`waiting_for_input`/`stuck`/`done_not_archived`/`blocked_external`/
`genuinely_active`. `main.js`'s `runOrchestratorSweep()` runs this every 15
minutes (off by default via `config.orchestratorHelper.enabled`) over
non-archived `waiting`/`idle` sessions, skipping any unchanged since its last
classification, capped at 15 classifications/sweep. Results merge into
`sessions:get`'s response as `session.orchestratorTag`. The renderer shows
the tag's `reason` as a small note on the row (the plan's own "auditable,
not a black box" principle — a minimal stand-in for the full visualizer,
which stays deferred until there's real behavior to design a UI around) and
sharpens the existing "Archive?" pill: it now also fires when the classifier
says `done_not_archived`, even before the session has aged into "idle" —
replacing the old blunt idle-and-no-Jot-work proxy with something that's
actually read the content, per the plan's own framing.

Also fixed a stale PLAN.md claim: Point 11's write-up said the mid-turn-
interjection spike had "confirmed working" — that was true as of the
2026-07-02 spike note but got FLIPPED by today's fuller spike (see below);
corrected before it misled a future read of the plan.

**Review caught one real issue before shipping**: `setInterval` doesn't know
whether a previous sweep is still running — up to 15 sequential classifier
calls (each with its own 30s timeout) stay under the 15-minute interval in
the stated worst case, but that's a coincidental margin, not an enforced
one. Added a `sweepInFlight` guard so a slow sweep can't overlap a second
one and double the concurrent spend. Everything else review checked
(cost/rate safety, staleness-check correctness, archive-pill condition
safety, fingerprint completeness, object-isolation between the sweep's and
the IPC handler's separate `readAllSessions()` calls) came back clean.

## 2026-07-03 — restart-dev.sh's kill step was silently a no-op all session — rewritten in PowerShell

**Bug:** Aidin noticed a new Maestro window opening without the old one
closing. Investigated instead of guessing: `restart-dev.sh`'s kill step
(`wmic ... | grep -i "$REPO_PATH_WIN"`, built earlier today specifically to
stop boot-tests from killing Reinmaker) had a real bug — `grep`'s regex mode
interprets a literal Windows path's backslashes as escape sequences (`\R`,
`\T`, `\m`...), so matching `D:\Repo\Tools\maestro` against wmic's CSV output
silently failed on EVERY invocation, and `|| true` swallowed the failure
with zero visible error. Every restart-dev.sh call this session launched a
NEW Maestro instance on top of whatever was already running instead of
replacing it — confirmed live: found 3 stray Maestro instances (12 stray
electron.exe processes) piled up by the time Aidin caught it.

`grep -F` (fixed-string) was tried next and still failed/crashed against the
real wmic output in this environment (a `grep` abort, not investigated
further — not worth chasing when a cleaner tool was available). Rewrote the
kill step in PowerShell (`scripts/kill-maestro.ps1`, invoked via
`-File` — nesting the PS one-liner inside a bash single-quoted `-Command`
argument mis-parsed `-Filter` on the first attempt, a second quoting layer
not worth fighting): `Get-CimInstance Win32_Process` + a plain `-like`
string match, no regex-escaping ambiguity. Verified live end-to-end twice —
first run correctly found nothing to kill (fresh baseline) and started one
instance; second run correctly found and killed that exact instance (all 4
of its child processes) before starting a new one, with Reinmaker's 4
processes confirmed untouched both times.

## 2026-07-03 — Spiked persistent-process architecture: doesn't unlock what we wanted

**Decision:** Both "a real input box when Claude needs an answer mid-turn"
and "interject info into a PROGRESS run" were blocked on the same
architecture question — a persistent `claude -p --input-format stream-json`
process per pane instead of one process per turn — and it was unverified
whether either use case is even possible headlessly. Aidin approved running
a spike before deciding whether the architecture change is worth it
(`spike/test-persistent-process-blocking-input.mjs`,
`spike/test-permission-deny-path.mjs`).

**Result — negative for both, and NOT an investment question anymore:**
1. Headless `-p` mode has NO pause-and-ask primitive at all. A tool call
   either runs or gets denied synchronously based on flags
   (`--allowed-tools`/`--permission-mode`) — no stream-json event type pauses
   the turn and waits for a stdin-supplied decision, with or without a
   persistent process. Confirmed with both an allowed-tool run (ran
   immediately, no permission event) and a should-be-restricted run (also
   ran immediately, no block, no hang, no permission event — `-p` mode's
   permission model just isn't an interactive round-trip).
2. A second stdin message written 1.5s into a 14-second-long first turn
   (while it was still actively generating) was NOT folded into that
   turn's output — the CLI ran the first turn to full completion, THEN
   processed the second message as an entirely separate next turn. This is
   functionally identical to Maestro's existing "queue next prompt"
   (already built via a fresh process per turn) — a persistent process adds
   no new capability here.

**Conclusion:** this isn't "is the architecture change worth it" — it's "the
architecture change doesn't solve the problem" for either feature, given the
CLI's actual headless behavior. Both items stay parked, now with a
conclusive technical reason instead of an open question. (Multi-turn on one
persistent process DOES work correctly for strictly sequential turns — just
not for anything resembling a live mid-turn interjection or a blocking
question.)

## 2026-07-03 — Scroll-to-bottom button + slightly larger chat font

**Decision:** Two quick asks. (1) "öka fontstorlek i chatten aningen" —
`.turn-bubble`'s font-size bumped 12.5px → 13.5px; left markdown code-
block/table sizes untouched (their own smaller size is a deliberate density
choice for dense content, not something "aningen" was asking to change).
(2) "scroll to bottom knapp" — a floating "↓" button, hidden by default,
appears once you've manually scrolled more than 80px away from the bottom
(e.g. to reread earlier history), click smooth-scrolls back down.

Implementation note/bug caught before shipping: `.pane-scroll` is the SAME
persistent DOM node across every `renderPane()` call (only its innerHTML
gets cleared) — a plain `addEventListener("scroll", ...)` inside the wiring
function would have piled up a new listener on every single render (every
streamed chunk, every poll-triggered update) forever, each stale one still
closing over its own now-detached button from a past render. Fixed by
stashing the listener function on the element and removing the previous one
before attaching a new one — exactly one live listener at a time, no matter
how many times the pane re-renders.

## 2026-07-02 — Done checkmark is now toggleable (un-ack undoes it)

**Decision:** Aidin: "checkmarken bör gå att ta bort också (?) eller?" Agreed
— a checkbox you can't uncheck is an odd affordance, and clicking an already-
acked checkmark to say "actually, this needs attention again" is exactly the
real state `acknowledgedSessions` already models (deleting the entry makes
`main.js`'s status override fall through to the normal `deriveStatus`
result, correctly reverting to "waiting" if still within the attention
window). Removed the `disabled` gate; the button now toggles both ways —
click un-acked → acked (adds the config entry), click acked → un-acked
(deletes it) — with the same instant local visual feedback ahead of the
async round-trip in both directions.

## 2026-07-02 — Fixed: the Done checkmark was "following along" onto new replies

**Bug:** Aidin: "nästan rätt. Min avsikt var att checkmarken skulle betyda,
jag är klar till det här läget. Men om jag sen fortsätter prompta tillkommer
nya saker och då ska inte checkmarken följa med." Root cause: `isAcked` in
`wireDoneButtonOnLastReply` compares `config.acknowledgedSessions[sessionId]`
against `session.lastActivityAt` — but `session` comes from `state.sessions`,
which is ONLY refreshed by the 30s poll / explicit `refresh()`, never
updated live as a run streams. When a new reply streamed in mid-conversation,
the pane's live `pane.turns` already had the new content, but
`state.sessions`' `lastActivityAt` for that session was still the OLD
(pre-new-reply) value — which could still exactly equal the earlier ack
timestamp, making `isAcked` wrongly true and painting the checkmark onto a
reply it was never placed on.

**Fix:** `bumpSessionActivity(sessionId)` mutates the matching
`state.sessions` entry's `lastActivityAt` to `Date.now()` the INSTANT new
content actually streams into a pane — called right before `renderPane()` in
all four places a pane pushes a new assistant-role turn (`"assistant"`
event, `"error"` event, the "⚠ Failed to start" path, and the "⏹ Stopped."
path). This invalidates any stale ack match immediately, without waiting for
the next poll. Verified with a standalone sequence simulation (4/4): ack
holds through no-op time passing, clears the instant new content streams in,
and stays correctly un-acked once the real poll's timestamp catches up.

## 2026-07-02 — Swapped Done/Copy icon order (Done first)

**Decision:** "vi borde byta plats på checkbox och copy ikonen, annars ser
det konstigt ut när den är ikryssad." With Done appended AFTER Copy, an
acked (always-visible) checkmark sat to the right of Copy's hover-only slot
— hovering made Copy pop in to its LEFT, visibly shifting the checkmark
sideways. Switched to `actions.prepend(done)` so Done leads the row; its
position stays fixed whether or not Copy is currently visible.

## 2026-07-02 — Boot-test restarts were silently killing Reinmaker

**Bug (mine):** every boot-test in this repo restarted Maestro via
`taskkill /F /IM electron.exe` — matches by image name only, machine-wide.
Aidin reported "Appen stängdes, jag tror du och reinmaker slåss om samma
port." Investigated instead of guessing: no port conflict — Maestro's source
has zero `listen()`/`createServer()` calls anywhere. The real cause: Reinmaker
(tgs-reinmaker) runs unpackaged in dev mode via `electron .`, so its process
also shows up as bare `electron.exe` in Task Manager, indistinguishable by
name from Maestro's own dev process. Every blind image-name kill this
session silently closed Aidin's live Reinmaker session too — confirmed live:
found 4 running `electron.exe` PIDs, all four traced via `wmic ... get
CommandLine` to `tgs-reinmaker\node_modules\electron\dist\electron.exe`, none
to Maestro.

**Fix:** `scripts/restart-dev.sh` — resolves the repo's own path, queries
`wmic process where "name='electron.exe'"` for CommandLine, and only kills
PIDs whose command line actually points at THIS repo before restarting.
Verified live: ran it while Reinmaker's 4 processes were up — Maestro
restarted cleanly and all 4 Reinmaker PIDs were untouched afterward. This is
now the only sanctioned way to restart Maestro during dev work; a bare
`taskkill /IM electron.exe` must not be used again in this repo.

## 2026-07-02 — Done button: check icon beside Copy, hover-only, persists as a checkmark once clicked

**Decision:** Follow-up on the per-reply Done button (previous entry):
"kan vi lägga den som en liten check ikon bredvid copy ikonen som endast
dyker upp på hoover. Och när den är checkan dyker en checkmark upp på
svaret." Redesigned:
- `turnEl()` now wraps the assistant reply's Copy button in a `.turn-actions`
  row (previously appended directly to the `.turn` column) so a second
  button sits BESIDE it, not stacked underneath.
- The Done button reuses the `copy-btn` class, giving it the exact same
  hover-only opacity behavior as Copy — invisible until you hover the reply.
- Once clicked (or on a re-render of an already-acknowledged reply — checked
  via exact equality between `config.acknowledgedSessions[sessionId]` and
  the session's current `lastActivityAt`), it gets an `.acked` class that
  forces it permanently visible and accent-colored, and gets disabled — a
  persistent checkmark confirming that specific reply was marked done,
  matching the copy button's own instant-feedback pattern but WITHOUT
  reverting afterward (since the underlying state, unlike a copy action,
  actually changed).
- Backend (config.acknowledgedSessions, the main.js status-override ordering
  fix) is completely unchanged — only the affordance's visual treatment and
  DOM position moved.

## 2026-07-02 — Performance + token usage audit; one real fix applied

**Decision:** Aidin's Jot task "performance + token usage granskning av
appen" — ran an audit (two agents, renderer perf + Maestro's own internal
LLM-call costs) rather than guessing. Verdict: the app is already well-
optimized at its actual single-user scale (~9 groups, ~35 grouped + ~100
total sessions). Token/cost axis fully clean — the model-fit judge (Haiku,
per completed run) uses the established cheap-call recipe correctly, is
gated off `internal:true` launches, and costs ~$0.015/run;
`suggestModelEffort` isn't an LLM call at all (pure regex, also debounced);
Fas 2's summarize-and-carry-over correctly does NOT use the cheap recipe
(it's a real generative Sonnet call by necessity) and only fires on an
explicit user click. No cost leaks found anywhere.

**One real, worth-fixing finding on the renderer side**: the 30s
`setInterval` poll unconditionally called `renderSidebar()` (full
`innerHTML=""` + rebuild) even when nothing the sidebar displays had
changed since the last poll — 100% wasted work most ticks, all day, every
day the app is open. (Everything else flagged — an O(n²)-shaped grouping
loop, transcript re-reads, potential memory-leak shapes in
pendingLaunchCallbacks/launchPaneHistory/paneNavHistory — checked out fine
at this app's real scale; no action needed on those.)

**Fix**: `computeSidebarFingerprint(sessions, config)` builds a cheap string
from exactly the fields renderSidebar()'s OUTPUT depends on (session
identity/status/model/archived + the Jot badge fields + config.groups/
sidebarMode/archiveSuggestions/hideArchived) — deliberately not a full
JSON.stringify of the whole payload, since most session fields (turns, cwd,
etc.) don't affect a sidebar row and would cause false-positive "changed."
`refresh()` compares this against the previous poll's fingerprint and skips
`renderSidebar()` when unchanged. Every OTHER call site that renders on a
real user action (search, category CRUD, opening a session, drag-reorder,
...) still calls `renderSidebar()` directly and is unaffected by this cache
— it only guards the unconditional 30s timer tick. Sensitivity verified
standalone (7/7: status change, group rename, collapse toggle, new session,
deadline change, archiveSuggestions toggle, and identical-data-stays-
identical all behave correctly).

## 2026-07-02 — Manual "✓ Done" button on the last reply (not a sidebar pill)

**Decision:** Aidin's ask: "jag hoppas fas 3 orkestratorn löser detta men man
kanske också ska stoppa en manuell check på varje svar så att jag med den kan
ange - jag är klar med denna" (a session that ended with a real answer, e.g.
"here's what to tell your colleagues," has nothing left to do but still sits
in "Needs you" until the attention window expires — he wants a manual check
ahead of the Fas 3 orchestrator eventually automating it). First built it as
a "✓ Done" pill on the sidebar ROW. Feedback: "Nej, inte riktigt vad jag
tänkt mig. Jag vill ha den per svar inte per session" — he'd literally said
"per svar" (per reply) in the original ask and I'd read it as "per session."
Moved the button to the reply itself: it now sits under the LAST assistant
bubble in the pane (only that one — it's the only reply whose ack actually
changes the session's status, since status is derived from the last
message's role/age; an older reply already has a newer one after it).
Backend unchanged — same `config.acknowledgedSessions[sessionId] =
lastActivityAt` mechanism (stale-checks itself on new activity, no cleanup
code needed), same recipe as `titleOverrides`. Only the affordance's
LOCATION changed, from `rowEl()` (sidebar) to `wireDoneButtonOnLastReply()`
(pane, alongside `wireEditableUserTurns`) — deliberately always-visible
(unlike `.copy-btn`/`.rewind-btn`'s hover-only opacity) since it's a status
affordance like `.archive-suggest-pill`, not a hover utility.

Before the relocation, review caught a real ordering bug in the backend:
`sessions:get` ran `enrichWithJot` (computes `attentionScore`/
`needsAttention` off `session.status`) BEFORE the ack-downgrade loop, so an
acknowledged session's score/spotlight stayed stuck at full "waiting" weight
even though it displayed as idle. Fixed by moving the downgrade before
`enrichWithJot` — this fix carried over unchanged through the relocation.

## 2026-07-02 — Collapse/expand-all-categories button (the "list-sorting view")

**Decision:** Aidin's follow-up on the (now-working) category drag-reorder:
"needs a dedicated view for list sorting — sounds like a simple collapse/
expand-all button." Built exactly that: a toolbar button that toggles all
categories collapsed↔expanded at once (if all are already collapsed, expand;
else collapse), so you can drop the whole sidebar to just category headers,
see and reorder the list order at a glance, then expand back. Persists via
each group's existing `collapsed` flag — no new state. Deliberately the
lightweight option over a separate modal/settings-page reorder UI (the two
heavier ideas from the discussion), matching Aidin's "simple button" framing.

## 2026-07-02 — Rewind rebuilt as real transcript-forking (the true desktop behavior)

**Decision:** Second round of rewind feedback: "all history still disappears
— in the desktop app only the messages AFTER the rewind point vanish." The
same-pane-with-text-replay approach still dumped everything into a draft
blob; the prior conversation didn't stay as real rendered history. To get the
actual desktop behavior I first had to answer whether it's even buildable on
the CLI.

**Spike (`spike/test-rewind-fork.mjs`) — PASS.** Created a throwaway session
(favorite color blue → changed to red), hand-truncated a fork of its
transcript to before the "red" turn, wrote it as a new `<uuid>.jsonl`, and
`--resume`d it: it answered "blue." So `claude --resume` reads a
hand-authored truncated transcript with NO desktop metadata, and
post-truncation turns are genuinely gone from the model's context. Real
rewind is buildable. (First run was inconclusive — I'd used a "secret code"
probe that Haiku refused as suspicious; swapped to an innocuous favorite-
color fact and it worked. Test-design fix, not a mechanism problem.)

**Built:** `forkTranscriptAtUserMessage(cliSessionId, userMsgIndex)` in
sessions.js writes a truncated fork beside the original (never touches it);
IPC `session:fork`; `rewindToTurn` loads the fork IN THE SAME pane, so the
prior turns render as REAL bubbles (they're in the forked transcript), later
turns are gone, and the clicked message drops into the composer to edit.
Exactly the desktop behavior.

**Two off-by-one bugs caught (one by me pre-review, one by the review) —
both about the rendered-bubble index the button passes NOT matching the
fork's transcript line count:** (1) the fork counted `<task-notification>`
and empty user lines that transcript.js does NOT render as user bubbles —
common in an orchestrator that spawns subagents — so it'd cut at the wrong
message; fixed by mirroring pushUserTurn's exact predicate. (2) On a
tail-truncated view of a very long session, rendered bubbles start at a
non-zero turn while the fork counts from absolute 0; fixed by gating rewind
to only appear when the full transcript is loaded (`!transcriptTruncated`),
and stopping the "show earlier" handler from hardcoding hiddenCount=0.
Truncation logic unit-tested standalone (incl. task-notif/empty/tool_result
exclusion); async safety, file-write safety, and no-metadata handling all
reviewed clean.

**Known limitation:** the fork has no desktop `local_*.json`, so it won't
appear in the sidebar's session list — it's a working branch, resumable in
its pane but not (yet) catalogued.

## 2026-07-02 — Rewind now happens in the SAME pane (Aidin's call on the constraint tradeoff)

**Decision:** Aidin's review: rewind "switches to a new session instead of
continuing in the same session." Surfaced the hard constraint to him —
`--resume` takes the WHOLE transcript, so "same session" AND "drop future
context" can't both hold; it's genuinely either/or. Asked which he wanted
(AskUserQuestion, with the tradeoff spelled out). He chose **"same pane, fork
underneath"**: rewind now replaces the CURRENT pane in place (no new pane
pops up — feels like going back in this conversation), while underneath it's
still a fresh forked session with prior context replayed, so future context
is genuinely dropped, not just hidden. This is the option that keeps rewind's
unique value (the other option — truly same session via --resume — would
have made it a near-duplicate of the existing double-click-edit-resend, since
it couldn't drop context).

**Implementation:** `openFreshDraftInPane`'s 3rd arg went from a bare
`avoidIndex` to an options object: `{ forceIndex }` (rewind — target this
exact pane) or `{ avoidIndex }` (summarize — don't clobber the pane you're
looking at). Rewind passes `forceIndex: sourceIndex`. The forced pane's view
is replaced by a fresh draft; sending starts a new session (freshPane has no
cliSessionId, so sendFromPane won't --resume) with the replayed context in
the prompt. Rewinding a BUSY pane orphans its in-flight launch exactly like
"+/new chat" already does — consistent, not a new failure mode. The replaced
session's transcript stays on disk, reopenable from the sidebar.

## 2026-07-02 — Review feedback: category-drag regression fixed, mouse back/forward wired

Aidin's review of the backlog batch surfaced two concrete issues (plus a
rewind design question handled separately):

1. **Regression — "can't drag a list anymore."** The drag-collapse feature
   (hide session lists to headers during a category drag) broke dragging
   entirely: hiding the `.section-list` elements SYNCHRONOUSLY inside the
   `dragstart` handler reflows the drag source, which Chromium/Electron
   treats as grounds to cancel the drag outright. Classic gotcha. Fixed by
   deferring the collapse to a `requestAnimationFrame` after dragstart
   finishes (dataTransfer.setData/effectAllowed stay synchronous — they must
   — only the visual collapse is deferred), with a guard against the drag
   already having ended by then. Worth noting: the cumulative review had
   reasoned about whether the collapse disturbed the drop-position MATH
   (it didn't) but not whether the reflow ABORTS the drag — a real-hands-on
   failure a static review couldn't catch.
2. **Mouse back/forward buttons** now drive the focused pane's chat history,
   same as the ←/→ header buttons — a document-level `mouseup` listener on
   `e.button === 3` (back) / `4` (forward).

## 2026-07-02 — Cumulative integration review of the whole backlog batch; one glitch fixed

Aidin asked for a review of all the backlog-pass fixes before his own manual
review. Each feature already had an isolated review when built, so this pass
took the CUMULATIVE / integration angle across the two clusters they share
code in: sidebar (category DnD reorder + drag-collapse + back/forward nav +
deadline chip) and workspace (resizable split + rewind + queue-next-prompt +
event routing + version badge).

**Workspace cluster: fully clean** — no cross-feature bugs. Notably confirmed
the inserted `.pane-divider` element (between panes 0/1) breaks nothing,
because every pane lookup is `[data-pane="N"]`-attribute-based, never
child-index/sibling-based; `pane.els` never goes stale because `renderPane`
(the "done"/transcript-reload path) rebuilds only `.pane-scroll`, not the
composer; and `fireQueuedPromptIfAny` runs synchronously after the identity
guard with no intervening await.

**Sidebar cluster: one medium glitch, fixed.** The 30s `refresh()` timer (or
any session event) could call `renderSidebar()` mid category-drag —
`innerHTML=""` destroying the dragged header and un-hiding the collapsed
lists mid-gesture (a jarring layout jump; not corruption — the HTML5 drag
continues on the detached node and the drop still resolves via the persisted
dataTransfer). Fixed: `refresh()` skips the sidebar rebuild while a category
drag is in progress, gated on a `categoryDragStartedAt` TIMESTAMP (not a
bool) so a drag that somehow never ends self-heals after 30s instead of
freezing the sidebar — dragend clears it in every normal case.

## 2026-07-02 — Resizable split panes (the contained half of the split-view ask)

**Decision:** Split the "split view ska kunna drag-and-dropas som i VS Code +
kunna justeras i bredd" backlog item into its two halves and shipped the
tractable one: a draggable divider between the two panes that adjusts their
relative width (module-level `splitRatio`, clamped 0.2–0.8, applied via
`--left-fr`/`--right-fr` grid vars). The other half — full VS Code-style
dockable/rearrangeable panes — is genuinely larger UI work and stays open
for its own focused session. Pointer-capture drag so tracking survives the
cursor leaving the thin divider mid-drag. `splitRatio` is in-memory (survives
split toggles within a session, resets on restart) — persisting to config is
a noted possible follow-up, deliberately not done to keep v1 contained.

Passed an independent review (pane indexing unaffected by inserting the
divider element between panes, pointer-handler cleanup leak-free, single-pane
layout ignores the stale fr vars). Review flagged one cosmetic issue — a
0-width divider column drew a faint double-seam via the base 1px grid gap on
both sides — fixed by making the divider a real 1px column that IS the seam,
with gap:0 on the split grid.

## 2026-07-02 — Deadline-aware attention sorting from Jot

**Decision:** Jot todos carry an optional `deadline` (epoch ms) — now factored
into the sidebar's attention ranking. `jot.js` surfaces each category's
`nearestDeadline` (soonest deadline among its still-open, non-done tasks,
overdue ones included since they're the MOST urgent). `sessions.js` adds a
tiered boost to `attentionScore` via `deadlineBoost()`: overdue = full weight
(default 80, a new configurable `deadline` weight), <24h = 75%, <3d = 45%,
<7d = 20%, beyond a week = 0 (a deadline that far off shouldn't reorder the
board yet). A "⏰ due in Nd / due today / overdue" chip renders on the row in
BOTH simple and advanced views (unlike the advanced-only Jot-counts chip) —
a bearing-down deadline is high-signal and it's what's reordering the row, so
hiding it in the default view would make the sort look arbitrary.

Verified the full pipeline against real Jot data: the boost math is correct
across all tiers (standalone test), and `nearestDeadline` surfaces correctly
(the one real deadline in the board today is 2027, >7 days out, so it
correctly produces no boost and no chip yet — the machinery is dormant until
a near-term deadline exists, which is the intended behavior, not a bug).

## 2026-07-02 — "Rewind to here": fresh session replaying prior context, since --resume can't retract turns

**Decision:** Mirrors the desktop app's rewind icon, but implemented around
a hard constraint: the CLI's `--resume` cannot retract turns from an
existing session. So instead of editing the old session in place, clicking
"⤺" on a past user message opens a FRESH session/pane whose draft replays
the conversation up to (not including) that message, then the message itself
as an editable draft — future context is genuinely dropped, not just
visually hidden. Prior turns are replayed VERBATIM (not LLM-summarized like
Fas 2's carry-over): a rewind is usually to somewhere recent where the raw
exchange is more faithful than a lossy summary, and it keeps the action
instant and free. Capped at the 30 most-recent prior text turns (with an
"N omitted" note) and 500 chars/turn so rewinding deep into a long chat
can't build a pathological draft. Distinct from the existing double-click-
to-edit-and-resend (which just refills the current composer, appending a new
turn to the SAME session — no context dropped).

**Critical bug caught in review, fixed before shipping:** the shared
`openFreshDraftInPane` → `pickDraftTargetPane` helper, when both panes are
full, fell back to `focusedPaneIndex` and overwrote it in place. Since the
rewind button lives INSIDE a pane (which is focused when you click it), this
meant rewinding in a two-pane layout wiped the very conversation you were
rewinding from. (Latent gap the summarize feature shared but rarely hit,
since summarize is triggered from the sidebar with a free pane usually
available.) Fixed by threading an `avoidIndex` through so the fallback picks
the OTHER pane, never the source; verified across 5 pane-layout scenarios
plus the draft-building logic across 3 (excludes future turns + tool noise,
caps correctly keeping most-recent, handles zero-prior-context first
message). The clobber was never real data loss — the session's transcript on
disk is untouched and reopenable — but it was destructive to the pane view
and exactly the wrong pane.

## 2026-07-02 — Drag-and-drop reorder for categories themselves, not just sessions

**Decision:** Categories/lists in the sidebar could never be reordered
relative to each other before — only sessions within a category could be
dragged. Added the same VS Code-style reorder to category headers: a
distinct dataTransfer type (`"text/category-label"`, never
`"text/session-id"`) so it can never be confused with session-row dragging
that already lives on the same header element (dropping a session onto a
category header still appends it there, unchanged). Reuses the exact
zero-layout-impact pseudo-element indicator technique already proven for
session rows, just scoped to `.section` instead of `.row`. Only the header
itself is draggable, not the whole (session-count-dependent, sometimes very
tall) section — a small fixed-size handle is far easier to aim than judging
"top half vs bottom half" of a 30-session category.

**Real bug caught in review:** the session-row's own `dragover`/`drop`
handlers had no guard against a CATEGORY-type drag landing on them — so
dragging a category header over an unrelated session row (in a different
category's list) falsely showed a session-row drop indicator that would
never actually do anything (the row's drop handler already no-ops on a
missing `text/session-id`, so no data corruption, but the UI lied about
having a valid target here). The same gap existed in `wireListDropZone`
(empty list space). Fixed by adding an early `types.includes("text/category-
label")` guard to both.

Splice-based reorder math unit-tested standalone (6/6 scenarios) before
shipping; DOM/event integration passed an independent review.

## 2026-07-02 — Backlog pass: version numbering, pinned card, split-icon fix, queue-next-prompt, chat history nav

Working through the priority-0 Jot backlog. Five shipped this pass, each
boot-tested and independently reviewed:

1. **Version numbering** (`src/lib/version.js`) — same scheme as Crewline
   (major.minor hand-bumped in `package.json`, a trailing number that's
   actually a commit count since that bump so it resets to 0 on every bump
   instead of growing forever). Crewline computes this at Vite build time;
   Maestro has no bundler, so it runs once at app startup via `git log -1
   -S... -- package.json` + `git rev-list --count`. Verified end-to-end
   against the real repo (`v0.1.32`) before wiring into the UI. Review
   caught the pickaxe search string being too loose (`"0.1` would also
   match `0.10`, `0.11`, `0.1.5`) — fixed with a trailing-dot anchor,
   re-verified after the fix.
2. **Split-view icon fixed a self-inflicted collision** — it was "⧉", the
   exact same glyph used for the copy button (added a few commits ago in
   the Tier 3 pass, without noticing the reuse). Changed to "◫".
3. **Orchestrator card now genuinely pinned** — it was the first child
   appended INSIDE the scrollable `#sidebarBody`, so it scrolled out of
   view with everything else despite being called "pinned." Moved to a new
   sibling `#sidebarPinned` div above the scroll area.
4. **Queue next prompt** ("flika in" scenario 2 from Aidin's clarification:
   queue a follow-up to run once the current job finishes, distinct from
   scenario 1 — inject info into a run that's already happening — which
   still needs the persistent-process architecture decision). Typing while
   a pane is busy and pressing Enter now queues instead of silently
   discarding the text (a real pre-existing bug: Enter-while-busy called
   the SAME handler as Stop, which never read the textbox at all — so
   typing + Enter while busy used to both lose your text AND kill the run).
   Fires through the exact same `sendFromPane` path once "done" arrives, no
   duplicated send logic.
5. **Back/forward chat navigation** between chats opened in a pane, browser-
   tab style. History lives in a module-level map keyed by pane INDEX, not
   on the pane object (which gets fully replaced on every navigation).
   Review caught two real bugs: `navigateHistory` advanced its position
   pointer before confirming the target session still existed, silently
   desyncing the buttons from what was actually navigable if a session in
   history had been archived/removed — fixed to walk past dead entries
   instead of committing to one blindly. And `paneNavHistory` was cleared on
   split-close but NOT on "New chat" (either the sidebar button or the
   pane-header reset) — an inconsistency, now fixed in both places.

## 2026-07-02 — Fix the last bullet-list spacing gap; "tight" transition out of a list

**Decision:** New feedback on the already-fixed bullet spacing: the
transition INTO a list got a deliberate gap (`.md-li`'s own `margin-top`),
but the transition OUT of one — the line right after the last bullet,
resuming prose or a bold lead-in — got nothing, since a plain `<span>` has
no margin rule at all. It sat flush against the last bullet with only
incidental line-height between them, reading as "tight" next to every other
spaced transition in the same bubble. Fixed with a new `.md-after-list`
class (mirrors `.md-li`'s own 10px) applied when the nearest actual content
line above (skipping blank separators) was a list line.

**Two real bugs caught in review before shipping**, both in the SAME spot as
the earlier bullet-spacing fix: `precededByListLine`'s single-line lookback
missed the common case of TWO OR MORE consecutive blank lines between a list
and the next paragraph — only the first blank got skipped, the rest
re-rendered as ordinary empty lines, reintroducing the doubled-gap problem
the earlier fix existed to solve, this time compounded by the new margin.
Fixed by generalizing to a bidirectional `nearestContentLine(lines, idx,
direction)` walk used by BOTH the blank-line-skip check and the after-list
detection — now correct for any number of consecutive blanks. A second
flagged concern (that a preceding `<br>` might stack with `.md-after-list`'s
`margin-top`, making the gap larger than the into-list case) was
investigated and did NOT reproduce — traced the control flow by hand and
confirmed empirically (6 scenarios via a standalone DOM-trace script) that
no `<br>` is ever emitted immediately before an after-list span, so the two
gaps ARE symmetric as intended.

**Also cleaned up two misplaced Jot cards while triaging in-progress**: a
drag-and-drop comment ("konstiga markeringar") had landed on the unrelated
interject-during-execution task again (second time this exact card has had
stray feedback attached) — rerouted to the DnD task, then the user confirmed
it was itself a misfire and it moved back to review with no code change.
Two other in-progress items (the blocking-input UI, the interject feature)
moved back to open — no new feedback, still genuinely blocked on an
architecture decision, not something actively being worked.

## 2026-07-02 — Second review round (Opus) over the shipped Tier 1-3 fixes: 3 more real issues

Aidin (back on Opus) asked for a verification pass over everything Sonnet
shipped for the 15 review findings, plus a fresh review round. The per-batch
reviews each saw only their own batch; this round deliberately took the
CUMULATIVE / integration angle (the three tiers all touched the same
renderer event handler + main.js lifecycle) and re-read the final combined
state. It confirmed all 15 tier fixes are sound AND surfaced three genuine
issues the isolated reviews structurally couldn't see:

1. **`before-quit` killed children asynchronously — losing the race against
   the app's own exit** (`main.js`). The Tier-1 quit sweep called the async
   `taskkill` form and didn't await, so the app could tear down before the
   kill actually ran — orphaning the very process tree the sweep exists to
   clean up (the Stop-button path was fine; only quit was affected). Notably
   the Tier-1 per-batch review had explicitly dismissed this ("fired
   async/best-effort... not a concern") — a fresh adversarial pass caught
   what a confirm-the-fix pass didn't. Fixed with a synchronous `execFileSync`
   kill on the quit path only.

2. **`fs.readSync`'s return value was ignored in the transcript tail read**
   (`transcript.js`). Node explicitly warns the buffer may not be fully
   filled; a short read would leave `Buffer.alloc`'s zero-fill as NUL bytes
   appended to the last line, which then fails `JSON.parse` and silently
   drops the most recent turn(s). Low-probability (only under a concurrent
   truncation of the file), but the fix is unambiguous: decode only
   `buffer.toString("utf8", 0, bytesRead)`.

3. **"Summarize & carry over" silently drove the judge + usage analytics**
   (`main.js` + `renderer.js`) — the highest-value find, and a textbook
   cross-batch defect. The summarize feature (Fas 2, built BEFORE the
   model-fit judge and usage analytics existed) resumes a session via the
   same `startSession` path, so every summarize spent a real ~$0.015 judge
   call AND injected a synthetic run — hidden carry-over prompt, model forced
   to sonnet-5 — into the exact By-model / Model-fit / Suggestion-accuracy
   views the app is built to surface. No isolated review could see it: it's
   the interaction of a feature from one era with a pipeline from another.
   Fixed with an `internal: true` flag threaded startSession -> IPC ->
   main.js that suppresses the usage log, the completion notification, and
   the judge for Maestro's own internal launches (the renderer still gets its
   `done` event, which the summarize callback needs).

Both fresh reviewers otherwise confirmed the shipped work clean: the
pane-routing consolidation integrates correctly across all three batches, no
map leaks, no reentrancy, the atomic archive write / config deep-merge /
judge output-cap all hold against the probed edge cases. Per Aidin's
explicit say-so this one time, all 15 finding tasks moved to done (normally
they'd sit in review for his own check).

## 2026-07-02 — Tier 3 fixes from the full-app review: polish/a11y (closes the review)

**1. config.js deep-merge for nested defaults** — a shallow
`{...DEFAULT_CONFIG, ...parsed}` meant a config.json with a partial
`jot`/`modelFitJudge`/`archiveSuggestions` object silently dropped the other
default sub-keys. Now merges those three (the only fixed-shape nested
defaults — everything else is a free-form map/array where shallow replace
is correct) one level deep.

**2. paths.js skips symlinks in the session-directory walk** — a symlinked
subdirectory reports `isDirectory()` true, so a symlink cycle under the
session-storage tree would re-walk the same target repeatedly until the
existing depth guard finally stopped it. Real subdirectories there are never
symlinks (it's app-managed storage), so skipping them outright has no
downside.

**3. Stop-vs-natural-completion race** — a process finishing naturally in the
small window between a Stop click and the IPC call landing still showed
"⏹ Stopped." even though it completed normally, because the check was
`pane.stopRequested` alone. Now also checks `!evt.summary?.sawResult`
(confirmed in `launcher.js`: only set when the CLI itself emitted a genuine
`result` event) — a stop-click race that turns out to have actually finished
is now correctly treated as a completion, not a stop.

**4. Context-menu keyboard/UX** — three small additions: Escape now closes
the context menu (previously only an outside click did; verified no conflict
with the inline-edit input's own Escape handling, which stops propagation
before it can reach this new document-level listener); the "Move to
category" submenu now flips to the left side when it would overflow past the
right edge of the window (right-clicking a row near the edge used to push it
off-screen with no way to reach it); the copy button under an assistant
reply is now visible on keyboard focus, not just mouse hover (previously
invisible to keyboard/touch entirely).

**Investigated, not changed:** the inline-edit "blur commits the edit"
behavior the review flagged — re-read `makeInlineEditable`'s own doc comment
and found this is already-intentional, already-documented design (Enter/blur
commit, Escape cancels — Escape-to-cancel was already correctly wired, just
not what the review initially assumed was missing). Left as-is rather than
change a working, deliberate behavior. Full keyboard arrow-navigation
through the custom context menu/dropdown was scoped OUT of this pass — a
real accessibility gap, but a larger UI undertaking than "polish," better
addressed as its own piece of work if it matters enough to prioritize.

All 4 fixes passed an independent review — no new bugs found. **This closes
the full-app review**: 15 findings across 3 tiers, all fixed and verified.

## 2026-07-02 — Tier 2 fixes from the full-app review: robustness/degradation

**1. Unbounded transcript read** (`transcript.js`) — a huge .jsonl file was
read whole into memory then doubled via `split("\n")`, blocking the main
process. Now caps the read to the trailing 8MB via a byte-offset `readSync`
(mirrors sessions.js's own 96KB tail-read technique, sized for actually
rendering chat instead of just checking the last message's role), dropping
the resulting partial first line. Caught two of my own mistakes before
shipping: `hiddenCount` could go negative when the tail window happened to
produce fewer turns than `maxTurns` (fixed with a `Math.max` floor), and
review flagged `totalLines` silently changing meaning (whole-file count →
partial-window count) once the cap could kick in — renamed to `linesRead`
since nothing in the codebase consumes the field today, so the honest name
costs nothing.

**2. Judge had no timeout** (`judge.js`) — a hung Haiku call (network stall,
an auth prompt with no TTY to answer) left the child running forever and the
fire-and-forget promise dangling. Added a 30s timeout that kills the child
and resolves `null`, a 1MB output cap, and a `settled` guard so a
timeout-then-close race can't resolve twice.

**3. backgroundTasks — unbounded growth + dropped out-of-order events**
(`renderer.js`) — the only removal path was the manual "Clear finished"
click, and `task_progress`/`task_updated`/`task_done` for a taskId with no
prior `task_started` (this stream has no delivery-order guarantee) were
silently ignored, making that task permanently invisible. Added an
auto-prune for terminal tasks older than an hour, and `getOrCreateBackgroundTask()`
so those three event kinds backfill a placeholder instead of dropping the
event. Caught a real bug myself before the review even ran: `task_started`
unconditionally overwrote whatever was already there, including a
just-backfilled TERMINAL placeholder from an out-of-order `task_done` — a
demonstrably-finished task could get un-finished back to "running" forever.
Fixed by skipping the overwrite when the existing entry is already terminal.

**4. summarize/pendingLaunchCallbacks had no timeout** (`renderer.js`) — if
a summarize launch's "done"/"error" never arrived, `summarizeAndCarryOver`
awaited forever and the pane's status line stuck on "Summarizing…"
permanently. Added a 5-minute timeout that resolves an error and cleans up
the map entry.

**5. Table-cell splitter broke on pipes in inline code/escapes** (`renderer.js`,
`tableCells`) — `line.split("|")` treated every `|` as a column delimiter,
so a cell like `` `Set-Cookie: a|b` `` or an escaped `\|` misaligned the
whole row. Replaced with a char-by-char parser that treats a pipe inside a
backtick span, or escaped as `\|`, as literal content. Unit-tested standalone
(5/5 cases) before shipping.

**Investigated, not changed:** the review also flagged the code-fence
info-string strip (`renderMarkdownInto`) as possibly eating a real content
line when a fenced block has no language tag and its first line is a bare
token. Traced through the actual regex behavior for both the "language tag
present" and "no language tag" cases by hand — in both, only the true
info-string line is stripped, matching CommonMark's own spec (whatever text
follows the opening fence up to the first newline IS the info string, by
definition — there's no way to distinguish "real code" from "info string"
that lands on that exact line, because in well-formed markdown they're the
same line and even CommonMark itself doesn't try). Left as-is rather than
"fix" something that traced out to already be spec-correct.

All fixes passed an independent review; only the `totalLines`/`linesRead`
naming issue survived as a real (if currently inert) finding, fixed above.

## 2026-07-02 — Full-app review (4 parallel Opus reviewers), Tier 1 fixes shipped

**Context:** ran a whole-codebase review (main process/IPC, data/read layer,
renderer state/lifecycle, renderer DOM/CSS/UX — 4 independent reviewers, no
sub-agents), synthesized + personally verified the top findings against the
actual code, then ranked everything into Tier 1 (real bugs) / Tier 2
(robustness/degradation) / Tier 3 (polish/a11y). All 15 findings filed in
Jot at priority -2. Fixing all of them in order per Aidin's explicit ask.

**Tier 1, shipped this batch (6 fixes):**

1. **Stop didn't kill the process tree on Windows** (`main.js`) —
   `child.kill()` only signals the top-level `claude.exe`; its own children
   (model runtime, MCP servers, subagents) survived and kept running/costing
   subscription usage. New `killChildTree()` uses `taskkill /pid <pid> /T /F`
   on win32. **Verified empirically**, not just by reading the code: spawned
   a real 2-level process tree, confirmed plain `kill()` left an orphan
   (before=16, after=17) and `taskkill /T /F` cleaned up fully (after=17,
   back to baseline).
2. **Nothing killed live children on app quit** — added an `app.on("before-
   quit")` sweep over `liveChildren` using the same `killChildTree()`.
3. **Unprotected post-run bookkeeping could strand a pane as "running"
   forever** — `done.then(...)` used to run `appendUsageLog`/Notification/
   judge-kickoff BEFORE sending the `done` IPC event; a throw in any of them
   (corrupt config, disk-full log write) meant the renderer never got
   unblocked. Now `send({kind:"done"})` fires first, and everything after it
   is wrapped in try/catch (+ a `.catch()` on the judge's own promise chain).
4. **Archive write was non-atomic against another app's live file**
   (`sessions.js`) — `writeFileSync` truncates-then-writes; a crash/disk-full
   mid-write could corrupt the desktop app's own session file. Now writes to
   a temp file in the same directory + `renameSync` (atomic same-volume),
   with best-effort cleanup if the rename itself fails. Verified the temp
   name's shape (`.<file>.<hex>.tmp`) is invisible to every directory scan
   that looks for `local_*.json`.
5. **Orphaned launch could bleed into an unrelated new session, and the
   error path leaked forever** (`renderer.js`) — the biggest structural fix.
   A separate `paneLaunchMap` (launchId→index, no identity check) routed
   every launch-scoped event, and its own cleanup only ran on `done`, never
   on `error` — an unbounded leak on every failed launch. Removed entirely;
   ALL launch-scoped events (session/tool_use/assistant/error/done/modelFit)
   now route through the existing `launchPaneHistory` map with the identity
   check (`panes[index] === pane`) already used elsewhere in this codebase.
   `quota` was pulled out of the pane-gated switch too — it's app-wide and
   was being silently dropped whenever the routing lookup failed for
   unrelated reasons.
6. **`pruneStaleLaunchHistory`'s blind time cutoff became a correctness
   risk** once launchPaneHistory became the ONLY routing table (previously
   it only fed the model-fit judge, where losing an entry early was a
   cosmetic miss at worst) — a long xhigh-effort prompt running past the
   10-minute cutoff would have had its entry pruned mid-run, silently
   dropping its remaining events. Fixed: never prune an entry whose pane is
   still attached AND still busy; only the time cutoff applies once a launch
   is actually finished or orphaned.

All 4 fixes passed an independent review pass (main-process integration,
atomic-write correctness, and the full renderer-routing consolidation with
its 4 specific correctness questions) — no new bugs found.

## 2026-07-02 — Drag-and-drop reorder: full rewrite (single source of truth + zero-layout indicator)

**Decision:** After two partial fixes didn't fully resolve "reorder is
sporadic / doesn't land where I drop it," rewrote the interaction rather than
patch it a third time. Two root causes, both now gone:

1. **The indicator was a real block element inserted into the list flow**
   (`row.before(line)`). Even inert (`pointer-events:none`), it took vertical
   space, so every row below shifted and every `getBoundingClientRect()` on
   the next `dragover` was offset — a feedback loop that could flip the
   insertion point with a stationary mouse. Now the indicator is a pure CSS
   class drawing an absolutely-positioned `::before`/`::after` line (`.row`
   is `position:relative`), which takes zero space and never reflows.
2. **Drop recomputed the position from a fresh rect** (`nextRowSessionId`),
   a second measurement independent of what the indicator showed — so once
   layout had shifted, the drop could land somewhere other than the line.
   Now a module-level `dropTarget = {row, before}` is set in `dragover` and
   read verbatim by `drop`. Single source of truth: the drop acts on exactly
   the indicator you saw.

**Edge cases handled:** dropping onto the row you're dragging is a true
no-op (guarded in both `dragover` and `drop`); "after row X" skips a trailing
`.dragging` sibling so dropping just below the dragged item isn't an
off-by-one move; `clearDropIndicators()` is document-wide (required — a
cross-category drag must clear the previous list's marker) and called before
every marker add, so exactly one shows at a time; `dragend` is the catch-all
reset for Escape / drop-outside-any-zone, so no stale `dropTarget` survives
into the next drag.

**Verification:** the pure index-reorder math was unit-tested standalone
(9/9 scenarios incl. adjacent no-ops) and the DOM/event/state lifecycle
passed an independent review across all four drop paths. Removed
`insertion-line` / `nextRowSessionId` / `clearInsertionLines` entirely.
Still needs Aidin's hands-on confirmation that the *feel* is finally right.

## 2026-07-02 — Root-caused the bullet-spacing bug; partial fix for sporadic drag-and-drop; Archive page split into 2 columns

**Bullet spacing, actually fixed this time:** the earlier `.md-li + .md-li`
CSS rule (shipped a few commits ago) never actually did anything — it just
looked like it should. `renderInlineLines` unconditionally inserted a `<br>`
after every line (list or not) and rendered every blank line as an empty
`<span>`, so real assistant output with blank lines between bullets produced
`<div class="md-li">...</div><br><span></span><br><div class="md-li">...`.
A `<br>`/`<span>` sitting between two `.md-li` divs means they are not
adjacent siblings, so `.md-li + .md-li` could never match. Fixed at the
source: blank lines touching a list line are now skipped entirely (they're
pure markdown separation, not content), and a `<br>` is only ever inserted
between two consecutive PLAIN-TEXT lines — never immediately before/after a
list item, since a `display:block` div already forces its own line break.
Verified with a standalone DOM-trace script before shipping (five cases:
blank-separated list, non-blank list, plain multi-line text, blank-separated
paragraphs, heading-then-list) — non-list rendering is byte-for-byte
identical to before, only the list-adjacency case changed.

**Drag-and-drop reorder, partial fix:** "still very sporadic" after the
earlier `pointer-events: none` fix. Real remaining cause: the dragover
handler unconditionally removed and re-inserted the insertion-line indicator
on EVERY dragover event (which fires continuously, far more often than the
mouse crosses a row's midpoint) — inserting that line shifts the list's
layout, which shifts every row's `getBoundingClientRect()` for the NEXT
event, creating a feedback loop that could flip the insertion point even
with a stationary mouse. Fixed by skipping the DOM mutation when the line is
already exactly where it belongs. **Honest caveat:** this fixes
dragover-loop-induced flicker specifically; it does NOT touch the
drop-time midpoint recalculation in `nextRowSessionId`, which could still
occasionally disagree with what was last shown if the mouse moves fast
between the last dragover and the drop. If it's still not fully reliable
after this, the more thorough fix is caching each row's position once at
drag-start instead of re-measuring live throughout the drag.

**Archive page:** the two sections (Archived / Removed from Maestro) now sit
side-by-side in the same 2-column grid the Analysis page already uses,
instead of stacked vertically.

## 2026-07-02 — New "Archive" page: see and restore hidden/archived sessions

**Decision:** Added a 4th header tab, "Archive," with two sections —
"Archived sessions" (`isArchived: true`, real desktop-app state; an
"Unarchive" button flips it back via the existing `session:archive` IPC
handler with `archived: false`) and "Removed from Maestro" (sessions in
`config.hiddenSessions`; a "Restore" button removes the id from that array).
No new IPC or data source needed — both flags were already tracked, there
was just no UI to see or undo either one before now (archiving/removing were
one-way outside manually editing `config.json`).

**Why:** direct request after shipping manual archiving — "we need a page to
see all hidden + archived sessions to get them back if needed." Both
"hide" actions were one-way by design (a deliberate choice at the time,
documented above), but that only works long-term with an undo path, which
didn't exist until now.

**Bug caught in review:** the two flags (`isArchived`, `hiddenSessions`) are
independent — a session could be both archived AND hidden, which would have
listed it in both sections with two unrelated "get it back" buttons.
Archived sessions are now excluded from the "Removed from Maestro" list;
unarchiving is enough to see it again here, even if it's separately still
hidden from Maestro's own sidebar.

## 2026-07-02 — Jot-review fix batch: bullet spacing, icon-only copy button, a real DnD drop bug, image lightbox

**Bullet-list spacing:** a side-by-side vs. the desktop app showed the gap
after a heading was right but consecutive bullets read as too tall. Each
list line renders as a standalone sibling `<div class="md-li">` (no `<ul>`
wrapper), so `.md-li + .md-li { margin-top: 4px }` (down from the uniform
10px) tightens only "bullet right after another bullet" while leaving the
gap after a heading/paragraph untouched.

**Copy button:** changed from an always-visible "Copy" text button under
every assistant reply to an icon-only button (⧉ / ✓), invisible until the
row is hovered.

**Real bug in drag-and-drop reordering:** category reordering "worked but
jumped and didn't always land where I dropped it." Root cause: the visual
insertion-line indicator shown between rows is a sibling `<div>` with no
drop handler of its own. Dropping exactly ON the line (the natural thing to
do — it's what "drop here" is pointing at) made the line itself the drop
event's `e.target`; the list container's own drop handler bails via an
`e.target !== el` guard meant for a *different* case (append-on-empty-space),
so the drop was silently swallowed. Fixed with `pointer-events: none` on
`.insertion-line` so drag/drop events pass through to whatever's actually
underneath.

**Image lightbox:** attachment chips now show a real thumbnail (via a new
`toFileUrl()` path→`file://` converter) instead of an emoji; clicking it
opens a full-screen enlarged view. Needed `img-src 'self' file:` added to
the CSP meta tag. Review caught a real bug in `toFileUrl`: it
`encodeURIComponent`'d every path segment including the drive letter,
turning `D:` into `D%3A` — Chromium does not decode that back to a drive
letter, so every thumbnail would have silently failed to load. Fixed by
leaving a bare `<letter>:` segment un-encoded; verified the corrected output
resolves via `new URL(...).pathname` before shipping.

## 2026-07-02 — Confirmed: mid-turn interjection genuinely works (not just between-turns) — architecture change, not built tonight

**Finding:** `spike/test-mid-turn-interject.mjs` sent a first message asking
the model to run `sleep 6 && echo done` via Bash, then wrote a SECOND stdin
message the moment the Bash tool_use event appeared — well before that
turn's `result` event. The final reply was `DONE1\n\nMAESTRO_INTERJECT_SEEN`:
the interjected instruction ("say MAESTRO_INTERJECT_SEEN") was genuinely
picked up and honored WITHIN the same in-progress turn, not queued for a
separate next turn. This is a real answer to the open "flika in med extra
info under körning" Jot task — `2026-07-01`'s spike only proved multi-turn
works BETWEEN completed turns; this is the first confirmation the actual
"interject while running" case works at all.

**Why not built tonight:** using this means switching a pane's session from
"spawn a fresh `-p` process per message" to "hold one persistent
`--input-format stream-json` process per pane for its whole conversation."
That touches Stop (currently: kill the process — would need to become "send
an interrupt within the persistent process" or similar), the model-fit judge
(currently fires from a one-shot process's exit), usage logging, and resume
semantics, all of which are hardened and working well right now per tonight's
and Aidin's own testing. This is real architecture surgery across several
already-verified code paths, not an evening feature — flagging for Aidin's
go-ahead on approach rather than autonomously rewiring the core launch
mechanism.

**Also verified, not previously known:** a long-running Bash tool call (the
6-second sleep) triggered `task_started`/`task_notification` system events —
the same lifecycle previously thought to be Agent/Task-tool-only. Not
investigated further tonight; worth knowing if the Background Tasks panel
should also reflect long individual tool calls, not just subagents.

**Honest note on how long this took:** spent well over half an hour chasing
a phantom "intermittent ENOENT spawning claude.exe" before finding the real
cause — the spike file was originally written via a bash heredoc
(`cat > file << 'EOF'`), which silently collapsed `"D:\\Repo\\Tools\\maestro"`
into a single-backslash string. `\R`, `\T`, `\m` are not recognized JS escape
sequences, so the literal cwd string became `"D:RepoToolsmaestro"` — an
invalid path, which Windows' CreateProcess surfaces as ENOENT on the
executable, not as an invalid-cwd error. This looked exactly like
"environment/sandbox flakiness" for a long time because it was NOT
consistently reproducible with structurally-similar test scripts written
correctly. Lesson: **write files with backslash-heavy Windows path strings
via the Write/Edit tool, never a bash heredoc** — this is now the second
time in this project a heredoc silently mangled backslashes (the first
being a Jot-update script earlier tonight).

## 2026-07-02 — Generalized image-paste to "attach any file," and closed the suggestion-heuristic feedback loop

**Decision (attachments):** The image-paste mechanism generalized cleanly to
plain files — a new 📎 button opens a file picker (`dialog:pickFiles`,
multi-select) and attaches by path exactly like a pasted image
(`[Attached file: <path>]` vs `[Attached image: <path>]`, based on extension).
Renamed `pane.pendingImages` → `pendingAttachments` throughout. No new
mechanism needed — this was always going to work the same way, images just
happened to be the first case.

**Decision (suggestion accuracy):** Closes the open "periodically analyze
whether the right model was suggested" task with a pull-model report instead
of a background job — added a `launchId` field to both the `"run"` and
`"modelFitVerdict"` usage-log entries so they can be joined per-run (not just
matched by model+time proximity), and a new "Suggestion accuracy" block on
the Analysis page comparing judge verdicts for runs where the auto-suggestion
was followed vs. overridden. If overriding scores better, that's a direct
signal `suggest.js`'s heuristic needs work — the report says so plainly
instead of hedging.

**Why a report instead of a cadence/trigger:** "do a periodic analysis" needs
a cadence decision (daily? weekly? after N runs?) that's Aidin's call, not
mine to guess. A report that's always current and one click away sidesteps
needing that decision at all, and the data foundation (`followedSuggestion`)
already existed — this was just never joined into something readable.

Both features (paste generalization, suggestion accuracy) passed independent
code-review agent passes before committing. The suggestion-accuracy review
caught a real bug: `launchId` was `++launchSeq`, an in-memory counter that
resets to 0 on every app restart, while `usage-log.jsonl` persists forever —
a verdict whose write got delayed past a NEW session's reused small integer
(e.g. both sessions' first run being `launchId: 1`) could join to the WRONG
run. Fixed by switching `launchId` to `crypto.randomUUID()` — it was already
used as an opaque Map key everywhere (IPC payload, `liveChildren`,
`paneLaunchMap`, `launchPaneHistory`), never arithmetic, so this needed no
other change.

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
background timer or heuristic that archives on its own — matches Aidin's
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
only. **Needs Aidin to verify once**: launch Maestro normally (not through a
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

**Why not the Agent SDK (`query()`) route, mirroring how Reinmaker does image
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
autonomously while Aidin is away. Maestro's existing "Remove from Maestro"
(hides via config.json only) remains the only session-hiding mechanism until
real archiving is explicitly requested and scoped carefully.

**Why this order:** the context-flow half directly unblocks Aidin's stated
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
  schema definitions (Aidin has several MCP servers configured) being sent on
  every non-bare invocation regardless of system prompt size — not CLAUDE.md.

**Why this matters beyond this feature:** any future "small utility call"
(judge, classifier, summarizer) that doesn't need tools should use this same
recipe (`--system-prompt` + empty `--allowed-tools` + empty
`--strict-mcp-config`) to stay cheap without giving up subscription auth.

**Toggle:** `config.json`'s `modelFitJudge.enabled` (default `true`, per
Aidin's explicit request "efter varje färdig prompt"). Set `false` to disable
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
`cwd`) forces a git worktree — which conflicts with Aidin's "work on main"
default. A harness lets *us* control cwd (real dir, on main, no worktree),
model/effort per task, and context injection.

**Alternatives considered:**
- *Headless service + Session Radar as its UI* — fastest to value, reuses the
  web dashboard. Rejected in favor of a polished dedicated app (Aidin's call);
  he already ships Electron apps (Loom, Jot).
- *Extend the Reinmaker/TG Studio wrapper* — shares a codebase but mixes a
  personal tool into a work product. Rejected: this is explicitly private.

## 2026-07-01 — Form factor: standalone Electron app

**Decision:** New standalone Electron + (likely React/TS) desktop app, same
pattern as Loom and Jot.

**Why:** Aidin wants a dedicated, polished UI and does not want to start
sessions via VS Code / CLI. Standalone keeps the personal tool separate from
work tools.

## 2026-07-01 — Private project, personal git

**Decision:** Lives at `D:\Repo\Tools\maestro`. When a remote is created it goes
on Aidin's *personal* GitHub (not The Gang). No remote/push until he asks.

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

**What happened:** after shipping several features, Aidin reported real prompts
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
