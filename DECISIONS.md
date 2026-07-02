# Decisions

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
