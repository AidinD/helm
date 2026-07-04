# Decisions

## 2026-07-04 — Orchestrator model clarified: one overarching orchestrator, rooted nowhere; workers rooted per-project

**Decision:** Aidin flagged (twice) confusion about "rooting" that I caused by
conflating two things. Clarified, and wrote it into orchestrator-instructions.md
("Where the orchestrator runs vs. where the work runs"):
- The orchestrator is ONE overarching thing above ALL projects, rooted in
  none. There is no per-project orchestrator.
- Two distinct notions of "rooted": (a) a session's own cwd — decides which
  project's CLAUDE.md/settings/skills auto-load for THAT session; (b) the
  target project of a piece of work — which the orchestrator names EXPLICITLY
  at dispatch. Never conflate them.
- Dispatch: launch each worker with cwd = its target project (so that
  project's CLAUDE.md loads for the worker), in an isolated worktree made via
  `git -C <projectPath> worktree add`. The orchestrator never has to be "in"
  the project. Mirrors firstmate (first mate isn't in a project; crewmates
  get worktrees of specific projects).
- The Agent-tool `isolation:"worktree"` shortcut infers the repo from the
  CALLING session's cwd (why it failed from this Dropbox-rooted session) — a
  harness-shortcut quirk, NOT evidence orchestrators must be rooted anywhere.

**Also (parallelism / worktrees, from a related discussion):** worktrees are
the substrate for conflict-free parallel work, but they DEFER conflicts to
merge time, not eliminate them — disjoint files merge clean, same-line edits
still conflict, and a shared append-target like DECISIONS.md conflicts at
merge (so the orchestrator writes shared files AFTER merge). Tonight I
hand-orchestrated raw Agent calls on ONE shared working tree, which is why I
serialized on shared files (renderer.js) instead of parallelizing — the
Agent-tool worktree isolation was unavailable from this session's root, and
Maestro's own worktree-based dispatch isn't built. Building it (treehouse
automation + dispatch) is what turns "serialize on shared files" into real
conflict-free parallelism.

**Operating context:** we currently work IN Claude Desktop; Maestro is the
tool being built, not the runtime. Assume Claude Desktop until Aidin says
migrated. So today CLAUDE is the hand-orchestrator; the self-hosting hazard
doesn't bite yet.

## 2026-07-04 — Ship-review round on the risky commits: containment sound, real fixes applied

**Decision:** Aidin asked for ship-reviews of the commits that warrant it.
Ran report-only adversarial reviews (fresh context, no file edits, no app
launch — to avoid app-instance collision with the concurrent harness build)
on the three genuinely risky commits, then applied every real finding myself,
serially, committing per-feature. Verdicts + fixes:
- **Lavish (CSP/iframe):** containment SOUND (no sandbox escape, XSS, IPC
  reach-through, or spoofable postMessage). Fixed: the in-code comment stated
  the security model BACKWARDS (dangerous — would mislead someone into
  relaxing index.html's hash-pin and breaking containment); img-src tightened
  to `data:`; 8MB cap on lavish:readFile. Notably, the review's own "inner
  'unsafe-inline' is inert, set it to 'none'" suggestion was WRONG (it's the
  required inner half of the CSP intersection — 'none' would CSP-block the
  SDK) — caught by reasoning through CSP semantics rather than applying blind.
- **goalOrchestrator:** destructive-git containment CONFIRMED airtight (reset
  --hard/clean -fd can only hit the isolated worktree, never the primary
  checkout — full chain verified). But a real HIGH: iterations ran with no
  `--permission-mode`, so real goals would hang to timeout (feature
  dead-on-arrival; only the trivial spike passed). Fixed with
  bypassPermissions (safe via worktree isolation). Also: auto-remove
  zero-commit worktrees+branches (were leaking every run), base-commit-based
  commit count (was miscounting on non-main repos), server-side maxIterations
  clamp. Re-ran the spike: real iteration now completes.
- **Focus page:** write path CONFIRMED atomic + BOM-free + shape-correct. One
  MED lost-update race (Maestro vs. the Jot app both doing whole-file writes)
  — fixed with a stat compare-before-swap + retry so a concurrent Jot write
  is detected and retried, never clobbered.

Takeaway: the ship-reviews earned their cost — the goalOrchestrator
permission-mode HIGH would have shipped a headline feature that silently
didn't work.

## 2026-07-04 — Reusable Electron E2E harness over CDP (scripts/e2e/)

**Built** a standing Electron E2E harness so testing Maestro's UI (and later jot/loom) is repeatable, and so an agent or a human can SCREENSHOT and inspect the running app.
Context: Maestro is a native Electron app with no browser-servable dev server, so the standard preview_* / browser tools don't apply.
The same ad-hoc CDP dance (launch electron with `--remote-debugging-port`, find the renderer target, drive it) had been hand-rolled repeatedly; this turns it into a small reusable module.

**Files:** `scripts/e2e/harness.mjs` (the module) and `scripts/e2e/demo.mjs` (a verification script that drives Maestro end to end).
Put under `scripts/` alongside the existing `scripts/kill-maestro.ps1` / `restart-dev.sh` rather than a new `test/` tree, matching where the repo already keeps its dev tooling.
This is a NEW standalone tool that only DRIVES the app from outside; it does not touch `src/` (main.js, renderer.js, preload.cjs).

**CDP transport: raw WebSocket + the `/json/list` HTTP endpoint, ZERO npm dependencies.**
Node 24 (and any Node 18+) ships a global `WebSocket` and `fetch`, so the harness talks CDP directly with nothing to install.
Chose this over the `chrome-remote-interface` package deliberately: on Windows a zero-dependency path is the most robust (no native build, no lockfile churn, nothing to break on `npm ci`), and the CDP surface we need is tiny (`Runtime.evaluate`, `Page.captureScreenshot`, `Runtime.enable` + the `consoleAPICalled`/`exceptionThrown` events, `Page.enable`).
Electron 31 is Chromium ~126, so full modern CDP is available.
The API is intentionally small and obvious: `launch()`, then `eval`, `click`, `type`, `getText`, `waitForSelector`, `screenshot`, `getConsole`/`getConsoleErrors`, `close`.

**Cleanup scope: match on the unique `--remote-debugging-port=<port>` flag, NOT the app-directory basename.**
This is the load-bearing decision and a deliberate divergence from `kill-maestro.ps1`.
`kill-maestro.ps1` matches electron processes by command line containing `*Tools\maestro*`, which is correct for boot-testing (nothing else is running Maestro then).
But the E2E harness is expected to run WHILE the user's own Maestro is live - and a single Electron app spawns several `electron.exe` (main + GPU + renderer + utility).
Verified at run time: 4 `electron.exe` already matched `*maestro*` before launch (the user's session).
Matching on the app-directory basename would have killed that live session too - exactly the class of mistake CLAUDE.md warns about.
The `--remote-debugging-port=<port>` flag is a per-launch unique token that appears only on the main process we spawned, so a `-like` match on it can never hit an unrelated Electron app.
`close()` resolves the matching main PID(s) and `taskkill /PID <pid> /T /F` each, taking the whole child tree (GPU/renderer/utility) with it and nothing else.
Guarded against an invalid/low port to refuse a broadening match.

**Verified end to end** (`node scripts/e2e/demo.mjs`): launched Maestro on port 9333, waited for `#pageToggle`, screenshotted the chat dashboard, clicked the Focus tab, waited for `#focusPage` visible, screenshotted again, read console (0 messages, 0 errors), then clean shutdown.
Two real PNGs produced (1184x755, 137 KB + 66 KB, confirmed PNG signatures).
Process check before vs after: 4 Maestro `electron.exe` at start, 4 after, 0 strays on port 9333 - the user's session untouched, the launched instance fully gone.

**Pointing it at another Electron app later (jot/loom):** pass `launch({ appDir, command, args, port })`.
`appDir` is the cwd to launch from; `command`/`args` default to `npm`/`["start"]` (the harness inserts `-- --remote-debugging-port=<port>` so the flag reaches electron through npm).
Cleanup keys off the port, so no per-app kill script is needed - the same harness works unchanged for any Electron app whose start script runs `electron .`.

## 2026-07-04 — AXI ecosystem mapped; gh-axi adopted, TOON as a principle (standalone build has thin surface today)

**Decision:** Aidin asked whether to pull in the rest of Kun Chen's "axi"
tools (the token-saving angle). Mapped the whole ecosystem at the source
level (read-only, via gh api). Findings:
- **AXI is a design principle + a small lib (`axi-sdk-js`), not a runtime.**
  The core token lever is **TOON** output (Token-Oriented Object Notation,
  a tabular JSON-alternative, ~40% fewer tokens on structured lists) plus 10
  principles (minimal schemas, pre-computed aggregates to kill follow-up
  calls, definitive empty states, loud-failing flags).
- **Reality check that reframes it:** the dramatic savings (57-74%) are vs
  MCP. Vs an already-lean CLI like raw `gh`, the token delta is ~1% - the
  AXI win there is reliability/turn-count, not raw tokens. So AXI pays off
  where you're replacing verbose JSON/MCP output or making tool output
  unambiguous, not for shaving already-terse commands.
- **All `-axi` tools are Node 20+ and cross-platform** (each carries a
  Windows badge; `axi-sdk-js` has explicit Windows shim-parsing). The
  earlier "lavish server is Unix-only" concern was only its port-recovery
  path (lsof/ps); the core is plain Node HTTP - moot for us anyway since
  Maestro's Lavish uses IPC, no server.

**Decided (Aidin: "kör på din rekommendation"):**
- **gh-axi: ADOPTED.** Verified it installs+runs on Windows (`npx -y gh-axi
  --help`, exit 0, its own output is already TOON-compact). Added a
  proportionate rule to the global personal CLAUDE.md: prefer `gh-axi` for
  non-trivial GitHub API work, plain git for local ops.
- **TOON: adopt as a PRINCIPLE, standalone build queued but reconsidered.**
  On reflection, Maestro's current agent-facing surfaces are already
  compact (the classifier/judge send short text, not verbose JSON), so a
  standalone "convert Maestro's output to TOON" build has thin surface
  *today*. The real value is prospective - as the structured-injection
  features (`/triage` feeding the board, Focus feeding goals, goal-
  orchestrator notes) mature, encode THOSE as TOON. So: fold TOON in with
  those features rather than build a TOON layer into thin surface now.
  Tracked as a Jot task; not built.
- **Also tracked:** stop reading the whole `todos.json` into context when
  only a category/few fields are needed (the AXI minimal-schema lens applied
  to how Jot data is consumed, both by Maestro-to-agent injection and by
  Claude reading it directly) - a small recurring token win.
- **Skipped:** terminal-axi (empty repo, LICENSE only), agent-browser-axi
  (redundant with chrome-devtools-axi), rough-cut-axi (niche, no license),
  tasks-axi (redundant with Jot), mcp-compressor (wrong direction).
  chrome-devtools-axi is a later "if/when Maestro agents do browser work"
  adopt-candidate (57% fewer tokens vs chrome MCP).

## 2026-07-04 — Fas 4 Lavish: a FIRST-PASS interactive-plan annotate loop (draft, not final UX)

**Built** a v1 of the "Lavish"-style interactive-plan feature (PLAN Phase 4).
The distinctive value over a plain text plan is the ANNOTATE-FEEDBACK LOOP: an HTML mockup is rendered in a sandboxed iframe with an annotation SDK injected, the user clicks an element and types feedback ON it, and each annotation comes back as a structured record that can seed the next agent prompt.
This is explicitly a DRAFT for Aidin to react to - scoped to the core loop plumbing (show mock -> annotate -> get structured feedback out), NOT a polished product.

**Lifted the annotation-capture logic from Kun Chen's lavish-axi (MIT), did not reinvent it.**
Fetched `src/artifact-sdk.js` read-only via `gh api` and lifted its `selector()` (best-effort CSS path: prefer `#id`, else `tag:nth-of-type`, capped ~5 ancestors), `context()` (the `{uid, selector, tag, text}` record, `text` = up to ~240 chars of trimmed innerText), the shadow-DOM floating annotation-card overlay, the capture-phase hover/click handlers with the `isNativeInteractiveControl` guard (native controls behave natively instead of annotating), and `snapshot()` (indented uid/tag/text tree).
Attribution is in the header of `src/lib/lavishSdk.js`.
**Wrote fresh / deliberately dropped:** all of lavish-axi's Mermaid pan/zoom, its layout-overflow auditing, and its text-range selection (out of scope for v1); and - the key architectural collapse - its entire Express-server + postMessage + HTTP long-poll + `state.json` transport.
lavish-axi needs that only because its artifact is a cross-origin sandboxed iframe with no app context (and that server layer is macOS/Linux-only, so it would break on Windows anyway).
In Electron the iframe lives in the same renderer process, so the injected SDK posts each record to `window.parent` (the one channel that crosses the sandbox boundary), the renderer host collects it into `lavishState`, and a formatter turns it into text on demand.
No server, no long-poll, no persisted state.

**Improvement over lavish worth keeping:** if the artifact HTML already carries a stable `data-lavish-id` on an element, the SDK records it as `lavishId` (via `closest('[data-lavish-id]')`), and the formatter prefers that anchor over the recomputed CSS selector - so anchoring is exact when we control the mockup.

**The one non-obvious problem, and its fix: CSP.**
First attempt loaded the mockup via the iframe's `srcdoc` attribute.
A `srcdoc` document INHERITS the embedder's Content-Security-Policy, and Maestro's page CSP is `default-src 'self'` - which blocks the inline SDK script (a srcdoc document can only make the inherited policy STRICTER, never looser).
Confirmed live: the SDK `<script>` was present in the frame DOM but never executed, with a `Refused to execute inline script ... default-src 'self'` console violation.
Switched to loading the mockup as a `data:text/html` URL (a separate browsing context) AND pinned the SDK's exact sha256 in the parent CSP's `script-src`.
A framed `data:` document still has the embedder's CSP applied on top of its own, so the parent MUST whitelist the SDK by hash for it to run - the rest of the app stays inline-script-free (no blanket `'unsafe-inline'`).
The SDK source is deterministic (`buildArtifactSdkSource()` returns a constant string), so a single pinned hash works; Chromium's reported hash matched the computed one exactly.
To stop this from silently breaking if the SDK is ever edited, `spike/test-lavish.mjs` asserts both that the exported `LAVISH_SDK_SCRIPT_SHA256` matches the current source AND that `index.html` contains that hash - drift fails loudly (it already caught one hash change during this build, after a `snapshot()` tweak).
Artifact author's own inline scripts do NOT run under this scheme (only the pinned SDK does) - acceptable for v1 (mockups are static HTML); noted as a later consideration if generated mockups need their own scripts.

**Single source of truth in an ES module, bridged to the non-module renderer via IPC.**
`renderer.js` is loaded as a plain `<script>` (not `type=module`), so it can't `import` from `src/lib/lavishSdk.js`.
Rather than duplicate the SDK-source and formatter into the renderer, `main.js` exposes `lavish:buildSrcdoc` (wrap artifact HTML into the SDK-injected document) and `lavish:formatPrompt` (format collected annotations to text) - both pure string transforms, no fs.
A separate `lavish:readFile` reads an HTML artifact by path (the renderer has no fs).
`preload.cjs` exposes `readArtifactFile` / `buildArtifactSrcdoc` / `formatAnnotations`.

**Surface: a new "Plan" page**, added via the exact same `#pageToggle` pattern as Focus/Goal/Analysis/Archive/Settings (a `data-page="lavish"` button + `#lavishPage` div toggled with `.hidden`, rendered by `renderLavishPage()`).
Load form accepts pasted HTML OR a file path (with the composer's own `pickFiles` picker); an annotate-mode toggle; the sandboxed review iframe; a collected-annotations list; and "Send to composer" / "Copy feedback" / "Clear" actions.
"Send to composer" drops the formatted block into the focused pane's composer and switches to the Chat page (also copies to clipboard); "Copy feedback" just copies.

**Deliberate re-render split so a click never reloads the mockup.**
A new annotation (or Clear/Remove) refreshes ONLY a stable `#lavishCollectedWrap` region via `renderLavishCollected()`, never the whole page - because re-rendering the page would recreate the iframe, reloading the mockup and resetting the SDK's state on every single click.
Found and fixed this during live testing.

**Guardrails honored:**
- USER-TRIGGERED ONLY - everything starts from a click; nothing on a timer.
- Left untouched (recently-committed, unrelated): voice input code, mic button, thinking indicator, language picker, Focus page, Goal page.
- Did NOT call the Agent tool / delegate - built directly.

**Verified end-to-end via live CDP against the running renderer** (`--remote-debugging-port`, the established technique), driving the frame through a `Page.createIsolatedWorld` context:
1-3. Plan page shows, iframe renders, SDK executes inside the frame (mockup DOM present).
4. Clicking a NON-interactive element (`<h1>`) opens the annotation card in the shadow DOM (clicking a `<button>` correctly does NOT - native controls are exempt, exactly as lavish intends).
5. The typed feedback lands in host `lavishState` with correct `selector` (`div#hero > h1`), `tag`, `text` ("Welcome home"), `lavishId` (`hero-block`, picked up from the ancestor's `data-lavish-id`), and `prompt`; DOM snapshot captured on ready.
6. The formatter (real IPC -> main -> lavishSdk) produced the expected text block, preferring the `data-lavish-id` anchor.
7. Snapshot excludes the injected SDK `<script>`.
8. Toggling annotate mode OFF suppresses the card (no new annotation) without rebuilding the iframe.
9. "Send to composer" drops the formatted feedback into the focused pane's composer and switches to Chat.
Plus `node --check` on all changed JS, a standalone unit test of the pure helpers (`spike/test-lavish.mjs`, 14 assertions incl. the CSP-hash drift guard), and a clean boot with zero CSP violations in the log.

**What still needs Aidin's real click-test:** the actual feel of clicking-and-typing on a real, visually-styled mockup (the CDP test dispatches synthetic clicks, not a human's); whether the "Plan" page is the right home vs. integrating into the composer/plan flow; and the annotation-card ergonomics on a dense layout.

**This is a first-pass DRAFT.** Explicitly deferred to a later pass: artifact GENERATION during planning (an agent producing the mockup in the project's visual style - PLAN calls this the noted next step); the deep "start a fresh rooted session with this feedback as the prompt" wiring (v1 drops it into the composer instead); Mermaid/text-range/layout-audit parity with lavish-axi; and letting artifact-authored scripts run.

## 2026-07-04 — Fas 3 Point 11: a minimal FIRST-PASS UI onto the goal orchestrator (draft, not final UX)

**Built** the first UI that can trigger and watch `src/lib/goalOrchestrator.js`'s `runGoal`, which had been backend-only since earlier the same day (no interface consumed it).
This is explicitly a DRAFT for Aidin to react to - the point is to make the already-built orchestrator TESTABLE, not to finalize its interface.
Deliberately kept minimal and clearly-bounded rather than deeply integrated: one run at a time, one new "Goal" page, no coach/escalation layer.

**Surface: a new "Goal" page**, added via the exact same `#pageToggle` pattern as Focus/Analysis/Archive/Settings (a `data-page="goal"` button + a `#goalPage` div toggled with `.hidden`, rendered by `renderGoalPage()` in `renderer.js`).
Not threaded into the crowded session-list/pane paths - same isolation reasoning the Focus page used.
The page has three inputs (goal textarea, project-folder text field with the composer's own "…" `pickFolder` picker, max-iterations number defaulting to 5), a Start button, a Cancel button, a live per-iteration progress list, and a final summary card.
The project folder defaults to the focused pane's `cwd` when it has one (matching the composer's rooting default), else the picker.

**Live progress uses its OWN IPC channel, parallel to session events - not overloaded onto `session:event`.**
`main.js`'s `goal:run` handler builds a `send()` that does `webContents.send("goal:event", { goalRunId, ...payload })`, exactly mirroring the shape of the existing `session:event` path (`launchId` there, `goalRunId` here).
The handler wires the orchestrator's `onIteration` callback straight to `send({ kind: "iteration", record })`, and emits `started` / `done` / `error` on the same channel.
`preload.cjs` exposes `runGoal` / `cancelGoal` / `onGoalEvent` (the last mirrors `onSessionEvent`'s subscribe-and-return-unsubscribe shape).
The renderer's `onGoalEvent` subscriber ignores any event whose `goalRunId` doesn't match the current `goalRunState`, so a stale/previous run's late events can't clobber current state, and it only re-renders when the Goal page is actually visible.

**Cancel is wired to the real `cancelToken`.**
`goal:run` holds `{ cancelToken }` in a `liveGoalRuns` map keyed by a `crypto.randomUUID()` goalRunId (same id discipline as `session:start`'s launchId); `goal:cancel` flips `run.cancelToken.cancelled = true`, and the orchestrator stops at its next iteration boundary (an in-flight iteration always runs to its own completion/timeout - the module never kills mid-iteration).
The handler resolves immediately with `{ ok, goalRunId }` (fire-and-return) so the renderer can wire Cancel while the run streams progress; the run's own resolution/rejection is reported over `goal:event`, never left to reject an already-resolved `invoke`.

**Guardrails honored (this runs REAL autonomous claude subprocesses making real commits):**
- USER-TRIGGERED ONLY - the run starts only from the Start button's click handler; nothing here is on a timer or any automatic event.
- No push/merge affordance - the orchestrator already refuses to push/merge/PR, and this pass deliberately adds no button that would.
- The final summary card states explicitly, in the UI, that the run did NOT push or merge and that all work lives in the isolated worktree + branch (shown by path) for the user to review/merge or discard by hand - so Aidin knows where the work went.
- Left untouched (recently-committed, unrelated): the voice input code, mic button, thinking indicator, language picker, and the Focus page.

**Verified the WIRING without a full real autonomous run** (per the task's explicit instruction not to spend tokens/spawn real claude just to test UI):
- `node --check` on all changed JS (`main.js`, `preload.cjs`, `renderer.js`, `goalOrchestrator.js`) - all pass; CSS brace-balance 325/325.
- Full boot-test via `scripts/restart-dev.sh` (never a bare taskkill, per CLAUDE.md) - clean boot, no errors.
- Live CDP verification against the real running renderer (the same `--remote-debugging-port` technique the token-ticker investigation established): clicking the Goal tab renders the page with all form fields, Cancel correctly disabled while idle; all three bridge methods (`runGoal`/`cancelGoal`/`onGoalEvent`) present on `window.maestro`; and the real render functions `goalIterationCard`/`goalSummaryCard` produce correct DOM (iteration card shows number + "committed" badge + summary + key-changes with the `goal-iter-ok` accent class; summary card shows commits/branch/worktree/stopped-reason plus the "did NOT push or merge" note).
- The complete IPC round-trip was proven incidentally-but-strongly: a Start click against a deliberately non-existent folder drove the REAL path (renderer -> `goal:run` IPC -> `runGoal` -> `createWorktree` throws "Project path does not exist" BEFORE any iteration -> real `goal:event` `{kind:"error"}` -> `onGoalEvent` -> `goalRunState.status="error"` -> re-render). This confirms the end-to-end channel AND that a bad path fails fast with ZERO claude subprocesses spawned and zero tokens spent. Confirmed afterward: no stray worktree (`git worktree list`), no `maestro/goal-*` branch, maestro's own working tree clean apart from the intended edits.
- NOT exercised live (would need a real autonomous run): a successful `iteration`/`done` event mutating state through to the summary card. That path is the same handler/switch already proven for the `error` kind, and both render funcs are proven to render correctly - but the genuinely-successful end-to-end run is left for Aidin's own test, as instructed.

**This is a first-pass DRAFT needing Aidin's review.** The UX is genuinely open (a dedicated page was one of several equally-valid choices); no coach/escalation layer (Point 12); single concurrent run; no re-run-from-summary, no worktree-open-in-explorer shortcut, no per-model/effort selection in the form (the backend accepts them; the form omits them for v1 simplicity). Point 11 remains IN PROGRESS, not done.

## 2026-07-04 — Continuous voice input: rolling re-transcription (live partials while holding), not real streaming

Follow-up to the same-day voice-input entries (hold-to-record, multilingual,
language picker, whisper-base).
Aidin's ask: make transcription CONTINUOUS - show what it's hearing
progressively WHILE he speaks, like Claude Desktop, instead of all-at-once when
he releases the hold.

**Design reality, stated honestly: Whisper is NOT a streaming model.**
There is no token-level streaming to tap into - the model transcribes a whole
clip at once.
So "continuous" here is built as ROLLING RE-TRANSCRIPTION, the pragmatic
approach that actually fits Whisper: while the hold is active, on an interval we
take ALL the audio captured so far, transcribe the whole accumulated clip, and
replace the live partial text in the composer with the latest fuller result; on
release, one last full transcription produces the authoritative text.
No attempt at real streaming was made because the model can't do it.

**Kept the trigger identical - this is purely additive.**
Hold-to-record (mic button mousedown/mouseup/mouseleave, and Alt-in-composer
keydown/keyup/blur) is untouched, as are the mic SVG icons, the language picker,
the model, and the thinking indicator - all already done and committed.
Continuous is about showing partial results DURING the existing hold, not a new
interaction.

**Rolling loop (`src/renderer/renderer.js`, `startVoiceRecording` ~line 228).**
`MediaRecorder` is now started with a 1s timeslice (`mediaRecorder.start(1000)`)
so `dataavailable` chunks accumulate ~every second instead of arriving as one
blob only at stop.
A `setInterval(rollingTick, VOICE_ROLLING_INTERVAL_MS)` (new named tunable
constant, 2000ms) drives the live updates: each tick concatenates the
chunks-so-far, reuses the EXACT existing path - `decodeToMono16k` +
`window.maestro.transcribeVoice(samples, language)` -> the same
`voice:transcribe` IPC -> the same `transcribeAudio` in `voice.js` - and shows
the result as the live partial.
No second transcription path was built; `voice.js` is UNCHANGED (the same
`transcribeAudio` works on a partial clip - confirmed by reading it, nothing
there assumes a "complete" utterance).
2s was chosen because whisper-base takes a couple seconds per call and each tick
re-transcribes the FULL clip-so-far; shorter risks the model never keeping up.

**Non-overlap: skip a tick, never queue a backlog.**
The per-recording entry carries an `inFlight` boolean.
`rollingTick` returns immediately if `inFlight` is already true (the previous
tick's whisper call hasn't returned yet), so a slow transcription just means
fewer live updates that interval, never a pile-up of queued calls that outlives
the recording.
The interval is cleared the instant `MediaRecorder` fires `stop`
(`clearInterval(entry.rollingTimer)`), and a `stopped` flag makes any
late-returning rolling tick discard its own result rather than clobber the
authoritative final text.
A tick also discards its result if `activeRecordings.get(index) !== entry` - the
pane was reset/replaced mid-recording (same staleness concern the index-keyed
map already guards elsewhere).

**Text replacement: replace only the VOICE span, never the user's typed text.**
The core requirement was that a partial "vi ska" becoming "vi ska bygga" updates
IN PLACE rather than appending duplicates, AND that text the user typed manually
before recording is never destroyed.
Implemented via a pure helper `replaceVoiceSpan(currentValue, voiceStart,
voiceLen, newVoiceText)` returning `{ value, newVoiceLen }`.
`voiceStart` is captured once - the caret position (`selectionStart`) when the
hold began - so everything before it is the user's own text and is left
untouched; `voiceLen` tracks how much the voice text currently occupies, so each
update replaces exactly the previous partial's span.
A separator space is added before the voice text only when there is preceding
user text that doesn't already end in whitespace, and that space counts as part
of the voice span so a later SHORTER partial still replaces cleanly (no stranded
space).
The final result on release goes through the same helper, replacing the last
partial; an empty final result cleanly removes any stray partial rather than
leaving it behind.

**Perf honesty (a known v1 limitation, not papered over).**
whisper-base is slower than tiny, and re-transcribing the full accumulated clip
every 2s is real CPU that grows with recording length.
The non-overlap skip and immediate interval-stop-on-release are implemented;
a windowed/VAD approach that only re-transcribes recent audio was deliberately
NOT built for v1 (over-engineering before we know it's needed).
If long recordings feel laggy in real use, that windowing is the documented next
step.
A second real unknown: this decodes a mid-stream webm/opus blob
(header chunk + accumulated chunks) via `decodeAudioData` on each tick - the
standard MediaRecorder-timeslice approach, but its behavior on a partial stream
is exactly the kind of thing only a live mic can confirm.

**Verified.**
`node --check src/renderer/renderer.js` passes.
The text-replacement logic was unit-tested standalone
(`spike/test-voice-span-replace.mjs`, a new spike): it reads the shipped
`replaceVoiceSpan` out of renderer.js and evals it (testing the real code, not a
copy), 10 assertions, all pass - empty composer, partial growing in place,
partial shrinking, preceding user text with/without trailing whitespace, newline
separators, final-empty-removes-stray, and the after-span edge case.
Full boot-test via `scripts/restart-dev.sh` (never a bare taskkill, per
CLAUDE.md): clean boot, killed exactly Maestro's own 4 PIDs, no errors in the
boot log, exactly 4 Maestro PIDs running afterward (no stray duplicate
instances).
**What this could NOT verify** (no microphone on this machine, same limitation
as every prior voice-input entry): the actual live experience - partials
appearing in the composer while speaking and updating in place, the 2s cadence
feeling right, whisper-base keeping up (or not) with the rolling re-transcription
on real hardware, mid-stream webm/opus decoding working per-tick, and whether the
final text cleanly supersedes the last partial.
All of that needs Aidin's own real-microphone test.
The non-overlap skip logic and the voice-span replacement logic ARE verified
(the former by code inspection of the `inFlight`/`stopped` guards, the latter by
the standalone unit test above).

## 2026-07-04 — Voice input: a language picker next to the mic (replaces hardcoded forced-Swedish)

Follow-up to the same-day "force Swedish transcription" entry, after Aidin's
feedback: instead of forcing one language, give him a small language menu next
to the mic button so he can pick the transcription language (he mixes Swedish
and English).
The previous version hardcoded `const TRANSCRIBE_LANGUAGE = "swedish"` in
`src/lib/voice.js` and passed it unconditionally.
That entry itself had named "a language toggle/picker in the composer" as the
proper fix for true mixed use, deferred at the time - this is that fix.

**UI - reused the existing dropdown component, not a hand-rolled `<select>`.**
The composer's model/effort/permission pills are all built by one shared helper,
`dropdownPill(initialValue, options, onSelect)` (`renderer.js:567`), which
returns `{ el, setValue, value }` and renders a `.meta-pill` button that opens
the app's own `showContextMenu` on click.
The new language picker (`languageDD`, `renderer.js` in `paneComposerEl`) calls
that exact same helper with the same `[{value,label}, …]` option shape, so it
looks and behaves identically to its neighbours - same class, same menu, same
keyboard/mouse behavior.
It is appended into the same `controls` row, immediately before `micBtn`
(`controls.append(… effortDD.el, languageDD.el, micBtn, sendBtn)`), so it sits
right next to the mic it controls.

**Options / default.**
Auto-detect, Svenska (swedish), English (english), plus Norsk (norwegian),
Dansk (danish), Deutsch (german), Español (spanish) - a short list, trivially
added since they're all just more `{value,label}` entries the same pattern
already handles.
Display labels are the nicer native names; the `value` passed through is always
the full lowercase English language NAME transformers.js requires
("swedish"/"english"/…), or "auto" for auto-detect - never an ISO code.
Default selection is **Svenska** (`config.voiceLanguage` defaults to "swedish"),
preserving today's forced-Swedish behavior exactly.

**Persistence - a single global setting, via the existing setConfig IPC.**
Added `voiceLanguage: "swedish"` to `DEFAULT_CONFIG` (`config.js`) - a top-level
primitive, so the existing shallow `{ ...current, ...patch }` merge in the
`config:set` handler (`main.js:168`) persists it correctly with no
nested-object protection needed (unlike `jot`/`autoCompact`/etc.).
The dropdown's `onSelect` calls `window.maestro.setConfig({ voiceLanguage })`
and stores the returned config back into `state.config`, the same one-liner
every other setting toggle in the renderer uses.
The dropdown's initial value is read back from `state.config?.voiceLanguage`
on render.
Deliberately a single global setting, not per-pane state (overkill for v1, per
the ask).

**Plumbed the language through to `transcribeAudio`.**
The path is renderer's `startVoiceRecording` -> `window.maestro.transcribeVoice`
(preload.cjs) -> IPC `voice:transcribe` (main.js) -> `transcribeAudio` (voice.js).
Each hop now carries the language: `startVoiceRecording` reads
`state.config?.voiceLanguage || "swedish"` fresh at transcribe time (so a change
mid-recording still applies) and passes it; `transcribeVoice(samples, language)`
forwards it in the IPC payload; the `voice:transcribe` handler destructures
`{ samples, language }` and passes it on; `transcribeAudio(float32Samples,
language = "swedish")` uses it.
In `voice.js` the hardcoded `TRANSCRIBE_LANGUAGE` const is replaced by
`DEFAULT_TRANSCRIBE_LANGUAGE = "swedish"` (the fallback default, so a stale
caller that passes nothing keeps today's behavior rather than silently
switching to auto-detect).
When the value is "auto" (or null/empty) the `language` option is OMITTED
entirely from the pipeline call - that is how transformers.js's ASR pipeline
triggers auto-detection (its JSDoc: language "Default is `null`, meaning it
should be auto-detected."); otherwise it passes
`{ language: <name>, task: "transcribe" }`.

**Left untouched, per the ask:** the hold-to-record logic, the mic SVG icons,
and the thinking indicator - all already done and committed. This change only
ADDS the dropdown and the language plumbing.

**Verified.** `node --check` on all five changed files
(`config.js`/`voice.js`/`main.js`/`preload.cjs`/`renderer.js`) - all pass.
A mechanical plumbing test (standalone script importing the real
`transcribeAudio`, fed a 1s silent 16kHz buffer): a named language ("english")
runs without throwing; "auto" runs without throwing AND emits transformers.js's
own `"No language specified - defaulting to English (en)."` log line - the
message that only appears when the `language` option is genuinely omitted,
proving the auto-detect branch works as intended, not just that it doesn't
crash; the no-arg default correctly ran in Swedish mode (produced Swedish
output off the silence, confirming the "swedish" fallback passes a real
language); an empty string behaved as auto-detect (same omitted-language log).
Full boot-test via `scripts/restart-dev.sh` (never a bare taskkill, per
CLAUDE.md) - clean boot, no errors, killed exactly Maestro's own 4 PIDs.
**What this could NOT verify** (no microphone and no Swedish voice on this
machine, same limitation as every prior voice-input entry): real transcription
QUALITY in any language, and the dropdown actually rendering/selecting/
persisting through a real click in the running app. Both need Aidin's own live
test - in particular whether picking each language actually improves his real
Swedish and mixed Swedish/English transcription over the old forced-Swedish
behavior.

## 2026-07-04 — Live token ticker investigated (no reproducible bug found); thinking-dot recolored + animated

**Context:** Aidin reported, after live-testing the 2026-07-03 "Live time/
tokens ticker" feature: "Och dessutom räknar den fortfarande inte upp tokens
live" (it still doesn't count up tokens live). That feature's own DECISIONS.md
entry admits no live click-through was ever done — only a standalone Node
script against a captured transcript, plus a static code read. Per this
repo's own Bug-Fixes-&-Testing rule, this had to be reproduced end-to-end in
the real running app before touching any code — "I read the code and it
looks right" was explicitly not an acceptable standard here, since that is
exactly what shipped the bug in the first place.

**How it was actually driven live:** Maestro is a native Electron app with no
browser-servable dev server, so the standard preview tools don't attach to
it. Launched the real `electron.exe` (found in `node_modules/electron/dist/`)
directly with `--remote-debugging-port=9333`, which exposes a Chrome DevTools
Protocol endpoint over the real renderer page. A small throwaway Node script
(`cdp.mjs`, not committed — scratchpad only) connected over that CDP
WebSocket and used `Runtime.evaluate` to fill the real composer textarea,
click the real Send button, and read back real `pane` state and DOM content
from the live running app — genuine end-to-end interaction, not a simulation.
(Aside, logged for whoever hits this next: launching the Electron process via
a bash `(cmd &)` detached subshell is unreliable in this environment — the
process and its CDP port die a few seconds after the bash tool call returns,
even though `electron.exe` itself is still technically running. Launching via
`run_in_background: true` on the Bash tool, or via a `Start-Process`-launched
detached process, both kept the CDP port alive reliably across many
subsequent tool calls.)

**What was actually verified, live, across 5 independent real runs**
(including 2 with temporary raw stream-json tracing added to both
`launcher.js` and `renderer.js`'s "usage" handling, removed again afterward —
`git diff` on both files is empty): a brand-new session with no prior
`--resume`, a resumed/continued session, and a second pane in split-view all
showed the exact same correct chain, every time:
- `launcher.js`'s per-`assistant`-event usage-emission block (added in the
  2026-07-03 commit) fires correctly off real `evt.message.usage`, deduped by
  `message.id` as designed — confirmed via raw trace output, not inference.
- Every `{kind: "usage", totalTokens}` event reaches
  `window.maestro.onSessionEvent` in the renderer and finds its
  `launchPaneHistory` entry (`entryFound=true` on the very first event of a
  fresh run, checked explicitly).
- `pane.liveTokens` increments correctly and cumulatively (watched it climb
  e.g. 492,049 → 1,119,755 → 1,892,945 → 2,162,001 tokens over one real run).
- `renderLiveStats` finds `.pane-status` and creates/updates
  `.pane-live-stats` with real, changing text (` · 21.0s · 236.1k tokens`
  etc.), confirmed via both `document.querySelector` reads and a real
  `Page.captureScreenshot` showing the ticker visibly live under a busy pane.
- `startLiveStatsTicker`'s 250ms interval is genuinely running (elapsed-time
  component of the readout climbed in step with wall-clock time across
  repeated samples).

One earlier test run did show 4 "usage" emissions from `launcher.js` with no
matching renderer-side receipt — the initial signal that looked like a real
race (an `await window.maestro.suggestModelEffort(...)` / `startSession(...)`
gap between a send starting and `launchPaneHistory.set()` actually running,
which could in principle let very early stream events arrive before the map
entry exists). This did NOT reproduce on a clean, isolated retest with full
instrumentation from event #1 onward. The likely explanation, in hindsight:
that specific test had accidentally been driven against a pane that had
resumed a huge, live, already-1900-turns-deep session (traced back to a
stray `cwd`/session default left over from earlier manual CDP polling
in this same investigation) — self-inflicted test contamination, not a
defect in the shipped code.

**Conclusion: no reproducible defect found in the current, committed ticker
code.** The most plausible real explanation for Aidin's report is that his
live Maestro window was still running the pre-fix build — this repo has no
hot-reload (confirmed: no file-watcher, no `webContents.reload` call
anywhere in `main.js`), so any code change only takes effect after a full
restart via `scripts/restart-dev.sh`, and 10 further commits shipped after
the ticker commit before this report came in. Filed here rather than
silently closed out, since it's a real user report and the fix (if the
stale-window theory is right) is simply "restart Maestro" — flagging in case
it recurs after a confirmed-fresh restart, which would mean this
investigation missed something and needs to resume with a different angle
(e.g. a specific model/effort combination, or a much longer real session,
not reproduced here).

**Thinking-dot color + animation (Aidin's second ask, same message):**
"Kan vi ha en roligare tänkar ikon, inte bara pulserande och roligare färg än
blå, orange som bubblorna hade passat bättre tror jag" (a more fun thinking
icon, not just pulsing, and a more fun color than blue — orange like "the
bubbles"). "Bubblorna" is the user's own chat turn bubbles
(`.turn.user .turn-bubble`), which already use `background: var(--accent)`
(`#d97757`) — grepped `style.css` for existing orange/amber values first per
the ask to reuse rather than invent; `--accent` was the obvious existing
candidate, already described in an existing comment as "accent orange."
- `.pane-status-icon` (`src/renderer/style.css`) recolored from `var(--active)`
  (blue) to `var(--accent)` (orange), matching the user bubbles exactly.
- Replaced the flat scale+opacity pulse with a three-dot wave: the single
  `<span>` `setPaneBusyUI` already creates is the center dot, with
  `::before`/`::after` pseudo-elements adding the left/right dots (no JS
  change needed) on staggered `animation-delay` for a left-to-right bounce,
  evoking a "typing" indicator rather than a flat pulse.
- The original `pane-status-pulse` keyframe was kept (renamed usage only on
  `.pane-status-icon` itself) since `.icon-btn.recording` (the mic button)
  independently reuses that same keyframe name for its own unrelated
  live-recording cue.
- The reactive "ping" on new events (`tool_use`/`usage`/`assistant`) now
  pings orange instead of blue too; still only the center dot pings, with the
  two side dots continuing their ambient wave underneath.

**Verified:** `node --check` on all touched JS (traces added then fully
reverted — confirmed via `git diff` showing zero changes to `launcher.js`/
`renderer.js`), a CSS brace-balance check, a full `scripts/restart-dev.sh`
boot-test (clean log), and live CDP verification of the new dot: computed
`background-color: rgb(217, 119, 87)` (`#d97757`, matching the bubbles
exactly) on the real running element during a real busy run, `animationName`
confirmed as `pane-status-wave` on the pseudo-elements and `pane-status-ping`
reactively on new events, and a real screenshot showing both the orange user
bubble and the orange animated thinking dots side by side.

## 2026-07-04 — Fas 3 Point 11 v1: a real goal orchestrator (`src/lib/goalOrchestrator.js`)

**Built** the first real slice of PLAN.md's Point 11 ("real orchestration") —
the biggest piece of Fas 3 still unbuilt. New module
`src/lib/goalOrchestrator.js` exporting `runGoal({ projectPath, goal,
maxIterations, model, effort, onIteration, cancelToken })`. Backend/library
only, same posture as `worktree.js` before it — no dispatch UI, no wiring
into `main.js`/`renderer.js`, nothing consumes it yet on purpose.

**Shape, adapted (not copied) from gnhf's actual source-verified
architecture** (DECISIONS.md's 2026-07-03 source-read entries, PLAN.md's
Phase 4 "DECIDED" note: vendor/adapt gnhf's `Orchestrator` pattern, not a
live dependency — there's no package boundary to depend on cleanly anyway):

1. **Isolated worktree per run**, via `worktree.js`'s already-spike-verified
   `createWorktree(projectPath, {...})` — all iterations run there, the
   primary checkout is never touched.
2. **A loop of FRESH `claude -p` subprocess iterations, no `--resume`** —
   confirmed live (2026-07-03) as gnhf's real architecture for the CLI-agent
   family, not an assumption to revisit. Reuses `launcher.js`'s
   `resolveClaudeBinary()` + direct-`.exe`-spawn convention (the same
   space-truncation-bug avoidance already proven there) rather than
   reinventing subprocess plumbing. Capped at `maxIterations` (default 5) —
   v1 is deliberately small-scale.
3. **Continuity via `.maestro-goal/notes.md` in the worktree, not
   conversation memory** — `readOrCreateNotes` reads (creating if absent)
   before each iteration and folds the content into that iteration's prompt;
   `appendNotes` appends a structured summary after. This is gnhf's actual
   verified continuity mechanism, not an invented alternative.
4. **Structured per-iteration output**, matching the exact cost-optimized
   recipe `judge.js`/`orchestratorHelper.js` already established
   (`--output-format json` + `--json-schema`, though NOT the Haiku-only/
   no-tools stripped-down variant those two use — an iteration is a real
   coding turn that needs its normal tools, unlike a classifier/judge call).
   Schema: `success` (bool — false discards the iteration), `summary` (one
   sentence, doubles as the git commit message — no separate LLM call to
   produce one, mirroring gnhf), `keyChanges` (array), `keyLearnings` (array
   — the only channel through which knowledge survives into the next fresh
   subprocess). The iteration system prompt explicitly instructs: smallest
   next step, run your own build/test/lint, do NOT commit yourself (the
   orchestrator commits), stop any background processes before finishing.
5. **One orchestrator-authored git commit per successful iteration**,
   message built from that iteration's own `summary` field
   (`[goal-orchestrator] iteration N: <summary>`). On `success:false` or a
   hard process error (timeout/spawn failure/bad JSON/schema mismatch):
   `git reset --hard` + `git clean -fd` in the worktree, mirroring gnhf's
   verified rollback behavior. A "commit itself failed" case (e.g. a hook
   blocked it) is deliberately NOT treated the same as a bad iteration — it's
   logged clearly and the (presumably good) changes are left uncommitted for
   a human to inspect, rather than being discarded.
6. **Stop conditions**: `maxIterations` reached, two consecutive
   `success:false`/hard-error iterations in a row, or an explicit
   `cancelToken.cancelled` flag checked between iterations (never mid-run —
   an in-flight subprocess always finishes or times out on its own).
7. **Never pushes, never merges to the primary checkout, never opens a PR** —
   per the human-gating principle (PLAN.md Phase 3) and matching the
   `ship-review` skill's own "stop before push" stance (same reasoning:
   pushing/merging is more consequential and harder to undo than a local
   fix-and-verify loop). Returns `{ worktreePath, branchName, notes,
   commitCount, iterations, stoppedReason }` and leaves everything on disk
   for a human (or a future dispatched review pass) to look at.
8. **`onIteration` callback**, optional, fires after each iteration's result
   — for a future UI/CLI caller to show live progress. No UI built this pass.

**A real ordering bug caught by the spike, not by inspection:** the first
version appended to `notes.md` AFTER `commitIteration`'s `git add -A && git
commit`, so every successful commit captured notes.md one iteration stale,
and the worktree was left dirty (`git status --porcelain` showed a modified
`notes.md`) after every "successful, nothing left to review" run. Fixed by
moving `appendNotes` before `commitIteration` in the success branch only —
the failure/error branches correctly already appended AFTER
`discardWorktreeChanges` (a `reset --hard` would otherwise wipe an
uncommitted pre-discard append). Caught because the spike asserts a genuinely
clean working tree post-run, not just "a commit happened somewhere."

**Verified with a real spike, real `claude` subprocess calls, not mocked**
(`spike/test-goal-orchestrator.mjs`) — this feature's entire value
proposition is real autonomous iteration, so per Aidin's own instruction it
had to be proven against a live invocation. Goal: "create hello.txt
containing the word hello, then stop" against a scratch git repo under the
OS temp dir (never Maestro's own working tree). Real run: 3 iterations (the
capped max), first one created and committed `hello.txt`, the next two
correctly recognized the goal was already complete and made no further
changes (still committed, since `success:true` — a genuinely idempotent
"nothing more to do" report, not a bug). 24 real assertions, all passed:
worktree created on disk, checked out on the right `maestro/goal-*` branch,
3 real commits independently visible via `git log main..branch` (not just
this module's own count), `hello.txt` content verified byte-exact both in
the worktree AND inside the actual commit via `git show branch:hello.txt`
(rules out an uncommitted stray file passing the check), working tree
genuinely clean post-run, `notes.md` content matches what's actually on disk
and documents the iteration, `stoppedReason` correct, primary repo checkout
(`main`) completely untouched throughout, and the scratch repo has zero
remotes at all — proving push wasn't just skipped but structurally
impossible in this test. Total spike cost: a few cents (Haiku-effort-`low`
Sonnet calls).

**A second, environmental (non-code) issue surfaced and fixed in the spike
itself:** the first two spike versions called `fs.rmSync` directly on the
scratch root without first calling `worktree.js`'s own `removeWorktree()` —
unlike the pre-existing `test-worktree-lifecycle.mjs`, which does. This left
git's internal `.git/worktrees/<id>` registration pointing at a directory
Node was deleting out from under it, and Windows would refuse to release the
directory handle (`EPERM`/"being used by another process") for tens of
seconds afterward — confirmed NOT a leftover process (checked via
`Get-CimInstance`, nothing had the path open) and confirmed NOT reproducible
in the already-proven worktree-only spike, which does call `removeWorktree`
first. Fixed by adding the same proper teardown call before the raw
directory delete; re-ran clean immediately after.

**Explicitly deferred to a future pass** (v1 scope, not gaps to silently
paper over): a dispatch UI (start/monitor/cancel a goal run from Maestro's
own interface — `onIteration`/`cancelToken` are the hooks a future caller
would use, nothing consumes them yet); the coach/escalation layer (PLAN.md's
Point 12 framing — this module has no judgment about WHEN to escalate to
Aidin, it just runs and stops on its own fixed conditions); real cancellation
wiring beyond the flag itself (no IPC channel, no way for a human to actually
flip `cancelToken.cancelled` from a running UI yet); dependency-install into
the worktree (same gap `worktree.js`'s own `createWorktree` already defers —
a goal touching a project that needs `npm install` to even build will have
its first iteration discover and presumably fix that itself, same as gnhf's
own documented behavior); a configurable `--permission-mode` per run (the
spike ran successfully on the CLI's own default, unconfigured — a future
pass may want tighter/looser control per project, matching firstmate's
per-project mode idea already noted in PLAN.md's Phase 4 section); and any
independent build/test verification of an iteration's own `success:true`
self-report (gnhf's own documented weak spot — v1 trusts the agent's
self-report plus process exit code only, same as gnhf).

**Verification commands run:** `node --check` on both new files; confirmed
`goalOrchestrator.js` imports only `node:child_process`/`node:fs`/`node:path`
plus the two local lib modules (no Electron-specific import, so it works in
plain Node outside the Electron app, matching the "pure library module" ask);
`node spike/test-goal-orchestrator.mjs` — full real run, all 24 assertions
passed (paste of the actual run output kept in this session's own report,
not duplicated here). No boot-test via `restart-dev.sh` — this is a pure
backend library with no `main.js`/renderer wiring, per the task's own scope.

## 2026-07-04 — Mic button: SVG icon instead of emoji, and a standing "icons over emoji" convention

Aidin's feedback on the hold-to-record mic button (previous entry, same day):
"kan du också fixa mikrofon ikonen till att använda något mer stilrent. Gör
det till en vana i maestro" (fix the mic icon to something more sleek/
polished, and make this a habit in Maestro).

- `src/renderer/renderer.js`: the mic button's two raw-emoji states
  (`micBtn.textContent = "🎤"` idle, `"⏹"` recording) replaced with two small
  inline SVG constants, `MIC_ICON_IDLE` (mic capsule + stand, stroke-based)
  and `MIC_ICON_RECORDING` (filled rounded square), assigned via
  `micBtn.innerHTML` at the three call sites (initial creation, the
  `mediaRecorder` `"stop"` handler reverting to idle, and
  `startVoiceRecording` switching to recording).
- Not a new pattern invented from scratch - matches the one inline-SVG
  precedent already in this file, `wireScrollToBottomButton`'s down-arrow
  (`stroke="currentColor"`, no hardcoded color, sized to fit its button).
  `currentColor` means the glyph automatically respects `.icon-btn`'s
  existing hover/active/`.recording` CSS (the red pulse background swaps
  `color` too, so the stop-square recolors with it for free) instead of
  baking a color into the SVG.
- No icon-library dependency added - this app has none today, and two small
  hand-written glyphs (a handful of path/rect commands each) don't justify
  pulling one in.
- Deliberately scoped to only the composer's mic button. Left
  `.pane-status-icon` and the pane header's status-row/thinking-indicator
  emoji untouched - separate in-flight work by someone else at the time of
  this change.
- **Made it a standing habit, not a one-off**, per the ask: added an "Icons
  over emoji" section to `CLAUDE.md` - prefer small inline SVG glyphs
  (`currentColor`, no library) over raw emoji for interactive controls going
  forward, since emoji render inconsistently across platforms/fonts and read
  as less polished; informal status text/badges (the existing "⚠"/"❓ Needs
  your input" markers) are explicitly still fine as emoji, since building a
  custom glyph for those isn't worth it. Points at this mic button as the
  reference example.

**Verification.** `node --check src/renderer/renderer.js` passed. No
style.css changes were needed - `.icon-btn`/`.icon-btn.recording` already
apply `color`, which both new SVGs inherit via `currentColor`/`fill`, so no
new brace-balance risk. Full boot-test via `scripts/restart-dev.sh` (never a
bare taskkill, per this file's own rule) came up clean with no console
errors. This is a native Electron app with no browser-preview tooling
available in this environment - the actual visual result (icon shape,
crispness, alignment inside the 26px button) still needs Aidin's own look
before calling it done.

## 2026-07-04 — Voice input v1 feedback: hold-to-record (button + Alt), and a multilingual model so Swedish actually works

Follow-up to the 2026-07-03 "Voice input v1" entry, after Aidin live-tested
the shipped mic button and gave two pieces of feedback.

**1. "Jag vill ha en hold to record function. Typ alt knappen eller någon
enkel kombination."** (I want a hold-to-record function, like the Alt key or
some simple combo.) v1 was click-to-start/click-to-stop
(`toggleVoiceRecording`, renderer.js). Replaced entirely with hold-to-record —
not layered alongside the old toggle, per the ask that hold is now THE
interaction model, not a second confusing mode.

- `renderer.js`: `toggleVoiceRecording` split into `startVoiceRecording`/
  `stopVoiceRecording`, called from two independent hold mechanisms that both
  route through the same pair so neither can leave the button in a
  half-held state: (a) `mousedown`/`mouseup` on the mic button itself, with
  `mouseleave` also stopping it — dragging the mouse off the button while
  held must not strand a recording with no way to release it; (b) `keydown`/
  `keyup` on Alt while focus is in that pane's composer textarea, with a
  `blur` listener as the equivalent of `mouseleave` for the keyboard path
  (Alt-tabbing away blurs the textarea without a matching `keyup` ever
  firing).
- New `heldRecordings` Set (index-keyed, alongside the existing
  `activeRecordings` map) tracks which panes are CURRENTLY being held,
  independent of whether a `MediaRecorder` exists yet — `getUserMedia`'s
  permission round-trip is async, so a hold can end before the stream is even
  ready. `startVoiceRecording` re-checks `heldRecordings.has(index)` right
  after that `await` and bails out (stopping the tracks it just opened) if
  the hold was already released, so a fast tap can never open a recording
  nothing will ever stop.
- **Alt was checked for collisions before picking it**, per the ask: grepped
  every `keydown`/`keyup` handler in `renderer.js` (Enter-to-send, Escape for
  the context menu/image lightbox, inline-rename Enter/Escape) — none read
  `e.altKey` or check `e.key === "Alt"`, and `main.js` sets no
  `accelerator`/`globalShortcut` anywhere (confirmed via grep — zero matches).
  The one real interaction: no custom `Menu` is set in this Electron 31 app,
  so the OS-default File/Edit/View/Window/Help application menu bar is
  present, and bare Alt normally shifts keyboard focus to it.
  `e.preventDefault()` in the `keydown` handler suppresses that reliably in
  Chromium/Electron, so Alt is free to reuse for this without stealing focus
  from the composer.

**2. "Språk funkar inte för svenska, kan man fixa hem ett svenska paket?"**
(Language doesn't work for Swedish, can we get a Swedish package?) Root
cause, confirmed rather than assumed: v1 shipped `Xenova/whisper-tiny.en` —
the `.en` suffix is Hugging Face/OpenAI's own naming convention for an
ENGLISH-ONLY fine-tune of Whisper. It was never going to transcribe Swedish
regardless of any option passed to it.

- `src/lib/voice.js`: `MODEL_ID` changed to `Xenova/whisper-tiny` (no `.en` —
  the multilingual checkpoint, same tiny size class, ~150MB). Confirmed
  Swedish is genuinely in this checkpoint's vocabulary, not just "should
  work in theory": inspected the downloaded `generation_config.json`'s
  `lang_to_id` map directly — it contains a `<|sv|>` token.
- **`language` left unset, not hardcoded to `"sv"`.** Read transformers.js's
  own `automatic-speech-recognition` pipeline source
  (`node_modules/@huggingface/transformers/src/pipelines/automatic-speech-
  recognition.js`) rather than assuming: its JSDoc states `language` "Default
  is `null`, meaning it should be auto-detected." Chose to keep that default
  rather than force `"sv"` — Aidin mixes Swedish and English naturally in the
  same utterance (matches his own usage pattern), so a hardcoded language
  would fight that instead of helping it. Auto-detect picks per-utterance
  instead.

**Verified end-to-end, not just a model-name swap.** Checked for a Swedish
SAPI voice on this machine first (per the ask) — `System.Speech.Synthesis`
only has `Microsoft Hazel Desktop` (en-GB), `Microsoft David Desktop`
(en-US), and `Microsoft Zira Desktop` (en-US) installed; no Windows language
pack and no OneCore speech voices exist here either (`Get-WinUserLanguageList`
returned empty). **No genuine Swedish speech sample could be generated or
found on this machine** — this is the one thing that still needs Aidin's own
live test (real mic, real Swedish, ideally some natural Swedish/English
mixing to match his actual usage).

What WAS verified directly against the shipped module: a standalone script
imported `src/lib/voice.js`'s real `transcribeAudio` (not a mock), fed it a
real speech WAV (Windows SAPI TTS, same technique the original English spike
used), and confirmed (a) the new multilingual model downloads and caches
correctly (`node_modules/@huggingface/transformers/.cache/Xenova/whisper-tiny/`,
alongside the old now-unused `whisper-tiny.en` cache, both gitignored), (b)
transcription still works correctly end-to-end against English speech — a
real regression check, not an assumption that multilingual models stay
English-compatible — producing "Hello, Vice-Draud. Please switch to hold to
record as supports Swedish." against the spoken "Hello Maestro, please switch
to hold to record and support Swedish." (a couple of words mangled, expected
given robotic SAPI TTS input — the original English-only spike had similar
roughness), and (c) the console log line `"No language specified - defaulting
to English (en)."` confirms auto-detect is genuinely active end-to-end, not
silently ignored — it inspected the actual audio and correctly identified
English, which is exactly the mechanism that will identify Swedish when the
real input is Swedish.

**Verification commands run:** `node --check` on both edited files
(`src/lib/voice.js`, `src/renderer/renderer.js`); the standalone
`transcribeAudio` exercise above against a real SAPI-generated WAV; a full
boot-test via `scripts/restart-dev.sh` (clean boot, no errors) with
`Get-CimInstance` confirming only Maestro's own 4 processes were running
afterward (no stray prior instances, no Reinmaker collision). **What this
could NOT verify** (no live microphone on this machine, same limitation as
every prior voice-input entry): the hold-to-record interaction actually
feeling right with a real hand on a real mouse/keyboard, Alt not misbehaving
against any OS-level or driver-level global hotkey Aidin might have configured
outside this app, and — the actual point of this whole fix — real Swedish
transcription quality against Aidin's own voice, accent, and mixed Swedish/
English speech. All three need Aidin's own live test.

## 2026-07-04 — CLAUDE.md quick-links: open the real canonical file (not the stub), and open its FOLDER (not the bare file)

Follow-up to the 2026-07-03 "CLAUDE.md quick-links" entry, after Aidin
live-tested the shipped links and gave two pieces of feedback.

**1. "den globala länken går till den tomma filen istället för den som finns
i dropbox"** (the global link opens the empty file instead of the one that
exists in Dropbox). The previous `claudeMd:openGlobal` deliberately opened
`~/.claude/CLAUDE.md` - the thin stub, not the canonical Dropbox file it
`@imports` - on the reasoning that Claude Code itself resolves the import
automatically and the stub is the one path every machine actually has. That
reasoning was sound for how Claude Code consumes the file, but wrong for
what a human clicking a link in the app wants to see: the stub is a few lines
pointing elsewhere, not the actual rules. Aidin has now said directly he
wants the real file. Fixed by having `main.js` read the stub's own content,
regex-match its `^@(.+\.md)$` import line, and resolve that path
(`D:/Dropbox/Mina Dokument/Claude/CLAUDE.md` on this machine) instead of the
stub. New `resolveCanonicalGlobalClaudeMd()` helper isolates that parse step
so it can be exercised independently of Electron.

**2. "det är nog dessutom bättre om länken går till foldern med de samlade
filerna, t.ex om jag vill se decisions eller plan"** (better if the link
goes to the FOLDER with the collected files, e.g. to see DECISIONS or PLAN).
Both `claudeMd:openGlobal` and `claudeMd:openProject` now call
`shell.showItemInFolder(file)` instead of `shell.openPath(file)` - Explorer
opens on the containing folder with CLAUDE.md pre-selected, so
DECISIONS.md/PLAN.md/OPINIONS.md/VOICE.md/skills/ sitting right next to it
are immediately visible, without an extra "go up one level" step.
`showItemInFolder` chosen over `openPath` on the folder itself specifically
for that highlighted-selection behavior - a bare folder-open would land in
the same place but without drawing the eye to CLAUDE.md first. The global
link now resolves to the canonical Dropbox Claude folder (via the same
`@import`-parsing helper above); the project link resolves to `cwd` itself,
the project's own root folder - both changes are one-line swaps in
`main.js`'s two IPC handlers since `showItemInFolder` still takes a file
path and derives the folder itself. The existing "only show the project link
if a project CLAUDE.md exists" gate (`claudeMd:projectExists`) is unchanged.

**Verification:** a standalone script
(outside the app, no Electron/shell dependency) that calls the same
stub-parsing and existence-check logic the real handlers now use, asserting:
the resolved global file is the Dropbox canonical path (not the stub) and
its folder contains OPINIONS.md/VOICE.md/skills/; the resolved project
folder equals `cwd` and contains this repo's own
CLAUDE.md/DECISIONS.md/PLAN.md; both the "no CLAUDE.md at this cwd" and
"no cwd" cases still correctly report not-ok. All checks passed before
wiring the logic into `main.js`. Also ran `node --check` on both edited
files and a full boot-test via `scripts/restart-dev.sh` (clean boot, no
errors, Reinmaker's PIDs untouched). Actually clicking the links and
confirming Explorer opens on the right folder with the right file selected
still needs Aidin's own live test - no way to observe a real Explorer window
from here.

## 2026-07-04 — Classifier sweep was leaking a permanent transcript per check; encodeProjectDir was silently wrong for any path with a space

**Bug (Aidin's report, "sessions rooted themselves in Mina Dokument\Claude
again"):** Investigated instead of assuming a switch-root-folder regression.
Real cause: the orchestrator classifier (`orchestratorHelper.js`,
`config.orchestratorHelper.enabled: true`, sweeping every ~15 min) spawns a
real `claude -p` call per session it checks, correctly rooted in that
session's own folder - but that call creates a full, permanent session
transcript on disk with nothing ever cleaning it up. Confirmed live: 320 of
442 `.jsonl` files under the Dropbox Claude project directory were the
classifier's own throwaway artifacts (content-matched via its exact prompt
template, `"Session: X\nLinked task: ..."`) - not real conversations. Since
many of Aidin's genuinely personal (non-project) sessions are rooted in that
same general folder, the classifier's leak concentrated there, reading as
"my sessions keep re-rooting" when it was actually junk accumulating
alongside them. Disabled `orchestratorHelper.enabled` immediately as a
stop-gap (a config flip, non-destructive) while fixing the root cause.

**Fix attempt #1 surfaced a second, deeper, pre-existing bug.** Added
`deleteOwnTranscript(cwd, sessionId)` to `classifySessionStatus`'s `close`
handler - delete the just-created transcript immediately after reading its
`structured_output`, since nothing else ever reads it again. First
verification (a real end-to-end call against this repo's own project
folder, not a mock) still leaked a file. Traced with temporary debug tracing
(removed before committing): `encodeProjectDir` (`paths.js`, built earlier
2026-07-03 for the original `switchSessionRootFolder` fix) only replaces `:`
and `\` with `-` - it silently preserves spaces and any other special
character. The real Claude Code convention (confirmed by inspecting every
directory under `~/.claude/projects` - none contain anything outside
`[a-zA-Z0-9-]`) replaces EVERY non-alphanumeric character 1:1 with a hyphen,
e.g. `D:\Dropbox\Mina Dokument\Claude` -> `D--Dropbox-Mina-Dokument-Claude`.
The old regex produced a wrong, non-existent directory name for exactly this
folder (a space in "Mina Dokument"), so the delete silently no-opped -
`fs.existsSync` on the wrong path just returns false, no error, no signal
anything was wrong.

**Fix:** `encodeProjectDir` now does `cwd.replace(/[^a-zA-Z0-9]/g, "-")`.
Verified no regression for ordinary paths (only `:`/`\` present) - old and
new regexes produce byte-identical output when there's nothing else to
replace. The ONLY other caller besides the new cleanup is
`switchSessionRootFolder` (`sessions.js`) - meaning tonight's earlier
root-folder-switch fix has ALSO been silently computing the wrong copy-
destination directory for any target path containing a space this whole
time, a real latent bug now fixed as a side effect, not just today's leak.

**Re-verified end-to-end after the fix** (real `classifySessionStatus` call
against this repo's own large real transcript, twice): both runs returned a
genuine classification AND left zero files behind, real transcript
untouched both times. `orchestratorHelper.enabled` left OFF in config.json
pending Aidin's own decision on whether to re-enable now that the leak is
fixed - this fix stops new leaks, it doesn't retroactively clean up the 320
already-accumulated junk files, which need his explicit go-ahead before any
deletion (a call I won't make unilaterally).

## 2026-07-03 — Fas 3 Point 8 v1: a Jot-backed "Focus" page (ranked goals + goal breakdown with safe subtask write)

**Built** the first slice of PLAN.md's Phase 3 "Point 8 — split work +
prioritize focus," scoped deliberately to exactly two capabilities and no
more: (1) a read-only Focus page that ranks the user's active GOALS, and (2)
a goal-breakdown view that can add subtasks back into Jot. NOT built (out of
scope by the task's own framing): goal-to-session dispatch, auto-scheduling,
drag-reprioritization — those are later.

**Backed by Jot, not a second task system.** Per PLAN.md's own framing and
the ephemeral-sessions reorientation (the unit worth organizing is
work/goals, which already live in Jot), this reads the SAME
`D:\Dropbox\jot\todos.json` the sidebar's category matching already reads.
Reused the existing `src/lib/jot.js` read layer rather than writing a second
parser — extended it, didn't fork it.

**Bug found and fixed while reusing the read layer: Maestro's Jot integration
was silently disabled.** The real todos.json carries a UTF-8 BOM (EF BB BF —
left by an editor or a legacy external write; Jot's own app writes without
one). `loadJot`'s `JSON.parse(fs.readFileSync(...,"utf8"))` throws on a
leading BOM, so it was falling through its own `catch` into `emptyIndex` on
every call — meaning category counts, deadline sorting, and the whole
attention-scoring Jot contribution had been quietly reading zero. Fixed with
a shared `readJotFile(jotPath)` helper (strips a leading `﻿`, then
parses) that both the existing `loadJot` and the new goal functions go
through. Verified: `loadJot({}).ok` now returns 11 categories against the
real file where it previously returned the empty index.

**Capability 1 — `loadGoals(jotConfig)` (read-only ranking), jot.js:**
returns top-level todos (`parentId === null`) whose status is `open` or
`in-progress` (the goals actually worth choosing between now), each carrying
its category, priority, deadline, subtask progress (done/total), review-count,
and its own subtasks (so the breakdown needs no second read). Ranks them by an
attention score built from the SAME signals sessions.js scores sessions with:
deadline proximity via a `goalDeadlineBoost` that is byte-for-byte the same
tiering as sessions.js's `deadlineBoost` (replicated, not imported, to keep
this addition isolated to jot.js and off sessions.js's export surface that
other in-flight work also edits — noted inline that they agree on purpose and
may diverge later), in-progress status, Jot priority (lower number = more
urgent, mapped through a bounded `priorityBoost` so an extreme value can't
dominate), and small boosts for being an epic and for having review-status
subtasks. Verified against the real file: 31 active goals, top-ranked ones
are the in-progress p0 goals, as expected.

**Capability 2 ended up READ-WRITE (not read-only) — `addSubtask(jotConfig,
parentId, text)`, jot.js.** Confidence to write came from reading jot's own
`INTEGRATION.md` (the authoritative external-agent contract) and its
`storage.ts`: Jot's own writer is `JSON.stringify(state, null, 2)` as UTF-8
**without a BOM**, and the contract prescribes exactly the safe-write flow
this codebase already uses elsewhere (read latest → modify in memory → temp
file → atomic rename). So `addSubtask` re-reads the FRESHEST file immediately
before writing (never trusts an earlier in-memory snapshot — the Jot app
live-reloads and may have flushed its own edit since), appends ONE todo (a
minimal targeted change, never a blind whole-file overwrite of remembered
state), and writes via temp-file + `fs.renameSync` (atomic on-volume) so an
interrupted write can't leave todos.json torn — the same discipline as
sessions.js's `patchSessionMeta`. Output is UTF-8 no-BOM, 2-space JSON: the
file Maestro leaves behind is byte-shape-identical to one Jot's own app
wrote. The new subtask inherits the parent's `categoryId` (verified data-model
behavior), gets `status:"open"`, `priority:0`, a fresh UUID. Guards refuse:
empty text, a missing parent, or a parent that is itself a subtask (Jot nests
exactly one level — no grandchildren).

**Verified the write against a COPY, never the real board.** A standalone
script copied the real todos.json (with its BOM) into the scratchpad and
exercised `addSubtask` against that copy only: append lands under the right
parent, category inherited, text trimmed, output has no BOM and re-parses
cleanly, all three guards fire, no stray `.tmp` left behind, and the real
`D:\Dropbox\jot\todos.json` was confirmed untouched throughout. The atomic
temp-file+rename behavior was exercised as part of that (the written file is
always fully valid JSON).

**Surface: a new "Focus" page** (`renderFocusPage` in renderer.js), added as
its own page in the established `#pageToggle` pattern (a `focus` button + a
`#focusPage` div toggled with `.hidden`, exactly like Analysis/Archive/
Settings) — deliberately NOT threaded into the crowded session-list/pane
rendering paths where it could collide with other recent renderer work. The
page lists ranked goals as cards (top 3 get an accent left-edge as the
"work on this now" recommendation, the rest under an "Also active" divider),
each expandable to show its description, subtasks with status, and an
add-subtask input. Adding re-renders from the freshly-read file (never an
optimistic guess), so the UI always reflects real Jot state. All styling is
self-contained under `.focus-*` classes reusing the existing CSS variables and
the analysis-page visual language (no dependency on button/input classes that
don't exist in this repo).

**Wiring:** `main.js` — two IPC handlers (`jot:goals` read-only, and
`jot:addSubtask` for the write, both loading `config.jot`); `preload.cjs` —
`getJotGoals`/`addJotSubtask` on the `window.maestro` surface, one line each,
same pattern as every other channel.

**Verification:** `node --check` on all four changed JS files
(`jot.js`/`main.js`/`renderer.js`/`preload.cjs`); a CSS brace-balance check
(286/286); direct exercises of `loadGoals` against the real file (read-only)
and `addSubtask` against a scratch copy (see above); and a full boot-test via
`scripts/restart-dev.sh` (clean boot, no app-level errors — the GPU disk-cache
warnings in the log are benign Electron cache noise, not app errors; confirmed
via `Get-CimInstance` that only Maestro's own 4 PIDs recycled and Reinmaker's
4 PIDs — 20556/4560/25124/6292 — were untouched, consistent with the
documented safe-restart behavior). **What this could NOT verify** (native
Electron app, no browser-servable preview — same limitation noted on every
other UI change in this file): the Focus page actually rendering, the goal
cards/chips/breakdown looking right, and the add-subtask flow end-to-end
through the real IPC in the running app. That needs Aidin's own visual test.

## 2026-07-03 — Orchestrator lifespan: no privileged "the orchestrator" session; land on a dashboard, start fresh orchestrator sessions

**Decision:** Aidin flagged that two original UI choices — app opens directly
onto "the orchestrator," and any session can be assigned as "the
orchestrator" — were made before the ephemeral-sessions philosophy and now
contradict it. Both treat the orchestrator as one durable, history-
accumulating session-identity, which is the same megasession anti-pattern the
strategic reorientation rejects, and also contradicts the already-made
decision that the classifier is stateless (2026-07-02). Confirmed the
redesign (full detail in PLAN.md's new "Orchestrator-lifespan redesign"
subsection under Phase 3): (1) remove session-assignment — no privileged
session IS the orchestrator; the sensor/sweep/dispatch runs headless in the
main process; (2) app lands on the overview/dashboard (Phase 1's original
vision), not a chat; (3) "open the orchestrator" becomes "start a NEW
orchestrator session" — fresh each time, pre-loaded with orchestrator-
instructions.md + a current-state brief (Jot, PLAN.md), never resumed
history, reusing Phase 2's planned handoff mechanism. This session itself is
the illustrating example: it worked as an orchestrator and became exactly the
long everything-session we're moving away from.

Not ripped out today (current default still works); it's the confirmed
direction for new orchestrator UI work. Aidin explicitly delegated steering
Maestro's direction along this philosophy to me from here, being newer to it
himself — so this and future direction calls are made on that standing
authority, still surfaced here for his review, not presumed silently.

## 2026-07-03 — Voice input v1: local offline Whisper (transformers.js), not OS speech API or whisper.cpp bindings

**Context:** PLAN.md's Phase 4 candidate pool flags voice input as "the best
first experiment" — Kun Chen uses OpenSuperWhisper as his PRIMARY prompt-
composition method instead of typing. Aidin asked for a spike first, then a
minimal build, not upfront design certainty ("build a first prototype, then
we review it together").

**Spike — three options checked in the requested preference order:**
1. **Windows' own OS-level speech recognition** (Windows Speech Recognition /
   `Windows.Media.SpeechRecognition`) — not pursued past a quick check: there
   is no simple Node/Electron binding for this WinRT API; reaching it would
   mean either a native addon or a PowerShell/COM bridge, both meaningfully
   more fragile and heavier than option 2 below for the same outcome.
2. **A local whisper.cpp binary or an npm wrapper** — checked both
   `nodejs-whisper` and `whisper-node`. Both compile whisper.cpp from source
   at install/first-run time; their own Windows install docs require
   MinGW-w64/MSYS2 (`make`/`cmake`) on PATH. Verified directly on this
   machine: no `cmake` or `make` on PATH, only a bare `gcc.exe` from an
   existing msys64 install (not the full toolchain either package's docs
   ask for) — exactly the "exotic manual install" case Aidin asked me to
   flag rather than force through.
   - Found a third path in the same family that DOES clear the bar:
     **`@huggingface/transformers`** (transformers.js, the actively-maintained
     successor to `@xenova/transformers`) runs Whisper via prebuilt
     `onnxruntime-node`/`sharp` binaries — no C++ compile step at all.
     `npm install` completed cleanly in ~8s with zero build tooling. This is
     the option actually used (see below) — closer to option 2's spirit (a
     real local Whisper model) than option 3, without its blocker.
3. **OpenSuperWhisper itself** — Aidin's actual daily tool. It is macOS-only
   (a native macOS app); not installable or scriptable on this Windows
   machine. Stated plainly rather than attempting to force it — matches the
   ask.

**Chosen: `@huggingface/transformers` running `Xenova/whisper-tiny.en`,
inference in Maestro's own Electron MAIN process (Node), not the renderer.**
Verified live end-to-end via a real spoken WAV (Windows SAPI
`System.Speech.Synthesis` TTS used to generate a genuine speech waveform for
the spike, since no live mic input is available to me): first call
auto-downloaded the model (~151MB fp32 ONNX, two files — encoder + merged
decoder — into `node_modules/@huggingface/transformers/.cache`, a one-time
background download, not a blocking manual step) and transcribed correctly
("Hello Maestro. Please open the project folder and start a new session.")
in ~13s total (mostly the download); a second run with the model already
cached loaded in ~1.4s and transcribed a short clip in ~1-2s. Picked
`whisper-tiny.en` (smallest usable size, English-only) to match the
deliberately minimal v1 scope — no language picker yet (see below).

**Why main-process inference, not renderer:** keeps the renderer's strict CSP
(`default-src 'self'`) completely irrelevant to the model/runtime — no WASM/
worker CSP exceptions needed — and matches this repo's existing division of
labor (all CLI/file-system/model work lives in `src/lib/*`, IPC-bridged to
the renderer via `preload.cjs`, same shape as `judge.js`/`suggest.js`).

**Built (minimal "record → transcribe → insert" loop only, per the ask —
no language selection, no continuous dictation):**
- `src/lib/voice.js` (new) — `transcribeAudio(float32Samples)`, lazily creates
  and caches one `pipeline("automatic-speech-recognition", "Xenova/whisper-
  tiny.en")` for the process lifetime (re-creating it per call would reload
  the model from disk every time). A failed first load clears the cached
  promise so a transient network error on the first-ever download doesn't
  permanently wedge the feature.
- `src/main.js` — a `mainWindow.webContents.session.setPermissionRequestHandler`
  added in `createWindow()` (none existed before), scoped to only grant the
  `"media"` permission (needed for the renderer's `getUserMedia`) and deny
  everything else; Electron denies all media requests by default without an
  explicit handler. New `voice:transcribe` IPC handler rebuilds a
  `Float32Array` from the plain array the renderer sends (contextBridge's IPC
  boundary carries a plain array more reliably across Electron versions than
  a typed array) and calls `transcribeAudio`.
- `src/preload.cjs` — `transcribeVoice(samples)` added to the exposed
  `window.maestro` surface, same one-line-per-channel pattern as every other
  entry.
- `src/renderer/renderer.js` — a microphone icon-button (`.icon-btn`, same
  class/size as the existing pick-folder/attach buttons) added to
  `composer-controls`, immediately before the send button. Click starts
  `getUserMedia({audio: true})` + `MediaRecorder`; click again (now showing a
  stop icon) stops it. On stop: decodes the recorded Blob via
  `AudioContext.decodeAudioData` then `OfflineAudioContext` (1 channel,
  16kHz) to get the exact mono/16kHz `Float32Array` Whisper's feature
  extractor expects — resampling falls out of the same decode step for free,
  no separate resampling library needed — sends it to
  `window.maestro.transcribeVoice`, and **appends** the returned text into
  the composer's textarea (a trailing space/newline is added first only if
  the existing text doesn't already end in one). Chose append over replace:
  voice is meant as an alternative way to ADD to what you're composing, not a
  silent overwrite of anything already typed. Recording state and the
  in-flight `MediaRecorder`/stream are keyed by pane INDEX in a module-level
  `activeRecordings` Map — same reasoning as the existing `liveStatsTickers`
  map (a pane can be reset/replaced mid-recording; looking `panes[index]` up
  fresh means a stale recording has nowhere valid to land).
- `src/renderer/style.css` — `.icon-btn.recording` (red, same hex family as
  `.send-btn.stopping`, for a consistent "something live/attention-needing"
  cue) reuses the existing `pane-status-pulse` keyframe so it visibly pulses
  while recording, no new animation needed.
- `package.json` — added the one new runtime dependency,
  `@huggingface/transformers` (`npm install`, no other package changes).

**Verification:** `node --check` on all four edited/new JS files, a CSS
brace-balance check, and a full boot-test via `scripts/restart-dev.sh` twice
(clean both times; confirmed via `Get-CimInstance` that only Maestro's own 4
PIDs recycled and Reinmaker's 4 PIDs were untouched throughout). Separately
verified the actual shipped `src/lib/voice.js` module end-to-end against a
real speech WAV via a standalone script importing it directly — confirmed
correct transcription text, and confirmed the model cache lands in this
repo's own `node_modules` (gitignored, so it never gets committed). **What
this could NOT verify** (no live mic access, no browser-servable preview for
a native Electron app — same limitation noted on every other UI change in
this file): whether `getUserMedia` actually prompts for and receives real
microphone permission end-to-end in the packaged app, whether the microphone
button renders correctly alongside the other composer controls, and — most
importantly — real transcription QUALITY against Aidin's own voice, accent,
and speaking environment (background noise, distance from mic, etc.). All of
that needs Aidin's own live test. Deferred by design, per the ask to keep v1
to exactly "record, transcribe, insert": language selection, continuous/
live dictation, a visible recording-duration indicator, and error-surfacing
richer than a button tooltip.

## 2026-07-03 — Model/effort suggestion-accuracy check made proactive, folded into the existing sweep

**Context:** PLAN.md's Fas 3 write-up already named this as one of "two more
periodic checks folded in here rather than getting their own mechanism"
(2026-07-02 decision, "infogas i Fas 3:s orkestrator-helper istället för en
egen separat loop") — the other being auto-compact, already shipped. Until
now the model/effort suggestion-accuracy review only existed as an on-demand
"Suggestion accuracy" report on the Analysis page (renderer.js's
`renderAnalysisPage`, backed by `usage.js`'s `readUsageSummary`), which Aidin
has to remember to open. This closes that gap: the same periodic
`runOrchestratorSweep` that already runs the session-status classifier and
auto-compact now also periodically re-checks suggestion accuracy and
surfaces a finding when it looks meaningfully off — sensing + surfacing
only, per the task's own scope; changing the suggestion heuristic itself
(`suggest.js`) stays a separate, bigger follow-up.

**Built:**
- `usage.js`'s `computeSuggestionAccuracyVerdict(summary)` — extracted the
  EXACT followed-vs-overridden "appropriate" rate comparison the Analysis
  page already computed inline, so the proactive sweep and the on-demand
  report are provably the same metric, not two that could drift apart. Takes
  `readUsageSummary()`'s output, returns `null` when there isn't at least one
  judged run on each side (mirrors the report's own empty state), otherwise
  `{ followedTotal, overriddenTotal, followedRate, overriddenRate,
  diffPoints, message }`. Verified against hand-computed cases (a "heuristic
  looks bad" case and a "heuristic looks fine" case) — output matches the
  report's own arithmetic exactly.
- `main.js`'s `runSuggestionAccuracyCheck(config)` — called from the end of
  `runOrchestratorSweepBody` behind a new `config.suggestionAccuracyCheck.
  enabled` toggle (off by default, same opt-in posture as the classifier and
  auto-compact). No model call and no extra file I/O beyond what the
  on-demand report already does (`readUsageSummary` parses the local
  `usage-log.jsonl`), so cost isn't the reason it's gated — re-nagging Aidin
  about the same stale finding is. Gated on **data volume, not wall-clock
  time**: `config.suggestionAccuracyCheck.lastCheckedFollowedTotal/
  lastCheckedOverriddenTotal` remember the totals as of the last check, and
  the sweep only re-evaluates once at least `SUGGESTION_ACCURACY_CHECK_
  EVERY_N_RUNS` (10) new judged+suggested runs have accumulated since. A
  fixed calendar interval (e.g. weekly) was considered and rejected — Aidin's
  usage is bursty, so a wall-clock trigger would either fire on completely
  unchanged data during a quiet week or stay silent through a heavy one; a
  count of new data points ties the check to when the verdict could actually
  have moved.
- The finding surfaces as `config.suggestionAccuracyNotice = { message,
  diffPoints, totalAtCheck, dismissed }`, written only when `diffPoints < 0`
  (overriding the suggestion did better than following it — the "suggested
  Sonnet but Opus was judged appropriate more often" signal). A
  positive/neutral diff clears any existing notice instead of leaving a
  stale one around once new data shows the heuristic is fine again.
  Dismissing (Analysis page) sets `dismissed: true`; the SAME staleness
  pattern as `acknowledgedSessions` (keyed on a value that changes with real
  new activity, here `totalAtCheck` instead of `lastActivityAt`) means a
  dismissal only sticks until the next check finds enough new data to
  produce a genuinely different reading, not forever.
- Surfaced on the **Analysis page** (not a per-session row) since this is a
  whole-heuristic finding, not about any one session — placed directly above
  the existing "Suggestion accuracy" block it's derived from, using the same
  dashed-border "propose, you decide" visual language as the archive-suggest
  pill (`.analysis-notice`/`.analysis-notice-dismiss` in style.css). A new
  settings toggle ("Proactively check suggestion accuracy (Fas 3)") sits
  alongside the existing orchestrator-helper/auto-compact toggles rather than
  a new settings section, matching the task's own instruction to keep this
  small.
- `config.js`: new `suggestionAccuracyCheck` (deep-merged like the other
  nested toggles, so a partial `config.json` never silently drops
  `lastCheckedFollowedTotal`/`lastCheckedOverriddenTotal`) and
  `suggestionAccuracyNotice` defaults.

**Verified:** `node --check` on all four changed JS files
(`config.js`/`usage.js`/`main.js`/`renderer.js`); a standalone ESM
exercise of `computeSuggestionAccuracyVerdict` against synthetic
"heuristic looks bad"/"heuristic looks fine"/empty-data cases; a
standalone exercise of the check's gating logic across four sequential
calls (fires and sets a notice on enough new bad-heuristic data, skips on 0
new runs, skips below the 10-run threshold, then fires again and CLEARS the
notice once enough new data flips the verdict positive); a run of the real
`computeSuggestionAccuracyVerdict` against this repo's actual
`usage-log.jsonl` (correctly returns `null` today — no overridden+judged
runs logged yet); and a full boot-test via `scripts/restart-dev.sh` (clean
boot, no errors, twice — once before and once after an unrelated concurrent
edit to `main.js` from other in-progress work).

## 2026-07-03 — Live time/tokens ticker, "needs your input" flag, CLAUDE.md quick-links

Three independently-scoped UI fixes bundled into one pass (all touch
renderer.js/style.css) rather than three parallel agents, to avoid concurrent
edits to the same files.

**1. The time/tokens readout is now LIVE, not static.** Aidin's feedback on
the just-shipped version: "den här är inte rolig eller särskilt animerande,
och den räknar inte upp varken tokens eller tid" — it only ever showed a
number after the fact, from the final `result` event.

- `launcher.js` now also reads `evt.message.usage` off every `"assistant"`
  stream-json event (not just the final `result` event) and emits a new
  `{kind: "usage", totalTokens}` event per the CLI's own per-message usage
  snapshot. Verified via the claude-api skill that each assistant message's
  `usage` is that message's own token count, not a cumulative running total —
  so summing across every assistant event in a turn (each is one real API
  call in the underlying agentic loop) gives the correct turn total with no
  double-counting.
- Renderer: `pane.runStartedAt`/`pane.liveTokens` (new `freshPane()` fields),
  a `startLiveStatsTicker`/`stopLiveStatsTicker` pair (module-level map keyed
  by pane INDEX, same pattern as `paneNavHistory` — looks up `panes[index]`
  fresh every 250ms tick so it naturally goes inert once that slot no longer
  holds the run it was started for), and `renderLiveStats` which appends a
  ticking "Ns · Nk tokens" span to `.pane-status`. Started at the true send
  moment in `sendFromPane` (not inside `setPaneBusyUI`, which also fires on
  every intermediate tool_use — that would reset the clock each time) and
  stopped at every point a run ends (`done`, `error`, stop-button, switch-
  folder failure, start failure) and at every point a pane gets replaced
  wholesale (new chat, split close, rewind, session navigation) so no ticker
  is ever left running against a discarded pane.
- The existing final-summary logic (`pane.lastTurnStats` /
  `wireTurnStatsOnLastReply`) is untouched — the live ticker hands off to it
  the moment `pane.busy` goes false, matching the ask ("don't remove the
  current final-summary logic, make it update live before that point").
- "Thinking" dot now visibly reacts to each new event: `pulsePaneStatusIcon`
  toggles a `.pane-status-icon-ping` class (a one-shot brighter/bigger CSS
  animation, self-clearing since it's driven by the animation itself, not a
  toggled state) on `tool_use`, `usage`, and `assistant` events, layered on
  top of the existing ambient pulse rather than replacing it — simplest
  change that reads as "more animated" per the ask not to over-engineer this
  part.

**2. Flag a completed reply that's actually asking the user something.**
Context: a 2026-07-03 spike (see the persistent-process entry below)
already conclusively established headless `-p` has no live pause-and-ask
mechanism — a real Claude-Desktop-style blocking dialog is architecturally
impossible here, not something to attempt. This is the agreed approximation
instead: a purely visual "don't miss this" flag, not a new input mechanism —
the user still answers via the normal composer.

- `looksLikeQuestion(text)` — cheap, synchronous, deliberately not an LLM
  call: true if the last non-empty line ends in `?`, OR the last couple of
  lines match a small set of common ask-for-input phrasings that don't
  necessarily end in `?` (e.g. "Let me know how you'd like to proceed.").
  Verified against 7 hand-picked cases including two deliberate near-misses
  (a rhetorical question followed by a statement, a code snippet containing
  `?.`) — 7/7 correct.
- `wireQuestionFlagOnLastReply` applies it to the LAST assistant bubble
  whenever the pane is not busy (mirrors the non-destructive/idempotent
  pattern the other `wireX` helpers on `renderPane` already use, for the same
  queued-prompt intermediate-render reason documented on
  `wireTurnStatsOnLastReply`). When true: a `.needs-input` class tints the
  bubble's existing border with `--waiting` (the same amber already meaning
  "needs you" elsewhere in the app, e.g. the sidebar status) and a "❓ Needs
  your input" badge is prepended inside the bubble.

**3. Clickable links to open Aidin's global and the current project's
CLAUDE.md.** Re-does a prior pass that had misread this as a documentation-
only fix — the actual want was in-app navigation.

- `main.js`: three new IPC handlers — `claudeMd:openGlobal` (opens
  `~/.claude/CLAUDE.md`, the thin stub, not the canonical Dropbox file it
  `@imports` — Claude Code resolves the import automatically regardless of
  which one is opened, and the stub is the one path every machine actually
  has, so it's the more reliable fixed target; Aidin can follow the `@import`
  line himself for the canonical file), `claudeMd:openProject` (opens
  `<cwd>/CLAUDE.md`), and `claudeMd:projectExists` (existence check so the
  renderer can skip the affordance entirely rather than show a link that
  errors on click). All via `shell.openPath`, same mechanism `skills:open`
  already uses.
- Renderer: `updateClaudeMdLinks(header, cwd)` renders two small icon-buttons
  (🌐 global, 📄 project — reusing the `.icon-btn` class the header's
  existing ←/→/+/✕ buttons use, sized down via a new `.claude-md-links` rule
  since the header's full 26px icon size would dwarf the 11px `.pane-sub`
  text it sits beside) next to the pane header's folder-path text. Called
  from both `paneHeaderEl`'s initial build and `updatePaneSubText` (the
  existing live-update path for cwd changes — folder pick, typing, a root-
  folder switch) so the project link never points at a stale folder. The
  project button is only appended after `projectClaudeMdExists(cwd)`
  resolves true, per the ask to hide rather than error on a missing file.

**Verification:** `node --check` on all four edited JS files, a CSS brace-
balance check, and a full boot-test via `scripts/restart-dev.sh` (clean log,
Reinmaker's pre-existing PIDs confirmed untouched). No live click-through was
possible beyond that — native Electron app, no browser-servable dev server —
so all three items still need Aidin's own visual/interactive confirmation:
the live ticker actually counting up during a real run, the question-flag
badge/border rendering as expected on a real question reply, and both
CLAUDE.md links actually opening the right file in his default editor.

## 2026-07-03 — Worktree automation v1 built (`src/lib/worktree.js`) — the Phase 4 prerequisite

**Built:** a first version of the worktree-automation module PLAN.md's Phase
4 section flags as the prerequisite for everything else in that roadmap
(parallel dispatch, gnhf-style orchestration, no-mistakes-style pipelines) —
nothing else there can safely run multiple agents against one repo without
it. New module `src/lib/worktree.js`, exporting `createWorktree`,
`removeWorktree`, `listWorktreePaths`, `worktreeExists`,
`hasUncommittedChanges`, `worktreesRootFor`, `worktreePathFor`. Backend/
library only — not wired into `main.js`'s IPC handlers or `renderer.js` yet;
nothing consumes it today, on purpose, to stay clear of other in-flight
renderer/main changes.

**Shape, inspired by (not copying) treehouse/gnhf's actual source** (both
studied 2026-07-03, see the entries below): every function takes an
EXPLICIT `projectPath` argument and never touches this process's own cwd —
the exact design question resolved in the "worktree-rooting" entry below.
All git calls go through a local `runGit(projectPath, args)` helper that
always shells out as `git -C <projectPath> ...`, using the codebase's
existing `execFileSync("git", [...])` pattern from `version.js` rather than
inventing a new way to shell out. Worktree location mirrors gnhf's own
sibling-directory convention: `worktreesRootFor(projectPath)` resolves
`<repo>-worktrees/` next to the repo itself (e.g.
`D:\Repo\Tools\maestro-worktrees\<id>`), not nested inside the repo, so
worktrees never show up as clutter in the very repo they're isolating work
from. `createWorktree` runs `git worktree add <worktreePath> -b
<branchName>` and returns `{ worktreePath, branchName, envFilesCopied }`.

**Improved on gnhf's documented gap, kept simple:** gnhf's own `git.ts`
(confirmed via source read) leaves a fresh worktree with only tracked files
— no `node_modules`, no `.env` — and relies on the first agent iteration to
notice and fix it. `createWorktree` closes the cheap half of that gap:
after `git worktree add`, it copies any top-level `.env`/`.env.local` from
the source repo into the new worktree (`copyEnvFiles`, top-level only, not
recursive) so a fresh worktree isn't immediately broken for projects that
need an env file just to boot. Deliberately did NOT attempt dependency
install (`npm install` or otherwise) in this pass — genuinely more complex
(registry access, install timing, per-project package-manager choice) and
out of scope for v1; noted both here and inline in `createWorktree`'s doc
comment as a clear follow-up once something actually dispatches work into
these worktrees.

**Fail-closed removal, matching firstmate/gnhf's own teardown principle:**
`removeWorktree` refuses to remove a worktree with uncommitted changes
(`hasUncommittedChanges`, via `git status --porcelain`) unless the caller
explicitly passes `{ force: true }`. Also refuses to remove a path that
isn't a currently-registered worktree at all (checked via
`worktreeExists`/`listWorktreePaths`, both backed by `git worktree list
--porcelain`) rather than silently no-op'ing — every failure mode throws
instead of swallowing, so a caller always knows whether removal actually
happened.

**Verified with a real spike, not just "no error thrown":**
`spike/test-worktree-lifecycle.mjs` creates a throwaway git repo under the
OS temp dir (never Maestro's own working tree), then exercises the full
lifecycle against it: create -> confirm the worktree directory exists on
disk, the tracked file is present, `.env` was copied byte-for-byte, and
`git worktree list --porcelain` independently agrees a new worktree exists
on the right branch; list -> confirms both the new worktree and the
project's own primary working tree are reported; a dirty-worktree removal
attempt -> confirms it's correctly blocked and the directory survives;
forced removal -> confirms the directory is actually gone from disk AND
git no longer lists it; a second removal attempt on the now-gone worktree
-> confirms a clear error rather than a silent no-op. All 20 assertions
passed on a real run; the scratch repo and its worktrees directory are
deleted at the end (via a `finally` block, so cleanup runs even on
failure), and `git status`/`git branch --show-current` on Maestro's own
repo were checked before and after — completely unaffected throughout.

**Verification commands run:** `node --check` on both new files;
`node spike/test-worktree-lifecycle.mjs` (full pass, real filesystem/git
state inspected at each step, not just exit code).

## 2026-07-03 — Orchestrator instructions extracted into their own file (the third CLAUDE.md-shaped layer)

**Context:** Aidin asked a good architecture question while looking at
`orchestratorHelper.js`'s inline classifier prompt: as the orchestrator's job
grows beyond classifying (into dispatch, escalation, etc. — see PLAN.md's
Phase 3 write-up), where should its own "how should the orchestrator itself
behave" instructions live? Agreed it's a THIRD layer, distinct from (1)
Aidin's global personal CLAUDE.md (general collaboration rules, applies
everywhere) and (2) each project's own repo CLAUDE.md (dev conventions for
that specific project). This third layer is the orchestrator's own operating
manual — the same role `AGENTS.md` plays for `firstmate` (already studied,
see the 2026-07-03 source-read entries below): a dedicated, editable file
completely separate from any project it happens to be supervising.

**Built:** extracted the classifier's inline `CLASSIFIER_SYSTEM_PROMPT`
string out of `src/lib/orchestratorHelper.js` into a new
`src/lib/orchestrator-instructions.md`, loaded at runtime via
`fs.readFileSync` (resolved relative to the module's own file via
`fileURLToPath(import.meta.url)`, so it works regardless of cwd) instead of
being hardcoded JS. Chose to keep it next to `orchestratorHelper.js` in
`src/lib/` rather than the repo root — it's consumed by exactly one module
today, unlike `PLAN.md`/`DECISIONS.md`/root `CLAUDE.md`, which serve the
whole repo/every session.

**Content — relocated, then modestly expanded, not rewritten:** the file
keeps the original classification instructions (the 5 status tags, JSON-only
response, the 12-word `reason` constraint) verbatim, and adds two sections
already decided in PLAN.md's Phase 3 write-up rather than inventing anything
new: the **orchestrator vs. worker** distinction (orchestrator holds the
continuous thread and can explain why; workers are ephemeral and scoped) and
**human gating scaled to blast radius** (propose via a UI affordance, never
fully autonomous for anything that mutates state a human would want to
review — today's classifier output is explicitly framed as a signal that
feeds sorting/pills, never a trigger that acts on its own). Deliberately kept
lean — a foundational first version sized to what the classifier alone needs
today, to be grown as dispatch/escalation/coaching actually get built, not a
full spec written in advance.

**Behavior unchanged, verified:** the classifier's actual recipe —
`--allowed-tools ""`, empty `--strict-mcp-config`, the Haiku model/effort
args, the `TAG_SCHEMA` JSON schema, and the 5 `STATUS_TAGS` values — is
untouched; `git diff --stat` confirms only `orchestratorHelper.js` changed
(10 insertions/9 deletions, all in the prompt-loading section) plus the one
new untracked markdown file. Verified: `node --check` on the edited file,
a standalone ESM import test that exercises the exact `readFileSync` path
resolution at module-load time (confirms `classifySessionStatus` still
exports correctly and the file loads without throwing), and a full boot-test
via `scripts/restart-dev.sh` (clean log, no errors; confirmed via
`Get-CimInstance` that Maestro's own 4 processes recycled correctly and
Reinmaker's 4 processes were untouched, consistent with the documented safe-
restart behavior).

## 2026-07-03 — firstmate/gnhf relationship CONFIRMED; worktree-rooting question resolved

**Decision:** Aidin confirmed the recommendation from the deep source read
(see the entry below): firstmate → reference only, not code (impossible to
run on Windows regardless, tmux/POSIX-locked); gnhf → vendor/adapt its
`Orchestrator` source into Maestro's own codebase; treehouse → build first,
independent of the rest. "Reuse the code" for firstmate specifically means
reuse the SOURCE-LEVEL KNOWLEDGE of how it solved wake-classification,
escalation, and worktree hand-off — not running its bash.

**Also resolved a real technical question Aidin raised:** if Maestro's own
future orchestrator dispatches work across many different projects, it
can't itself be "rooted" in all of them at once — so how would it create a
worktree for a project it isn't rooted in? Answer: it doesn't need to be.
The constraint hit earlier tonight (Agent-tool worktree isolation failing
because it infers the target repo from the calling session's own cwd) is
specific to that one convenience feature in Claude Code's own tooling, not
a property of git worktrees in general. Confirmed directly in both repos'
source: `treehouse get` takes an explicit project reference regardless of
firstmate's own cwd, and gnhf's `createWorktree` (`git.ts`) takes an
explicit repo/path argument. Maestro already tracks `session.cwd` per
project, so its own orchestrator can run `git -C <projectPath> worktree add
<worktreePath> -b <branch>` directly against the right repo from wherever
the orchestrator process itself happens to run — no rooting requirement.

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
