const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };

// Mirrors isWorkingState in src/lib/sessionState.js. The renderer is a classic
// script, not a module, so it cannot import the helper - and a bare
// `lifecycleState === "working"` here is how a NEW state silently reads as idle:
// adding `launching` did exactly that to the Fleet rows, reintroducing the
// "idle while working" display the FSM epic exists to remove. Any reader asking
// "is this session working" must go through this, never a string compare.
// Add a state to sessionState.js's isWorkingState and it must be added here too.
const WORKING_LIFECYCLE_STATES = new Set(["working", "launching"]);
const isWorkingLifecycle = (ls) => WORKING_LIFECYCLE_STATES.has(ls);

let state = { sessions: [], config: { groups: [], viewMode: "simple" }, quota: null, orchestratorHome: "" };
// The CLI session ids currently bound to an active first mate (mate.sessionId).
// Refreshed each poll in refresh(); the signal for "is this session a first
// mate" (see isOrchestratorSession) - being rooted at the meta-home is not
// enough on its own.
let mateSessionIds = new Set();
// sessionId (both cliSessionId and sessionId forms) -> the active first mate it
// belongs to. Lets any session surface (the needs-you queue especially) show
// "this is first mate X" instead of the cryptic prompt-derived title a
// first-mate session gets after its first turn. Rebuilt each refresh().
let mateBySessionId = new Map();
// Mates whose crew was still RUNNING on the previous poll. The transition that
// matters is the crew's, not the session's: a mate ends its turn while its crew is
// still going, so by the time the crew finishes the session has long since settled
// into "waiting" and no session-level transition will ever fire again. Without this
// the arrival of finished crew is silent - measured on a real day, crew finished at
// 12:41 and 13:10 and nothing said so.
let matesWithLiveCrew = new Set();
let secondMateBySessionId = new Map();
// CLI session ids with a turn CURRENTLY running (from the "session" event until
// the process "closed"), tracked independently of any pane so it survives
// navigating away and reopening. Lets a reopened pane show "working" for a live
// turn instead of a hung-looking idle (bug a39286b7).
let runningSessions = new Set();
// cliSessionId -> queued follow-up prompt text, tracked independently of any
// pane for the exact same reason as runningSessions: the queue's whole point
// (see paneComposerEl) is "step away and it still fires when the current run
// finishes" - but it lived only on the pane object, which openSessionInPane
// discards on ANY navigation away and back (bug: the captain, "message queues
// verkar inte funka ... försvinner när jag lämnar sessionen" - confirmed by
// reading the code, not just suspected).
let queuedPromptBySession = new Map();
// App-level view history (Dashboard/Analysis/Archive/Chat/...), driven by the
// mouse side buttons so back/forward navigate across the WHOLE app.
// navigateToPage pushes here; appNavigateView walks it.
let viewNavStack = [];
let viewNavIndex = -1;
// Ids (mateId or sessionId) whose retire/archive handoff-summarize is in flight,
// so the specific fleet card shows a busy state (not just the bottom toast) -
// the "visa på rutan" half of the retire/archive-spinner ask. Cleared when the
// op's final re-render runs.
let handoffBusyIds = new Set();
let archiveSearchTerm = ""; // filters the Archive page's two lists by title/folder
// Goal page (Fas 3 Point 11) — all autonomous runs this session, keyed by
// goalRunId. The backend (main.js liveGoalRuns + goal:event carrying
// goalRunId) already supports several concurrent runs, each in its own
// isolated worktree; the renderer tracks each as its own entry so the Goal
// page can launch and watch more than one at a time. Each entry:
// { goalRunId, ordinal, goal, projectPath, maxIterations, model, effort,
//   verifyCommand, escalationConfig, status, iterations: [...], result, error,
//   escalation, latestPlan, latestModel }. `escalation` (Point 12 Phase-0, opt-in) is set
// when a run pauses on a signal instead of finishing - see goalOrchestrator.js.
let goalRuns = new Map();
// Monotonic label counter so concurrent runs are tellable apart ("Run 1", …).
let goalRunSeq = 0;
// goalRunIds whose error/escalation hasn't been seen yet - drives the small
// attention dot on the primary Dashboard tab so a failed/paused run started
// off-page (e.g. while on Chat) isn't silently missed. Cleared whenever the
// user navigates into the Goal facet (see navigateToPage).
let unseenGoalAttention = new Set();
// Persists the "Escalate on trouble" checkbox across re-renders of the launcher
// form (renderGoalPage rebuilds the whole page's DOM each time). A plain module
// var since it must survive before any run exists.
let goalEscalateOnTrouble = false;
let selectedSessionId = null;
let focusedPaneIndex = 0;
// The single source of truth for a drag-reorder: set on every dragover and
// read verbatim by drop, so the drop lands exactly where the indicator was
// First-mate refresh pipe (docs/orchestration-model.md phase 5): when a
// first-mate session's context gauge crosses this %, nudge to hand off to a
// fresh one (a first mate stays thin - continuity is in files, not a bloating
// window). firstMateHandoffNotified keeps the away-from-desk notification
// one-per-session so it doesn't fire on every gauge tick.
const FIRST_MATE_HANDOFF_PCT = 70;
// Tier-discipline detection (ad17e2e6, layer 1): a first mate that has taken many
// turns in one session has ground through a lot of work/context even if its
// context% is still low (the dinghy runaway was ~143 turns at ~12% of a 1M
// window) - a signal to hand off to a fresh session. Complements the ctx gauge.
const FIRST_MATE_HOT_TURNS = 60;
const firstMateHandoffNotified = new Set();

// launchId -> { index, pane, startedAt }. The ONE map every launch-scoped
// event (session/tool_use/assistant/error/done) is routed through,
// always gated on `panes[index] === pane` before being applied. Storing the
// pane OBJECT (not just its index) is what makes that check meaningful: if
// the user resets/reopens that pane slot before a launch's events arrive,
// `panes[index]` no longer IS this object, and the (now orphaned) event is
// correctly dropped instead of bleeding into an unrelated session. A prior
// version used a second map (paneLaunchMap) for the common-case lookup
// WITHOUT this identity check, plus its own separate, leak-prone cleanup —
// removed in favor of this single map used everywhere.
const launchPaneHistory = new Map();
// App-wide, not per-pane — a background Task-tool subagent's lifecycle
// (task_started -> task_progress* -> task_updated/task_done), keyed by taskId.
// Schema verified via spike/test-task-events-shape.mjs before building this.
const backgroundTasks = new Map();
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
// A long session can spawn many subagents; the only removal path used to be
// the manual "Clear finished" click, so a session that never clicks it
// grows this map forever. Mirrors pruneStaleLaunchHistory's shape.
const BACKGROUND_TASK_MAX_AGE_MS = 60 * 60 * 1000;
// Ad-hoc listeners for a specific launchId that isn't tied to a pane's normal
// display flow — used by "Summarize & carry over" to capture a resumed
// session's summary reply without it needing to occupy a visible pane.
const pendingLaunchCallbacks = new Map();

// Each pane: { sessionId, cliSessionId, cwd, title, turns, hiddenCount, loading,
//              busy, currentLaunchId, isOrchestrator, pendingAttachments }
let panes = [freshPane()];

function freshPane() {
  return {
    sessionId: null,
    cliSessionId: null,
    cwd: "",
    title: "New session",
    turns: [],
    hiddenCount: 0,
    transcriptTruncated: false, // true when the loaded view is missing earlier turns (gates rewind)
    contextTokens: null, // estimated context tokens in use, for the pane-header gauge
    loading: false,
    busy: false,
    currentLaunchId: null,
    stopRequested: false,
    isOrchestrator: false,
    pendingAttachments: [], // [{ path, name }] — pasted images attached to the next send
    queuedPrompt: null, // text to auto-send once the current busy run finishes
    els: null, // the currently-live composer's element refs, set by paneComposerEl
    lastTurnStats: null, // { durationMs, totalTokens, costUsd } for the reply that just completed — consumed once by wireTurnStatsOnLastReply
    runStartedAt: null, // Date.now() at send time, drives the LIVE elapsed-time readout while busy (see startLiveStatsTicker)
    liveTokens: 0, // running total summed from each turn's incremental "usage" events, reset per run
  };
}

// Live "Ns · Nk tokens" ticker while a pane is busy — the captain's feedback on the
// first version of this readout ("den räknar inte upp varken tokens eller
// tid," i.e. it doesn't count up): a plain per-second interval reading
// pane.runStartedAt/pane.liveTokens (already updated live by the "usage"
// event case below) is the simplest thing that reads as "ticking," no need
// for anything fancier. Keyed by pane INDEX (not the pane object) since
// the pane object gets replaced wholesale on reset/new-chat — the ticker
// looks up panes[index] fresh on every tick rather than closing over a
// specific pane object, so it naturally goes inert once that slot no longer
// holds the run it was started for.
const liveStatsTickers = new Map();

function startLiveStatsTicker(index) {
  stopLiveStatsTicker(index);
  const timer = setInterval(() => {
    const pane = panes[index];
    if (!pane || !pane.busy || !pane.runStartedAt) {
      stopLiveStatsTicker(index);
      return;
    }
    renderLiveStats(index, pane);
  }, 250);
  liveStatsTickers.set(index, timer);
}

function stopLiveStatsTicker(index) {
  const timer = liveStatsTickers.get(index);
  if (timer) {
    clearInterval(timer);
    liveStatsTickers.delete(index);
  }
}

// Renders the live elapsed-time + running-token status text for a busy pane,
// without touching whatever tool-name text setPaneBusyUI's caller last set —
// this appends its own trailing span instead, so "Working — ToolName" and
// the ticking "12.3s · 1.2k tokens" coexist rather than fighting over the
// same status line.
function renderLiveStats(index, pane) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const status = paneEl?.querySelector(".pane-status");
  if (!status) {
    return;
  }
  let live = status.querySelector(".pane-live-stats");
  if (!live) {
    live = document.createElement("span");
    live.className = "pane-live-stats";
    status.append(live);
  }
  const elapsedS = (Date.now() - pane.runStartedAt) / 1000;
  const parts = [`${elapsedS.toFixed(1)}s`];
  if (pane.liveTokens > 0) {
    parts.push(pane.liveTokens >= 1000 ? `${(pane.liveTokens / 1000).toFixed(1)}k tokens` : `${pane.liveTokens} tokens`);
  }
  live.textContent = " · " + parts.join(" · ");
}

// Voice input (PLAN.md Phase 4) — records via getUserMedia/MediaRecorder,
// decodes+resamples in the renderer (Web Audio APIs are only available here,
// not in the main process), then hands off a plain 16kHz mono Float32Array to
// main's offline-Whisper transcriber (src/lib/voice.js). Keyed by pane INDEX,
// same reasoning as liveStatsTickers above: a pane can be reset/replaced
// while a recording is in flight, and looking panes[index] up fresh (rather
// than closing over the pane object) means a stale recording naturally has
// nowhere valid to insert its result.
//
// Hold-to-record, not click-to-toggle (the captain's v1 feedback: "Jag vill ha en
// hold to record function. Typ alt knappen eller någon enkel kombination.") —
// press-and-hold starts recording, releasing stops it and transcribes. Two
// equivalent ways to hold: the mic button itself (mousedown/mouseup), or the
// Alt key while focus is in that pane's composer. Click-to-toggle is gone
// entirely, not layered alongside hold, per the ask ("hold is now the
// interaction model", not a confusing dual mode).
const activeRecordings = new Map(); // index -> { mediaRecorder, stream, chunks }
// Tracks which panes are CURRENTLY being held (button pressed down or Alt
// held), independent of activeRecordings — getUserMedia's permission
// round-trip is async, so the hold can end (mouseup/keyup, or the OS
// permission prompt taking a while) before the stream is even ready. Checked
// right after the await below so a released hold never starts a recording
// nothing will ever stop.
const heldRecordings = new Set(); // index
// index -> { streamId, voiceStart, voiceLen, committed } for a hold using
// the TRUE real-time streaming path (whisper-stream.exe, see
// src/lib/whisperStream.js), as opposed to activeRecordings above (the
// MediaRecorder + rolling-re-transcription path). A pane is in exactly one
// of these two maps at a time, never both — see startVoiceRecording's
// dispatch below.
const activeVoiceStreams = new Map();

// CONTINUOUS ("live") transcription — the captain's ask: show what's being heard
// progressively WHILE holding, like Claude Desktop, instead of only on
// release. Whisper is NOT a streaming model, so this is deliberately built as
// ROLLING RE-TRANSCRIPTION, not real token streaming: while held, on this
// interval we take ALL audio captured so far, transcribe the whole
// accumulated clip, and replace the live partial in the composer with the
// latest fuller result. On release, one last full transcription produces the
// authoritative text. See DECISIONS.md ("continuous voice input").
//
// Tunable. Bumped from 2000 to 4000ms after the captain's live-test feedback that
// the whole experience felt slow: the current model (kb-whisper-small,
// Swedish-specialized - see src/lib/voice.js) is heavier per call than the
// earlier whisper-base this constant was originally tuned for, and each tick
// re-transcribes the FULL clip-so-far (not just the new audio), so the clip
// keeps getting more expensive to re-transcribe the longer the hold lasts.
// At 2s, a hold of more than a few seconds meant ticks were firing back to
// back with no breathing room, competing with each other and with the
// eventual release-time final transcription for the same CPU. 4s gives the
// model room to actually finish a tick before the next one is even due.
// Overlapping calls are still skipped (the in-flight guard on the recording
// entry below), so a slow tick never queues a backlog - it just means fewer
// live updates, never a pile-up.
const VOICE_ROLLING_INTERVAL_MS = 4000;

// Pure helper (unit-tested standalone, see spike/test-voice-span-replace.mjs):
// replace only the VOICE-inserted span of the composer text, leaving anything
// the user typed manually before recording untouched. `voiceStart` is the
// offset where voice text begins; `voiceLen` is the length currently occupying
// that span (0 before the first insert). Returns the new full value plus the
// new voice-span length so the caller can track it for the next update.
//
// A separator space is inserted before the voice text only when there IS
// preceding user text and it doesn't already end in whitespace — so "hej" +
// voice "world" becomes "hej world", but an empty composer just gets "world".
// The separator counts as part of the voice span so a later shorter partial
// (e.g. "world" -> "wo") still cleanly replaces it without stranding a space.
function replaceVoiceSpan(currentValue, voiceStart, voiceLen, newVoiceText) {
  const before = currentValue.slice(0, voiceStart);
  const after = currentValue.slice(voiceStart + voiceLen);
  let insert = newVoiceText;
  if (before.length > 0 && !/\s$/.test(before) && newVoiceText.length > 0) {
    insert = " " + newVoiceText;
  }
  return { value: before + insert + after, newVoiceLen: insert.length };
}

// TRUE real-time streaming transcription (whisper-stream.exe, see
// src/lib/whisperStream.js) — the word-by-word-while-speaking upgrade over
// the rolling re-transcription above. In this mode, whisper-stream.exe OWNS
// the microphone directly via SDL2 (spawned in the main process), so the
// renderer does NOT call getUserMedia/MediaRecorder at all for this pane's
// hold — the two mic-capture paths are mutually exclusive per hold. Only
// engaged when config.voiceEngine is "whispercpp" AND the main process
// confirms whisper-stream.exe + the model are actually installed
// (voice:streamStart returns { ok: false } otherwise, e.g. on a machine that
// only has the .whisper/ whisper-cli half installed); startVoiceRecording
// falls back to the rolling path in that case, so the feature degrades
// gracefully rather than silently doing nothing.
//
// One IPC event channel, "voice:streamEvent" (mirrors goal:event/
// session:event's shape: every payload carries the id of the run it belongs
// to, here streamId, so a stale/previous hold's late events can never be
// misapplied to a fresh one), dispatches into whichever pane's
// activeVoiceStreams entry has that streamId.
let voiceStreamListenerWired = false;

function wireVoiceStreamListener() {
  if (voiceStreamListenerWired) {
    return;
  }
  voiceStreamListenerWired = true;
  window.helm.onVoiceStreamEvent((payload) => {
    for (const [index, entry] of activeVoiceStreams.entries()) {
      if (entry.streamId !== payload.streamId) {
        continue;
      }
      if (payload.kind === "partial") {
        entry.livePartial = payload.text || "";
        applyVoiceStreamText(entry);
      } else if (payload.kind === "committed") {
        entry.committed = entry.committed ? `${entry.committed} ${payload.text}` : payload.text || "";
        entry.livePartial = "";
        applyVoiceStreamText(entry);
      } else if (payload.kind === "error") {
        // whisper-stream.exe failed to spawn or crashed mid-hold (e.g. lost
        // the capture device). The process is already gone or dying on the
        // main-process side at this point, so there is nothing left to stop
        // here — just release the hold and surface the failure. Text already
        // committed into the composer (from before the crash) is left as-is
        // rather than discarded; the user can keep typing or retry the hold.
        console.error("[helm] voice stream error:", payload.message);
        activeVoiceStreams.delete(index);
        heldRecordings.delete(index);
        entry.micBtn.classList.remove("recording");
        entry.micBtn.innerHTML = MIC_ICON_IDLE;
        entry.micBtn.title = `Streaming voice input failed, hold again to retry: ${payload.message}`;
      } else if (payload.kind === "exit") {
        // A clean stop (stopVoiceStreamIfActive) already removed this pane
        // from activeVoiceStreams before killing the process, so a normal
        // exit finds nothing here. Reaching this with the entry still
        // present means the process exited on its own without an "error"
        // event ever firing (e.g. exit code 0 for an unforeseen reason) —
        // treat it the same as an error so the UI never gets stuck showing
        // "recording" for a process that is actually gone.
        activeVoiceStreams.delete(index);
        heldRecordings.delete(index);
        entry.micBtn.classList.remove("recording");
        entry.micBtn.innerHTML = MIC_ICON_IDLE;
        entry.micBtn.title = "Streaming voice input stopped unexpectedly, hold again to retry";
      }
      return; // streamId is unique per hold; no need to keep scanning.
    }
  });
}

// Pushes the stream's current committed+partial text into the composer's
// voice span, same replaceVoiceSpan mechanism the rolling path uses so both
// paths share identical "don't clobber text the user typed before/after the
// voice span" behavior.
function applyVoiceStreamText(entry) {
  const fullText = entry.committed && entry.livePartial
    ? `${entry.committed} ${entry.livePartial}`
    : entry.committed || entry.livePartial || "";
  const { value, newVoiceLen } = replaceVoiceSpan(entry.promptEl.value, entry.voiceStart, entry.voiceLen, fullText);
  entry.promptEl.value = value;
  entry.voiceLen = newVoiceLen;
  const caret = entry.voiceStart + newVoiceLen;
  entry.promptEl.setSelectionRange(caret, caret);
  entry.promptEl.dispatchEvent(new Event("input", { bubbles: true }));
}

// Attempts to start the streaming path for this hold. Returns true if it
// took over the hold (caller must not also start the rolling path), false if
// it declined (engine isn't whispercpp, or the main process reports the
// binary/model missing) and the caller should fall back.
async function tryStartVoiceStream(index, micBtn, promptEl, language) {
  if ((state.config?.voiceEngine || "whispercpp") !== "whispercpp") {
    return false; // streaming only exists for the whisper.cpp backend
  }
  wireVoiceStreamListener();
  const res = await window.helm.startVoiceStream(language);
  if (!heldRecordings.has(index)) {
    // Hold released while the spawn round-trip was pending — if it did
    // start, stop it immediately rather than leaving it running unheld.
    if (res.ok) {
      window.helm.stopVoiceStream(res.streamId);
    }
    return true; // claim the hold either way so the caller doesn't also fall back to the rolling path
  }
  if (!res.ok) {
    console.warn("[helm] real-time voice streaming unavailable, falling back to rolling re-transcription:", res.error);
    return false;
  }
  const selStart = typeof promptEl.selectionStart === "number" ? promptEl.selectionStart : promptEl.value.length;
  activeVoiceStreams.set(index, {
    streamId: res.streamId,
    promptEl,
    micBtn,
    voiceStart: selStart,
    voiceLen: 0,
    committed: "",
    livePartial: "",
  });
  micBtn.classList.add("recording");
  micBtn.innerHTML = MIC_ICON_RECORDING;
  micBtn.title = "Recording - release to stop (live streaming transcription)";
  return true;
}

// Stops an in-progress stream for `index`, if any. Returns true if one was
// active (and has now been stopped) so the caller knows not to also attempt
// the rolling-path stop.
async function stopVoiceStreamIfActive(index) {
  const entry = activeVoiceStreams.get(index);
  if (!entry) {
    return false;
  }
  activeVoiceStreams.delete(index);
  await window.helm.stopVoiceStream(entry.streamId);
  // Whatever text is already in the composer's voice span (committed +
  // last live partial) IS the final result — unlike the rolling path, there
  // is no separate "final transcription" pass to run, since whisper-stream
  // has already been continuously transcribing in real time.
  entry.micBtn.classList.remove("recording");
  entry.micBtn.innerHTML = MIC_ICON_IDLE;
  entry.micBtn.title = "Hold to record voice input (transcribed locally, offline) - or hold Alt in the composer";
  entry.promptEl.focus();
  return true;
}

// Inline SVGs, not emoji, for the mic button's two states — matches the
// convention set by wireScrollToBottomButton's down-arrow: currentColor
// strokes/fills so the glyph inherits the button's own text color (works
// with .icon-btn's normal/hover/.recording states via CSS, nothing baked
// in), sized to sit inside the existing 26px .icon-btn box. See CLAUDE.md
// "Icons over emoji" for the standing convention this establishes.
const MIC_ICON_IDLE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
  '<path d="M5 11a7 7 0 0 0 14 0"/>' +
  '<path d="M12 18v4"/>' +
  "</svg>";
const MIC_ICON_RECORDING = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

// Globe icon for the "open global CLAUDE.md folder" button, and a
// file/document icon for the "open this project's CLAUDE.md folder" button
// (see updateClaudeMdLinks below) — replaces the previous full-color emoji
// (🌐/📄) per CLAUDE.md "Icons over emoji": currentColor stroke so both
// inherit .icon-btn's normal/hover text color instead of rendering as fixed-
// color pictographs regardless of theme.
const GLOBE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="9"/>' +
  '<path d="M3 12h18"/>' +
  '<path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>' +
  "</svg>";
const DOCUMENT_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M7 2h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>' +
  '<path d="M14 2v5h5"/>' +
  "</svg>";
// Paperclip icon for non-image attachments (composer file-attach button, and
// the small marker on a non-image attachment chip) — same replacement, same
// reasoning as GLOBE_ICON/DOCUMENT_ICON above.
// Clock, for "send this later" (task 7d9d2188). Same 13px/24-viewBox/stroke-2
// build as the paperclip so it sits in the composer row as a sibling, not as a
// one-off.
const CLOCK_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>' +
  "</svg>";

const PAPERCLIP_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 12.5l-8.5 8.5a4.5 4.5 0 0 1-6.36-6.36l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.19 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49"/>' +
  "</svg>";

async function startVoiceRecording(index, micBtn, promptEl) {
  if (activeRecordings.has(index) || activeVoiceStreams.has(index) || heldRecordings.has(index)) {
    return; // already recording, or already mid-startup for this pane (button + Alt held together fire this twice).
  }
  heldRecordings.add(index);
  const language = state.config?.voiceLanguage || "swedish";
  // Try the true real-time streaming path first (whisper-stream.exe); it
  // owns the microphone itself via SDL2, so on success we must NOT also
  // start getUserMedia/MediaRecorder below. Falls back to the rolling
  // re-transcription path (unchanged from here on) when streaming isn't
  // available — see tryStartVoiceStream's docstring.
  if (await tryStartVoiceStream(index, micBtn, promptEl, language)) {
    return;
  }
  if (!heldRecordings.has(index)) {
    return; // released during the streaming attempt's own round-trip
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    heldRecordings.delete(index);
    micBtn.title = `Microphone unavailable: ${err.message}`;
    return;
  }
  if (!heldRecordings.has(index)) {
    // Hold was released while the permission prompt/round-trip was pending —
    // don't open a recording nothing will ever stop.
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  const mediaRecorder = new MediaRecorder(stream);
  const chunks = [];
  mediaRecorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
  });

  // The recording entry carries the live-transcription bookkeeping:
  //  voiceStart  — offset in promptEl.value where voice text begins (captured
  //                once, at the caret position when the hold started, so text
  //                the user typed BEFORE recording is never clobbered).
  //  voiceLen    — length currently occupying the voice span (grows/shrinks as
  //                partials come in; 0 before the first insert).
  //  inFlight    — a rolling transcription is currently running; the next tick
  //                skips rather than queueing a backlog (whisper-base is slow).
  //  stopped     — the hold has been released; a late-returning rolling tick
  //                must NOT overwrite the authoritative final transcription.
  //  rollingTimer — the setInterval handle, cleared the instant recording ends.
  const selStart = typeof promptEl.selectionStart === "number" ? promptEl.selectionStart : promptEl.value.length;
  const entry = {
    mediaRecorder,
    stream,
    chunks,
    voiceStart: selStart,
    voiceLen: 0,
    inFlight: false,
    stopped: false,
    rollingTimer: null,
  };

  // Apply one transcription result (partial OR final) into the composer,
  // replacing only the voice span and updating voiceLen so the next result
  // replaces THIS text rather than appending a duplicate. Caret is left at the
  // end of the voice span so a partial growing in place reads naturally.
  const applyResult = (text) => {
    const { value, newVoiceLen } = replaceVoiceSpan(promptEl.value, entry.voiceStart, entry.voiceLen, text);
    promptEl.value = value;
    entry.voiceLen = newVoiceLen;
    const caret = entry.voiceStart + newVoiceLen;
    promptEl.setSelectionRange(caret, caret);
    promptEl.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // Read the transcription language fresh each call so a change mid-recording
  // still takes effect; fall back to "swedish" (pre-picker default) if config
  // hasn't loaded. Reused by both the rolling ticks and the final pass.
  const currentLanguage = () => state.config?.voiceLanguage || "swedish";

  // Transcribe the accumulated-so-far clip and, if still valid to do so, show
  // it as the live partial. Skips overlapping calls via entry.inFlight, and
  // discards its own result if the recording has since stopped (the final
  // transcription is authoritative) or the pane's recording was replaced.
  const rollingTick = async () => {
    if (entry.inFlight || entry.stopped || chunks.length === 0) {
      return;
    }
    if (activeRecordings.get(index) !== entry) {
      return; // pane reset/replaced this recording out from under us.
    }
    entry.inFlight = true;
    try {
      const samples = await decodeToMono16k(new Blob(chunks.slice(), { type: mediaRecorder.mimeType }));
      const res = await window.helm.transcribeVoice(Array.from(samples), currentLanguage());
      if (!entry.stopped && activeRecordings.get(index) === entry && res.ok && typeof res.text === "string") {
        applyResult(res.text);
      }
    } catch {
      // A failed partial is non-fatal — the final transcription on release is
      // the authoritative one; just skip this tick's update.
    } finally {
      entry.inFlight = false;
    }
  };

  mediaRecorder.addEventListener("stop", async () => {
    entry.stopped = true;
    if (entry.rollingTimer) {
      clearInterval(entry.rollingTimer);
      entry.rollingTimer = null;
    }
    stream.getTracks().forEach((track) => track.stop());
    activeRecordings.delete(index);
    heldRecordings.delete(index);
    micBtn.classList.remove("recording");
    micBtn.innerHTML = MIC_ICON_IDLE;
    micBtn.disabled = true;
    micBtn.title = "Transcribing…";
    try {
      const samples = await decodeToMono16k(new Blob(chunks, { type: mediaRecorder.mimeType }));
      const res = await window.helm.transcribeVoice(Array.from(samples), currentLanguage());
      if (res.ok) {
        // Authoritative final result — replaces whatever partial the last
        // rolling tick left in the voice span (voiceStart/voiceLen still point
        // at exactly that span). If the final text is empty, this cleanly
        // removes any stray partial rather than leaving it behind.
        applyResult(res.text || "");
        promptEl.focus();
      } else {
        micBtn.title = `Transcription failed: ${res.error}`;
      }
    } catch (err) {
      micBtn.title = `Transcription failed: ${err.message}`;
    } finally {
      micBtn.disabled = false;
      micBtn.title = "Hold to record voice input (transcribed locally, offline) - or hold Alt in the composer";
    }
  });

  activeRecordings.set(index, entry);
  // Timeslice so dataavailable fires ~every second, giving the rolling loop a
  // growing set of chunks to re-transcribe instead of one blob only at stop.
  mediaRecorder.start(1000);
  entry.rollingTimer = setInterval(rollingTick, VOICE_ROLLING_INTERVAL_MS);
  micBtn.classList.add("recording");
  micBtn.innerHTML = MIC_ICON_RECORDING;
  micBtn.title = "Recording - release to stop (transcribing live)";
}

function stopVoiceRecording(index) {
  // Always clear the hold flag, even if getUserMedia/MediaRecorder isn't
  // ready yet — startVoiceRecording's post-await check relies on this to
  // bail out instead of starting a recording nothing will ever stop.
  heldRecordings.delete(index);
  stopVoiceStreamIfActive(index);
  const active = activeRecordings.get(index);
  if (active) {
    active.mediaRecorder.stop();
  }
}

// Decodes a recorded audio Blob (whatever codec MediaRecorder used, typically
// webm/opus) into a mono Float32Array at 16kHz — the sample rate Whisper's
// feature extractor expects. OfflineAudioContext does the resample for free
// as part of the same decode step, no separate resampling library needed.
async function decodeToMono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  decodeCtx.close();
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

// Converts a Windows absolute path to a file:// URL an <img> can load —
// forward slashes, percent-encoded per path segment (handles spaces and any
// other special characters e.g. in "D:\Dropbox\Documents\..."). The
// drive-letter segment ("D:") is left un-encoded — encodeURIComponent would
// turn it into "D%3A", which Chromium does NOT decode back to a drive letter,
// silently breaking every single local-file image load.
function toFileUrl(winPath) {
  const normalized = winPath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return "file:///" + encoded;
}

// Attachment markers embedded in a user turn's text. sendFromPane builds each
// as `[Attached image: <abspath>]` / `[Attached file: <abspath>]` (one per
// line, \n-joined) — this regex MUST stay byte-identical to that shape. See
// sendFromPane (~line 4100) where the literal is constructed.
const ATTACHMENT_MARKER_RE = /^\[Attached (image|file): (.+)\]$/;

// Splits a user turn's raw text into ordered segments so the transcript
// renderer can turn `[Attached image: <path>]` marker lines into inline
// thumbnails instead of literal text. Consecutive non-marker lines are
// coalesced back into one text segment (line breaks preserved). Pure (no DOM)
// so it stays unit-testable. Returns [{type:"image"|"file", path}] and
// {type:"text", text} segments in document order.
function parseAttachmentLines(text) {
  const segments = [];
  const lines = String(text ?? "").split("\n");
  let textBuf = [];
  const flushText = () => {
    if (textBuf.length) {
      segments.push({ type: "text", text: textBuf.join("\n") });
      textBuf = [];
    }
  };
  for (const line of lines) {
    const m = ATTACHMENT_MARKER_RE.exec(line);
    if (m) {
      flushText();
      segments.push({ type: m[1], path: m[2] });
    } else {
      textBuf.push(line);
    }
  }
  flushText();
  return segments;
}

// Full-size click-to-enlarge view for an attached image — dismissed by
// clicking anywhere (including the image itself) or pressing Escape.
function showImageLightbox(fileUrl) {
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  const img = document.createElement("img");
  img.src = fileUrl;
  overlay.append(img);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
    }
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
}

// ========================== Review queue (task ce2d19ab) ==========================
// The bottleneck was never producing work, it was reviewing it - and what made
// review expensive is that every item looked equally heavy. So this page's whole
// job is one distinction: which items actually need the captain's judgment, and which
// are settled and just need reading. Everything else here serves that.
//
// Ordering, evidence and the judgment/stamp split come from lib/reviewRecords.js;
// this only paints them.

function reviewChip(text, kind) {
  const el = document.createElement("span");
  el.className = "rev-chip" + (kind ? ` ${kind}` : "");
  el.textContent = text;
  return el;
}

/**
 * Splits a unified diff (as `git show --stat --patch` produces, one or more
 * commits concatenated) into file blocks - each a run of header/meta lines
 * (commit line, --stat summary, "diff --git"/"index"/"---"/"+++") plus zero
 * or more hunks, each hunk's content lines paired into old/new rows for a
 * side-by-side view (the captain, task c3dfbb42: "Kan vi få en side by side diff
 * istället som i vanliga git klienter").
 *
 * Pairing rule (the one every git GUI uses): consecutive '-' lines and the
 * '+' lines that immediately follow them are the "before/after" of the same
 * change and sit on the same rows, positionally; a run with more of one than
 * the other leaves the shorter side's extra rows blank on its side. A
 * context line (leading space) always occupies its own row, unpaired,
 * identical on both sides - it never merges with a pending +/- run.
 *
 * Returns [{ header: string[], hunks: [{ header, rows: [{left,right}] }] }].
 * left/right are null (blank row on that side) or { num, text, type }, type
 * one of "ctx"|"add"|"del".
 */
function parseUnifiedDiffFiles(text) {
  const lines = String(text || "").split("\n");
  const files = [];
  let current = null;
  let hunk = null;
  let pendingDel = [];
  let pendingAdd = [];
  let oldNum = 0;
  let newNum = 0;

  function flushPending() {
    if (!hunk) {
      pendingDel = [];
      pendingAdd = [];
      return;
    }
    const n = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < n; i++) {
      const delText = pendingDel[i];
      const addText = pendingAdd[i];
      hunk.rows.push({
        left: delText !== undefined ? { num: oldNum++, text: delText, type: "del" } : null,
        right: addText !== undefined ? { num: newNum++, text: addText, type: "add" } : null,
      });
    }
    pendingDel = [];
    pendingAdd = [];
  }
  function closeHunk() {
    flushPending();
    if (hunk && current) {
      current.hunks.push(hunk);
    }
    hunk = null;
  }
  function closeFile() {
    closeHunk();
    if (current) {
      files.push(current);
    }
    current = null;
  }

  for (const raw of lines) {
    if (/^commit [0-9a-f]{7,40}/.test(raw) || /^diff --git /.test(raw)) {
      closeFile();
      current = { header: [raw], hunks: [] };
      continue;
    }
    if (!current) {
      current = { header: [raw], hunks: [] };
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunkMatch) {
      closeHunk();
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      hunk = { header: raw, rows: [] };
      continue;
    }
    if (!hunk) {
      current.header.push(raw);
      continue;
    }
    if (raw.startsWith(" ") || raw === "") {
      flushPending();
      const contentText = raw.startsWith(" ") ? raw.slice(1) : raw;
      hunk.rows.push({
        left: { num: oldNum++, text: contentText, type: "ctx" },
        right: { num: newNum++, text: contentText, type: "ctx" },
      });
    } else if (raw.startsWith("-")) {
      pendingDel.push(raw.slice(1));
    } else if (raw.startsWith("+")) {
      pendingAdd.push(raw.slice(1));
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" - a note about the previous line, not content.
    } else {
      // A line that isn't diff content while still "inside" a hunk (e.g. a stray
      // separator some git config injects) - close the hunk rather than guess.
      closeHunk();
      current.header.push(raw);
    }
  }
  closeFile();
  return files;
}

/** One diff-body line's class, for the plain (non-hunk) header/meta lines. */
function diffMetaLineClass(raw) {
  if (/^\+\+\+|^---/.test(raw) || /^diff --git/.test(raw)) {
    return "diff-file";
  }
  if (/^commit [0-9a-f]{7,40}/.test(raw)) {
    return "diff-commit-head";
  }
  return "";
}

/** A single side-by-side row's four grid cells (old-num, old-text, new-num, new-text). */
function diffRowCells(row) {
  const cells = [];
  for (const side of ["left", "right"]) {
    const entry = row[side];
    const numEl = document.createElement("span");
    numEl.className = `diff-ln diff-ln-${side === "left" ? "old" : "new"}`;
    numEl.textContent = entry ? String(entry.num) : "";
    const textEl = document.createElement("span");
    textEl.className = `diff-cell diff-cell-${side === "left" ? "old" : "new"}` + (entry ? ` diff-${entry.type}` : " diff-empty");
    textEl.textContent = entry ? entry.text : "";
    cells.push(numEl, textEl);
  }
  return cells;
}

/**
 * The path a file block is about, or null for a preamble block (a commit's
 * message + --stat summary, before its first "diff --git" line) - those
 * aren't about any one file, so the changed-files column never filters them
 * out. Prefers the "b/" (new) path; a renamed-but-unchanged-content file has
 * no hunks to show anyway, so which side wins rarely matters in practice.
 */
function diffFileBlockPath(file) {
  const line = file.header.find((l) => /^diff --git /.test(l));
  if (!line) {
    return null;
  }
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return m ? m[2] : null;
}

/** Renders parsed file blocks (see parseUnifiedDiffFiles) into `body`, side by side. */
function renderDiffFiles(body, files) {
  for (const file of files) {
    const block = document.createElement("div");
    block.className = "diff-file-block";
    const filePath = diffFileBlockPath(file);
    if (filePath) {
      block.dataset.file = filePath;
    }
    if (file.header.length > 0) {
      const header = document.createElement("pre");
      header.className = "diff-file-header";
      for (const raw of file.header) {
        const line = document.createElement("span");
        line.className = diffMetaLineClass(raw);
        line.textContent = raw + "\n";
        header.append(line);
      }
      block.append(header);
    }
    for (const hunk of file.hunks) {
      const grid = document.createElement("div");
      grid.className = "diff-grid";
      const hunkHeader = document.createElement("div");
      hunkHeader.className = "diff-hunk-row";
      hunkHeader.textContent = hunk.header;
      grid.append(hunkHeader);
      for (const row of hunk.rows) {
        grid.append(...diffRowCells(row));
      }
      block.append(grid);
    }
    body.append(block);
  }
}

/**
 * The patch for a review item, in the document viewer, coloured like a diff.
 *
 * Rendered line by line into elements this code creates - never innerHTML of git output.
 * A diff carries whatever the change carried, including markup, and the point of the
 * viewer is to READ it, not to run it.
 */
function openDiffViewer(row, res) {
  // Content-free (Helm's own usage log): did the diff actually get looked at, not
  // just claimed reviewed (the captain, task 76790f23 follow-up: "kollar jag på diffen").
  // taskId is what lets summarizeReviewActions join this against the eventual
  // decision on the SAME item, not just count diff-opens in the abstract.
  window.helm.trackUsage({ type: "action", action: "review_diff_opened", taskId: row.taskId });
  const overlay = document.getElementById("docViewer");
  const body = document.getElementById("docvBody");
  const fileList = document.getElementById("docvFileList");
  document.getElementById("docvTitle").textContent = `${row.title} · ${res.commits.length} commit${res.commits.length === 1 ? "" : "s"}`;
  const revealBtn = document.getElementById("docvReveal");
  // Something that actually happens. There is no open-a-folder bridge in preload, and a
  // button wired to `window.helm.openPath?.()` would have been a control that visibly
  // does nothing - the exact bug this app has shipped before. Copying the shas is useful
  // and real: it is what you paste into git to look further.
  revealBtn.textContent = "Copy commit ids";
  revealBtn.onclick = () => {
    window.helm.copyToClipboard(res.commits.map((c) => c.sha).join(" "));
    showToast(`Copied ${res.commits.length} commit id(s).`);
  };
  body.innerHTML = "";

  // Where the commits came from. A search of the log is a GUESS, and it says so.
  const prov = document.createElement("div");
  prov.className = "suggest-hint";
  // Three provenances, because how the commits were FOUND changes how much the diff can be
  // trusted to be the whole change. "commit" is the unbound-commit row: there is no
  // attribution step at all, so there is nothing to caveat - this is exactly that commit.
  prov.textContent =
    res.source === "commit"
      ? `Commit ${res.commits[0]?.sha.slice(0, 8) || ""} in ${res.projectPath} - the whole of it, nothing inferred`
      : res.source === "record"
        ? `${res.commits.length} commit(s) named by the review record, in ${res.projectPath}`
        : `${res.commits.length} commit(s) found by searching the log for "${row.taskId.slice(0, 8)}" - the record names none, so this is a search and could miss a commit that never mentioned the task`;
  body.append(prov);

  const list = document.createElement("div");
  list.className = "diff-commits";
  for (const c of res.commits) {
    const line = document.createElement("div");
    line.className = "diff-commit";
    const sha = document.createElement("span");
    sha.className = "diff-sha";
    sha.textContent = c.sha.slice(0, 8);
    const subj = document.createElement("span");
    subj.textContent = c.subject;
    line.append(sha, subj);
    list.append(line);
  }
  body.append(list);

  const files = parseUnifiedDiffFiles(res.text);
  renderDiffFiles(body, files);

  if (res.truncated) {
    const t = document.createElement("div");
    t.className = "md-truncated";
    t.textContent = `Showing ${res.shown} of ${res.total} commits - the rest was cut at a commit boundary to keep this readable. Use the folder button and read it in git for the whole thing.`;
    body.append(t);
  }

  // The changed-files column (task c3dfbb42 follow-up: "borde finnas en till
  // kolumn där man kan se ändrade filer och väljer fil att se diff för
  // där"). Paths in FIRST-APPEARANCE order, deduped - the same file can carry
  // more than one block when more than one commit touches it, and picking it
  // shows every one of those blocks together rather than just the first.
  const paths = [...new Set(files.map(diffFileBlockPath).filter(Boolean))];
  fileList.innerHTML = "";
  if (paths.length > 1) {
    const blocksFor = (path) => [...body.querySelectorAll(".diff-file-block")].filter((b) => b.dataset.file === path);
    // A preamble block (a commit's message + --stat summary) has no dataset.file at
    // all, so it is never touched by the hide logic below - it always stays visible,
    // whichever file is selected.
    const select = (path, btn) => {
      fileList.querySelectorAll(".docv-filelist-item").forEach((b) => b.classList.toggle("selected", b === btn));
      const showAll = !path;
      for (const p of paths) {
        blocksFor(p).forEach((b) => b.classList.toggle("hidden", !showAll && p !== path));
      }
      if (!showAll) {
        blocksFor(path)[0]?.scrollIntoView({ block: "start" });
      } else {
        body.scrollTop = 0;
      }
    };
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "docv-filelist-item docv-filelist-all selected";
    allBtn.textContent = `All files (${paths.length})`;
    allBtn.addEventListener("click", () => select(null, allBtn));
    fileList.append(allBtn);
    for (const p of paths) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "docv-filelist-item";
      btn.textContent = p.split(/[\\/]/).pop();
      btn.title = p;
      btn.addEventListener("click", () => select(p, btn));
      fileList.append(btn);
    }
    fileList.classList.remove("hidden");
  } else {
    // One file (or none, e.g. a commit-only record with no diffable change) isn't
    // worth a column that only ever offers "All files" - the column would be a
    // control with nothing to actually pick between.
    fileList.classList.add("hidden");
  }

  overlay.classList.remove("hidden");
  body.scrollTop = 0;
}

/**
 * Send an independent reviewer at this item.
 *
 * It DISPATCHES - the session starts and the brief is sent (the captain, 2026-08-05: "jag vill
 * att den skickar iväg direkt, men sessionen ska fortfarande skapas så jag kan få
 * feedback"). So there is one confirm, and it names what it is about to spend: the model
 * is RECOMMENDED from the change's own complexity and can be overridden in the dialog,
 * because a recommendation you cannot refuse is just someone else's decision.
 *
 * The reviewer is also told to write its verdict to a file, which the review row reads
 * back - so the answer arrives where the question was asked, not only in a chat pane.
 *
 * `priorVerdict`, when given (the "Second opinion" button), is a PRIOR reviewer's own
 * verdict text - the new reviewer is told what it found and asked to reach its own
 * conclusion independently, then say whether it agrees. Not a resume of that first
 * reviewer's session (it has already exited by the time its verdict is readable at
 * all) - a fresh one, briefed on the disagreement.
 */
async function openIndependentReview(row, priorVerdict = null) {
  // Synthesize a project-only record when the task has none, so an UNRECORDED card can
  // still send a reviewer - the reviewer's job is precisely to WRITE the missing record
  // (the captain, 2026-08-12). row.repoPath is resolved by the payload builder (category
  // binding, or the auto-run's own project), which is the reliable source here.
  const rec = row.record || { projectPath: row.repoPath || null };
  const cwdCheck = rec.projectPath || "";
  if (!cwdCheck) {
    showNotice(`"${row.title}" has no project folder yet, so there is nowhere to root a reviewer. Bind the board to a repo folder in Jot, or add projectPath to a record.`);
    return;
  }
  // The task's own prose goes with the request: main decides from it which language
  // the verdict must be written in (task 7bd1e2df), and only the row has it. Pass the
  // resolved project so a record-less task still resolves a reviewer plan.
  const plan = await window.helm.getReviewerPlan(row.taskId, `${row.title || ""}\n${row.description || ""}`, rec.projectPath);
  if (!plan?.ok) {
    showNotice(`Could not work out what to send at "${row.title}": ${plan?.error || "unknown reason"}`);
    return;
  }
  const rc = plan.recommendation;

  // The picker. The recommendation is preselected and labelled as such; the reason is on
  // screen so it can be disagreed with rather than just obeyed.
  const extra = document.createElement("div");
  extra.className = "reviewer-pick";
  const why = document.createElement("div");
  why.className = "reviewer-why";
  why.textContent = rc.why;
  extra.append(why);
  const facts = document.createElement("div");
  facts.className = "suggest-hint";
  facts.textContent =
    plan.commits > 0
      ? `${plan.commits} commit(s), ${plan.stats.files} file(s), +${plan.stats.added}/-${plan.stats.removed} lines${plan.commitSource === "log" ? " (commits found by searching the log)" : ""}`
      : "No commits are tied to this task, so the reviewer will have the record and the working tree to go on - and the recommendation had less to work from.";
  extra.append(facts);

  const modelRow = document.createElement("label");
  modelRow.className = "reviewer-field";
  modelRow.append(document.createTextNode("Model"));
  const modelSel = document.createElement("select");
  for (const m of plan.models) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.value === rc.model ? `${m.label} (recommended)` : m.label;
    modelSel.append(opt);
  }
  modelSel.value = rc.model;
  modelRow.append(modelSel);

  const effortRow = document.createElement("label");
  effortRow.className = "reviewer-field";
  effortRow.append(document.createTextNode("Effort"));
  const effortSel = document.createElement("select");
  for (const e of ["low", "medium", "high"]) {
    const opt = document.createElement("option");
    opt.value = e;
    opt.textContent = e === rc.effort ? `${e} (recommended)` : e;
    effortSel.append(opt);
  }
  effortSel.value = rc.effort;
  effortRow.append(effortSel);
  extra.append(modelRow, effortRow);

  customConfirm(
    priorVerdict
      ? `Send a SECOND independent reviewer at "${row.title}"?\n\nIt gets the first reviewer's verdict and is asked to reach its own conclusion, then say whether it agrees. It starts a real session and sends the brief immediately, so this spends tokens.`
      : `Send an independent reviewer at "${row.title}"?\n\nIt starts a real session and sends the brief immediately, so this spends tokens.`,
    "Send it",
    async () => {
      const model = modelSel.value;
      const effort = effortSel.value;
      const res = await window.helm.startSession(independentReviewSessionArgs(row, rec, plan, model, effort, priorVerdict));
      if (!res?.ok) {
        showNotice(`The reviewer did not start: ${res?.error || "unknown error"}`);
        return;
      }
      // Content-free (Helm's own usage log): which model an independent reviewer
      // was actually sent on, joined against the eventual decision by taskId
      // (the captain, task 76790f23 round 2: "Jag vill även att intependent reviewer
      // stats ska vara med och vilken model som valdes").
      window.helm.trackUsage({ type: "action", action: "review_independent_dispatched", taskId: row.taskId, model, effort });
      // A notice, not a toast: it is now running somewhere else, and the row will grow
      // its verdict when it writes one.
      showNotice(
        `An independent reviewer is running on ${reviewerModelLabelInRenderer(model)} (${effort} effort) for "${row.title}". It writes its verdict to the record's folder; reopen this row to read it.`,
        { actions: [{ label: "Watch it", onClick: () => navigateToPage("chat") }] }
      );
    },
    { extraEl: extra }
  );
}

/**
 * Send an independent reviewer at a COMMIT with no Jot task (task cb249577).
 *
 * Same shape as openIndependentReview - recommended model/effort, shown with its
 * reasoning, confirmed before a token is spent - but built from the commit's own size
 * rather than from a record, because there isn't one. Kept as its own function rather
 * than a mode flag on the task version: the two briefs genuinely differ (one tests
 * declared claims, the other has none to test), and a flag would have made every line
 * of both read as conditional.
 */
async function openCommitIndependentReview(projectPath, commitRow) {
  const plan = await window.helm.getCommitReviewerPlan(projectPath, commitRow.sha);
  if (!plan?.ok) {
    showNotice(`Could not work out what to send at ${commitRow.shortSha}: ${plan?.error || "unknown reason"}`);
    return;
  }
  const rc = plan.recommendation;
  const extra = document.createElement("div");
  extra.className = "reviewer-pick";
  const why = document.createElement("div");
  why.className = "reviewer-why";
  why.textContent = rc.why;
  const facts = document.createElement("div");
  facts.className = "suggest-hint";
  facts.textContent = `${plan.stats.files} file(s), +${plan.stats.added}/-${plan.stats.removed} lines. No record exists, so the recommendation is based on the change's size alone - and the reviewer is asked to set the criticality itself.`;
  extra.append(why, facts);

  const modelRow = document.createElement("label");
  modelRow.className = "reviewer-field";
  modelRow.append(document.createTextNode("Model"));
  const modelSel = document.createElement("select");
  for (const m of plan.models) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.value === rc.model ? `${m.label} (recommended)` : m.label;
    modelSel.append(opt);
  }
  modelSel.value = rc.model;
  modelRow.append(modelSel);

  const effortRow = document.createElement("label");
  effortRow.className = "reviewer-field";
  effortRow.append(document.createTextNode("Effort"));
  const effortSel = document.createElement("select");
  for (const e of ["low", "medium", "high"]) {
    const opt = document.createElement("option");
    opt.value = e;
    opt.textContent = e === rc.effort ? `${e} (recommended)` : e;
    effortSel.append(opt);
  }
  effortSel.value = rc.effort;
  effortRow.append(effortSel);
  extra.append(modelRow, effortRow);

  customConfirm(
    `Send an independent reviewer at commit ${commitRow.shortSha} ("${commitRow.subject}")?\n\nIt starts a real session and sends the brief immediately, so this spends tokens.`,
    "Send it",
    async () => {
      const model = modelSel.value;
      const effort = effortSel.value;
      const res = await window.helm.startSession({
        cwd: projectPath,
        prompt: commitReviewBrief(plan.commit, plan.notePath, plan.writingBrief || []),
        model,
        effort,
        // Exactly the one file the brief tells it to write, for the same reason the
        // task-keyed dispatch pre-approves its own: the verdict lands outside the
        // project, and a headless launch has nobody to answer a permission prompt.
        allowedTools: [`Write(${plan.notePath})`],
      });
      if (!res?.ok) {
        showNotice(`The reviewer did not start: ${res?.error || "unknown error"}`);
        return;
      }
      window.helm.trackUsage({ type: "action", action: "review_independent_dispatched", taskId: commitRow.sha, model, effort });
      showNotice(
        `An independent reviewer is running on ${reviewerModelLabelInRenderer(model)} (${effort} effort) for ${commitRow.shortSha}. Reopen this row to read its verdict.`,
        { actions: [{ label: "Watch it", onClick: () => navigateToPage("chat") }] }
      );
    },
    { extraEl: extra }
  );
}

/** Label for a model id, mirroring src/lib/reviewerModel.js for the renderer's own use. */
function reviewerModelLabelInRenderer(value) {
  return (
    {
      "claude-opus-5": "Opus 5",
      "claude-opus-4-8": "Opus 4.8",
      "claude-sonnet-5": "Sonnet 5",
      "claude-haiku-4-5-20251001": "Haiku 4.5",
    }[value] || value
  );
}

/**
 * The brief. Built FROM the record - the claims, the gaps, the declared checks - because
 * an independent pass that is not told what is being claimed just re-reads the code and
 * agrees with it.
 */
function independentReviewBrief(row, rec, notePath, priorVerdict = null, writingBrief = []) {
  const short = row.taskId.slice(0, 8);
  const intent = row.intent || null;
  const lines = [
    `You are an INDEPENDENT reviewer. You did not write this work, and your job is not to agree with it.`,
    ``,
    `Task ${short}: ${row.title}`,
    `Criticality claimed: ${row.criticality || "not stated"}. Verdict claimed: ${rec.verdict || "none"}.`,
    ``,
    // WHAT WAS ASKED FOR, and the order here is deliberate. The reviewer states what IT
    // thinks was wanted before it is shown the answer, because a reviewer handed the ask
    // and the work together reconciles them - it reads the intent through the code it just
    // read, and "does this match?" becomes a formality. Asking first makes a mismatch a
    // thing it noticed rather than a thing it was told.
    //
    // Measured 2026-08-21: nothing in this brief carried the ask at all, so "correct, but
    // not what was asked" was not a finding the reviewer could physically report.
    `FIRST, BEFORE READING ANY FURTHER: read the commits and the task title, then write down`,
    `in one sentence what you believe was ASKED FOR. Do not skip this and do not revise it`,
    `afterwards - it is the only part of your verdict that is not contaminated by having`,
    `read the author's account.`,
    ``,
    ...(intent
      ? [
          `THEN compare it with what was actually asked:`,
          intent.text,
          intent.source === "captain"
            ? `(the captain's own words.)`
            : intent.source === "goal"
              ? `(The goal the autopilot was given, written before the run.)`
              : `(An assistant's paraphrase of the ask, NOT confirmed by the captain - so treat a mismatch between this and the commits as possibly a mis-stated intent rather than wrong code, and say which you think it is.)`,
          ``,
          `Work that is correct but does NOT answer this is a FINDING, and a serious one.`,
          `Report it first, before any bug. Say plainly what was asked and what was built.`,
          ``,
        ]
      : [
          `NOBODY WROTE DOWN WHAT WAS ASKED FOR. There is no recorded intent for this task, so`,
          `nothing here can be checked against it. Say so in your verdict, and say what the`,
          `commits look like they were TRYING to do - that sentence is the missing intent and`,
          `is worth more than anything else you can write about this item.`,
          ``,
        ]),
    ...(row.intentDrift?.drifted
      ? [
          `THE ASK CHANGED after the record was written. It now reads:`,
          row.intentDrift.live,
          `Judge the work against the CURRENT one, and say whether the change invalidates it.`,
          ``,
        ]
      : []),
    `What the author says was done:`,
    rec.summary || "(no summary)",
    ``,
    `Their evidence, to CONFIRM OR REFUTE one by one - by running something, not by reading:`,
    ...(rec.evidence || []).map((e, i) => `${i + 1}. ${typeof e === "string" ? e : `${e.claim || ""}${e.claim && e.detail ? " - " : ""}${e.detail || ""}`}`),
    ``,
    `What they say is NOT verified - check whether any of it is worse than stated:`,
    ...(rec.notVerified || []).map((n, i) => `${i + 1}. ${n}`),
    ``,
    `Their declared checks:`,
    ...(rec.checks || []).map((c) => `- ${c.label}: ${c.cmd}`),
    ``,
    `Start with: git log --all --regexp-ignore-case --grep=${short} --format="%H %s"  then read those commits' patch.`,
    `Then, in order:`,
    `1. Answer the intent question above: does this work do what was asked? Not "is it correct" - is it the RIGHT THING. A clean implementation of the wrong thing fails here.`,
    `2. Decide the criticality yourself before reading theirs again. If yours is higher, say so first.`,
    `3. Name which commands would catch a regression here. A command they do not have is your most useful output.`,
    `4. Try to BREAK one guard on purpose and check that a test notices. A guard whose removal leaves the suite green is not a guard.`,
    `5. Report: what is wrong, what is unproven, and what you ran to find out. Cite file:line.`,
    ``,
    // A SECOND opinion: the prior verdict goes in AFTER the instructions above, and
    // is framed as a claim to test rather than a conclusion to start from - the whole
    // value of asking twice is lost if the second reviewer just re-reads the first
    // one's reasoning and nods. Reaching its own conclusion first, then comparing, is
    // the same discipline the brief already imposes about the AUTHOR's own claims.
    ...(priorVerdict
      ? [
          `--- A PREVIOUS INDEPENDENT REVIEWER ALREADY LOOKED AT THIS ---`,
          ``,
          `the captain asked for a second opinion because he is not convinced by it. Do your OWN`,
          `investigation FIRST, using the steps above, and only then read this and say`,
          `plainly whether you agree, and about which specific points. Where you disagree,`,
          `say what you ran that they apparently did not.`,
          ``,
          `Their verdict:`,
          priorVerdict,
          ``,
          `Your verdict REPLACES theirs in the file below, so restate anything of theirs`,
          `that still holds - do not write only the delta.`,
          ``,
        ]
      : []),
    // Language and register, placed HERE rather than at the top: this is the point
    // where the model turns findings into prose, and instructions given a page earlier
    // are the ones it has already stopped applying (task 7bd1e2df). The lines come
    // from the plan because deciding them needs src/lib/reviewLanguage.js, which this
    // classic script cannot import - main computes them from the sample sent with the
    // plan request.
    ...(writingBrief || []),
    ``,
    `WRITE YOUR VERDICT TO A FILE, as your last action, so it reaches the review page and not`,
    `only this chat:`,
    ``,
    `  ${notePath}`,
    ``,
    `Plain text or light markdown. Start with one line that is either CONFIRMED or NOT`,
    `CONFIRMED and why. Then, as the SECOND line, "Asked for: ..." - your own sentence from`,
    `step one, before you had read their account. That line is what makes this verdict`,
    `worth having twice: it is the only place a wrong-intent bug can show up, and it must`,
    `survive into the file rather than staying in your chat. Then the findings, then what`,
    `you ran. Overwrite the file if it exists - the newest verdict is the one that counts.`,
    ``,
    `Do not change anything else. This is a review.`,
  ];
  return lines.join("\n");
}

/**
 * The brief for an independent reviewer sent at a COMMIT with no Jot task.
 *
 * Deliberately not the task brief with the record parts blanked out: half that brief
 * is "confirm or refute the author's claims one by one", and there are no claims here
 * - nobody wrote a record. What replaces them is the commit message, which is the
 * only statement of intent that exists, and an explicit instruction to judge the
 * change against it rather than against an imagined spec.
 */
function commitReviewBrief(commit, notePath, writingBrief = []) {
  return [
    `You are an INDEPENDENT reviewer. You did not write this work, and your job is not to agree with it.`,
    ``,
    `Commit ${commit.shortSha} in this repository: ${commit.subject}`,
    `By ${commit.author || "unknown"}${commit.date ? ` on ${commit.date}` : ""}.`,
    ``,
    `There is NO review record for this commit - it is not tied to any task, so nobody`,
    `wrote down what it was meant to do, what was checked, or what was left unverified.`,
    `The commit message below is the only stated intent that exists:`,
    ``,
    commit.body?.trim() ? commit.body.trim() : "(the commit message has no body - only the subject line above)",
    ``,
    `Start with: git show ${commit.shortSha}`,
    `Then, in order:`,
    `1. Say what this change actually does, in your own words, and whether that matches`,
    `   the message. A message that describes something other than the diff is itself a finding.`,
    `2. Decide how critical it is yourself - security, data, money or anything irreversible`,
    `   is the top tier - and say which, since nobody has classified it.`,
    `3. Name which commands would catch a regression here, and run the ones that exist.`,
    `4. Report: what is wrong, what is unproven, and what you ran to find out. Cite file:line.`,
    ``,
    ...(writingBrief || []),
    ``,
    `WRITE YOUR VERDICT TO A FILE, as your last action, so it reaches the review page and not`,
    `only this chat:`,
    ``,
    `  ${notePath}`,
    ``,
    `Plain text or light markdown. Start with one line that is either CONFIRMED or NOT`,
    `CONFIRMED and why, then the findings, then what you ran. Overwrite the file if it exists.`,
    ``,
    `Do not change anything else. This is a review.`,
  ].join("\n");
}

/**
 * The startSession(...) call an independent-reviewer dispatch actually sends -
 * pulled out of the confirm callback so a test can pin its exact shape without
 * spending a token (contextBridge's window.helm cannot be stubbed from a
 * renderer test, so the callback itself is untestable directly; this pure
 * function is).
 *
 * allowedTools is scoped to exactly the verdict file the brief tells it to
 * write, not a broader permission mode: the brief writes OUTSIDE its own
 * project directory (the meta-home's .helm/reviews/), which the ordinary
 * permission gate correctly treats as more sensitive than an in-project write
 * - and this is a headless -p launch with no live channel to answer that
 * prompt, so it just stalled (the captain: "Would you grant permission to write the
 * verdict file?" - a question with nobody able to answer it). Pre-approving
 * exactly that one path keeps "do not change anything else" (the brief's own
 * instruction) technically enforced, not just requested.
 */
function independentReviewSessionArgs(row, rec, plan, model, effort, priorVerdict = null) {
  return {
    cwd: rec.projectPath,
    prompt: independentReviewBrief(row, rec, plan.notePath, priorVerdict, plan.writingBrief || []),
    model,
    effort,
    allowedTools: [`Write(${plan.notePath})`],
  };
}

/**
 * The prompt that carries an independent reviewer's verdict into a session that
 * can actually act on it (the "Open a fix session" button).
 *
 * States plainly that the verdict is a CLAIM, not an instruction: a reviewer can
 * be wrong, and a session that starts by assuming otherwise will "fix" things
 * that were never broken. The same posture the review brief takes towards the
 * author's claims, pointed the other way.
 */
function independentVerdictFixBrief(row, verdictText) {
  return [
    `An independent reviewer looked at "${row.title}" (task ${row.taskId.slice(0, 8)}) and reported the following.`,
    ``,
    `Treat this as a CLAIM to verify, not a work order - it did not write the code and it can be wrong.`,
    `For each finding: reproduce it first. Fix what is real, and say plainly which findings you could NOT`,
    `reproduce and why, rather than quietly fixing around them.`,
    ``,
    `--- the reviewer's verdict ---`,
    verdictText,
  ].join("\n");
}

/**
 * Which review rows are open. Empty by default: every row starts COLLAPSED.
 *
 * the captain, task 10ac9c23: "review sectionen är lite jobbig att läsa - texten är liten och
 * allt är ganska kompakt. Kanske ha alla kollapsade så expanderar man den man vill titta
 * på med mycket bättre formatering." Eight fully-expanded records is a wall, and the
 * page's job is to let him pick which one to read.
 *
 * In memory, not config: which row is open is a way of looking at the page, not a
 * setting - and a row that stayed open across restarts would fight the empty default.
 */
const reviewExpanded = new Set();

/**
 * Which manual test steps the captain has personally walked through, per task.
 *
 * taskId -> Set of step indices. In memory only, like `reviewExpanded` above - ticking
 * a box records that HE walked through it, not evidence for the record, so it must
 * never survive a restart pretending to be something checked into the record itself
 * (the captain, task 978f876f: wanted the checkboxes back that used to sit on these steps).
 */
const reviewCheckedSteps = new Map();

/** One review item: what changed, the evidence, the gaps, and how to check it. */
function reviewRowEl(row, band = null) {
  const el = document.createElement("section");
  // The rail colour follows the BAND, not the verdict. Driving it off verdict meant a
  // card in "Claimed, not confirmed" still wore the green stamp rail, because its
  // verdict is technically still "stamp" - so the one visual cue a skimming reader
  // takes in contradicted the heading directly above it.
  el.className = `rev-item ${band || row.verdict}`;

  const head = document.createElement("div");
  head.className = "rev-head";
  // The whole head is the toggle, so there is no small target to hit.
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  const chev = document.createElement("span");
  chev.className = "rev-chev";
  chev.textContent = "▸";
  head.append(chev);
  const title = document.createElement("span");
  title.className = "rev-title";
  title.textContent = row.title;
  const id = document.createElement("span");
  id.className = "rev-id";
  id.textContent = row.taskId.slice(0, 8);
  id.title = row.taskId;
  head.append(title, id);
  if (row.category) {
    head.append(reviewChip(row.category));
  }
  // Subtasks are in the queue now (they used to be filtered out entirely, so a subtask
  // in review was invisible and needed no record). Name the parent so the row still
  // reads as belonging somewhere.
  if (row.parentTitle) {
    const chip = reviewChip(`in: ${row.parentTitle.slice(0, 40)}`, "neutral");
    chip.title = `Subtask of "${row.parentTitle}"`;
    head.append(chip);
  }
  if (typeof row.priority === "number") {
    head.append(reviewChip(`p${row.priority}`));
  }
  // Criticality up front: it tells you how much of your attention this deserves
  // before you read a word of it, which is the entire point of the gradient.
  if (row.criticality) {
    // Colours were actively misleading: `critical` used the same amber as a
    // notVerified gap (so the highest-stakes tier read as a minor caveat) and
    // `cosmetic` used green (so the tier that requires NO evidence read as a pass).
    // critical now gets its own emphatic style; cosmetic is deliberately neutral -
    // it is a statement about scope, not a verdict.
    const chip = reviewChip(row.criticality, row.criticality === "critical" ? "crit" : row.criticality === "core" ? "rel" : "neutral");
    chip.title =
      row.criticality === "critical"
        ? "Security, data, money, or something irreversible. An independent pass is required - my own passing tests don't count here."
        : row.criticality === "core"
          ? "State or behaviour other work depends on. Needs at least one runnable check."
          : "Visual/front-end only. A bug here is recoverable.";
    head.append(chip);
  }
  // The gauntlet's state belongs in the COLLAPSED head: "have its checks passed" is the
  // one thing worth knowing before deciding whether to open it.
  const gaunt = row.gauntlet || { declared: 0, state: "none" };
  if (gaunt.declared > 0) {
    const tone = gaunt.state === "passing" ? "ok" : gaunt.state === "failing" ? "crit" : "gap";
    const chip = reviewChip(
      gaunt.state === "passing" ? `checks ${gaunt.passed}/${gaunt.declared}` : gaunt.state === "failing" ? `checks failing` : `checks unconfirmed`,
      tone
    );
    head.append(chip);
  }
  // Which released version this fix is out in, on the COLLAPSED head so it is visible
  // without opening the row - task 860b4661 came back "kan inte se versionen" because the
  // first version put it as a chip buried among the commit shas in the expanded body. Only
  // when the record pins commits and did not name a release by hand; filled in async and
  // revealed only if the fix is actually in a tagged release, so unreleased work shows
  // nothing. (Needs a build that HAS this feature; an older running app has no such IPC.)
  if (row.record && !row.record.release && (row.record.commits || []).length > 0 && window.helm?.getShippedVersion) {
    const shipped = reviewChip("", "rel");
    shipped.hidden = true;
    head.append(shipped);
    window.helm
      .getShippedVersion(row.taskId)
      .then((res) => {
        if (res && res.version) {
          shipped.textContent = `shipped in ${res.version}`;
          shipped.title = `This fix is released in ${res.version}.`;
          shipped.hidden = false;
        }
      })
      .catch(() => {});
  }
  el.append(head);

  // Everything below the head lives in one collapsible body, so a row is a HEADLINE
  // until it is opened (task 10ac9c23). `body` is what the rest of this function
  // appends to; `el` only ever holds the head and the body.
  const body = document.createElement("div");
  body.className = "rev-body";
  const expanded = reviewExpanded.has(row.taskId);
  el.classList.toggle("rev-open", expanded);
  body.hidden = !expanded;
  const toggle = () => {
    const open = reviewExpanded.has(row.taskId);
    if (open) {
      reviewExpanded.delete(row.taskId);
    } else {
      reviewExpanded.add(row.taskId);
    }
    body.hidden = open;
    el.classList.toggle("rev-open", !open);
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  // An item with no record is the honest failure case: it is IN review but nobody
  // wrote down what to check. Say so instead of rendering a confident empty card.
  if (row.verdict === "unrecorded") {
    const warn = document.createElement("div");
    warn.className = "rev-warn";
    warn.textContent = `No review record: ${row.problems.join("; ")}. Nothing here has been verified for you - treat it as unreviewed.`;
    body.append(warn);
    // Show what IS knowable instead of nothing at all: the task's own prose. For an
    // autopilot-completed task this is exactly where the machine wrote what it did and
    // where the work lives (finishAutoRun's Jot note) - previously invisible on the
    // card, which is why a record-less card read as a total blank (the captain, 2026-08-12:
    // "varfor dessa inte har en beskrivning over vad som gjorts?"). The diff and the
    // reviewer sit in the actions below.
    if (row.description && row.description.trim()) {
      const note = document.createElement("div");
      note.className = "rev-unrecorded-note";
      const lab = document.createElement("div");
      lab.className = "rev-list-label";
      lab.textContent = "What the task says (no verified record - read as context, not evidence):";
      const txt = document.createElement("div");
      txt.className = "rev-independent-note";
      renderMarkdownInto(txt, row.description.trim());
      note.append(lab, txt);
      body.append(note);
    }
    // The actions come along even here. They used to be built AFTER this return, so
    // this band had no controls at all and could never be cleared (f2ab6a5a). Marking
    // one done still costs a deliberate confirm - a row with no record has, by
    // definition, had nothing checked - and Send back is the honest move when it
    // should have had a record in the first place.
    body.append(reviewActionsEl(row));
    el.append(body);
    return el;
  }

  // A record EXISTS but doesn't meet the bar. Louder than "no record", because
  // somebody claimed this was reviewed and the claim is inadmissible - most often a
  // critical item with nothing independent behind it. The rest of the card still
  // renders below, so the claim can be read; it just isn't vouched for.
  if (row.verdict === "incomplete") {
    const warn = document.createElement("div");
    warn.className = "rev-warn";
    warn.textContent = `This record does not meet the bar for a ${row.criticality || "?"} item: ${row.problems.join("; ")}. Read it, but do not treat it as verified.`;
    body.append(warn);
  }

  // The acceptance criteria moved after the record was written. Neither side can be
  // auto-resolved: either the work needs revisiting or the record does.
  if (row.drift?.drifted) {
    const warn = document.createElement("div");
    warn.className = "rev-warn";
    warn.textContent = `The task's acceptance criteria changed after this record was written (${row.drift.snapshot.length} then, ${row.drift.live.length} now) - the evidence may be answering the old question.`;
    body.append(warn);
  }

  // THE ASK CHANGED after the record was written - which here usually means the captain
  // corrected it, so it is the most useful thing the card can say. Louder than the
  // acceptance drift above only in placement: it comes first because if the question
  // moved, every answer below it is answering the old one.
  if (row.intentDrift?.drifted) {
    const warn = document.createElement("div");
    warn.className = "rev-warn";
    warn.textContent = `What was asked for changed after this record was written. It now reads: "${row.intentDrift.live}" - the work below was measured against the old wording.`;
    body.append(warn);
  }

  const rec = row.record;

  // WHAT WAS ASKED, above WHAT WAS DONE. Two short rows, read as a pair (the captain,
  // 2026-08-21: "det ska stå i review en kort sammanfattning av vad intent var utöver
  // vad som faktiskt gjordes"). The order carries the meaning: the ask is the question
  // and the summary is the answer, and an answer read before its question is just a
  // claim to agree with.
  //
  // Absence is rendered, not hidden. A card that silently omits the ask looks complete
  // while missing the only thing the work can be judged wrong against.
  const intent = row.intent || null;
  // Class is `rev-intent`, NOT `rev-ask`: `.rev-ask` already exists and means the
  // judgment question ("Needs you: ..."), i.e. the decision the captain has to make. Two
  // different things that both read as "the ask" in English, so they do not get to share
  // a name - a collision here would style one as the other and, worse, blur the two in
  // every later conversation about the page.
  const askRow = document.createElement("div");
  askRow.className = "rev-intent" + (intent ? "" : " rev-intent-missing");
  const askLabel = document.createElement("div");
  askLabel.className = "rev-intent-label";
  askLabel.textContent = intent ? "Asked for" : "Nobody wrote down what was asked for";
  askRow.append(askLabel);
  if (intent) {
    const askText = document.createElement("div");
    askText.className = "rev-intent-text";
    askText.textContent = intent.text;
    askRow.append(askText);
    // Whose words these are. Only shown when it MATTERS - a paraphrase presented as the
    // ask is the failure this field exists to prevent, while "the captain's own words" needs no
    // caption. `fromTask` means the record predates intents and this was read live off the
    // task, which the reader has to know: it was not what the work was handed over against.
    if (intent.source !== "captain") {
      const note = document.createElement("div");
      note.className = "rev-intent-note";
      note.textContent = intent.fromTask
        ? "Read from the task just now - this record was written before the ask was being recorded, so the work was not handed over against it."
        : intent.source === "goal"
          ? "The goal the autopilot was given, written before the run."
          : "My reading of the ask, not confirmed by the captain - correct it in the task if it is wrong.";
      askRow.append(note);
    }
  }
  body.append(askRow);

  const summary = document.createElement("p");
  summary.className = "rev-summary";
  summary.textContent = rec.summary;
  body.append(summary);

  // The independent reviewer's own verdict, if one has been written, ON THIS ROW - the
  // answer arriving where the question was asked (the captain, 2026-08-05: "alternativt att
  // feedback kommer direkt på review vyn"). Fetched per row and appended when it lands,
  // so a row with no reviewer note renders exactly as before and nothing waits on IPC.
  const indBox = document.createElement("div");
  body.append(indBox);
  window.helm
    .getIndependentNote(row.taskId)
    .then((res) => {
      if (!res?.ok || !res.present) {
        return;
      }
      indBox.className = "rev-list rev-list-independent";
      const lab = document.createElement("div");
      lab.className = "rev-list-label";
      const when = new Date(res.writtenAt);
      lab.textContent = `Independent reviewer · written ${when.toLocaleString()}`;
      lab.title = res.path;
      const verdictText = res.text.trim();
      const text = document.createElement("div");
      text.className = "rev-independent-note";
      // Now rendered as markdown (the captain, task 76790f23: "jag vill kunna se verdict
      // lättläst") via the SAME safe DOM-construction renderer chat replies already
      // use (renderMarkdownInto never touches innerHTML - it builds elements from the
      // text itself, so an agent-authored file is exactly as safe here as a chat
      // reply from the model already is). The prior plain-text choice reasoned this
      // file was less trusted than "files we control" (DECISIONS.md etc.), but that
      // distinction does not hold: this IS a model's own text output, the same trust
      // level as every reply already rendered this way.
      renderMarkdownInto(text, verdictText);
      indBox.append(lab, text);

      const indActions = document.createElement("div");
      indActions.className = "rev-independent-actions";
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "text-btn";
      viewBtn.textContent = "View verdict";
      viewBtn.title = "Open the full verdict in its own readable, resizable view.";
      viewBtn.addEventListener("click", () =>
        openDocViewer({
          label: `${row.title} · independent reviewer's verdict`,
          read: () => Promise.resolve({ ok: true, text: verdictText }),
          reveal: () => window.helm.copyToClipboard(res.path).then(() => showToast("Copied the verdict file's path.")),
          revealLabel: "Copy path",
        })
      );
      indActions.append(viewBtn);

      // A second, independent opinion on the SAME work - not a resume of the first
      // reviewer's own session (which has already exited by the time its verdict is
      // readable here), a fresh one told what the first one found (the captain: "om jag
      // inte håller med eller vill ha second opinion vill jag ha möjlighet att
      // skicka verdict vidare till en till granskare"). Only offered once a first
      // verdict exists - a "second" opinion with no first would just be another
      // ordinary dispatch, already offered above.
      const secondBtn = document.createElement("button");
      secondBtn.type = "button";
      secondBtn.className = "text-btn";
      secondBtn.textContent = "Second opinion";
      secondBtn.title = "Sends a FRESH independent reviewer, told what the first one found, asked to reach its own conclusion and say whether it agrees.";
      secondBtn.addEventListener("click", () => openIndependentReview(row, verdictText));
      indActions.append(secondBtn);

      // Getting the verdict to whoever can act on it (the captain: "Hur ger man tillbaka
      // den oberoende granskarens feedback till ain som gjorde featuren?"). This
      // opens a fresh draft in the project, seeded with the verdict as the job -
      // it does NOT send. Deliberate: "Send back" already exists for the board
      // decision, and this is the separate question of starting the actual fix.
      // Leaving it unsent means the verdict can be read and the prompt edited
      // before a single token is spent, which matters most when the verdict is
      // the very thing being disputed.
      const fixBtn = document.createElement("button");
      fixBtn.type = "button";
      fixBtn.className = "text-btn";
      fixBtn.textContent = "Open a fix session";
      fixBtn.title = "Opens a fresh session in this project with the verdict as the brief. It does NOT send - you read it and press Enter.";
      fixBtn.addEventListener("click", () => {
        openFreshDraftInPane(rec.projectPath, independentVerdictFixBrief(row, verdictText), { forceIndex: 0 });
        navigateToPage("chat");
      });
      indActions.append(fixBtn);
      indBox.append(indActions);
    })
    .catch(() => {
      // A row that cannot read its reviewer note still renders the record.
    });

  // What this record is resting on, when what it rests on is an ABSENCE. A cosmetic
  // record with no checks and no criteria is fully valid and used to render NOTHING
  // to that effect: no gauntlet box, no button, nothing amber, filed under "Ready to
  // stamp". Cosmetic buys speed, not silence.
  if (row.caveats?.length > 0) {
    const box = document.createElement("div");
    box.className = "rev-caveats";
    const label = document.createElement("div");
    label.className = "rev-caveats-label";
    label.textContent = "Resting on the author's word";
    box.append(label);
    const list = document.createElement("ul");
    for (const c of row.caveats) {
      const li = document.createElement("li");
      li.textContent = c;
      list.append(li);
    }
    box.append(list);
    body.append(box);
  }

  // The argument for calling it cosmetic - the tier that requires no evidence. Shown
  // so it is something the captain can disagree with; the word alone gives him nothing to
  // push back on.
  if (row.whyNotCritical) {
    const why = document.createElement("div");
    why.className = "rev-whynot";
    why.textContent = `Why not critical: ${row.whyNotCritical}`;
    body.append(why);
  }

  // The certificate that gates the critical tier, SHOWN. It was rendered nowhere -
  // grep for independentReview in this file returned nothing - so the record could
  // claim "reviewed by a fresh-context agent, 0 findings" and the reader had no way
  // to see who looked, what they said, or that zero was claimed rather than earned.
  // A gate whose evidence is invisible is a gate on the author's honour.
  if (rec.independentReview) {
    const ind = rec.independentReview;
    const box = document.createElement("div");
    box.className = "rev-independent" + (ind.findings === 0 ? " zero" : "");
    const label = document.createElement("div");
    label.className = "rev-independent-label";
    label.textContent =
      ind.findings === 0
        ? `Independent pass claims ZERO findings — ${ind.by || "unnamed reviewer"}`
        : `Independent pass: ${ind.findings} finding${ind.findings === 1 ? "" : "s"} — ${ind.by || "unnamed reviewer"}`;
    if (ind.findings === 0) {
      // Zero is the value most worth distrusting: it is what an author writes when
      // no reviewer was ever run.
      label.title = "Zero findings is the easiest thing to claim without doing. Check that a reviewer actually ran.";
    }
    // NOT named `body`. It was, and that shadowed the row's collapsible body: the line
    // below then appended the BOX into its own child, which throws DOMException ("the new
    // child element contains the parent") and killed the whole review page render - the
    // page rendered nothing at all, and only for a record that HAS an independentReview,
    // which is why no test saw it. The cause was a scripted line-number replacement moving
    // `el.append` to `body.append` and landing inside this block, where `body` meant
    // something else. This codebase already carries a comment about a scripted replace
    // hitting the wrong site; that is now twice.
    const summaryEl = document.createElement("div");
    summaryEl.className = "rev-independent-body";
    summaryEl.textContent = ind.summary || "(no summary given)";
    box.append(label, summaryEl);
    body.append(box);
  }

  if (rec.verdict === "judgment" && rec.ask) {
    const ask = document.createElement("div");
    ask.className = "rev-ask";
    const label = document.createElement("b");
    label.textContent = "Needs you: ";
    ask.append(label, document.createTextNode(rec.ask));
    body.append(ask);
  }

  // Evidence and gaps are SENTENCES, so they render as sentences.
  //
  // They used to be pills - one chip per item, 11px monospace, wrapped across the width -
  // which is most of why this page was "jobbig att läsa" (task 10ac9c23). A chip is right
  // for a token like a commit sha or a release number and wrong for "Not exercised
  // against a real failing triage - the failure path was reasoned about from the code".
  // Two labelled lists instead; the chip row keeps only what is actually chip-shaped.
  const listBlock = (label, items, className, hint = null) => {
    if (!items || items.length === 0) {
      return;
    }
    const box = document.createElement("div");
    box.className = `rev-list ${className}`;
    const lab = document.createElement("div");
    lab.className = "rev-list-label";
    lab.textContent = `${label} · ${items.length}`;
    if (hint) {
      lab.title = hint;
    }
    box.append(lab);
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      const claim = typeof item === "string" ? item : item?.claim || "";
      const detail = typeof item === "string" ? "" : item?.detail || "";
      if (claim && detail) {
        // Progressive disclosure. These two halves used to be glued into one line, so
        // every entry was as long as its longest possible explanation and there was no
        // way to skip the part you did not need - complete and unreadable at once.
        // the captain, 2026-08-20: an explain button, or an expander with the longer
        // description per item. Native <details>, so no state to track and no listener
        // to leak on a re-render.
        const d = document.createElement("details");
        d.className = "rev-why";
        const s = document.createElement("summary");
        s.textContent = claim;
        const body2 = document.createElement("div");
        body2.className = "rev-why-body";
        body2.textContent = detail;
        d.append(s, body2);
        li.append(d);
      } else {
        li.textContent = claim || detail;
      }
      ul.append(li);
    }
    box.append(ul);
    body.append(box);
  };
  // The HEADING does most of the work here, because it frames every line under it.
  // These used to read "Evidence" and "Not verified", with subtitles that explained the
  // METHOD to the reader ("a record listing only what passed is a sales pitch") - which
  // is the author talking about his own process, not help. The captain, 2026-08-20: both lists
  // were still the hard part to understand after the length was fixed.
  //
  // "What I checked" invites a line that names the worry and what happened instead.
  // "What could still be wrong" invites a line that names the RISK rather than the
  // omission - and the risk is the half he can act on. The gaps stay mandatory: a
  // feature once shipped whose tests all passed while the feature was broken, because
  // they exercised the wrong layer.
  listBlock("What I checked", rec.evidence, "rev-list-evidence", "Each line: the worry, and what actually happened.");
  listBlock("What could still be wrong", rec.notVerified, "rev-list-gaps", "The gaps, said as risk rather than as omission.");

  const chips = document.createElement("div");
  chips.className = "rev-chips";
  if (rec.release) {
    chips.append(reviewChip(`in ${rec.release}`, "rel"));
  }
  for (const c of rec.commits || []) {
    chips.append(reviewChip(c, "commit"));
  }
  if (chips.children.length > 0) {
    body.append(chips);
  }

  // What was agreed BEFORE the work, shown above the steps that claim to satisfy it.
  // Order matters: the criteria are the question, the steps are the answer, and the
  // failure this closes is an answer nobody checked against the question.
  if (Array.isArray(rec.acceptanceCriteria) && rec.acceptanceCriteria.length > 0) {
    const box = document.createElement("div");
    box.className = "rev-acceptance";
    const label = document.createElement("div");
    label.className = "rev-acceptance-label";
    label.textContent = "Agreed up front";
    box.append(label);
    const list = document.createElement("ol");
    for (const c of rec.acceptanceCriteria) {
      const li = document.createElement("li");
      li.textContent = typeof c === "string" ? c : c.text;
      list.append(li);
    }
    box.append(list);
    body.append(box);
  }

  if (Array.isArray(rec.testSteps) && rec.testSteps.length > 0) {
    const checkedForRow = reviewCheckedSteps.get(row.taskId) || new Set();
    reviewCheckedSteps.set(row.taskId, checkedForRow);

    const label = document.createElement("div");
    label.className = "rev-steps-label";
    const updateLabel = () => {
      label.textContent = `Manual steps — walk through each and tick it off (${checkedForRow.size}/${rec.testSteps.length})`;
    };
    updateLabel();
    body.append(label);

    const steps = document.createElement("ol");
    steps.className = "rev-steps";
    rec.testSteps.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "rev-step" + (checkedForRow.has(i) ? " is-checked" : "");
      const stepLabel = document.createElement("label");
      stepLabel.className = "rev-step-label";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "rev-step-checkbox";
      cb.checked = checkedForRow.has(i);
      // Only a note to himself that he personally walked through it - it writes
      // nothing to the record and proves nothing to anyone reading it later.
      cb.addEventListener("change", () => {
        if (cb.checked) {
          checkedForRow.add(i);
        } else {
          checkedForRow.delete(i);
        }
        li.classList.toggle("is-checked", cb.checked);
        updateLabel();
      });
      const text = document.createElement("span");
      text.className = "rev-step-text";
      const what = document.createElement("span");
      what.className = "rev-step-do";
      what.textContent = s.step;
      const exp = document.createElement("span");
      exp.className = "rev-step-expect";
      exp.textContent = s.expect;
      text.append(what, exp);
      stepLabel.append(cb, text);
      li.append(stepLabel);
      // Which agreed criterion this step is answering - the explicit link is what
      // makes coverage checkable instead of a matter of opinion.
      if (s.ac !== undefined && s.ac !== null) {
        const ref = document.createElement("span");
        ref.className = "rev-step-ac";
        ref.textContent = `AC ${[].concat(s.ac).join(", ")}`;
        ref.title = "The criterion agreed before the work that this step checks.";
        li.append(ref);
      }
      steps.append(li);
    });
    body.append(steps);
  }

  // The gauntlet: declared checks and what actually happened when they ran. Shown
  // separately from `evidence` on purpose - one is the author's claim, this is an
  // exit code.
  const g = row.gauntlet || { declared: 0, state: "none" };
  if (g.declared > 0) {
    const box = document.createElement("div");
    box.className = `rev-gauntlet ${g.state}`;
    const head = document.createElement("div");
    head.className = "rev-gauntlet-head";
    const label = document.createElement("b");
    label.textContent =
      g.state === "passing"
        ? `Checks passing (${g.passed}/${g.declared})`
        : g.state === "failing"
          ? `Checks FAILING (${g.failed} of ${g.declared})`
          : // The breakdown must name the REASON. It listed unrun and stale but not
            // unverified, so a record whose only check was a forgery summarised as
            // "0 unrun, 0 stale" - technically true, and silent about the one thing
            // that mattered.
            `Checks not confirmed (${g.passed}/${g.declared} — ${[
              g.unusable > 0 ? `${g.unusable} CANNOT FAIL` : null,
              g.unverified > 0 ? `${g.unverified} NOT VERIFIED` : null,
              g.unrun > 0 ? `${g.unrun} unrun` : null,
              g.stale > 0 ? `${g.stale} stale` : null,
            ]
              .filter(Boolean)
              .join(", ")})`;
    head.append(label);
    const run = document.createElement("button");
    run.type = "button";
    run.className = "text-btn";
    run.textContent = "Run checks";
    run.addEventListener("click", async () => {
      // This button executes arbitrary shell from a JSON file in the meta-home, with
      // no allowlist. For a prompt-injected or careless agent it is the most direct
      // capability in the whole flow: write a record, wait for the click. So the
      // commands are shown IN FULL and confirmed before anything runs, and the
      // confirm focuses Cancel.
      const cmds = (rec.checks || []).map((c, i) => `${i + 1}. ${c.cmd}`).join("\n");
      const cwd = rec.projectPath || "(no project path - the run will be refused)";
      const proceedRun = async () => {
        run.disabled = true;
        run.textContent = "Running…";
        return window.helm.runReviewChecks(row.taskId);
      };
      const res = await new Promise((resolve) => {
        customConfirm(`Run these in ${cwd}:\n\n${cmds}`, "Run them", async () => resolve(await proceedRun()), {
          deliberate: true,
          // Escape, Cancel and the backdrop all land here, so the await can't hang.
          onCancel: () => resolve(null),
        });
      });
      if (res === null) {
        return;
      }
      if (!res?.ok) {
        showToast(res?.error || "Couldn't run the checks.");
        run.disabled = false;
        run.textContent = "Run checks";
        return;
      }
      const failed = (res.results || []).filter((r) => !r.ok);
      // A result that was not STORED is not a result: the record card would still say
      // "never run" after a reload, so saying "all checks passed" here would be the
      // page lying about its own evidence.
      if (res.stored === false) {
        // Sticky: the checks really ran, and their outcome is GONE. A message that
        // fades leaves the card reading "never run" with no explanation for why.
        showNotice(`Checks ran, but the outcome could NOT be stored: ${res.storeError}`);
      } else if (failed.length > 0) {
        showToast(`${failed.length} check(s) failed: ${failed.map((f) => f.label).join(", ")}`);
      } else {
        // Green exit codes are not the same question as "does this count", and saying the
        // first while the card says the second is how the app came to contradict itself:
        // "All checks passed." over a card still reading "Checks not confirmed (0/1 - 1
        // stale)" (task d6b33767). The toast now reports the card's OWN verdict, which the
        // handler recomputes and returns, and names the reason so it is actionable.
        const g = res.gauntlet;
        const notCounted = (g?.perCheck || []).filter((c) => c.state !== "passed");
        if (!g || g.state === "passing" || notCounted.length === 0) {
          showToast("All checks passed.");
        } else {
          const why = notCounted[0].staleReason || notCounted[0].state;
          showToast(
            notCounted.length === 1
              ? `Checks ran green, but they do not count yet: ${why}.`
              : `Checks ran green, but ${notCounted.length} do not count yet: ${why}.`
          );
        }
      }
      renderReviewPage();
    });
    head.append(run);
    box.append(head);
    (rec.checks || []).forEach((c, i) => {
      const line = document.createElement("div");
      line.className = "rev-check";
      const dot = document.createElement("span");
      // The state comes from gauntletStatus's perCheck, NOT re-derived here. Deriving
      // it a second time is how the dots ended up contradicting the header: this used
      // `runInfo.ok`, a field the record's author writes, so a forged run drew a green
      // dot reading "exit 0" while the header correctly said incomplete. One rule,
      // one place - and the renderer cannot verify a signature anyway.
      // Matched BY POSITION, not by label. perCheck is built by walking rec.checks in
      // order, so index i is exactly this check - whereas find(p => p.label === c.label)
      // returned the FIRST match, so two checks sharing a label both drew the first
      // one's state: a green "exit 0" dot for a command that never ran, under a header
      // correctly saying "not confirmed".
      const info = (row.gauntlet?.perCheck || [])[i] || { state: "unrun" };
      const DOT_CLASS = { passed: "pass", failed: "fail", stale: "stale", unrun: "unrun", unverified: "unverified", unusable: "unverified" };
      dot.className = "rev-check-dot " + (DOT_CLASS[info.state] || "unrun");
      const name = document.createElement("span");
      name.className = "rev-check-label";
      name.textContent = c.label;
      name.title = c.cmd;
      // The label is author prose; the COMMAND is the fact. A check labelled
      // "auth e2e (34 assertions)" whose cmd is `exit 0` rendered as an
      // authoritative green tick with the truth hidden in a tooltip.
      const cmd = document.createElement("code");
      // NOT truncated. It was capped at 44ch with an ellipsis, and real commands in
      // this repo already exceed that - so a `|| exit 0` tail, which turns any check
      // into a guaranteed pass, was rendered off the end of the line. The command you
      // are about to execute has to be readable in full.
      cmd.className = "rev-check-cmd" + (info.passForced ? " forced" : "");
      cmd.textContent = c.cmd;
      if (info.passForced) {
        cmd.title = `This command cannot fail (${info.passForced}), so a green result here means nothing.`;
      }
      const state = document.createElement("span");
      state.className = "rev-check-state";
      state.textContent =
        info.state === "unrun"
          ? "never run"
          : info.state === "unusable"
            ? // Not a forgery: the command is real and may well have run. It simply
              // cannot fail, so its result carries no information either way.
              info.passForced
              ? `THIS COMMAND CANNOT FAIL (${info.passForced}) — a green result here means nothing`
              : "no command declared — there is nothing to verify against"
            : info.state === "unverified"
              ? // Reserved for a genuine provenance problem. Kept distinct from "could
                // not start", so the one wording that means forgery isn't diluted.
                info.exitCode === null && info.ranAt
                ? `could not run · ${relTime(info.ranAt)}`
                : "NOT VERIFIED — this outcome was not stamped by the app"
              : info.state === "stale"
                ? `stale — ${info.staleReason || "ran before the last change"}`
                : `exit ${info.exitCode} · ${relTime(info.ranAt)}`;
      if (info.tail) {
        state.title = info.tail;
      }
      line.append(dot, name, cmd, state);
      box.append(line);
    });
    body.append(box);
  }

  // Sign-off, so review doesn't mean leaving Helm for Jot.
  body.append(reviewActionsEl(row));
  el.append(body);
  return el;
}

/**
 * The Mark done / Send back controls for one review row.
 *
 * Extracted because the row builder returns EARLY for a row with no review record,
 * and that return sat before these buttons were ever created - so the one band that
 * fills up (everything handed over before review records were required) was the only
 * band with no way to act on it. The page's biggest pile was permanent and could
 * only grow, which is a large part of why the whole page read as broken (task
 * f2ab6a5a, the captain: "det finns ingen ageringsknapp på dessa, ingen I know").
 *
 * Extracted rather than duplicated at the two call sites on purpose: two copies of
 * an action row is exactly how the two paths drift into offering different buttons.
 */
// An image-attach zone for the Send back dialog (task 1116b7ef). Returns { el,
// images } where images is a live array of { base64, ext } the dialog reads on
// submit. Accepts a file picker, paste, and drop - the same three ways the
// composer takes images - and shows a small thumbnail per attachment.
function sendBackImageZone() {
  const images = [];
  const el = document.createElement("div");
  el.className = "sendback-images";
  const bar = document.createElement("div");
  bar.className = "sendback-images-bar";
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "text-btn";
  pick.textContent = "Attach image";
  pick.title = "Attach a screenshot - or paste / drop one onto this box. It lands on the Jot card.";
  const hint = document.createElement("span");
  hint.className = "sendback-images-hint";
  hint.textContent = "or paste / drop";
  bar.append(pick, hint);
  const thumbs = document.createElement("div");
  thumbs.className = "sendback-thumbs";
  el.append(bar, thumbs);

  const addImage = (file) =>
    new Promise((resolve) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        resolve();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
        if (!base64) {
          resolve();
          return;
        }
        const ext = (file.type.split("/")[1] || "png").toLowerCase();
        const entry = { base64, ext };
        images.push(entry);
        const thumb = document.createElement("div");
        thumb.className = "sendback-thumb";
        const img = document.createElement("img");
        img.src = dataUrl;
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "sendback-thumb-rm";
        rm.textContent = "×";
        rm.title = "Remove";
        rm.addEventListener("click", (e) => {
          e.stopPropagation();
          const i = images.indexOf(entry);
          if (i >= 0) {
            images.splice(i, 1);
          }
          thumb.remove();
        });
        thumb.append(img, rm);
        thumbs.append(thumb);
        resolve();
      };
      reader.onerror = () => resolve();
      reader.readAsDataURL(file);
    });

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", async () => {
    for (const f of Array.from(input.files || [])) {
      await addImage(f);
    }
    input.value = "";
  });
  pick.addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });
  el.append(input);

  // Paste an image straight in - the same gesture as the chat composer and Jot. A plain
  // div is not focusable, so a paste listener on the box alone never fired: task 1116b7ef
  // came back "ska gå att klistra in på samma sätt som i jot eller i chattfönstret". Fix:
  // make the box focusable AND let the caller wire the dialog's note textarea (where the
  // cursor actually is) through attachPasteTo, so pasting while typing the note works.
  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []).filter((it) => it.type && it.type.startsWith("image/"));
    if (!items.length) {
      return;
    }
    e.preventDefault();
    for (const it of items) {
      await addImage(it.getAsFile());
    }
  };
  const attachPasteTo = (target) => {
    if (target && typeof target.addEventListener === "function") {
      target.addEventListener("paste", handlePaste);
    }
  };
  el.setAttribute("tabindex", "0");
  attachPasteTo(el);
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("sendback-images-drag");
  });
  el.addEventListener("dragleave", () => el.classList.remove("sendback-images-drag"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("sendback-images-drag");
    for (const f of Array.from(e.dataTransfer?.files || [])) {
      await addImage(f);
    }
  });

  return { el, images, attachPasteTo };
}

function reviewActionsEl(row) {
  const g = row.gauntlet || { declared: 0, state: "none" };
  const actions = document.createElement("div");
  actions.className = "rev-actions";

  // The two things reviewing actually needs and did not have (task c3dfbb42: "Kunna se
  // diff. Kunna skicka oberoende agent på granskning"). Both come FIRST, because they are
  // what you do before deciding, and Mark done / Send back are the decision.
  // A record-less card (an autopilot moved it to review, or a hand board-move) used to
  // get NONE of these - no diff, no reviewer - which made it a dead end: no way to see
  // what was done or to ask someone to check it (the captain, 2026-08-12). The diff and the
  // reviewer do not actually need a record - they work off the task's commits and its
  // project (row.repoPath, resolved by the payload builder) - so offer them whenever
  // that project is known. Only "Present review" genuinely needs a record to render.
  const canDiff = !!(row.record || (row.repoPath && row.hasCommits));
  const canReview = !!(row.record || row.repoPath);
  if (canDiff) {
    const diffBtn = document.createElement("button");
    diffBtn.type = "button";
    diffBtn.className = "text-btn";
    diffBtn.textContent = "See the diff";
    diffBtn.title = "The patch for this task's commits. Read-only.";
    diffBtn.addEventListener("click", async () => {
      diffBtn.disabled = true;
      const was = diffBtn.textContent;
      diffBtn.textContent = "Reading…";
      try {
        const res = await window.helm.getReviewDiff(row.taskId, row.repoPath);
        if (!res?.ok) {
          // A notice, not a toast: this is usually "nothing ties a commit to this task",
          // which is a sentence worth reading rather than one worth catching.
          showNotice(`No diff for "${row.title}": ${res?.error || "unknown reason"}`);
          return;
        }
        openDiffViewer(row, res);
      } finally {
        diffBtn.disabled = false;
        diffBtn.textContent = was;
      }
    });
    actions.append(diffBtn);
  }
  if (row.record) {

    // The whole card, as a full-width page in the OS browser. It used to render only
    // the diff, which was the wrong half (the captain, task ccbf82e2: "Jag vill inte
    // presentera diffen i en html likt summary page - jag vill presentera hela
    // reviewn så den blir mer lättläst"): the diff already has a viewer, and the part
    // that is cramped in this panel is everything above it - warnings, evidence,
    // gaps, checks, steps, the independent verdict. The page carries all of that, with
    // the diff as its last section.
    const presentBtn = document.createElement("button");
    presentBtn.type = "button";
    presentBtn.className = "text-btn";
    presentBtn.textContent = "Present review";
    presentBtn.title = "Opens the whole review - evidence, gaps, checks, steps, the verdict, and the diff - as one readable page in your browser.";
    presentBtn.addEventListener("click", async () => {
      presentBtn.disabled = true;
      const was = presentBtn.textContent;
      presentBtn.textContent = "Rendering…";
      try {
        const res = await window.helm.presentReview(row.taskId);
        if (!res?.ok) {
          showNotice(`Couldn't present the review for "${row.title}": ${res?.error || "unknown reason"}`);
        }
      } finally {
        presentBtn.disabled = false;
        presentBtn.textContent = was;
      }
    });
    actions.append(presentBtn);
  }
  if (canReview) {
    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "text-btn";
    reviewBtn.textContent = "Independent reviewer";
    reviewBtn.title = row.record
      ? "Opens a fresh session in this project with a review brief prepared. It does NOT send it - you press Enter, so nothing is spent until you do."
      : "No record was written for this task. Send a fresh reviewer to read what was done and WRITE the missing review record. It does NOT send until you press Enter.";
    reviewBtn.addEventListener("click", () => openIndependentReview(row));
    actions.append(reviewBtn);
  }

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "text-btn";
  doneBtn.textContent = "Mark done";
  doneBtn.addEventListener("click", async () => {
    // A failing gauntlet is a real reason to stop and look, so make signing off
    // over it deliberate rather than a reflex click.
    const proceed = () =>
      window.helm.setReviewStatus(row.taskId, "done").then((res) => {
        showToast(res?.ok ? `"${row.title}" marked done.` : res?.error || "Couldn't update the board.");
        renderReviewPage();
      });
    // Every state that means "this has not been shown to work" gets a confirm, not
    // just an outright failing one. Previously only `failing` did - so unverified,
    // unrun, stale, drifted and a record that doesn't meet its own bar all signed off
    // on a single click, which are precisely the states a rushed session produces.
    const reason =
      row.verdict === "unrecorded"
        ? `has no review record at all - nothing about it has been checked for you`
        : g.state === "failing"
        ? `has FAILING checks`
        : g.unusable > 0
          ? `has ${g.unusable} check(s) that cannot fail, or declare no command - a green result there means nothing`
          : g.unverified > 0
            ? `has ${g.unverified} check(s) whose outcome was never stamped by the app`
            : row.verdict === "incomplete"
            ? `has a record that does not meet the bar for a ${row.criticality || "?"} item`
            : g.state === "incomplete"
              ? `has declared checks that have not passed (${g.unrun} unrun, ${g.stale} stale)`
              : row.drift?.drifted
                ? `has acceptance criteria that changed after the record was written`
                : (row.caveats || []).length > 0 && (g.declared || 0) === 0
                  ? `has no executed check at all - it rests on the author's word`
                  : null;
    if (reason) {
      customConfirm(`"${row.title}" ${reason}. Mark it done anyway?`, "Mark done", proceed, { deliberate: true });
      return;
    }
    proceed();
  });
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "text-btn";
  backBtn.textContent = "Send back";
  backBtn.addEventListener("click", () => {
    // customPrompt, NOT window.prompt: the latter is disabled in Electron and returns
    // undefined, so this button silently did nothing at all from the day it was
    // written (task ebb4e567). The rest of this handler was always what the captain asked
    // for - a required reason, dated, written onto the Jot card as the task moves
    // back a step - so only the asking was broken.
    // Optional screenshots ride along with the note (task 1116b7ef). The zone
    // collects them; sendReviewBack writes them under the Jot card and appends
    // the note - a plain note with no images behaves exactly as before.
    const imgZone = sendBackImageZone();
    customPrompt(
      `Send "${row.title}" back to in-progress. What needs changing?`,
      (note) => {
        window.helm
          .sendReviewBack(row.taskId, `[the captain ${new Date().toISOString().slice(0, 10)}] ${note}`, imgZone.images)
          .then((res) => {
            const n = imgZone.images.length;
            showToast(res?.ok ? `Sent back with your note${n ? ` and ${n} image${n === 1 ? "" : "s"}` : ""}.` : res?.error || "Couldn't update the board.");
            renderReviewPage();
          });
      },
      {
        confirmLabel: "Send back",
        placeholder: "What needs changing, and why - this lands on the Jot card.",
        extraEl: imgZone.el,
        // Paste a screenshot straight into the note, like the chat composer / Jot.
        onField: (field) => imgZone.attachPasteTo(field),
      }
    );
  });
  actions.append(doneBtn, backBtn);
  return actions;
}

// Review page filters. Module state, not DOM state, so they survive the full re-render
// that follows every action on the page.
//
// The repo filter defaults ON: "endast visa saker i review som faktiskt är rootade till
// ett repo - potentiella kodändringar är de enda som behöver reviewas" (the captain,
// 2026-08-04). His private board and his life-domain boards were filling the queue with
// rows that have no code to review. What is held back is always COUNTED and one click
// away - a queue that quietly omits work would defeat the surface's whole purpose.
let reviewOnlyRepoRooted = true;
let reviewProjectFilter = null; // a category name, or null for every project
// Work/private focus, brought back on the Review page (task 0ca1f3d3: "här borde
// vi faktiskt lägga tillbaka private/work togglen som fanns i focus"). Unlike the
// old Focus/Goals toggle - removed because it filtered a PLANNING list that just
// duplicated Jot - this filters review WORK: which finished tasks you look at now.
// The domain comes straight from each Jot category's own W/P classification. "all"
// = no domain filtering; resets on reload, like the other two.
let reviewDomainFilter = "all"; // "all" | "work" | "private"
// Defaults ON: a task in review with no commit tied to it, no declared checks, and
// no critical/core criticality is not code review's problem - it is what "korten
// ska vara bundna till commits - har ingen commit gjorts så behövs inget kort"
// (the captain, 2026-08-11) asks for. Kept as a toggle rather than a server-side drop,
// same reasoning as reviewOnlyRepoRooted: a filter that silently omits work is the
// exact failure this whole surface exists to prevent, so it stays discoverable and
// one click from reversible.
let reviewHideNoCommits = true;
// Deliberately narrow: this hides ONLY the "unrecorded" clutter - a task moved to
// review with no record at all AND nothing committed against it, which is noise,
// not work waiting on a decision. A record that DOES exist is never hidden by this
// rule, however it fares otherwise (stamp, judgment, incomplete, no commits and
// all) - it is documented evidence somebody wrote, and test-acceptance-gate is the
// load-bearing case: a cosmetic, fully-covered "stamp" record with no commit still
// carries its acceptance criteria and test steps, and hiding that card would hide
// real work, not noise. `r.hasCommits === false` is a POSITIVE statement from
// buildReviewsPayload ("git was asked and found nothing"); undefined (an older
// payload, or a row a test built by hand) is not treated as a confirmed absence.
const rowNeedsNoCommitsCard = (r) => r.verdict !== "unrecorded" || r.hasCommits !== false;

// Which band a row belongs to. The queue's own module decides this and sends it as
// row.band; the fallback is for a row from an older payload. At module scope so the page,
// the grouping and the tests all ask the SAME function - a second copy of this rule is how
// the page and the queue came to group by different definitions once already.
const bandOf = (r) => r.band || r.verdict;

/**
 * The rows the Review page would actually SHOW, and the tally of them.
 *
 * Both at module scope, and both used by the page AND the dashboard widget, because the two
 * disagreed: the page recomputes its numbers from the rows it displays (deliberately - a
 * summary describing a set the page is not showing is worse than none), while the widget was
 * printing the backend's unfiltered tally. So the widget said "12 need you" over a page with
 * one row on it (the captain, task daa4245f: "något säger 12 men det är bara 1"). Nothing was
 * miscounted; there were simply two counts of two different things, which is the same defect
 * class as the amber frame and the double-reported runs.
 */
function visibleReviewRows(allRows, { ignoreProjectFilter = false, ignoreDomainFilter = false } = {}) {
  const project = ignoreProjectFilter ? null : reviewProjectFilter;
  // The subnav badge is a GLOBAL attention signal, so it passes ignoreDomainFilter
  // (as it already passes ignoreProjectFilter): a work/private focus chosen on the
  // page must not shrink the badge and leave real review items uncounted until a
  // restart - the same under-flagging bug ignoreProjectFilter was added to prevent
  // (daa4245f), which this filter would otherwise reintroduce on a new axis.
  const domain = ignoreDomainFilter ? "all" : reviewDomainFilter;
  return (allRows || []).filter(
    (r) =>
      (!reviewOnlyRepoRooted || r.repoPath) &&
      (!project || r.category === project) &&
      (domain === "all" || r.domain === domain) &&
      (!reviewHideNoCommits || rowNeedsNoCommitsCard(r))
  );
}

function reviewTallyFromRows(rows) {
  const tally = { total: rows.length, judgment: 0, stamp: 0, unrecorded: 0, incomplete: 0, unconfirmed: 0 };
  for (const r of rows) {
    const b = bandOf(r);
    tally[b] = (tally[b] || 0) + 1;
  }
  // How much of this page can be judged at all. Counted apart from the bands because
  // it is a different question: the bands say what to do about a row, this says
  // whether there is anything to do it WITH. Measured on the real board 2026-08-31 it
  // was 0 of 33 - every row a task nobody could assess - and that fact was invisible,
  // because "no record" read as one bucket among six rather than as the state of the
  // whole page.
  tally.withEvidence = tally.total - tally.unrecorded;
  return tally;
}

/**
 * The one line under "Review" - and what it leads with depends on the page.
 *
 * It used to always open with "N need your judgment", which is the right lead when
 * there is something to judge. When most of the page has no record at all, that
 * opening is a lie of omission: it reports on the sliver that can be assessed and
 * says nothing about the rest, and the "with no record" clause sat last, after
 * three optional ones, where it read as a footnote.
 *
 * So when coverage is poor the coverage IS the headline. Nothing else on this page
 * means anything until it improves.
 */
function reviewHeaderLine(tally) {
  const parts = [];
  const bad = tally.withEvidence === 0 || tally.withEvidence * 2 < tally.total;
  if (bad) {
    parts.push(
      tally.withEvidence === 0
        ? `Nothing here can be reviewed - none of the ${tally.total} has a record`
        : `Only ${tally.withEvidence} of ${tally.total} can be reviewed - the rest have no record`
    );
  }
  if (tally.judgment > 0 || !bad) {
    parts.push(`${tally.judgment} need your judgment`);
  }
  if (tally.stamp > 0 || !bad) {
    parts.push(`${tally.stamp} ready to stamp`);
  }
  if (tally.unconfirmed > 0) {
    parts.push(`${tally.unconfirmed} claimed but unconfirmed`);
  }
  if (tally.incomplete > 0) {
    parts.push(`${tally.incomplete} below the bar`);
  }
  if (!bad && tally.unrecorded > 0) {
    parts.push(`${tally.unrecorded} with no record`);
  }
  return parts.join(" · ");
}

/**
 * Project chips plus the repo toggle.
 *
 * Built from the WHOLE queue, not the filtered view, so selecting a project never
 * removes the chip you would use to get back - a filter bar that erases its own
 * options is a trap. The counts on each chip are what the repo filter would leave, so
 * the numbers agree with what clicking actually shows.
 */
function reviewFilterBarEl(allRows, nonRepoCount, noCommitsCount) {
  const bar = document.createElement("div");
  bar.className = "rev-filters";
  // Repo-eligible rows, before the domain filter - so the Work/Private chips can
  // count what they WOULD show and never erase their own option (the same rule the
  // project chips follow against the whole queue).
  const repoEligible = allRows.filter((r) => !reviewOnlyRepoRooted || r.repoPath);
  // Rows the project chips count from: repo-eligible AND matching the active domain,
  // so a project's number agrees with what clicking it under this focus shows.
  const eligible = repoEligible.filter((r) => reviewDomainFilter === "all" || r.domain === reviewDomainFilter);
  const counts = new Map();
  for (const r of eligible) {
    const key = r.category || "(no project)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const chip = (label, active, onClick, title = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rev-filter-chip" + (active ? " is-active" : "");
    b.textContent = label;
    if (title) {
      b.title = title;
    }
    b.addEventListener("click", () => {
      onClick();
      renderReviewPage();
    });
    return b;
  };

  // Work/private focus (task 0ca1f3d3). A small segmented control at the head of the
  // bar. Counts come from repoEligible (pre-domain) so switching focus never hides
  // the chip that switches it back. Picking a domain also clears the project chip, so
  // a project that has nothing in the new focus can't strand the page on an empty view.
  const domainCounts = { work: 0, private: 0 };
  for (const r of repoEligible) {
    if (r.domain === "work" || r.domain === "private") {
      domainCounts[r.domain]++;
    }
  }
  const domSeg = document.createElement("div");
  domSeg.className = "rev-domain-seg";
  const domChip = (label, mode) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rev-filter-chip rev-domain-chip" + (reviewDomainFilter === mode ? " is-active" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      reviewDomainFilter = reviewDomainFilter === mode ? "all" : mode;
      reviewProjectFilter = null;
      renderReviewPage();
    });
    return b;
  };
  domSeg.append(
    domChip(`All (${repoEligible.length})`, "all"),
    domChip(`Work (${domainCounts.work})`, "work"),
    domChip(`Private (${domainCounts.private})`, "private")
  );
  bar.append(domSeg);

  bar.append(
    chip(`All projects (${eligible.length})`, !reviewProjectFilter, () => {
      reviewProjectFilter = null;
    })
  );
  for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    bar.append(
      chip(`${name} (${n})`, reviewProjectFilter === name, () => {
        reviewProjectFilter = reviewProjectFilter === name ? null : name;
      })
    );
  }

  // The held-back count, always visible even at zero-width: the point of stating it is
  // that he can tell the difference between "nothing else is waiting" and "something
  // else is waiting but filtered out".
  const spacer = document.createElement("span");
  spacer.className = "rev-filters-spacer";
  bar.append(spacer);
  bar.append(
    chip(
      reviewOnlyRepoRooted
        ? nonRepoCount > 0
          ? `Code only · ${nonRepoCount} hidden`
          : "Code only"
        : "Showing everything",
      reviewOnlyRepoRooted,
      () => {
        reviewOnlyRepoRooted = !reviewOnlyRepoRooted;
        // A project that only exists outside the code boards would otherwise leave the
        // page filtered to nothing with no obvious way back.
        reviewProjectFilter = null;
      },
      reviewOnlyRepoRooted
        ? `Only work on a board that maps to a git repo. ${nonRepoCount} row(s) are held back - click to include them.`
        : "Showing every board, including ones with no code to review. Click to go back to code only."
    )
  );
  // "No commit, no card" (the captain, 2026-08-11): a repo-rooted task with no commit tied
  // to it, no declared checks, and no critical/core criticality isn't code review's
  // problem, so it's held back by default - same reversible-chip pattern as "Code
  // only" above, not a silent drop.
  bar.append(
    chip(
      reviewHideNoCommits
        ? noCommitsCount > 0
          ? `Bound to commits · ${noCommitsCount} hidden`
          : "Bound to commits"
        : "Showing uncommitted too",
      reviewHideNoCommits,
      () => {
        reviewHideNoCommits = !reviewHideNoCommits;
      },
      reviewHideNoCommits
        ? `Only rows with a commit tied to them (or declared checks, or critical/core criticality). ${noCommitsCount} row(s) with nothing committed are held back - click to include them.`
        : "Showing rows with no commit tied to them too - click to hide them again."
    )
  );
  return bar;
}

// Bumped by every render so a slow fresh build cannot repaint a page the user has already
// navigated away from, or overwrite a newer render's output.
let reviewRenderToken = 0;

/**
 * Show the review queue at once, then correct it.
 *
 * This page used to await a FULL queue build before painting a single pixel. Measured in
 * the running app on 2026-08-12: 2770ms from the click to anything appearing, during which
 * the old page just sat there - it is the "att byta mellan vyer ... är långsamt" the captain
 * reported, and no amount of making the build cheaper fixes a view that refuses to draw
 * until it finishes.
 *
 * So: paint from the last known payload immediately (the main process keeps one, and it is
 * valid unless the board or the records have actually changed), and ask for a fresh build
 * in the background. When it arrives the page is repainted.
 *
 * A cached-then-corrected review page needs care rather than enthusiasm, because "stale
 * review state is exactly the kind of thing that should not be quietly out of date" - this
 * file's own words about the cache. Two things make it honest: whenever a CACHED payload is
 * painted a refresh always follows (never skipped because the cache looked recent), and
 * while it is in flight the page SAYS it is checking. Nothing is quiet about it.
 *
 * The one case with no refresh is a cold cache, where the first call built the queue itself -
 * that payload is already as fresh as a second call could make it. An earlier version of this
 * comment claimed the refresh was unconditional, which stopped being true the moment that
 * double build was fixed (second review, 2026-08-12).
 */
async function renderReviewPage() {
  const page = document.getElementById("reviewPage");
  if (!page) {
    return;
  }
  const token = ++reviewRenderToken;
  // Something on screen BEFORE the first await. On the very first visit there is no cached
  // payload to paint, and the build genuinely takes seconds - measured at 10.9s in a fresh
  // profile, where every project's commit baseline has to be established for the first
  // time. Without this the page is simply blank for all of it, which reads as broken
  // rather than as busy.
  if (page.childElementCount === 0) {
    const heading = document.createElement("h2");
    heading.textContent = "Review";
    const waiting = document.createElement("div");
    waiting.className = "analysis-totals";
    waiting.textContent = "Building the review queue…";
    page.replaceChildren(heading, waiting);
  }
  // A cached payload of any age is worth painting - it is replaced moments later, and the
  // alternative is showing nothing at all for seconds.
  //
  // The `cached` flag decides whether a second call is needed at all, and getting that wrong
  // was expensive: asking for a cached payload when the cache is COLD makes the main process
  // build the whole queue anyway and return it unflagged, so an unconditional refresh below
  // threw that away and built it a second time. The first visit after launch - the exact case
  // this whole change exists to improve, and the slowest one, ~10s in a fresh profile - paid
  // for TWO builds instead of one (found by review, 2026-08-12).
  let first = null;
  try {
    first = await window.helm.listReviews({ maxAgeMs: 24 * 60 * 60 * 1000 });
  } catch {
    // Nothing to paint yet; fall through to the fresh build, same as before.
  }
  if (token !== reviewRenderToken) {
    return; // navigated away, or a newer render started
  }
  if (first) {
    paintReviewPage(first, { refreshing: !!first.cached });
    if (!first.cached) {
      return; // that WAS a fresh build - there is nothing newer to fetch
    }
  }
  const fresh = await window.helm.listReviews();
  if (token !== reviewRenderToken) {
    return;
  }
  paintReviewPage(fresh, { refreshing: false });
}

function paintReviewPage(res, { refreshing = false } = {}) {
  const page = document.getElementById("reviewPage");
  if (!page) {
    return;
  }
  const allRows = res?.rows || [];
  const nonRepoCount = allRows.filter((r) => !r.repoPath).length;
  // Repo-rooted rows this filter would hold back - counted before it is applied, same
  // rule nonRepoCount follows, so the chip can say how many and never erase its own
  // toggle.
  const noCommitsCount = allRows.filter((r) => r.repoPath && !rowNeedsNoCommitsCard(r)).length;
  const rows = visibleReviewRows(allRows);
  // Counted from the rows actually SHOWN, not from the whole queue: a summary line that
  // described a set the page is not displaying is worse than no summary, because it is
  // the line a skimming reader trusts. The dashboard widget calls the same two functions,
  // so it cannot describe this board differently.
  const tally = reviewTallyFromRows(rows);

  const frag = document.createDocumentFragment();
  const topbar = document.createElement("div");
  topbar.className = "dash-topbar";
  const heading = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "Review";
  const sub = document.createElement("div");
  sub.className = "analysis-totals";
  sub.style.marginBottom = "0";
  sub.textContent =
    tally.total === 0
      ? "Nothing is waiting on your review."
      : reviewHeaderLine(tally);
  heading.append(h2, sub);
  // Said out loud, not implied. This is the last-known queue, drawn at once so the page is
  // not blank for seconds; the real one is being built right now and will replace it. A
  // review board that might be out of date has to admit it.
  if (refreshing) {
    const checking = document.createElement("div");
    checking.className = "analysis-totals";
    checking.style.marginBottom = "0";
    checking.style.opacity = "0.7";
    checking.textContent = "Showing the last known queue - checking for changes…";
    heading.append(checking);
  }
  topbar.append(heading);

  // "Re-run everything unconfirmed", so a board that went stale after a commit can be
  // brought back without opening every card. Pinning a pass to a commit is the right
  // rule but it makes staleness common, and a signal that is tedious to clear is a
  // signal that gets ignored.
  const needsRun = rows.filter((r) => (r.gauntlet?.declared || 0) > 0 && r.gauntlet.state !== "passing");
  if (needsRun.length > 0) {
    const runAll = document.createElement("button");
    runAll.type = "button";
    runAll.className = "text-btn";
    runAll.textContent = `Re-run ${needsRun.length} unconfirmed`;
    runAll.title = needsRun.map((r) => r.title).join("\n");
    runAll.addEventListener("click", async () => {
      runAll.disabled = true;
      let done = 0;
      let failed = 0;
      for (const row of needsRun) {
        runAll.textContent = `Running ${++done}/${needsRun.length}…`;
        const res2 = await window.helm.runReviewChecks(row.taskId);
        if (!res2?.ok || res2.stored === false || (res2.results || []).some((r) => !r.ok)) {
          failed += 1;
        }
      }
      showToast(failed === 0 ? `Re-ran ${done} item(s); all checks passed.` : `Re-ran ${done} item(s); ${failed} still not passing.`);
      renderReviewPage();
    });
    topbar.append(runAll);
  }
  frag.append(topbar);
  frag.append(reviewFilterBarEl(allRows, nonRepoCount, noCommitsCount));

  if (!res?.ok && res?.error) {
    const err = document.createElement("div");
    err.className = "rev-warn";
    err.textContent = res.error;
    frag.append(err);
  }

  // A stamp whose DECLARED checks aren't confirmed is not ready to stamp, and must
  // not sit under a heading that says "verified end to end". Found by rendering a
  // fabricated record: its one check showed NOT VERIFIED on its own line while the
  // heading above it still promised verification - and the heading is what a skimming
  // reader takes on trust.
  //
  // Only DECLARED checks count here: a cosmetic item legitimately declares none, and
  // demanding a green gauntlet from it would make the gradient meaningless in the
  // other direction.
  // reviewBand comes from the queue's own module (exposed on each row as row.band), so
  // the page can no longer group by a different rule than the queue sorted by. That
  // mismatch fragmented headings and discarded the queue's ordering.
  const BANDS = {
    judgment: { label: "Needs your judgment", hint: "these can't be settled by a test" },
    unconfirmed: {
      label: "Claimed, not confirmed",
      hint: "the record says it's done, but its own declared checks have not passed - run them before you trust this",
    },
    stamp: { label: "Ready to stamp", hint: "the evidence holds up - read it and move on" },
    incomplete: { label: "Below the bar", hint: "a record exists, but it does not meet the bar for its criticality - read it, do not trust it" },
    unrecorded: {
      label: "Nothing to review",
      hint: "in review, but no record was ever written - there is nothing here to judge, and approving it would say 'reviewed' about work nobody looked at",
    },
  };


  // Render in the order the QUEUE decided, emitting a heading whenever the band
  // changes - instead of re-filtering rows into a fixed heading sequence.
  //
  // The old loop silently discarded buildReviewQueue's ordering. That ordering exists
  // for one reason: a CRITICAL record that claims to be reviewed but isn't admissible
  // is put in band 0, above every stamp, with a comment saying burying it "hides
  // exactly the alarm the gradient exists to raise". The page then rendered it FOURTH,
  // below the cosmetic stamps, because "incomplete" came fourth in the hardcoded list.
  //
  // Worse, the test I wrote to prevent exactly this asserted the order of the IPC rows
  // and then, on the page, only COUNTED elements - never their order. That is the
  // count-the-buttons failure again, in the test written to stop it. The e2e now
  // asserts rendered DOM order.
  // Subtasks are drawn UNDER their epic when both are in the same band ("vi borde lägga
  // subtasks under huvudtasken om det går i review så man vet vilka som hör ihop" -
  // the captain, 2026-08-04, on an epic's subtasks arriving as N unrelated rows).
  //
  // Same band only, and that limit is deliberate rather than lazy: the band order is
  // load-bearing (a critical item claiming to be reviewed sits above every stamp, so
  // burying it under a parent would hide the alarm the ordering exists to raise). A
  // subtask whose parent sits in a different band stays where its own band puts it, and
  // its row already names the parent, so nothing loses its context.
  const bandOfRow = new Map(rows.map((r) => [r.taskId, bandOf(r)]));
  const childrenOf = new Map();
  for (const row of rows) {
    if (!row.parentId || bandOfRow.get(row.parentId) !== bandOf(row)) {
      continue; // no parent here, or the parent is in another band
    }
    if (!childrenOf.has(row.parentId)) {
      childrenOf.set(row.parentId, []);
    }
    childrenOf.get(row.parentId).push(row);
  }
  const nested = new Set([...childrenOf.values()].flat().map((r) => r.taskId));

  let lastBand = null;
  for (const row of rows) {
    if (nested.has(row.taskId)) {
      continue; // drawn under its parent, below
    }
    const band = bandOf(row);
    if (band !== lastBand) {
      lastBand = band;
      const spec = BANDS[band] || { label: band, hint: "" };
      const h = document.createElement("h3");
      h.className = "rev-group";
      h.textContent = spec.label;
      const hint = document.createElement("span");
      hint.className = "rev-group-hint";
      hint.textContent = spec.hint ? `— ${spec.hint}` : "";
      h.append(hint);
      frag.append(h);
    }
    const kids = childrenOf.get(row.taskId) || [];
    if (kids.length === 0) {
      frag.append(reviewRowEl(row, band));
      continue;
    }
    const group = document.createElement("div");
    group.className = "rev-epic";
    group.append(reviewRowEl(row, band));
    const kidWrap = document.createElement("div");
    kidWrap.className = "rev-epic-children";
    const label = document.createElement("div");
    label.className = "rev-epic-label";
    label.textContent = `${kids.length} subtask${kids.length === 1 ? "" : "s"} of this epic`;
    kidWrap.append(label);
    for (const kid of kids) {
      kidWrap.append(reviewRowEl(kid, bandOf(kid)));
    }
    group.append(kidWrap);
    frag.append(group);
  }

  // The audit: work that reached done without ever being recorded. A direct board
  // write (an agent editing todos.json, a drag in the Jot app) cannot be prevented
  // from here - only detected - so it has to appear on the page he actually reads.
  // Otherwise "I only look at the Review page" is safe only while every agent
  // voluntarily stops at `review`.
  // Same Work/Private focus and project chip the rows above obey - this list was
  // rendered from the unfiltered backend payload, so switching to "Work" still showed
  // Private tasks here (task 41f73e59: "Dessa filtreras inte på work och private").
  const skipped = (res?.doneWithoutRecord || []).filter(
    (t) =>
      (reviewDomainFilter === "all" || t.domain === reviewDomainFilter) &&
      (!reviewProjectFilter || t.category === reviewProjectFilter)
  );
  if (skipped.length > 0) {
    const h = document.createElement("h3");
    h.className = "rev-group";
    h.textContent = "Went to done without a record";
    const hint = document.createElement("span");
    hint.className = "rev-group-hint";
    hint.textContent = "— these bypassed review entirely; nothing was written down to check";
    h.append(hint);
    frag.append(h);
    for (const t of skipped) {
      const el = document.createElement("section");
      el.className = "rev-item skipped";
      const line = document.createElement("div");
      line.className = "rev-head";
      const title = document.createElement("span");
      title.className = "rev-title";
      title.textContent = t.title || "(untitled)";
      line.append(title);
      if (t.category) {
        line.append(reviewChip(t.category, "neutral"));
      }
      if (t.completedAt) {
        line.append(reviewChip(relTime(t.completedAt), "neutral"));
      }
      // Acknowledge: "I know this bypassed review." It does NOT claim the work was
      // reviewed and creates no evidence - it stops the audit repeating something
      // already read. Without it these sit for a fortnight and train you to skim the
      // section, which is how an attention signal dies.
      const ackBtn = document.createElement("button");
      ackBtn.type = "button";
      ackBtn.className = "text-btn";
      ackBtn.textContent = "I know";
      ackBtn.title = "Stop listing this. It does not mark the work as reviewed - there is still no evidence for it.";
      ackBtn.addEventListener("click", async () => {
        ackBtn.disabled = true;
        const res = await window.helm.acknowledgeNoRecord(t.id);
        if (!res?.ok) {
          ackBtn.disabled = false;
          showToast(res?.error || "Couldn't acknowledge that.");
          return;
        }
        renderReviewPage();
      });
      line.append(ackBtn);
      el.append(line);
      frag.append(el);
    }
  }

  // Commits with no Jot task (the commit-centric source): work not tracked on a Jot board
  // still needs reviewing - a session against a project that uses a GitHub board instead of
  // Jot (the captain's Halyard case) produced commits nothing here could show. Grouped per
  // project; each commit can be diffed and acknowledged (which advances the project's
  // watermark so it drops off). Deliberately NOT tied to the Work/Private or project chips:
  // those filter Jot categories, and these rows are keyed by repo, so they always show,
  // clearly labelled by project.
  const unboundGroups = res?.unboundCommits || [];
  for (const group of unboundGroups) {
    const h = document.createElement("h3");
    h.className = "rev-group";
    h.textContent = `Commits without a task — ${group.projectName}`;
    const hint = document.createElement("span");
    hint.className = "rev-group-hint";
    hint.textContent = `— ${group.commits.length} commit${group.commits.length === 1 ? "" : "s"} not tied to any Jot task`;
    h.append(hint);
    // Clear a whole project at once: advance the watermark to the newest shown commit (git
    // log is newest-first), so a burst of a project's own commits (helm's handoff/bump/etc.)
    // doesn't have to be acknowledged one by one. Chosen over auto-advancing on every build,
    // which would silently hide commits before you'd looked at them.
    if (group.commits.length > 1) {
      const ackAll = document.createElement("button");
      ackAll.type = "button";
      ackAll.className = "text-btn rev-group-action";
      // "Seen", not "Reviewed". This writes no evidence at all - no record, no checks, no
      // note - it only stops the row being shown. A task's "Mark done" is backed by a review
      // record; calling both of them the same thing made a dismissal look like a verdict,
      // which is the exact conflation the review pipe exists to prevent (the captain, 2026-08-12).
      ackAll.textContent = "Seen all";
      ackAll.title = `Stop showing all ${group.commits.length} listed ${group.projectName} commits. This records only that you have seen them - it does not claim anything was reviewed.`;
      ackAll.addEventListener("click", async (e) => {
        e.stopPropagation();
        ackAll.disabled = true;
        // Acknowledge EVERY shown commit, not just the newest: the group can hold divergent
        // siblings (each merged via its own merge commit), and acking only the top would leave
        // the others behind - the same toggle the single-watermark model caused (2026-08-12).
        const r = await window.helm.acknowledgeCommit(group.projectPath, null, group.commits.map((c) => c.sha));
        if (!r?.ok) {
          ackAll.disabled = false;
          showToast(r?.error || "Couldn't acknowledge those.");
          return;
        }
        renderReviewPage();
      });
      h.append(ackAll);
    }
    frag.append(h);
    for (const c of group.commits) {
      const el = document.createElement("section");
      el.className = "rev-item unbound-commit";
      // Namespaced so a commit's expanded-state key can never collide with a task's id.
      const key = "commit:" + c.sha;
      const line = document.createElement("div");
      line.className = "rev-head";
      line.tabIndex = 0;
      line.setAttribute("role", "button");
      const chev = document.createElement("span");
      chev.className = "rev-chev";
      chev.textContent = "▸";
      line.append(chev);
      const title = document.createElement("span");
      title.className = "rev-title";
      title.textContent = c.subject || "(no subject)";
      line.append(title);
      const shaChip = reviewChip(c.shortSha, "commit");
      shaChip.title = c.sha;
      line.append(shaChip);
      const noTask = reviewChip("no task", "gap");
      noTask.title = "This commit isn't tied to any Jot task - it's shown so the work still gets reviewed.";
      line.append(noTask);

      // The dismiss control lives in the row's FOOTER, not up here. Two reasons: a task's
      // card keeps Mark done / Send back in its body too, so this is the same shape; and a
      // control that hides a commit belongs next to the ones that let you look at it first,
      // not above them where it is the easiest thing to reach without reading anything.
      el.append(line);

      // The body a commit row was missing. It used to be the diff and NOTHING else, which
      // is why these rows read as second-class next to a task's card (the captain, task cb249577:
      // "Varför får inte reviews i Commits without a task t.ex samma body som andra med
      // tasks?"). The answer is that a task's body comes from a review record and a commit
      // has none - so the honest version is not to fabricate one, but to say that plainly
      // and then show everything that IS knowable: who wrote it and when, the FULL commit
      // message (usually where the author did explain themselves, and previously never
      // displayed at all), the size of the change, an independent reviewer's verdict if one
      // has been written, and the same actions a task row offers. Lazily loaded on first
      // open so a screen of collapsed rows costs no git.
      const body = document.createElement("div");
      body.className = "rev-body";
      const expanded = reviewExpanded.has(key);
      el.classList.toggle("rev-open", expanded);
      body.hidden = !expanded;
      let loaded = false;
      const loadBody = async () => {
        if (loaded) {
          return;
        }
        loaded = true;

        // The absence, stated first - the same thing an unrecorded task row says, and for
        // the same reason: a card that opens straight into content reads as reviewed.
        const warn = document.createElement("div");
        warn.className = "rev-warn";
        warn.textContent =
          "No Jot task, so no review record: nobody wrote down what this was meant to do, what was checked, or what was left unverified. Everything below is read straight out of git - treat it as unreviewed.";
        body.append(warn);

        const factsBox = document.createElement("div");
        factsBox.className = "rev-chips";
        body.append(factsBox);

        // The commit's own prose and facts.
        let detail = null;
        try {
          const d = await window.helm.getCommitDetail(group.projectPath, c.sha);
          if (d?.ok) {
            detail = d.commit;
            if (detail.author) {
              factsBox.append(reviewChip(detail.author, "neutral"));
            }
            if (detail.date) {
              factsBox.append(reviewChip(detail.date, "neutral"));
            }
            if (detail.shortstat) {
              factsBox.append(reviewChip(detail.shortstat, "neutral"));
            }
            if (detail.body) {
              // Through the markdown renderer, like the independent reviewer's note fifty
              // lines below - which this card was ALREADY doing, while dumping the commit
              // message into one flat paragraph. A multi-paragraph message then rendered as
              // an unbroken wall of text (the captain, 2026-08-12: "istället för att skriva det
              // som en oläslig blob som i bilden"), and the message is usually the only
              // place the author explained themselves at all.
              const msg = document.createElement("div");
              msg.className = "rev-summary";
              renderMarkdownInto(msg, detail.body);
              body.append(msg);
            }
          }
        } catch {
          // A row that cannot read its commit's metadata still shows the diff below.
        }

        // A verdict, if an independent reviewer has already been sent at this commit. Keyed
        // by the full sha, which is why getIndependentNote - written for task ids - works
        // unchanged here.
        try {
          const noteRes = await window.helm.getIndependentNote(c.sha);
          if (noteRes?.ok && noteRes.present) {
            const box = document.createElement("div");
            box.className = "rev-list rev-list-independent";
            const lab = document.createElement("div");
            lab.className = "rev-list-label";
            lab.textContent = `Independent reviewer · written ${new Date(noteRes.writtenAt).toLocaleString()}`;
            lab.title = noteRes.path;
            const text = document.createElement("div");
            text.className = "rev-independent-note";
            renderMarkdownInto(text, noteRes.text.trim());
            box.append(lab, text);
            body.append(box);
          }
        } catch {
          // no verdict is the ordinary case
        }

        // A FOOTER, pinned to the bottom of the row rather than laid out after the message.
        // These buttons used to sit below the commit body, so a long message pushed them off
        // the visible area entirely - which is why "Present review" and "Independent
        // reviewer" read as missing when they had been there all along (the captain, 2026-08-12:
        // "varför har den inte send back, skicka granskare etc knappar?"). Sticky keeps
        // every action reachable no matter how long the message is.
        //
        // "Send back" is deliberately NOT here: it moves a Jot TASK back to in-progress with
        // a note, and this row has no task to move. Offering a button that cannot do its
        // job is worse than not offering it.
        const actions = document.createElement("div");
        actions.className = "rev-actions rev-commit-footer";
        const presentBtn = document.createElement("button");
        presentBtn.type = "button";
        presentBtn.className = "text-btn";
        presentBtn.textContent = "Present review";
        presentBtn.title = "Opens this commit - its message, its size, any verdict, and the diff - as one readable page in your browser.";
        presentBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          presentBtn.disabled = true;
          try {
            const r = await window.helm.presentCommitReview(group.projectPath, c.sha);
            if (!r?.ok) {
              showNotice(`Couldn't present ${c.shortSha}: ${r?.error || "unknown reason"}`);
            }
          } finally {
            presentBtn.disabled = false;
          }
        });
        actions.append(presentBtn);
        const revBtn = document.createElement("button");
        revBtn.type = "button";
        revBtn.className = "text-btn";
        revBtn.textContent = "Independent reviewer";
        revBtn.title = "Sends a fresh session at this commit with a review brief. It starts immediately, so this spends tokens.";
        revBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openCommitIndependentReview(group.projectPath, c);
        });
        actions.append(revBtn);

        // The diff is BEHIND a button, never in the card. It used to load inline and stack
        // hundreds of lines under every expanded row (the captain, 2026-08-12: "Diffen bör aldrig
        // läggas direkt i kortet ... jag är sällan intresserad av diffen på det sättet").
        // This opens the same viewer a task's card uses, which also brings the changed-files
        // column with it - so the commit row stops being the one place with a worse diff.
        const diffBtn = document.createElement("button");
        diffBtn.type = "button";
        diffBtn.className = "text-btn";
        diffBtn.textContent = "See diff";
        diffBtn.title = "Opens this commit's diff in the viewer, with a column to pick a changed file.";
        diffBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          diffBtn.disabled = true;
          try {
            const r = await window.helm.getCommitDiff(group.projectPath, c.sha);
            if (!r?.ok) {
              showToast(`Couldn't load the diff: ${r?.error || "unknown reason"}`);
              return;
            }
            openDiffViewer(
              { taskId: c.sha, title: c.subject || c.shortSha },
              {
                source: "commit",
                projectPath: group.projectPath,
                commits: [{ sha: c.sha, subject: c.subject || "" }],
                text: r.text,
                truncated: !!r.truncated,
                shown: 1,
                total: 1,
              }
            );
          } finally {
            diffBtn.disabled = false;
          }
        });
        actions.append(diffBtn);

        // Dismiss last, and named for what it does. See the "Seen all" comment above.
        const ackBtn = document.createElement("button");
        ackBtn.type = "button";
        ackBtn.className = "text-btn";
        ackBtn.textContent = "Seen";
        ackBtn.title = "Stop showing this commit, and everything older than it. Records only that you have seen it - it does not claim anything was reviewed.";
        ackBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          ackBtn.disabled = true;
          const r = await window.helm.acknowledgeCommit(group.projectPath, c.sha);
          if (!r?.ok) {
            ackBtn.disabled = false;
            showToast(r?.error || "Couldn't acknowledge that.");
            return;
          }
          renderReviewPage();
        });
        actions.append(ackBtn);
        body.append(actions);
      };
      if (expanded) {
        loadBody();
      }
      const toggle = () => {
        const open = reviewExpanded.has(key);
        if (open) {
          reviewExpanded.delete(key);
        } else {
          reviewExpanded.add(key);
          loadBody();
        }
        body.hidden = open;
        el.classList.toggle("rev-open", !open);
      };
      line.addEventListener("click", toggle);
      line.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      el.append(body);
      frag.append(el);
    }
  }

  if (tally.total === 0 && skipped.length === 0 && unboundGroups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "When something moves to review on the Jot board, it lands here with its evidence and test steps.";
    frag.append(empty);
  }

  page.replaceChildren(frag);

  // Badge on the subnav: the count that actually needs him, not the total - a
  // total would nag about work that is already settled.
  //
  // Computed WITHOUT the project chip OR the work/private focus, unlike the page's own tally above.
  // The badge is a global signal; if it followed either, a view choice here would quietly shrink it
  // and keep it shrunk (see paintReviewBadge). The repo filter is still applied - that is a decision
  // about what belongs in review, not a way of looking at it.
  paintReviewBadge(reviewTallyFromRows(visibleReviewRows(allRows, { ignoreProjectFilter: true, ignoreDomainFilter: true })));
}

// How many review rows actually need him: the count that raises the subnav badge.
// Not the total - a total would nag about work that is already settled.
//
// `incomplete` counts too. It was omitted once, which meant the case the comment
// below calls "the more alarming" - a record EXISTS, so something claims to be
// reviewed, but the claim is inadmissible - raised no badge at all. Under-flagging an
// attention signal is the failure mode the captain explicitly rejects. Unconfirmed counts
// for the same reason: a record claiming done whose own checks have not passed is
// something he needs to know about.
function reviewAttentionCount(tally) {
  const t = tally || {};
  return (t.judgment || 0) + (t.unrecorded || 0) + (t.incomplete || 0) + (t.unconfirmed || 0);
}

/**
 * Paint the subnav's review badge.
 *
 * Split out of renderReviewPage because it used to BE the last statement of it - so
 * the number only existed after you had already opened the page you were meant to be
 * nudged towards (the captain: "siffran över review syns inte förrän man öppnar review").
 * An attention signal that requires you to look first is not one.
 *
 * Pass a tally to paint, or nothing to fetch one.
 */
async function paintReviewBadge(tally = null) {
  const badge = document.getElementById("reviewBadge");
  if (!badge) {
    return;
  }
  let t = tally;
  if (!t) {
    try {
      // A COUNT can be a few seconds old; recomputing costs a git spawn per project in
      // the main process (up to 2 seconds, measured) and this runs on a 60s tick.
      const res = await window.helm.listReviews({ maxAgeMs: 20_000 });
      // From the rows the page would SHOW, like the page and the widget - not res.tally,
      // which counts the whole queue. The page passes its own filtered tally in, so a badge
      // that fetched its own unfiltered one changed value depending on which surface had
      // painted it last (task daa4245f).
      //
      // But NOT through the project chip OR the work/private focus. Making the surfaces agree also
      // made the subnav badge inherit a filter set on another page: clicking one project (or one
      // domain) on the Review page left the badge counting only that slice, with nothing on screen
      // to say so and no reset until the app restarted. Under-flagging an attention signal is the
      // failure the captain has explicitly rejected, and a global badge is the wrong place to honour a
      // local view choice. The repo filter IS honoured - that one is a standing decision about what
      // belongs in review at all, not a way of looking at it. Raised by review, 2026-08-04 (project
      // chip) and 2026-08-09 (domain focus).
      t = res?.rows ? reviewTallyFromRows(visibleReviewRows(res.rows, { ignoreProjectFilter: true, ignoreDomainFilter: true })) : res?.tally || null;
    } catch {
      return; // leave whatever is there rather than clearing a real count on a hiccup
    }
  }
  const n = reviewAttentionCount(t);
  badge.textContent = n > 0 ? String(n) : "";
  badge.classList.toggle("hidden", n === 0);
}

// --- Scheduled prompts (task 7d9d2188) ---
// A caret beside the send button, the way Slack schedules a message: queue this
// prompt for later instead of sending it now. The headline option is "at quota
// reset", because that is the actual case - the quota runs out mid-job and the
// prompt you want to send is "fortsätt".
function scheduleSendMenu(anchor, pane, promptText, sendControls) {
  const text = (promptText || "").trim();
  if (!text) {
    showToast("Write the prompt first, then schedule it.");
    return;
  }
  if (!pane.cwd) {
    showToast("Pick a folder for this session first.");
    return;
  }
  const now = Date.now();
  const mkItem = (label, when) => ({
    label,
    onClick: async () => {
      const res = await window.helm.addScheduledPrompt({
        prompt: text,
        cwd: pane.cwd,
        resumeSessionId: pane.sessionId || pane.cliSessionId || null,
        model: sendControls?.model || "",
        effort: sendControls?.effort || "",
        when,
      });
      if (!res?.ok) {
        showToast(`Couldn't schedule: ${res?.error || "unknown"}`);
        return;
      }
      showToast(`Queued ${res.entry.label}.`);
      if (sendControls?.clear) {
        sendControls.clear();
      }
      renderScheduledPromptBar();
    },
  });
  const rect = anchor.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 4, [
    mkItem("Send when quota resets", "quota-reset"),
    { sep: true },
    mkItem("Send in 1 hour", now + 60 * 60 * 1000),
    mkItem("Send in 3 hours", now + 3 * 60 * 60 * 1000),
    mkItem("Send tomorrow 08:00", (() => {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return d.getTime();
    })()),
  ]);
}

// A thin bar listing what's queued, so a scheduled prompt is never invisible.
/** Which session a queued prompt will resume, in the id the panes use. */
function scheduledPromptSession(p) {
  return p?.resumeSessionId || null;
}

/** One queued-prompt row: the clock, what it is waiting for, the prompt, and Cancel. */
function scheduledPromptRowEl(p, quotaLimited, onChanged) {
  const row = document.createElement("div");
  row.className = "sched-row";
  const clock = document.createElement("span");
  clock.className = "sched-clock";
  clock.textContent = "⏱";
  const label = document.createElement("span");
  label.className = "sched-label";
  // Overdue + waiting on quota is a real state, not a bug: it is parked until
  // the window actually lifts (the queue re-checks rather than burning it).
  const state = p.overdue && p.waitForQuota && quotaLimited ? "waiting for quota" : p.overdue ? "sending…" : p.label;
  label.textContent = `${state} · ${p.prompt.length > 60 ? p.prompt.slice(0, 60) + "…" : p.prompt}`;
  label.title = p.prompt;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "text-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", async () => {
    await window.helm.cancelScheduledPrompt(p.id);
    onChanged();
  });
  row.append(clock, label, cancel);
  return row;
}

/**
 * A scheduled prompt that FAILED to reach the model, shown where its queue row used to be.
 *
 * "scheduled meddelande on token reset skickades aldrig, de bara försvann" (the captain, task
 * a797eb69). The row left the queue the instant the process was spawned, and the run's own
 * events went to a launchId no pane listens for - so a prompt fired into a still-spent quota,
 * or resumed against a session the CLI could not find, ended as a silent success. This is the
 * row that says otherwise, and it stays until dismissed: a notice that ages out would be
 * missed exactly when he was away, which is the whole reason to schedule a prompt.
 */
function failedScheduledPromptRowEl(p, onChanged) {
  const row = document.createElement("div");
  row.className = "sched-row sched-failed";
  const icon = document.createElement("span");
  icon.className = "sched-clock";
  icon.textContent = "⚠";
  const label = document.createElement("span");
  label.className = "sched-label";
  const what = p.prompt.length > 45 ? p.prompt.slice(0, 45) + "…" : p.prompt;
  label.textContent = `never sent · ${what} — ${p.error || "the run produced no reply"}`;
  label.title = `${p.prompt}\n\n${p.error || ""}`;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "text-btn";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", async () => {
    await window.helm.acknowledgeScheduledPrompt(p.id);
    onChanged();
  });
  row.append(icon, label, dismiss);
  return row;
}

/**
 * The queued prompts, shown WHERE THEY WILL FIRE.
 *
 * "Scheduled meddelanden borde synas i en kö här ... Istället för globalt längst ner"
 * (the captain, task c2aae246, arrow pointing just above a session's prompt box). A queue parked
 * at the bottom of the window told him something was scheduled but not which conversation
 * it belonged to - and with several sessions open that is the only thing worth knowing.
 *
 * So each pane shows the prompts queued for ITS session, right above the composer they will
 * be typed into. The global bar keeps exactly the ones no open pane is showing - prompts for
 * a session that is not on screen. Nothing is hidden by the move; it is only filed where it
 * means something.
 */
function paneScheduledQueue(pane, pending) {
  const sid = pane?.cliSessionId || pane?.sessionId;
  if (!sid) {
    return [];
  }
  return (pending || []).filter((p) => {
    const target = scheduledPromptSession(p);
    return target && (target === sid || target === pane.sessionId || target === pane.cliSessionId);
  });
}

async function renderScheduledPromptBar() {
  const host = document.getElementById("scheduledPromptBar");
  const res = await window.helm.listScheduledPrompts();
  const pending = res?.ok ? res.pending || [] : [];
  // A failure is filed exactly like a queue row - beside the session it was meant for - so it
  // appears where the row he queued used to be rather than in some separate notifications list.
  const failed = res?.ok ? res.failed || [] : [];
  const quotaLimited = !!res?.quotaLimited;

  // Per-pane queues first, so the global bar knows what is already accounted for.
  const shownInPane = new Set();
  panes.forEach((pane, index) => {
    const mine = paneScheduledQueue(pane, pending);
    const mineFailed = paneScheduledQueue(pane, failed);
    mine.forEach((p) => shownInPane.add(p.id));
    mineFailed.forEach((p) => shownInPane.add(p.id));
    const box = document.querySelector(`.pane[data-pane="${index}"] .pane-sched-queue`);
    if (!box) {
      return;
    }
    box.replaceChildren();
    box.classList.toggle("hidden", mine.length === 0 && mineFailed.length === 0);
    // Failures first: one is a thing that already went wrong, the others are still waiting.
    for (const p of mineFailed) {
      box.append(failedScheduledPromptRowEl(p, () => renderScheduledPromptBar()));
    }
    for (const p of mine) {
      box.append(scheduledPromptRowEl(p, quotaLimited, () => renderScheduledPromptBar()));
    }
  });

  if (!host) {
    return;
  }
  // What is left: queued for a session no open pane is showing. Keeping these is the
  // difference between moving the queue and losing half of it.
  const orphans = pending.filter((p) => !shownInPane.has(p.id));
  const orphanFailures = failed.filter((p) => !shownInPane.has(p.id));
  host.replaceChildren();
  host.classList.toggle("hidden", orphans.length === 0 && orphanFailures.length === 0);
  // A failure for a session that is not open still has to be seen - that is the case where he
  // was away, which is when a scheduled prompt matters most.
  for (const p of orphanFailures) {
    host.append(failedScheduledPromptRowEl(p, () => renderScheduledPromptBar()));
  }
  for (const p of orphans) {
    host.append(scheduledPromptRowEl(p, quotaLimited, () => renderScheduledPromptBar()));
  }
}

// --- Repo scripts (task 8bfae7a0) ---
// Run a bound repo's package.json scripts (build, release, test...) straight
// from the pane, with NO model turn - the point is to not spend tokens on
// something a plain command does. Output streams into an overlay so a long
// build is watchable, and can be stopped.
let repoScriptRunSeq = 0;

/**
 * Append styled output to the run panel.
 *
 * Built from text nodes and spans, never innerHTML: this is a build tool's stdout,
 * i.e. text Helm did not write, and it can contain anything - so it must never be
 * able to become markup. An unstyled segment is appended as a bare text node so a
 * plain log stays one node instead of thousands of spans.
 */
function appendScriptSegments(out, segments) {
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    if (!seg || !seg.text) {
      continue;
    }
    const style = seg.style || {};
    if (!style.color && !style.bold && !style.dim && !style.underline) {
      frag.append(document.createTextNode(seg.text));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = seg.text;
    if (style.color) {
      span.style.color = style.color;
    }
    if (style.bold) {
      span.style.fontWeight = "700";
    }
    if (style.dim) {
      span.style.opacity = "0.65";
    }
    if (style.underline) {
      span.style.textDecoration = "underline";
    }
    frag.append(span);
  }
  out.append(frag);
}

function showScriptRunOverlay(cwd, script) {
  const runId = `script-${++repoScriptRunSeq}-${Date.now()}`;
  const overlay = document.createElement("div");
  overlay.className = "script-run-overlay";
  const box = document.createElement("div");
  box.className = "script-run-box";

  const head = document.createElement("div");
  head.className = "script-run-head";
  const title = document.createElement("span");
  title.className = "script-run-title";
  title.textContent = `npm run ${script}`;
  const where = document.createElement("span");
  where.className = "script-run-cwd";
  where.textContent = cwd;
  const status = document.createElement("span");
  status.className = "script-run-status running";
  status.textContent = "starting…";
  head.append(title, where, status);

  const out = document.createElement("pre");
  out.className = "script-run-out";
  // Echo the command the way a terminal does, BEFORE anything runs. The captain's
  // report was "terminalen är inte tydlig, vet inte ens om den funkar" - the box
  // opened black and empty, and a script that prints nothing for thirty seconds
  // is indistinguishable from one that never started.
  out.textContent = `> npm run ${script}\n  in ${cwd}\n\n`;

  const actions = document.createElement("div");
  actions.className = "script-run-actions";
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "text-btn";
  stopBtn.textContent = "Stop";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "text-btn";
  copyBtn.textContent = "Copy output";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "text-btn";
  closeBtn.textContent = "Close";
  actions.append(stopBtn, copyBtn, closeBtn);

  box.append(head, out, actions);
  overlay.append(box);
  document.body.append(overlay);

  let unsubscribe = null;
  let finished = false;

  // A ticking elapsed time is the cheapest possible proof of life: even a script
  // that prints nothing shows a number going up, which answers "is this working?"
  // without the user having to know anything about the script.
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  const ticker = setInterval(() => {
    if (!finished) {
      status.textContent = `running… ${elapsed()}s`;
    }
  }, 1000);
  const close = () => {
    if (!finished) {
      // Closing while it runs would orphan the process - stop it first.
      window.helm.stopRepoScript(runId);
    }
    clearInterval(ticker);
    unsubscribe?.();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
    }
  };
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    await window.helm.stopRepoScript(runId);
  });
  copyBtn.addEventListener("click", () => {
    navigator.clipboard?.writeText(out.textContent || "");
    showToast("Output copied.");
  });
  // Clicks on the backdrop (not the box) close it, like the image lightbox.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
    }
  });

  unsubscribe = window.helm.onRepoScriptEvent((payload) => {
    if (payload.runId !== runId) {
      return;
    }
    if (payload.kind === "out") {
      const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
      // Segments come pre-parsed from the main process (see lib/ansi.js). Before
      // this, raw stdout went straight in, so any tool that colours its output -
      // Vite, most build tools - rendered its colour instructions as literal junk
      // with the escape byte drawn as a box. The captain hit it on `npm run dev`.
      appendScriptSegments(out, payload.segments || [{ text: payload.text || "", style: {} }]);
      if (atBottom) {
        out.scrollTop = out.scrollHeight;
      }
      return;
    }
    if (payload.kind === "done") {
      finished = true;
      clearInterval(ticker);
      stopBtn.disabled = true;
      const okRun = payload.code === 0 && !payload.error;
      const secs = elapsed();
      status.className = "script-run-status " + (okRun ? "ok" : "fail");
      // Say the OUTCOME in words. "exit 1" is a number he has to look up; the
      // exit code stays, in brackets, for when it matters.
      status.textContent = payload.error
        ? `couldn't run it - ${payload.error}`
        : okRun
          ? `done in ${secs}s`
          : `failed after ${secs}s [exit code ${payload.code}]`;
      // Close the transcript too, so scrolling to the bottom of a long build
      // tells you how it ended without looking back up at the header. With the
      // command echoed on open and the outcome written here, the box always has
      // a beginning and an end - it can no longer be the blank panel the captain saw.
      // append, never `textContent +=` - that flattens every styled span the run
      // just produced into a single plain text node.
      out.append(document.createTextNode(`\n> ${status.textContent}\n`));
      out.scrollTop = out.scrollHeight;
      closeBtn.textContent = "Close";
    }
  });

  window.helm.runRepoScript(cwd, script, runId).then((res) => {
    if (!res?.ok) {
      finished = true;
      clearInterval(ticker);
      stopBtn.disabled = true;
      status.className = "script-run-status fail";
      status.textContent = res?.error || "couldn't start";
      out.append(document.createTextNode(`${status.textContent}\n`));
    }
  });
}

/**
 * A "Scripts" pill for a pane whose folder has a package.json. Returns null when
 * there is nothing to offer, so the control simply doesn't appear.
 */
async function repoScriptsPill(cwd) {
  if (!cwd) {
    return null;
  }
  const res = await window.helm.listRepoScripts(cwd);
  if (!res?.ok || !res.scripts?.length) {
    return null;
  }
  const btn = document.createElement("button");
  btn.className = "meta-pill";
  btn.type = "button";
  btn.dataset.hasMenu = "1";
  btn.textContent = "Scripts";
  btn.title = `${res.scripts.length} script${res.scripts.length === 1 ? "" : "s"} in ${res.name || "package.json"} - runs directly, no model turn`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom + 4,
      // Show the COMMAND beside the name. "dist" or "release" says nothing about
      // what is about to run on his machine; the actual command does.
      res.scripts.map((s) => ({
        label: s.name,
        hint: s.command.length > 46 ? s.command.slice(0, 45) + "…" : s.command,
        onClick: () => showScriptRunOverlay(cwd, s.name),
      }))
    );
  });
  return btn;
}

function relTime(ts) {
  if (!ts) {
    return "unknown";
  }
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.round(hr / 24)}d ago`;
}

// Short deadline label for the sidebar chip, or "" when the deadline is too
// far off to be worth showing (matches sessions.js's 7-day deadlineBoost
// cutoff — beyond that it doesn't affect sorting, so it shouldn't clutter
// the row either). null/non-number → "".
function deadlineChipText(ms) {
  if (typeof ms !== "number") {
    return "";
  }
  const DAY = 24 * 60 * 60 * 1000;
  const msLeft = ms - Date.now();
  if (msLeft < 0) {
    return "overdue";
  }
  if (msLeft < DAY) {
    return "due today";
  }
  const days = Math.round(msLeft / DAY);
  if (days <= 7) {
    return `due in ${days}d`;
  }
  return "";
}

function sortByAttention(list) {
  return [...list].sort((a, b) => {
    const s = (b.attentionScore || 0) - (a.attentionScore || 0);
    return s !== 0 ? s : b.lastActivityAt - a.lastActivityAt;
  });
}


function sessionById(id) {
  return state.sessions.find((s) => s.sessionId === id);
}

// The session record backing a mate, matched on EITHER id form (mate.sessionId
// is the CLI session id, which is not always equal to session.sessionId).
function sessionForMate(mate) {
  return state.sessions.find((s) => (s.cliSessionId || s.sessionId) === mate.sessionId) || null;
}

// Last-known context size per mate session (keyed on mate.sessionId), refreshed
// each dashboard poll so EVERY first mate can show its context gauge, not only
// the one currently open in a pane (bug bf1ea538).
let contextTokensBySession = {};

// Context-window size for a model: prefer the real window Helm learned for it
// (from the CLI's result events, stored in config.modelContextWindows), fall
// back to the configurable default for a model not yet seen. Turns a token
// estimate into the gauge's %.
function contextWindowForModel(model) {
  const learned = state.config.modelContextWindows || {};
  return (model && learned[model]) || state.config.contextWindowTokens || 1000000;
}

function contextWindowForPane(pane) {
  return contextWindowForModel(sessionById(pane.sessionId)?.model);
}

// state.sessions is only refreshed by the 30s poll / explicit refresh() —
// it does NOT update live as a run streams. Without this, a reply that
// streams in mid-conversation renders against the SESSION's stale
// lastActivityAt, which can still exactly equal an earlier
// acknowledgedSessions timestamp — making wireDoneButtonOnLastReply's
// isAcked check wrongly true and the Done checkmark "follow along" onto a
// brand new reply it was never actually placed on (caught by the captain: "om jag
// sen fortsätter prompta tillkommer nya saker och då ska inte checkmarken
// följa med"). Bumping this the moment new content actually streams in
// invalidates the stale match immediately, without waiting for a poll.
function bumpSessionActivity(sessionId) {
  const session = sessionById(sessionId);
  if (session) {
    session.lastActivityAt = Date.now();
  }
}

// Windows paths compare case-insensitively and regardless of slash direction
// or a trailing separator — normalize both sides before matching. Empty never
// matches (so a session with no cwd isn't mistaken for a rootless orchestrator).
function samePath(a, b) {
  const norm = (p) => (p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

// An orchestrator session is simply one rooted in the meta-home — the
// coordinator root above every code project (see main.js "orchestrator:info").
// Being rooted there IS what makes a session a coordinator rather than project
// work, so that root is the whole signal: no manual "mark as orchestrator", no
// fragile Jot-category-name match. This matches the ephemeral model — an
// orchestrator is how you START a session (fresh, pointed at the meta-home),
// not a durable flag you toggle on a chat. state.orchestratorHome is fetched
// once at startup (falls back to "" until then, so nothing tags early).
// A first-mate (orchestrator) session is one BOUND to an active mate, not
// merely one rooted at the meta-home: the captain can keep personal chats in
// the meta-home dir too, and those must not read as first mates. A brand-new
// mate session binds on its first turn (bindMateSession); until then its pane
// carries isOrchestrator via paneOverrides, so the composer nudge still works.
function isOrchestratorSession(session) {
  if (!session) {
    return false;
  }
  return mateSessionIds.has(session.cliSessionId) || mateSessionIds.has(session.sessionId);
}

// The active first mate a session is bound to, or null. Used to show a session
// as its mate ("first mate X") instead of the prompt-derived title it picks up
// after the first turn - the reason a first-mate session was unrecognizable in
// the needs-you queue.
function firstMateForSession(session) {
  if (!session) {
    return null;
  }
  return mateBySessionId.get(session.cliSessionId) || mateBySessionId.get(session.sessionId) || null;
}

// The second mate a session is bound to (if any), so surfaces like the needs-you
// queue can name it by its fleet name instead of its first-prompt title (2992bcfd).
function secondMateForSession(session) {
  if (!session) {
    return null;
  }
  return secondMateBySessionId.get(session.cliSessionId) || secondMateBySessionId.get(session.sessionId) || null;
}

// The single canonical display name for a session: its durable FLEET name when it
// is a first/second mate, otherwise the prompt-derived session.title. Every
// user-facing surface must route through this so the SAME session never shows two
// different names in two places (bug 953bbafb: the archive-suggestion row in the
// needs-you queue showed the raw prompt title "vad gör den här appen..." while the
// Fleet card showed the fleet name "startup-simulator" for the same session).
function sessionDisplayName(session) {
  if (!session) {
    return "";
  }
  const fm = firstMateForSession(session);
  const sm = fm ? null : secondMateForSession(session);
  return (fm ? fm.name : sm ? sm.name : session.title) || session.title || "";
}

// "Delete" a session from Helm's own view — never touches the desktop
// app's real session files (that would risk destroying real conversation
// history). Purely hides it from the sidebar via config; restorable from
// the Archive page.
// "Remove from Helm" - the ACTION - is gone with the sidebar (the captain: "remove from helm vet jag
// inte ens vad är"). It was a second way to hide a session, distinct from archiving for reasons
// that had stopped being true, and unexplainable is a fair verdict on it. isHiddenFromHelm below
// stays, and so does restoreToHelm: anything already hidden must remain hidden, and remain
// restorable from the Archive page.

async function restoreToHelm(session) {
  const hidden = (state.config.hiddenSessions || []).filter((id) => id !== session.sessionId);
  state.config = await window.helm.setConfig({ hiddenSessions: hidden });
  await refresh();
  refreshArchivePageIfVisible();
}

// "Removed from Helm" (hiddenSessions) is a permanent hide, DISTINCT from
// archived (config.archivedSessions, applied as isArchived in readAllSessions).
// Every user-facing / attention derivation that reads state.sessions must honor
// it, or a removed session leaks back into some view (the sidebar filtered it,
// but Fleet Direct, the dashboard queues, and the taskbar badge did not - they
// drifted). Keyed on sessionId, matching what was written into config.hiddenSessions while the
// "Remove from Helm" action existed (removed 2026-08-04 - the entries it wrote are still honoured
// here and still restorable from the Archive page). This is the single predicate; do not re-inline
// the membership check.
function isHiddenFromHelm(session) {
  return (state.config.hiddenSessions || []).includes(session.sessionId);
}

// Analysis/Settings/Archive are pull-based - re-rendered on tab switch - so a row restored or
// unarchived while you are ON the Archive page would otherwise sit there stale until you left and
// came back. (This comment used to open with "refresh() only ever re-renders the sidebar", which
// stopped being true when the sidebar was removed; the function is still needed, its old reason
// was not.)
function refreshArchivePageIfVisible() {
  if (!document.getElementById("archivePage").classList.contains("hidden")) {
    renderArchivePage();
  }
}

// Real archiving. This comment used to say it "flips isArchived in the desktop app's
// OWN local_*.json file", and that has not been true since Helm took over its own
// session index: applySessionArchive writes config.archivedSessions, in Helm's config,
// and never touches Anthropic's session files. The stale version mattered - it is why
// "Remove from Helm" looked like the only way to hide a Helm-CREATED session (those have
// no desktop metadata at all), when archiving covers every session either way.
// Always a direct response to an explicit click — either the manual context
// menu action, or the user clicking a suggested-archive pill — never fired
// on a timer or any other unattended trigger.
async function archiveSession(session) {
  const res = await window.helm.archiveSession(session.sessionId, true);
  if (!res.ok) {
    console.error("[helm] archive failed:", res.error);
    showToast(`Couldn't archive "${session.title}": ${res.error}`);
    return;
  }
  refresh();
}

// Below this many transcript turns, a session is too thin to have durable
// cross-session knowledge worth a handoff - archiving one anyway just spends a
// summarize call and drops a "no task work was done" entry into DECISIONS.md
// (the captain caught a test session polluting it that way). ~2 exchanges.
const HANDOFF_MIN_TURNS = 4;

// Total turns in a session's transcript (shown + older hidden), or 0 when it
// can't be read. Its own function so the thin-session handoff guard is testable
// (window.helm.* bridge methods aren't reassignable in a test; a top-level fn
// is). 0 means "unknown" - callers fail open.
async function sessionTurnCount(session) {
  try {
    const t = await window.helm.getTranscript({
      cliSessionId: session.cliSessionId || session.sessionId,
      sessionId: session.sessionId,
    });
    return (t?.turns?.length || 0) + (t?.hiddenCount || 0);
  } catch {
    return 0;
  }
}

// Ask which topic a non-rooted session's handoff belongs to, when the classifier
// could not decide. Resolves the chosen slug, or null if dismissed.
//
// Reuses the app's own context-menu popup rather than a native dialog: same
// reason dropdownPill does (Chromium's native popups render unreadable in this
// Electron build), and it keeps the picker looking like every other menu.
function pickHandoffTopic({ existing = [], suggestion = "general", error = null, nearMiss = null }, title = "") {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    // `nearMiss` is the topic the matcher WOULD have reused on its own. Naming the
    // consequence matters here: picking it replaces whatever that topic currently
    // holds, and doing that silently is what buried the captain's training notes under a
    // leadership handoff. So it is listed first, with what it costs.
    const items = [
      {
        label: nearMiss
          ? `"${title}" looks like it might belong to an existing topic - which one?`
          : `Which topic should the handoff for "${title}" go under?`,
        hint: error || (nearMiss ? `guessed "${nearMiss}" from the wording alone - check it` : ""),
        onClick: null,
      },
      { sep: true },
      ...(nearMiss ? [{ label: nearMiss, hint: "the guess - REPLACES what it holds", onClick: () => done(nearMiss) }] : []),
      ...existing
        .filter((slug) => slug !== nearMiss)
        .map((slug) => ({ label: slug, hint: "existing - replaces its contents", onClick: () => done(slug) })),
      { sep: true },
      {
        label: `New topic: ${suggestion}`,
        hint: nearMiss ? "keeps both subjects separate" : "from the session name",
        onClick: () => done(suggestion),
      },
      { label: "Don't save a handoff", danger: true, onClick: () => done(null) },
    ];
    showContextMenu(Math.round(window.innerWidth / 2) - 140, Math.round(window.innerHeight / 3), items);
    // The menu closes on outside click/Escape without telling us; treat that as
    // "dismissed" rather than leaving the archive hanging forever.
    const poll = setInterval(() => {
      if (document.getElementById("contextMenu")?.classList.contains("hidden")) {
        clearInterval(poll);
        done(null);
      }
    }, 200);
  });
}

// THE ONE PLACE that saves a handoff. Both callers (archive-with-handoff, and the
// bulk child handoff during a first-mate retire) go through here so the
// "classifier could not pick a topic" case is handled the same way in both -
// filing one of them under a title-derived one-off while the other asks is
// exactly how the subject gets split across two files.
//
// `ask: false` is for the unattended bulk path, where blocking on a menu would
// stall a batch: it takes the suggestion knowingly and reports that it guessed.
// Note which way that falls for a near-miss: `suggestion` is the NEW slug, not the
// existing topic the matcher was drawn to. Unattended, a fresh file is the safe
// error - it can be merged later by hand, whereas reusing the wrong topic replaces
// notes that cannot be reconstructed.
async function saveHandoffResolvingTopic(session, text, { ask = true } = {}) {
  let res = await window.helm.saveHandoff(session.cwd, text, session.title);
  if (!res || !res.needsCategory) {
    return res;
  }
  const chosen = ask ? await pickHandoffTopic(res, session.title) : res.suggestion;
  if (!chosen) {
    return { ok: false, error: "no topic was chosen", cancelled: true };
  }
  const second = await window.helm.saveHandoff(session.cwd, text, session.title, chosen);
  if (second?.ok && !ask) {
    second.guessedTopic = true;
  }
  return second;
}

// Archive WITH a last-effort handoff: give the session one final turn to
// summarize itself, save that to its project's DECISIONS.md (a durable store,
// where a future session will actually read it), THEN archive. Unlike retire
// (which continues under a fresh mate), archiving means "done here", so the
// handoff lands in files rather than seeding a successor. A failed/empty
// summary still archives - the save is best-effort, never a blocker. Only
// offered when the session has a project cwd to write the handoff into.
async function archiveWithHandoff(session) {
  // Thin-session guard: skip the whole handoff (no summarize call, no
  // DECISIONS.md write) for a throwaway/test session. FAIL OPEN - a 0 (unknown)
  // count falls through and summarizes as before rather than dropping a real
  // handoff.
  const turnCount = await sessionTurnCount(session);
  if (turnCount > 0 && turnCount < HANDOFF_MIN_TURNS) {
    showToast(`"${session.title}" was too short for a handoff - archived without one.`);
    archiveSession(session);
    return;
  }
  const busy = showBusyToast(`Saving handoff for "${session.title}"…`);
  setPaneBusyUIRaw(focusedPaneIndex, `Saving handoff for "${session.title}"…`);
  // Key the busy flag on the SAME id the fleet/direct node checks against - the
  // node model's sessionId is `cliSessionId || sessionId` (see fleet branch
  // builder), not the raw Helm sessionId. Keying by session.sessionId meant the
  // on-card spinner never lit for a second mate whose cliSessionId differs from
  // its sessionId (it did for a first-mate retire, which keys by mateId on both
  // sides) - exactly the "no spinner on the card when archiving a 2nd mate" bug.
  const busyKey = session.cliSessionId || session.sessionId;
  handoffBusyIds.add(busyKey);
  // FORCE the repaint: handoffBusyIds is not part of dashboardFleetFingerprint,
  // so a plain (fingerprint-gated) refresh sees "nothing changed" and never
  // rebuilds the fleet slot - the card's markCardHandoffBusy would never run
  // and the on-card spinner never appears. (First-mate retire already forces
  // its refresh, which is why it showed a spinner and archive didn't.)
  refreshDashboardIfVisible({ force: true });
  let saved = false;
  let savedTopic = null;
  let savedTopicIsNew = false;
  try {
    const res = await summarizeSession(session);
    if (res && res.text) {
      // HANDOFF.md (overwrite, latest-only) - NOT DECISIONS.md (append), which
      // this used to bloat with transient session narrative (the captain 2026-07-14).
      const cap = await saveHandoffResolvingTopic(session, res.text.trim());
      saved = !!(cap && cap.ok);
      if (!saved) {
        // Sticky, like the other two handoff failures below: the session is archived
        // either way, so its continuity is gone and cannot be recovered by trying
        // again. That is not something to learn about from a message that fades.
        showNotice(`Handoff save failed for "${session.title}": ${cap?.error || "unknown"}. It was archived anyway, so nothing was written for the next session to read.`);
      } else if (cap.topicKeyed) {
        // Name the topic it was filed under - the category is chosen for you, so
        // it must never be invisible (task 663ab4b6).
        savedTopic = cap.category;
        savedTopicIsNew = !!cap.isNew;
      }
    } else if (res && res.error) {
      showNotice(`Couldn't summarize a handoff for "${session.title}": ${res.error}. It was archived anyway, with nothing written for the next session.`);
    }
  } catch (err) {
    showNotice(`Handoff failed for "${session.title}": ${err.message}. It was archived anyway, with nothing written for the next session.`);
  }
  setPaneBusyUIRaw(focusedPaneIndex, "");
  busy.done();
  handoffBusyIds.delete(busyKey);
  // Force a repaint so the spinner clears even if the archive below no-ops or
  // fails (same fingerprint-gap reason as the add above - the busy id isn't in
  // the fleet fingerprint).
  refreshDashboardIfVisible({ force: true });
  if (saved) {
    // A save is an EVENT worth confirming - which file it landed in, especially for
    // topic saves - so it slides in from the side and waits to be dismissed rather
    // than fading. tone "good" marks it a success, not a warning.
    showNotice(
      savedTopic
        ? `Handoff filed under "${savedTopic}"${savedTopicIsNew ? " (new topic)" : ""}; archiving "${session.title}".`
        : `Handoff saved to HANDOFF.md; archiving "${session.title}".`,
      { tone: "good" }
    );
  }
  archiveSession(session);
}

// THE ONE PLACE that builds an archive menu. Every archive path must go through
// here.
//
// Why it is a single builder and not three similar inline arrays: the topic-keyed
// handoff (task 663ab4b6) was added to one of the three menus only. The other two
// kept gating the handoff option on `session.cwd`, so a session with no project
// folder - exactly the case the feature was built for - was still offered nothing
// but "Archive without a handoff", and its knowledge was dropped silently. The captain
// hit this on 2026-07-28 archiving "Träning och kost (Hevy)". Same shape as the
// eight file writers: one instance fixed, the class assumed closed.
//
// Never re-introduce a `session.cwd` condition around the handoff ITEM. The cwd
// only decides WHERE the handoff lands (repo HANDOFF.md vs a topic-keyed file in
// Helm's own store), never WHETHER it is offered.
//
// `plainArchive` is the caller's own no-handoff archive, so each flow keeps its
// specifics (e.g. the Fleet button's optimistic removal). `after` runs once the
// chosen branch finishes (the Fleet needs to drop its node either way).
/**
 * Is this session NOT rooted in a real project?
 *
 * "Has a cwd" is not the same question, and assuming it was is why the archive menu
 * lied to the captain. His life-domain sessions (training, cycling journal, kombucha) are
 * all rooted at the META-HOME, so they DO have a cwd - the menu therefore promised
 * "Save handoff to HANDOFF.md" while the backend, which checks for the meta-home
 * properly, correctly filed them by topic. The behaviour was right and the label was
 * wrong, which is worse than a plain bug: he concluded the feature was missing.
 *
 * Mirrors isMetaHomeRoot in main.js. Windows paths are case-insensitive and mix
 * separators, so both sides must fold to one form before comparing.
 */
function isNonRootedSession(cwd) {
  if (!cwd) {
    return true;
  }
  const home = state.orchestratorHome;
  if (!home) {
    return false; // not yet known - assume rooted rather than mislabel the other way
  }
  const norm = (p) =>
    String(p)
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(cwd) === norm(home);
}

function archiveMenuItems(session, { plainArchive, after = null, nameInLabel = false }) {
  const named = nameInLabel ? ` "${session.title}"` : "";
  const run = (fn) => async () => {
    await fn();
    if (after) {
      await after();
    }
  };
  return [
    {
      label: `Save handoff ${isNonRootedSession(session.cwd) ? "by topic" : "to HANDOFF.md"} + archive${named}`,
      danger: true,
      onClick: run(() => archiveWithHandoff(session)),
    },
    { label: `Archive${named} without a handoff`, danger: true, onClick: run(plainArchive) },
  ];
}

// Shows the "save a handoff first?" choice for a DELIBERATE single-session
// archive (the "Archive?" pill, the queue approve). NOT used for bulk
// "Archive all" - a per-session summarize there would be N Sonnet calls (see
// its own inline note).
function offerArchiveChoice(x, y, session, plainArchive) {
  showContextMenu(x, y, archiveMenuItems(session, { plainArchive }));
}

// Retire a first mate: a two-option menu (mirrors offerArchiveChoice) so carrying
// the thread over is an explicit choice, not automatic. "Start fresh" retires
// without a handoff - the fresh mate lands on a blank composer, for when you're
// beginning something new. "Carry over" gives the outgoing mate a final
// summarize turn and seeds the successor's composer with it, for continuing the
// same job in clean context. See DECISIONS.md "Retire: carry-over is a choice".
// Three options, not two, because keeping the knowledge and carrying it forward are
// separate wishes (the captain, 2026-08-12: "jag vill inte carry over för jag vill starta en ny
// topic men jag vill fortfarande behålla det vi pratat om den här sessionen"). The middle
// one is the case he says is common and that previously had no button: the outgoing mate
// still writes its durable handoff document, and the successor still starts blank.
//
// Ordered cheapest-to-most, so the destructive-of-context option is not the default target
// of a mis-click, and worded by what you GET rather than by what the code does.
function offerRetireChoice(x, y, mate) {
  showContextMenu(x, y, [
    {
      label: "Retire (start fresh)",
      hint: "No summary. Anything already on disk stays.",
      onClick: () => retireMateClean(mate),
    },
    {
      label: "Retire, keep notes - new topic",
      hint: "Writes the handoff document, next mate starts blank",
      onClick: () => retireMateWithCarryOver(mate, undefined, { carryOver: false }),
    },
    {
      label: "Retire and carry over",
      hint: "Writes it AND seeds the next mate, to continue this thread",
      onClick: () => retireMateWithCarryOver(mate),
    },
  ]);
}

// From the Archive page — flips isArchived back to false so the session
// reappears both in Helm's sidebar and in the real desktop app.
async function unarchiveSession(session) {
  const res = await window.helm.archiveSession(session.sessionId, false);
  if (!res.ok) {
    console.error("[helm] unarchive failed:", res.error);
    showToast(`Couldn't unarchive "${session.title}": ${res.error}`);
    return;
  }
  await refresh();
  refreshArchivePageIfVisible();
}

// ---- Transient toasts and persistent notices -------------------------------
//
// the captain, task 709e4b90: "toasten vid händelser är för snabb och syns inte tillräckligt
// väl - kanske lägga till en andra typ av toast också som kommer fram som en sidoruta
// eller något och som man måste klicka bort, med en kö".
//
// Three separate problems were behind that:
//   1. Every toast was positioned at the same fixed spot, so two at once sat exactly on
//      top of each other and the one underneath was never read at all. They stack now.
//   2. Four seconds is not long enough for a sentence naming a file and a reason, and
//      the timer ran even while he was reading. Longer, and the countdown pauses while
//      the pointer is on it.
//   3. Some of these are not feedback on something he just did - they are EVENTS (a run
//      failed, a setting did not save, a handoff could not be written). A message that
//      disappears on its own is the wrong shape for those, so they get a notice: a card
//      that waits to be dismissed. Under-flagging is the worse failure here.
const TOAST_MS = 7000;
const NOTICE_VISIBLE_MAX = 4;
/** Notices beyond NOTICE_VISIBLE_MAX wait here, newest last, and take a freed slot. */
const noticeQueue = [];

/** The stack toasts live in, so a second one goes BESIDE the first, not over it. */
function toastHost() {
  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    document.body.append(host);
  }
  return host;
}

/** The side column notices live in. */
function noticeHost() {
  let host = document.getElementById("noticeHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "noticeHost";
    host.className = "notice-host";
    document.body.append(host);
  }
  return host;
}

/**
 * A transient message for feedback with no natural home (no pane to write into).
 * Click it to dismiss early; hovering holds it while you read.
 *
 * `showToast(text, { sticky: true })` routes to showNotice instead - the call sites that
 * report an EVENT rather than the result of a click use that, and the flag keeps them
 * one readable word different from the rest.
 */
function showToast(text, opts = {}) {
  if (opts.sticky) {
    return showNotice(text, opts);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  el.title = "Click to dismiss";
  toastHost().append(el);
  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    el.remove();
  };
  const arm = () => {
    timer = setTimeout(remove, opts.ms || TOAST_MS);
  };
  el.addEventListener("click", remove);
  el.addEventListener("pointerenter", () => clearTimeout(timer));
  el.addEventListener("pointerleave", arm);
  arm();
  return { dismiss: remove };
}

/**
 * A persistent notice in the side column: it stays until dismissed, and several stack
 * rather than replacing one another. Past NOTICE_VISIBLE_MAX the rest queue and move up
 * as slots free, so a burst of failures cannot bury the app behind its own warnings.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {"warn"|"info"|"good"} [opts.tone] warn (default) draws the accent stripe;
 *   good marks a success (e.g. a handoff that saved).
 * @param {Array<{label: string, onClick: Function}>} [opts.actions] buttons on the card.
 *   An action dismisses the notice after running, since it has been dealt with.
 */
function showNotice(text, opts = {}) {
  const entry = { text, opts };
  // A card animating out (.notice-leaving) no longer occupies a slot, so it must not
  // count toward the visible max or a new notice would be wrongly queued behind it.
  if (noticeHost().querySelectorAll(".notice:not(.notice-leaving)").length >= NOTICE_VISIBLE_MAX) {
    noticeQueue.push(entry);
    paintNoticeQueueCount();
    return { dismiss: () => {
      const i = noticeQueue.indexOf(entry);
      if (i >= 0) {
        noticeQueue.splice(i, 1);
        paintNoticeQueueCount();
      }
    } };
  }
  return mountNotice(entry);
}

function mountNotice({ text, opts }) {
  const host = noticeHost();
  const el = document.createElement("div");
  el.className = `notice notice-${
    opts.tone === "good" ? "good" : opts.tone === "info" ? "info" : "warn"
  }`;

  const body = document.createElement("div");
  body.className = "notice-text";
  body.textContent = text;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "notice-close";
  close.textContent = "×";
  close.title = "Dismiss";

  const dismiss = () => {
    if (el.classList.contains("notice-leaving")) {
      return; // already flying out; don't drain the queue twice
    }
    // Free slot and drain the queue SYNCHRONOUSLY so the next notice appears at
    // once - only the old card's physical removal waits for its exit animation.
    const next = noticeQueue.shift();
    paintNoticeQueueCount();
    if (next) {
      mountNotice(next);
    }
    paintNoticeDismissAll();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.remove();
      return;
    }
    // Fly the card back out to the right, then remove it once the animation ends.
    el.classList.add("notice-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);

  const head = document.createElement("div");
  head.className = "notice-head";
  head.append(body, close);
  el.append(head);

  if (opts.actions?.length) {
    const row = document.createElement("div");
    row.className = "notice-actions";
    for (const action of opts.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "text-btn";
      btn.textContent = action.label;
      btn.addEventListener("click", async () => {
        try {
          await action.onClick?.();
        } finally {
          dismiss();
        }
      });
      row.append(btn);
    }
    el.append(row);
  }
  // Newest on top: an event that just happened is the one being looked for.
  host.prepend(el);
  paintNoticeDismissAll();
  return { dismiss };
}

/** "+N waiting" under the stack, so a queued notice is never silently held back. */
function paintNoticeQueueCount() {
  const host = noticeHost();
  let el = host.querySelector(".notice-queued");
  if (noticeQueue.length === 0) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "notice-queued";
    host.append(el);
  }
  el.textContent = `+${noticeQueue.length} more waiting`;
}

/** One button to clear a pile, added only once there IS a pile. */
function paintNoticeDismissAll() {
  const host = noticeHost();
  const shown = host.querySelectorAll(".notice:not(.notice-leaving)").length;
  let el = host.querySelector(".notice-clear");
  if (shown < 2) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("button");
    el.type = "button";
    el.className = "notice-clear text-btn";
    el.textContent = "Dismiss all";
    el.addEventListener("click", () => {
      noticeQueue.length = 0;
      host.querySelectorAll(".notice").forEach((n) => n.remove());
      paintNoticeQueueCount();
      paintNoticeDismissAll();
    });
  }
  host.append(el); // keep it last, below the stack
}

// A PERSISTENT toast with a spinner, for a multi-second op (a handoff
// summarize) triggered from anywhere - including the dashboard, where the
// per-pane busy text isn't visible, so retire/archive-with-handoff used to look
// like nothing happened. Returns { done } to remove it. Never auto-dismisses.
function showBusyToast(text) {
  const el = document.createElement("div");
  el.className = "toast toast-busy";
  const spin = document.createElement("span");
  spin.className = "toast-spin";
  const label = document.createElement("span");
  label.textContent = text;
  el.append(spin, label);
  // In the same stack as the transient ones: a busy toast used to be pinned to the same
  // fixed spot, so an ordinary toast arriving mid-operation covered it completely.
  toastHost().append(el);
  let removed = false;
  return {
    update: (t) => {
      if (!removed) {
        label.textContent = t;
      }
    },
    done: () => {
      if (!removed) {
        removed = true;
        el.remove();
      }
    },
  };
}

// ============================== Context menu ==============================

function closeContextMenu() {
  document.getElementById("contextMenu").classList.add("hidden");
}

// Context-size + quota popover, opened from the composer's context gauge —
// the combined readout the captain wanted (like Claude Code: click the context
// meter, see both context and quota). Only one is ever open; a second click
// or an outside click closes it (closeContextPopover is wired into the
// document click handler alongside closeContextMenu).
function closeContextPopover() {
  document.querySelectorAll(".context-popover").forEach((el) => el.remove());
}

// Pure quota display model (task 1975093d: "Token usage often shows 0% in the
// quota tab"). Root cause: the code read `q.utilization`, but the real
// rate_limit_info payload has NO utilization field - it carries { status,
// resetsAt, rateLimitType, overage... }. So `q.utilization || 0` was always 0 ->
// a fabricated "0% used". (Almost certainly an API schema change: utilization was
// dropped in favour of status + resetsAt.) Fix: report the REAL signal we get -
// the limit status + when the window resets - and only show a % when utilization
// is genuinely a finite number (future-proof if it comes back). Pure + nowMs-
// injected so it's unit-testable.
// Human label for a rate-limit window. The CLI's rateLimitType enum grew beyond
// five_hour/seven_day to per-model weekly windows (seven_day_opus/sonnet) and
// overage - the same windows the Claude desktop usage panel lists as separate
// rows (bc6786c7). Kept as its own fn so the chip, the panel, and tests agree.
function quotaWindowLabel(type) {
  switch (type) {
    case "five_hour":
      return "5-hour limit";
    case "seven_day":
      return "Weekly · all models";
    case "seven_day_opus":
      return "Weekly · Opus";
    case "seven_day_sonnet":
      return "Weekly · Sonnet";
    case "overage":
      return "Overage";
    default:
      return type ? String(type).replace(/_/g, " ") : "usage limit";
  }
}

function quotaReadout(q, nowMs) {
  if (!q) {
    return null;
  }
  const typeLabel = quotaWindowLabel(q.rateLimitType);
  const util = typeof q.utilization === "number" && isFinite(q.utilization) ? q.utilization : null;
  // Reset countdown from resetsAt (unix SECONDS), and staleness. A rate-limit
  // reading describes ONE window that ends at resetsAt; once resetsAt is in the
  // past, that window has elapsed and its status/usage no longer describe reality
  // (bug bc6786c7: a 2-day-old persisted reading showed "5h limit · OK" while the
  // quota was actually spent). Treat a past-reset reading as STALE - we don't know
  // the current window's state, so don't claim "OK".
  let resetText = null;
  let stale = false;
  if (typeof q.resetsAt === "number" && q.resetsAt > 0) {
    const secs = Math.round(q.resetsAt - nowMs / 1000);
    if (secs > 0) {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      resetText = h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
    } else {
      stale = true;
    }
  }
  if (stale) {
    return {
      stale: true,
      hasPct: false,
      pct: null,
      level: "stale",
      label: typeLabel,
      chipText: `${typeLabel} · —`,
      barValueText: "no current reading",
      // Tooltips stay to the point: the limit and its reset, nothing else (the captain
      // 2026-07-22 - "jag vill bara veta kvot och när det resetas"). A stale
      // window has no live reset to show, so say only that it needs a fresh read.
      title: `${typeLabel} · no current reading (window elapsed)`,
    };
  }
  if (util !== null) {
    const pct = Math.round(util * 100);
    // Severity for prioritizing: red only when the window is effectively spent
    // (>=90%) or the API says rejected; amber when it's tightening (>=70%);
    // neutral below. Matches the mock the captain approved (18% neutral, 86% amber,
    // 100% red) - deliberately less alarmist than a plain >=80 red would be.
    const level = q.status === "rejected" || pct >= 90 ? "hot" : pct >= 70 ? "warm" : "ok";
    return {
      hasPct: true,
      pct,
      level,
      label: typeLabel,
      chipText: `Quota ${pct}%`,
      // Exposed so a surface with room (the Quota widget) can show the reset
      // without re-deriving it from the tooltip string. The captain, 2026-07-22: "jag
      // vill bara veta kvot och när det resetas".
      resetText,
      barValueText: `${pct}% used`,
      title: `${typeLabel} · ${pct}% used` + (resetText ? ` · resets in ${resetText}` : ""),
    };
  }
  // No percentage available - report status + reset instead of a misleading 0%.
  const status = q.status || "unknown";
  const level = status === "rejected" ? "hot" : status === "allowed_warning" ? "warm" : "ok";
  const statusWord =
    status === "rejected" ? "limited" : status === "allowed_warning" ? "near limit" : status === "allowed" ? "OK" : "status unknown";
  return {
    hasPct: false,
    pct: null,
    level,
    label: typeLabel,
    chipText: `${typeLabel} · ${statusWord}`,
    barValueText: resetText ? `${statusWord} · resets in ${resetText}` : statusWord,
    title: `${typeLabel} · ${statusWord}` + (resetText ? ` · resets in ${resetText}` : ""),
  };
}

// "as of Xm ago" for an accumulated window whose reading is no longer fresh.
// Returns null when the reading is recent enough that age is noise (< 90s) or
// when there's no timestamp - the panel only annotates staleness worth flagging.
function quotaFreshness(at, nowMs) {
  if (typeof at !== "number" || at <= 0) {
    return null;
  }
  const secs = Math.round((nowMs - at) / 1000);
  if (secs < 90) {
    return null;
  }
  const m = Math.floor(secs / 60);
  if (m < 60) {
    return `as of ${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `as of ${h}h ago`;
  }
  return `as of ${Math.floor(h / 24)}d ago`;
}

// Display order for the usage panel: the short binding window first, then the
// weekly windows (all-models, then per-model), then overage/unknown last.
const QUOTA_WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"];

// Turns the accumulated per-window readings (each { info, at }) into ordered row
// models for the usage panel (bc6786c7). Each row is a quotaReadout plus the
// window type and its "as of" freshness. Windows are remembered independently, so
// each row's staleness is judged on its own reset (a spent 5-hour window can read
// stale while the weekly window is still live).
// An old reading inside a window that has NOT reset is a floor, not a figure.
//
// "weekly är fortfarande fast på 36% och verkar inte uppdateras" (the captain, task
// 60738335, third pass). Checked against his running app rather than reasoned
// about: the weekly window's last reading was 39 HOURS old at 36%, while the
// five-hour window had reported four minutes earlier. He is right that it does not
// update, and Helm cannot make it - it never polls for quota, it only records what
// arrives on a rate-limit event, and the API reports the weekly window only when
// it has something to say about it. Telling him to wait for a number that may not
// come is not an answer.
//
// What IS knowable: usage inside an un-reset window only ever goes UP. So a
// 39-hour-old 36% is not "36% used", it is "at least 36% used" - and after a full
// day of work the real figure is certainly higher. The old wording erred in the
// one direction that costs something, telling him he had more room than he had,
// which is exactly why his Helm disagreed with Claude Desktop.
//
// Under the threshold nothing is qualified: a reading minutes old is the current
// figure, and hedging every number would make the qualifier meaningless.
const QUOTA_LOWER_BOUND_AFTER_MS = 60 * 60 * 1000;
function quotaLowerBound(readout, ageMs) {
  if (!readout?.hasPct || readout.stale || typeof ageMs !== "number" || ageMs < QUOTA_LOWER_BOUND_AFTER_MS) {
    return {};
  }
  return {
    // "≥" rather than "at least" because these strings live in a cramped widget
    // row; the tooltip spells it out in words.
    atLeast: true,
    chipText: `Quota ≥${readout.pct}%`,
    barValueText: `≥${readout.pct}% used`,
    title:
      `${readout.label} · at least ${readout.pct}% used - that reading is old, and usage inside a window only goes up, so the real figure is this or higher` +
      (readout.resetText ? ` · resets in ${readout.resetText}` : ""),
  };
}

function quotaPanelRows(windows, nowMs) {
  if (!Array.isArray(windows)) {
    return [];
  }
  const rows = [];
  for (const w of windows) {
    if (!w || !w.info) {
      continue;
    }
    const r = quotaReadout(w.info, nowMs);
    if (!r) {
      continue;
    }
    const ageMs = typeof w.at === "number" && w.at > 0 ? Math.max(0, nowMs - w.at) : null;
    rows.push({
      ...r,
      ...quotaLowerBound(r, ageMs),
      type: w.info.rateLimitType || "unknown",
      freshness: quotaFreshness(w.at, nowMs),
      // The raw age, so the headline choice can be made on it (see
      // QUOTA_HEADLINE_MAX_AGE_MS). `freshness` is a sentence for humans; this is
      // the number a decision can be based on.
      ageMs,
    });
  }
  rows.sort((a, b) => {
    const ia = QUOTA_WINDOW_ORDER.indexOf(a.type);
    const ib = QUOTA_WINDOW_ORDER.indexOf(b.type);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return rows;
}

// The single most-constrained FRESH window, for the compact dashboard chip: the
// chip should reflect the limit actually biting, not just whichever window fired
// last. Stale windows are excluded (their status no longer reflects reality -
// bc6786c7). Returns null when nothing fresh is known (chip falls back to Usage$).
const QUOTA_LEVEL_RANK = { hot: 3, warm: 2, ok: 1 };
// A reading this old must not take the headline position while a current one is
// available. `row.stale` only asks whether the WINDOW has reset - so a 26-hour-old
// weekly figure counted as fresh, outranked a five-hour reading taken seconds ago, and
// stood in the largest text in the widget. The captain watched it not move and said "den
// verkar inte uppdateras": correct, and the number he was watching was the one that
// cannot move, because its window reports only when it is the binding one.
//
// Falls back to the stale row when there is nothing newer - a stale figure with its age
// beside it beats "No current reading".
const QUOTA_HEADLINE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
function worstFreshQuotaRow(rows) {
  const recent = rows.filter((r) => !r.stale && (r.ageMs == null || r.ageMs <= QUOTA_HEADLINE_MAX_AGE_MS));
  const pool = recent.length > 0 ? recent : rows;
  let worst = null;
  for (const row of pool) {
    if (row.stale) {
      continue;
    }
    if (
      !worst ||
      (QUOTA_LEVEL_RANK[row.level] || 0) > (QUOTA_LEVEL_RANK[worst.level] || 0) ||
      ((QUOTA_LEVEL_RANK[row.level] || 0) === (QUOTA_LEVEL_RANK[worst.level] || 0) && (row.pct || 0) > (worst.pct || 0))
    ) {
      worst = row;
    }
  }
  return worst;
}

// A plain label/value row for the context popover (no bar) - used when there's a
// value worth showing but no meaningful 0-100 fill (e.g. quota status without a %).
function cpopTextRow(labelText, valueText) {
  const row = document.createElement("div");
  row.className = "cpop-row";
  const top = document.createElement("div");
  top.className = "cpop-row-top";
  const l = document.createElement("span");
  l.textContent = labelText;
  const v = document.createElement("span");
  v.className = "cpop-val";
  v.textContent = valueText;
  top.append(l, v);
  row.append(top);
  return row;
}

function cpopBarRow(labelText, valueText, pct, high) {
  const row = document.createElement("div");
  row.className = "cpop-row";
  const top = document.createElement("div");
  top.className = "cpop-row-top";
  const l = document.createElement("span");
  l.textContent = labelText;
  const v = document.createElement("span");
  v.className = "cpop-val";
  v.textContent = valueText;
  top.append(l, v);
  const bar = document.createElement("span");
  bar.className = "ctx-bar";
  const fill = document.createElement("span");
  fill.className = "ctx-fill" + (high ? " high" : "");
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  bar.append(fill);
  row.append(top, bar);
  return row;
}

// A severity-colored fill bar for the usage panel. level maps to a token:
// ok -> accent, warm -> amber (--waiting), hot -> red (--danger).
function quotaBar(pct, level) {
  const bar = document.createElement("span");
  bar.className = "ctx-bar";
  const fill = document.createElement("span");
  fill.className = "ctx-fill" + (level === "hot" ? " hot" : level === "warm" ? " warm" : "");
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  bar.append(fill);
  return bar;
}

// One usage-panel row for an accumulated window (bc6786c7). Shows the window
// label + its readout value, a severity-colored bar (a real fill when the API
// gave a %, a full colored bar for a definite limited/near status so severity
// reads without a number, nothing for a stale window), and an "as of" line when
// the reading is no longer fresh.
function cpopWindowRow(row) {
  const el = document.createElement("div");
  el.className = "cpop-row";
  const top = document.createElement("div");
  top.className = "cpop-row-top";
  const l = document.createElement("span");
  l.textContent = row.label;
  const v = document.createElement("span");
  v.className = "cpop-val" + (row.level === "hot" ? " crit" : row.level === "warm" ? " warn" : row.level === "stale" ? " faint" : "");
  v.textContent = row.barValueText;
  top.append(l, v);
  el.append(top);
  if (row.hasPct) {
    el.append(quotaBar(row.pct, row.level));
  } else if (!row.stale && (row.level === "hot" || row.level === "warm")) {
    el.append(quotaBar(100, row.level));
  }
  if (row.freshness) {
    const f = document.createElement("div");
    f.className = "cpop-fresh";
    f.textContent = row.freshness;
    el.append(f);
  }
  if (row.title) {
    el.title = row.title;
  }
  return el;
}

function toggleContextPopover(anchor, pane) {
  const existing = document.querySelector(".context-popover");
  closeContextPopover();
  if (existing) {
    return; // it was open under this or another gauge — toggle shut
  }
  const pop = document.createElement("div");
  pop.className = "context-popover";
  pop.addEventListener("click", (e) => e.stopPropagation()); // clicks inside don't close it

  const windowTokens = contextWindowForPane(pane);
  const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  const fmtWindow = windowTokens >= 1000000 ? `${(windowTokens / 1000000).toFixed(windowTokens % 1000000 === 0 ? 0 : 1)}M` : `${Math.round(windowTokens / 1000)}k`;

  if (typeof pane.contextTokens === "number") {
    const pct = Math.round((pane.contextTokens / windowTokens) * 100);
    pop.append(cpopBarRow("Context window", `${fmtK(pane.contextTokens)} / ${fmtWindow} (${pct}%)`, pct, pct >= 85));
  }

  // Usage-limit panel (bc6786c7): stack every accumulated window (5-hour, weekly-
  // all, weekly-per-model) the way the Claude desktop usage panel does, instead of
  // the single binding window. Each row carries its own freshness. Falls back to
  // the single latest reading if the accumulator is empty (older persisted state).
  const rows = quotaPanelRows(state.quotaWindows, Date.now());
  if (rows.length === 0 && state.quota) {
    const r = quotaReadout(state.quota, Date.now());
    if (r) {
      // The same lower-bound treatment as the accumulator path. A fallback that
      // skipped it would state a bare percentage in the one situation where the
      // accumulator has nothing - i.e. with the OLDEST possible data.
      const singleAge = typeof state.quotaAt === "number" && state.quotaAt > 0 ? Math.max(0, Date.now() - state.quotaAt) : null;
      rows.push({
        ...r,
        ...quotaLowerBound(r, singleAge),
        type: state.quota.rateLimitType || "unknown",
        freshness: quotaFreshness(state.quotaAt, Date.now()),
        ageMs: singleAge,
      });
    }
  }
  if (rows.length > 0) {
    const head = document.createElement("div");
    head.className = "cpop-head";
    head.textContent = "Usage limits";
    pop.append(head);
    for (const row of rows) {
      pop.append(cpopWindowRow(row));
    }
  } else {
    const none = document.createElement("div");
    none.className = "cpop-empty";
    none.textContent = "Usage limits: - (no data yet)";
    pop.append(none);
  }

  // Anchor above the gauge, right-aligned to it.
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  pop.style.top = `${r.top - pop.offsetHeight - 6}px`;
}

// Custom dropdown button reusing the context-menu popup, instead of a native
// <select> — Chromium's native select popup rendered white-on-white in this
// Electron build despite color-scheme:dark set three different ways, so this
// sidesteps it entirely by never using a native popup at all.
/**
 * A pill that opens a value picker.
 *
 * `options` is a flat list of `{ value, label }`, OR - to keep a long list from
 * cluttering (the captain, task cf96055c: "helst i en submeny för att inte plottra") -
 * an entry may instead be `{ label, submenu: [{ value, label }, ...] }`, which
 * renders as a nested menu (the context menu already supports `submenu`). The
 * label shown ON the pill is looked up across BOTH levels, so a value chosen
 * from a submenu still names itself on the pill rather than falling back to the
 * raw id.
 */
function dropdownPill(initialValue, options, onSelect) {
  const btn = document.createElement("button");
  btn.className = "meta-pill";
  btn.dataset.hasMenu = "1";
  btn.type = "button";

  // Every leaf option, top-level and nested, so the pill's own label lookup sees
  // a value no matter which level it was picked from.
  const leaves = options.flatMap((o) => (o.submenu ? o.submenu : [o])).filter((o) => o.value !== undefined);

  const setValue = (value) => {
    btn.dataset.value = value;
    const opt = leaves.find((o) => o.value === value);
    btn.textContent = opt ? opt.label : value;
  };
  setValue(initialValue);

  const toMenuItem = (o) => {
    if (o.submenu) {
      return { label: o.label, submenu: o.submenu.map(toMenuItem) };
    }
    return {
      label: o.label,
      onClick: () => {
        setValue(o.value);
        onSelect(o.value);
      },
    };
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, options.map(toMenuItem));
  });

  return { el: btn, setValue, get value() { return btn.dataset.value; } };
}

function showContextMenu(x, y, items) {
  const menu = document.getElementById("contextMenu");
  menu.innerHTML = "";
  menu.append(buildMenuItems(items));
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
}

function buildMenuItems(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement("div");
      sep.className = "sep";
      frag.append(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "item" + (it.danger ? " danger" : "");
    el.textContent = it.label;
    // Optional dim trailing text: for a menu of NAMES that stand for something
    // else (a package.json script name vs the command it runs), the name alone
    // makes the menu a guess.
    if (it.hint) {
      const hint = document.createElement("span");
      hint.className = "item-hint";
      hint.textContent = it.hint;
      el.append(hint);
    }
    // A DESCRIPTION rather than a trailing token. `hint` is styled as a short
    // right-floated monospace tail - right for "the command this script name runs", wrong
    // for a sentence, which would wrap into the label. This wraps under it instead.
    if (it.description) {
      const desc = document.createElement("span");
      desc.className = "item-desc";
      desc.textContent = it.description;
      el.append(desc);
    }
    if (it.submenu) {
      const sub = document.createElement("div");
      sub.className = "submenu";
      sub.append(buildMenuItems(it.submenu));
      el.append(sub);
      // The submenu opens at left:100% of its parent item by default —
      // right-clicking a row near the right edge of the window (a very
      // normal thing to do) pushed it off-screen with no way to reach its
      // items. Estimate against the submenu's own min-width (160px, set in
      // CSS) rather than measuring the real rect, since it's display:none
      // until hover and measuring a hidden element just returns zeros.
      el.addEventListener("mouseenter", () => {
        const itemRect = el.getBoundingClientRect();
        const submenuMinWidth = 160;
        sub.classList.toggle("flip-left", itemRect.right + submenuMinWidth > window.innerWidth);
        // Vertical overflow: the submenu opens downward from the item's top. When
        // the item sits low - e.g. "More models" at the bottom of a menu that
        // itself opened UPWARD from the composer's send button - the submenu ran
        // off the bottom of the window (task cf96055c: "more models listan
        // renderas utanför vyn"). Hover has made it displayable, so measure its
        // real height; fall back to an estimate if the layout hasn't flushed. Flip
        // it to grow upward (bottom-anchored) when it would overflow the bottom.
        const subHeight = sub.getBoundingClientRect().height || it.submenu.length * 30 + 10;
        sub.classList.toggle("flip-up", itemRect.top + subHeight > window.innerHeight - 8);
      });
    } else if (it.onClick) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        it.onClick();
      });
    }
    frag.append(el);
  }
  return frag;
}

document.addEventListener("click", () => {
  closeContextMenu();
  closeContextPopover();
});
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("[data-has-menu]")) {
    closeContextMenu();
  }
});
// The menu previously only closed on an outside click — no keyboard way to
// dismiss it at all, matching the image lightbox's own Escape handling.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeContextMenu();
    closeContextPopover();
  }
});

// Mouse side buttons (back = button 3, forward = button 4) navigate the WHOLE
// app's view history (Dashboard/Analysis/Chat/...) - the captain asked for the
// physical back/forward buttons to move across the app. Uses mouseup (fires
// for these buttons in Chromium).
document.addEventListener("mouseup", (e) => {
  if (e.button !== 3 && e.button !== 4) {
    return;
  }
  e.preventDefault();
  appNavigateView(e.button === 3 ? -1 : 1);
});

// A dashboard section re-render swaps whole slots via replaceChildren. If one
// fires while you're pressing a card, the card node is torn out from under the
// pointer and the click never lands — the reported "sometimes clicks on first
// mates don't register, when switching between them" (jumping into a mate flips
// its status, which changes the fleet fingerprint, so the very next click races
// that re-render; the 30s poll and streamed session events add more chances).
// Fix: while the pointer is held down on the dashboard, defer refreshes, then
// run the latest one AFTER the click has resolved.
//
// This guard covers FORCED refreshes too. `force` means "bypass the section
// fingerprints and rebuild anyway" — it is orthogonal to the pointer guard, and
// conflating the two was the bug behind the recurring regression: navigating
// back to the Dashboard (navigateToPage -> renderDashboardPage) fires an ASYNC
// forced fill, which can still be resolving when you press the next mate card,
// so the forced fleet swap eats that click. A diagnostic (diag-fleet-click-race)
// confirmed a forced swap mid-press ate 8/8 clicks while a non-forced swap ate
// none. So defer forced refreshes as well, and carry the force flag through to
// the deferred flush so a force-only repaint (archive spinner, rename restore —
// state the fingerprints don't track) still happens after release.
let dashPointerHeld = false;
let dashRefreshQueued = false;
let dashQueuedForce = false;
document.addEventListener("pointerdown", (e) => {
  if (isDashboardVisible() && e.target.closest?.("#dashboardPage")) {
    dashPointerHeld = true;
  }
});
function releaseDashPointer() {
  if (!dashPointerHeld) {
    return;
  }
  dashPointerHeld = false;
  if (dashRefreshQueued) {
    dashRefreshQueued = false;
    const force = dashQueuedForce;
    dashQueuedForce = false;
    // Defer past the `click` event that fires immediately after pointerup, so
    // the click lands on the still-present card before we replace the slot.
    setTimeout(() => fillDashboardSections({ force }), 0);
  }
}
document.addEventListener("pointerup", releaseDashPointer);
document.addEventListener("pointercancel", releaseDashPointer);
// Heal immediately if focus leaves the window mid-press (Alt+Tab, or a release
// outside the window that never delivers a pointerup/pointercancel) - otherwise
// dashPointerHeld could stay true until the next in-window click, needlessly
// deferring refreshes in the meantime.
window.addEventListener("blur", releaseDashPointer);

// Quick keyboard nav to the primary views:
//
//   Ctrl+Space        Dashboard   (the fast key the captain wanted, simpler than a digit)
//   Ctrl+Shift+Space  Review      (same key, one more modifier - see below)
//   Ctrl+Shift+X      Jot
//   Ctrl+1..4         Jot, Plan, Analysis, Archive - the header's own left-to-right order
//
// Skipped while the command palette is open so it doesn't fight its keys.
//
// Review sits on the SAME key as the dashboard with one more modifier, which is the whole
// reason for the choice (the captain: Ctrl+4 is "för långt mellan fingrarna", and Ctrl+R is
// Electron's reload, which would have thrown away every open pane). Same hand position,
// and the pair reads as one idea: what is going on, then what is waiting for me.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) {
    return;
  }
  const isSpace = e.code === "Space" || e.key === " ";
  if (e.shiftKey) {
    // Shift+Space -> Review, Shift+X -> Jot. Nothing else shifted is ours to take.
    //
    // Ctrl+Shift+X rather than Ctrl+X, which is cut and would break cutting in every text
    // field, and rather than Ctrl+J, which needs both hands ("ctrl+j är inte ergonomiskt,
    // kräver 2 händer") and is already the palette's move-down. Adding Shift keeps it on
    // the left hand and out of everyone else's way: no browser binds this chord.
    const isJot = e.code === "KeyX" || e.key === "x" || e.key === "X";
    if (!isSpace && !isJot) {
      return;
    }
    const palette = document.getElementById("commandPalette");
    if (palette && !palette.classList.contains("hidden")) {
      return;
    }
    e.preventDefault();
    navigateToPage(isSpace ? "review" : "jot");
    return;
  }
  // The digits follow the header's own tab order, left to right: Jot, Plan, Analysis,
  // Archive. They used to start at Plan and were therefore one step out of step with what
  // he sees - the comment claimed they mirrored the tabs while Jot, the FIRST one, had no
  // digit at all (the captain: "ctrl+1 borde gå till jot eftersom det är den första tabben").
  //
  // Jot's letter key is Ctrl+SHIFT+X, handled in the shifted branch above. Unshifted Ctrl+X
  // stays cut, and Ctrl+J was tried and rejected as two-handed.
  const page = isSpace ? "dashboard" : { 1: "jot", 2: "lavish", 3: "analysis", 4: "archive" }[e.key]; // lavish = the "Plan" tab
  if (!page) {
    return;
  }
  const palette = document.getElementById("commandPalette");
  if (palette && !palette.classList.contains("hidden")) {
    return;
  }
  e.preventDefault();
  // ctrl+space chains: first press shows the dashboard; pressing it again while
  // already ON the dashboard jumps into the first "needs you" chat, so the
  // shortcut reads "what needs me?" -> "take me into it" (task 93975f46).
  if (isSpace && isDashboardVisible()) {
    const firstNeedsYou = dashboardInMotionRows().find((r) => r.needsAction && r.kind === "session");
    if (firstNeedsYou) {
      navigateToPage("chat");
      openSessionInPane(firstNeedsYou.session, focusedPaneIndex);
      return;
    }
  }
  navigateToPage(page);
});

// ============================== Category CRUD ==============================
//
// window.prompt()/confirm() turned out to be unreliable in this Electron
// build (renaming silently failed, and the OS cursor got stuck once). Rename
// is now inline double-click editing everywhere, and delete is a two-step
// context-menu confirm — no native synchronous dialogs anywhere.





// Display-only rename — never writes to the desktop app's own session files,
// so it can't corrupt live state there; it just overrides what Helm shows.
async function renameSessionTo(session, newTitle) {
  if (!newTitle || !newTitle.trim() || newTitle === session.title) {
    return;
  }
  const titleOverrides = { ...(state.config.titleOverrides || {}), [session.sessionId]: newTitle.trim() };
  state.config = await window.helm.setConfig({ titleOverrides });
  refresh();
}

// Replaces `labelEl` with a text input pre-filled with its current text.
// Enter/blur commits via onCommit(value); Escape cancels. Restores the
// original element afterward either way — this never leaves a stray input.
function makeInlineEditable(labelEl, currentValue, onCommit) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit";
  input.value = currentValue;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) {
      return;
    }
    done = true;
    input.replaceWith(labelEl);
    if (commit) {
      onCommit(input.value.trim());
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

// The session row, and the drag-and-drop that only ever served it (dragging a session into a
// category, reordering categories), were removed with the sidebar on 2026-08-04 - see the note
// where the sidebar's own rendering used to be.
//
// renameSessionTo and makeInlineEditable, just above, are deliberately NOT part of this: the
// Dashboard's Fleet row renames a session with exactly those two.

// ============================== Fas 2: summarize & carry over ==============================
// Lets a session be archived without losing the thread: resume it once with a
// hidden "summarize yourself" prompt, then seed a fresh session's composer
// with that summary. Never touches the original session or any real file —
// purely additive (one more turn on the old session, one new draft prompt).

const CARRY_OVER_PROMPT =
  "Please write a concise handoff summary of this entire conversation so a " +
  "brand-new session could pick up seamlessly: current state, key decisions " +
  "made and why, and concrete next steps. This will be pasted as the opening " +
  "message of a new session, so write it as context FOR that new session, " +
  "not as a message to me. Don't duplicate content already captured in other " +
  "durable artifacts (DECISIONS.md, PLAN.md, commits) - reference them by path " +
  "instead. Redact any sensitive information such as API keys, passwords, or " +
  "personally identifiable information.";

// If a summarize launch's "done"/"error" event never arrives (a crashed main
// process, a dropped IPC message), the callback registered below would
// otherwise wait forever — the caller's `await summarizeSession(...)` never
// resolves and the pane's status line stays stuck on "Summarizing…"
// indefinitely. This bounds the wait; a real Sonnet summarization of even a
// very long conversation should finish well under this.
const SUMMARIZE_TIMEOUT_MS = 5 * 60 * 1000;

// A summarize turn can "succeed" and hand back something that is not a summary.
// When the CLI stops on a usage limit it emits its own one-line notice AS the
// assistant's reply and exits cleanly, so there is no error to notice. That line
// was saved verbatim as a handoff on 2026-08-02: a topic file whose entire
// contents were "You've hit your session limit · resets 9:40pm". A whole session's
// knowledge, replaced by a status message, silently.
//
// The guard is on LENGTH first, deliberately: a real handoff of a real
// conversation is never two lines, and length does not depend on the exact
// wording of a notice that will be reworded. The limit phrasing is matched only
// to say what happened in plain words - never to decide.
const MIN_SUMMARY_CHARS = 200;
function validateSummary(text) {
  const t = (text || "").trim();
  if (t.length >= MIN_SUMMARY_CHARS) {
    return { text: t };
  }
  if (/hit your .*limit|usage limit|resets \d/i.test(t)) {
    return { error: `the session ran out of usage before it could summarize ("${t}")` };
  }
  return { error: `what came back was too short to be a summary ("${t}")` };
}

function summarizeSession(session) {
  return new Promise(async (resolve) => {
    // session:start REFUSES an empty cwd, so a session with no folder could
    // never even be summarized - which silently defeated the whole non-rooted
    // handoff path (task 663ab4b6: the summarize failed, so nothing was ever
    // written). Fall back to the meta-home, which is the working directory a
    // folderless session effectively belongs to.
    let cwd = session.cwd;
    if (!cwd) {
      const info = await window.helm.getOrchestratorInfo();
      cwd = info?.cwd || "";
    }
    const res = await window.helm.startSession({
      cwd,
      prompt: CARRY_OVER_PROMPT,
      model: "claude-sonnet-5",
      effort: "medium",
      resumeSessionId: session.cliSessionId || session.sessionId,
      // Helm-internal launch (the hidden carry-over summary), not a real
      // user turn — keeps it out of the usage log, the "prompt finished"
      // notification, and out of the By-model analytics, which would otherwise
      // carry a synthetic run the user never initiated (model forced to
      // sonnet-5, a hidden prompt).
      internal: true,
    });
    if (!res.ok) {
      resolve({ error: res.error });
      return;
    }
    const timeoutId = setTimeout(() => {
      pendingLaunchCallbacks.delete(res.launchId);
      resolve({ error: "Timed out waiting for the summary." });
    }, SUMMARIZE_TIMEOUT_MS);
    pendingLaunchCallbacks.set(res.launchId, {
      assistantText: "",
      onDone: (text, error) => {
        clearTimeout(timeoutId);
        resolve(error ? { error } : validateSummary(text));
      },
    });
  });
}

// Prefers an existing empty pane over forcing a new split, so this doesn't
// clutter the workspace when one is already free. `avoidIndex` is a pane
// that must NOT be auto-clobbered — used by "Summarize & carry over", whose
// all-panes-full fallback would otherwise overwrite the pane you're looking
// at. (Rewind does NOT use this — it deliberately targets its own source
// pane via openFreshDraftInPane's forceIndex.) The chosen pane's in-memory
// view is replaced, but the replaced session's transcript on disk is
// untouched and still reopenable from the sidebar.
function pickDraftTargetPane() {
  // Single pane since split view was removed: always pane 0 (the draft replaces
  // whatever's there - the replaced session's transcript is untouched on disk
  // and reopenable from the sidebar).
  return { index: 0, addedPane: false };
}

// opts.forceIndex — drop the draft into THIS exact pane, replacing whatever's
// there (used by rewind: the captain wants it in the SAME pane, feeling like going
// back in the current conversation, not a new pane popping up). opts.avoidIndex
// — a pane that must NOT be auto-picked (summarize's safety so it doesn't
// clobber the pane you're looking at). With neither, pickDraftTargetPane
// prefers an empty/new pane. Either way the target pane's in-memory view is
// replaced by a fresh draft; the replaced session's transcript on disk is
// untouched and reopenable from the sidebar.
function openFreshDraftInPane(cwd, draftText, opts = {}) {
  let index;
  let addedPane = false;
  if (typeof opts.forceIndex === "number") {
    index = opts.forceIndex;
  } else {
    ({ index, addedPane } = pickDraftTargetPane(opts.avoidIndex));
  }
  stopLiveStatsTicker(index);
  // paneOverrides lets a caller stamp extra fields (e.g. isOrchestrator) onto
  // the fresh pane BEFORE the one render below, instead of mutating panes[]
  // and re-rendering afterward — a second render would wipe the draft text
  // set into the composer's textarea further down, since the composer isn't
  // backed by any persisted pane field.
  panes[index] = { ...freshPane(), cwd: cwd || "", ...(opts.paneOverrides || {}) };
  focusedPaneIndex = index;
  if (addedPane) {
    renderWorkspace(); // handles the .split class itself; pane count changed
  } else {
    renderSinglePane(index);
  }
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const promptEl = paneEl?.querySelector(".pane-composer textarea");
  if (promptEl) {
    promptEl.value = draftText;
    promptEl.focus();
    promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    promptEl.dispatchEvent(new Event("input"));
    // A fresh pane landing silently reads as "nothing happened" (esp. when
    // triggered from the Dashboard, far from the composer, or with a long
    // orchestrator draft where a border flash alone is easy to miss). So: a
    // toast (the app's reliable "something happened" signal, visible wherever
    // you're looking) PLUS an accent flash on the composer shell for when your
    // eyes are already there - for every fresh pane, draft or empty.
    showToast(draftText ? "Draft loaded - review and press Enter to send" : "New session started");
    const shellEl = paneEl.querySelector(".composer-shell");
    if (shellEl) {
      shellEl.classList.remove("composer-shell-draft-flash");
      void shellEl.offsetWidth; // restart animation if triggered again quickly
      shellEl.classList.add("composer-shell-draft-flash");
    }
  }
  return index;
}

// The faithful-transfer directive appended to a carried-over draft: names the
// durable stores that DON'T auto-load (DECISIONS.md/PLAN.md, the memory index)
// so the fresh session pulls them in on turn one instead of reasoning from the
// transcript summary alone. CLAUDE.md is mentioned only as "already loaded".
// Returns "" (no noise) when the cwd has no durable stores - e.g. a non-dev
// project. Best-effort: any failure just yields no directive.
async function buildDurableContextDirective(cwd) {
  let ctx;
  try {
    ctx = await window.helm.listContext(cwd);
  } catch {
    return "";
  }
  // Topic-keyed handoffs are NOT project docs: they live in Helm's own store
  // under the meta-home, not in the session's cwd. Listing them by bare filename
  // alongside DECISIONS.md told the fresh session to look for them in the wrong
  // folder - so the answer to "how does loading work?" was, until now, "it
  // doesn't". Name the folder, and let the session pick the matching subject
  // (there are only a handful, and no classifier runs while composing a draft).
  const docs = ctx?.projectDocs || [];
  const topics = docs.filter((d) => d.kind === "handoffTopic" && d.exists);
  const toRead = docs.filter((d) => d.kind !== "handoffTopic" && d.exists).map((d) => d.name);
  const memCount = ctx?.memory?.files?.length || 0;
  const projectClaudeLoads = (ctx?.claudeMd || []).some((c) => c.kind === "projectClaude" && c.exists);
  if (toRead.length === 0 && topics.length === 0 && memCount === 0 && !projectClaudeLoads) {
    return "";
  }
  const lines = ["\n\nBefore acting, load this project's DURABLE context (a transcript summary alone misses it):"];
  if (topics.length > 0) {
    const dir = topics[0].path.replace(/[\\/][^\\/]+$/, "");
    lines.push(
      `- This session has no project repo; its continuity lives in Helm's topic handoffs in ${dir}: ${topics
        .map((t) => t.name)
        .join(", ")}.`
    );
    lines.push("  READ the one matching this subject - it is the last session's state and what was next. Ignore the others.");
  }
  if (projectClaudeLoads) {
    lines.push("- CLAUDE.md auto-loads for this folder - its gotchas are already in your context.");
  }
  if (toRead.length) {
    lines.push(`- READ these first (they do NOT auto-load): ${toRead.join(", ")} in ${cwd}.`);
    // HANDOFF.md (when present) is the latest-session current-state note; the
    // others are durable reference. Name the split so the fresh session reads
    // for orientation vs rationale correctly.
    if (toRead.includes("HANDOFF.md")) {
      lines.push("  HANDOFF.md = where things stand + what's next (start here); DECISIONS.md = the why; PLAN.md = the roadmap.");
    }
  }
  if (memCount) {
    lines.push(`- ${memCount} memory file(s) exist for this project; consult the memory index for relevant decisions/traps.`);
  }
  return lines.join("\n");
}

async function summarizeAndCarryOver(session) {
  const statusIndex = focusedPaneIndex;
  const statusPane = panes[statusIndex]; // identity check below: focus/reset can change during the await
  setPaneBusyUIRaw(statusIndex, `Summarizing "${session.title}"…`);
  const result = await summarizeSession(session);
  if (panes[statusIndex] === statusPane) {
    setPaneBusyUIRaw(statusIndex, "");
  }
  if (result.error) {
    openFreshDraftInPane(session.cwd, `⚠ Failed to summarize: ${result.error}`);
    return;
  }
  // A transcript summary alone would drop the durable layer (proven 2026-07-08:
  // a fresh session missed load-bearing traps). So point the new session at the
  // durable stores that actually exist for this cwd - CLAUDE.md auto-loads, but
  // DECISIONS.md/PLAN.md/memory do NOT, so the handoff must name them. See
  // DECISIONS.md "Session-renewal strategy".
  const durable = await buildDurableContextDirective(session.cwd);
  const draft =
    `Continuing from "${session.title}". Summary of prior context:\n\n${result.text.trim()}` +
    durable +
    `\n\nPlease continue from here.`;
  // A first-mate handoff should produce a fresh FIRST MATE (same meta-home root
  // = orchestrator by cwd anyway, but carry the isOrchestrator flag + Sonnet
  // default so it behaves as one from turn one), not a plain chat.
  const carryOpts = isOrchestratorSession(session) ? { paneOverrides: { isOrchestrator: true, modelDefault: "claude-sonnet-5" } } : {};
  openFreshDraftInPane(session.cwd, draft, carryOpts);
}

// Retire a first mate WITH a last-effort handoff: give the outgoing mate's
// session one final turn to summarize itself, hand that to retireAndRespawn so
// the fresh mate's first jump-in continues the cross-project thread under the
// new name (planned renewal = faithful transfer, see DECISIONS.md
// "Session-renewal strategy"). A missing session or a failed summary never
// blocks retiring - it just respawns without a handoff.
// persona (optional) = a deliberate persona SWITCH: the fresh mate respawns
// into it. Omitted = an ordinary retire (fresh mate resets to plain
// coordinator). Either way the outgoing session's handoff is saved first so the
// thread survives the transfer.
// persona === undefined means an ordinary refresh, which KEEPS whatever the mate was; a key
// (or an explicit null for Coordinator) is a deliberate switch.
// KEEPING the session's knowledge and CARRYING IT INTO the next session are two
// different wishes, and bundling them was the mistake here.
//
// the captain, 2026-08-12, after the durable-document work landed: "nej, jag vill att det ska
// vara separata. Ofta vill jag inte carry over för jag vill starta en ny topic men jag
// vill fortfarande behålla det vi pratat om den här sessionen."
//
// The two options he had were all-or-nothing: carry over saved a durable document AND
// seeded the successor's composer, and "start fresh" did neither. So the common case -
// a new topic, without throwing away what was just discussed - had no button, and the
// only way to keep the notes was to accept a carry-over he did not want.
//
// `carryOver` therefore controls ONLY the one-shot message to the successor. The durable
// document is written whenever there is a summary at all, because that is the half he
// almost always wants.
async function retireMateWithCarryOver(mate, persona = undefined, { carryOver = true } = {}) {
  let handoff = null;
  // A persistent spinner toast for the WHOLE retire - the summarize, the
  // per-mate handoffs, and the archiving are all multi-second and usually
  // triggered from the dashboard where the per-pane status isn't visible, so
  // without this the retire sat silent while it archived its mates (task
  // 88b7afe3). Its text advances through the phases below.
  const busy = showBusyToast(`Retiring ${mate.name}…`);
  handoffBusyIds.add(mate.mateId);
  fillDashboardSections({ force: true });
  if (mate.sessionId) {
    busy.update(`Retiring ${mate.name} - saving handoff…`);
    setPaneBusyUIRaw(focusedPaneIndex, `Retiring ${mate.name} - saving handoff…`);
    try {
      const res = await summarizeSession({ cwd: mate.root || state.orchestratorHome, cliSessionId: mate.sessionId, sessionId: mate.sessionId, title: mate.name });
      if (res && res.text) {
        handoff = res.text.trim();
      }
    } catch {
      // fall through - retire without a handoff rather than blocking
    }
    setPaneBusyUIRaw(focusedPaneIndex, "");
    // The first mate's OWN summary, saved as a durable document too - not only as the
    // one-shot pendingHandoff that seeds its successor's composer.
    //
    // Its second mates have had this since task 663ab4b6 (saveSecondMateHandoffsFor, just
    // below); the coordinating mate above them did not, which is backwards - it holds the
    // thread the others hang off. handoffStore.js says exactly why the mate record is not
    // enough: pendingHandoff "is consumed once and is a message to the next instance, not a
    // durable document you can open and read later". So a first mate's knowledge lived
    // exactly one successor deep and then was gone (the captain, 2026-08-12: "det vore även bra om
    // samma handoff mekanik som finns hos 2nd mates också finns hos 1st mates").
    //
    // A first mate is rooted at the meta-home, which is not a repo, so this files by TOPIC -
    // the case handoffStore was built for. ask:false for the same reason the child batch uses
    // it: a menu here would block a multi-second retire that is already in progress. A
    // guessed topic is surfaced rather than swallowed.
    if (handoff) {
      try {
        const saved = await saveHandoffResolvingTopic({ cwd: mate.root || state.orchestratorHome, title: mate.name }, handoff, { ask: false });
        if (saved?.guessedTopic) {
          showNotice(`Couldn't tell which topic "${mate.name}" belongs to - filed its handoff under "${saved.category}".`);
        }
      } catch {
        // The carry-over into the successor still happens; a failed durable write must not
        // cost the retire itself.
      }
    }
  }
  await saveSecondMateHandoffsFor(mate, busy);
  busy.update(`Retiring ${mate.name} - archiving…`);
  // The durable document above is already written. What is withheld here is only the
  // one-shot carry-over: passing no handoff means the successor boots on a blank
  // composer, which is the point of "keep the notes, start a new topic".
  const retireRes = await window.helm.retireMate(mate.mateId, carryOver ? handoff : null, persona || null, persona === undefined);
  reflectTornDownSessions(retireRes);
  await archiveOutgoingMateSession(mate);
  busy.done();
  handoffBusyIds.delete(mate.mateId);
  fillDashboardSections({ force: true });
}

// Retire a first mate WITHOUT carrying a handoff into its successor: no final
// summarize turn, no pendingHandoff, so the fresh mate lands on a blank composer.
// For when you're retiring to start something NEW rather than to continue the
// thread (the common case). The outgoing session is still archived, and if it
// wrote a HANDOFF.md that file stays on disk - "start fresh" only drops the
// prompt carry-over, it doesn't destroy the durable handoff.
async function retireMateClean(mate, persona = undefined) {
  // Same spinner as the carry-over path: this tears down + archives the mates and
  // hands them off too, all multi-second, and previously ran with NO indicator at
  // all (task 88b7afe3).
  const busy = showBusyToast(`Retiring ${mate.name}…`);
  handoffBusyIds.add(mate.mateId);
  fillDashboardSections({ force: true });
  await saveSecondMateHandoffsFor(mate, busy);
  busy.update(`Retiring ${mate.name} - archiving…`);
  const retireRes = await window.helm.retireMate(mate.mateId, null, persona || null, persona === undefined);
  reflectTornDownSessions(retireRes);
  await archiveOutgoingMateSession(mate);
  busy.done();
  handoffBusyIds.delete(mate.mateId);
  fillDashboardSections({ force: true });
}

// Archive the outgoing mate's own session as part of retiring. Retire ends that
// mate's lifecycle (its context lives on in the handoff + the fresh mate, or is
// deliberately dropped on a clean retire), so the old session is finished - tuck
// it away here instead of leaving it to resurface as a stray "Archive finished
// session" proposal the captain has to deal with separately (bug a5178cbc: "I
// retired a 1st mate and then this came up - what do I do with it?"). A retired
// mate is no longer bound to an active mate, so isOrchestratorSession no longer
// shields it from the archive pile - archiving now is the clean end of the retire.
// Mark the second-mate sessions the server archived during retire (task
// 58e9a433 teardown) as archived in the LOCAL cache too, so they drop from the
// sidebar/fleet on the immediate re-render instead of lingering until the next
// getSessions() poll - the same staleness gap the retire-flash fix closed for
// the first mate's own session. Matches on either id form (the binding stores
// one; a session carries both).
function reflectTornDownSessions(retireRes) {
  const ids = retireRes && retireRes.tornDownSessionIds;
  if (!Array.isArray(ids) || !ids.length) {
    return;
  }
  const set = new Set(ids);
  for (const s of state.sessions) {
    if (set.has(s.cliSessionId) || set.has(s.sessionId)) {
      s.isArchived = true;
    }
  }
}

// Before retiring a first mate tears down its second-mate subtree, give each
// ENGAGED second mate (one with a live session) a final handoff to HANDOFF.md in
// its project - so tearing the subtree down doesn't silently drop its context
// (task 58e9a433 + the captain's "they should leave their handoffs too"). Proposed
// second mates (no session) have nothing to summarize. Best-effort per child; a
// failed summary never blocks the retire.
async function saveSecondMateHandoffsFor(mate, busy = null) {
  let children = [];
  try {
    const res = await window.helm.listSecondMates();
    children = ((res && res.secondMates) || []).filter((s) => s.firstMateId === mate.mateId && s.sessionId);
  } catch {
    return;
  }
  let n = 0;
  for (const sm of children) {
    const session = state.sessions.find((x) => (x.cliSessionId || x.sessionId) === sm.sessionId);
    // A non-rooted second mate (no repo - training, kombucha, job hunting) used
    // to be SKIPPED here, so retiring its first mate silently discarded its
    // handoff. It now files by topic instead (task 663ab4b6).
    if (!session) {
      continue;
    }
    // Progress on the retire spinner: summarizing each child is a real Sonnet
    // turn, so without this the retire sat silent while it worked through the
    // mates (task 88b7afe3).
    n += 1;
    busy?.update?.(`Retiring ${mate.name} - handing off ${sm.name || "a mate"} (${n}/${children.length})…`);
    try {
      const summary = await summarizeSession(session);
      if (summary && summary.text) {
        const saved = await saveHandoffResolvingTopic(session, summary.text.trim(), { ask: false });
        if (saved?.guessedTopic) {
          // A caveat, not a success: route it through the persistent right-side
          // notice (default warn tone) so it stays until dismissed and names the
          // topic file it was filed under, rather than fading away unseen.
          showNotice(`Couldn't tell which topic "${session.title}" belongs to - filed under "${saved.category}".`);
        }
      }
    } catch {
      // best-effort - a failed child handoff must never block the retire
    }
  }
}

async function archiveOutgoingMateSession(mate) {
  if (!mate.sessionId) {
    return;
  }
  try {
    const backing = state.sessions.find((s) => (s.cliSessionId || s.sessionId) === mate.sessionId);
    if (backing && !backing.isArchived) {
      await window.helm.archiveSession(backing.sessionId, true);
      // Keep the local cache in sync immediately. The mate removal is read fresh
      // from listMates() on the very next render, but the archive flag only
      // reaches state.sessions on a later getSessions() poll - so for one render
      // the session was mate-unbound AND locally-not-yet-archived, which is
      // exactly what augmentSecondMatesWithSessions classifies as a "direct" node,
      // flashing the retired mate under Captain tagged "2nd mate" (bug 96d34b98).
      // Setting it here closes that window so the next fillDashboardSections drops it.
      backing.isArchived = true;
    }
  } catch {
    // best-effort - a failed archive just leaves the old archive proposal
  }
}

// Sets just the status text on whichever pane is currently focused, without
// requiring that pane to be running its own launch (setPaneBusyUI assumes
// pane.busy reflects THIS pane's own send, which isn't true while summarizing
// happens via a detached background launch).
function setPaneBusyUIRaw(index, statusText) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const status = paneEl?.querySelector(".pane-status");
  if (status) {
    status.textContent = statusText || "";
  }
}

// paneIndex is always 0 since split view was removed; the 3rd param is a vestige
// of the old forceSplit and is ignored.
function openSessionInPane(session, paneIndex, { secondMateId: secondMateIdOverride } = {}) {
  focusedPaneIndex = paneIndex;
  selectedSessionId = session.sessionId;
  // Re-opening the session ALREADY showing in this exact pane (e.g. navigating
  // to a different session and back) is a no-op for the pane's own in-memory
  // state: rebuilding from scratch silently discarded any in-progress edit.
  // Skipping the reset also preserves any unsent draft prompt text.
  const alreadyOpenHere = panes[paneIndex]?.sessionId === session.sessionId;
  if (!alreadyOpenHere) {
    stopLiveStatsTicker(paneIndex);
    // Name a mate-bound session by its durable fleet name, not the prompt-derived
    // session.title (which a first mate picks up after its first turn). Mirrors the
    // needs-you queue (firstMateForSession/secondMateForSession). Without this the
    // chat pane header showed e.g. "Jag vill jobba med dinghy..." for a first mate
    // that has a real fleet name (bug 5fda2a96).
    const fm = firstMateForSession(session);
    const sm = fm ? null : secondMateForSession(session);
    panes[paneIndex] = {
      ...freshPane(),
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId || session.sessionId,
      cwd: session.cwd || "",
      title: sessionDisplayName(session),
      // Carry the resolved mate id so a turn in a RESUMED mate session attaches the
      // dispatch config bound to THAT mate. Without this, session:start fell back
      // to buildFirstMateMcpConfig's active[0], so a second first mate's dispatches
      // (create_second_mate, etc.) were stamped onto the slot-0 mate - "asked Davy
      // Jones to make second mates, they showed up under LeChuck" (bug 2a5e6196).
      // The fresh-draft path already set mateId; this fixes the resume path.
      mateId: fm ? fm.mateId : undefined,
      // Prefer the resolved binding, but fall back to an explicit override from the caller.
      // A DIRECT/derived second mate's session was never bound, so secondMateForSession
      // returns null for it - without the override, resuming it here dropped the second-mate
      // id and the turn launched as a PLAIN session (no helm_dispatch, no delegate manual),
      // so it did every task itself instead of dispatching autopilots (jumpIntoSecondMate).
      secondMateId: fm ? undefined : sm ? sm.secondMateId : secondMateIdOverride,
      loading: true,
      // If a turn is currently running for this session, reopen it as busy so it
      // shows "working" (stop icon + status), not a hung-looking idle. Live
      // events are redirected here by cliSessionId, and "done" clears it
      // (a39286b7). freshPane() defaults busy:false for a session with no live turn.
      busy: runningSessions.has(session.cliSessionId || session.sessionId),
      isOrchestrator: isOrchestratorSession(session),
      // Restores a prompt queued before navigating away (see queuedPromptBySession) -
      // the pane object itself was just discarded above, so without this the queue
      // silently vanished on ANY trip away from the session, not just a slow one.
      queuedPrompt: queuedPromptBySession.get(session.cliSessionId || session.sessionId) || null,
    };
  }
  renderSinglePane(paneIndex);
  loadTranscriptInto(paneIndex);
  if (panes[paneIndex]?.busy) {
    setPaneBusyUI(paneIndex, "Working…");
  } else if (panes[paneIndex]?.queuedPrompt) {
    // The run it was waiting on already finished while this pane was closed -
    // the live "done" event had nowhere to deliver it (fireQueuedPromptIfAny
    // needs a live pane), so fire it now instead of leaving it queued forever.
    fireQueuedPromptIfAny(paneIndex, panes[paneIndex]);
  }
  // Clicking into a session is an intent to write in it — put the cursor in
  // the composer so you can type immediately without a second click (the captain's
  // ask). focus() is a no-op on a textarea inside a hidden (#chatPage.hidden)
  // ancestor, so this only works when chat is already visible. Every caller
  // that could open while chat is hidden (the Fleet jump-ins) navigates to chat
  // FIRST now, so by here the pane is always visible - see jumpIntoFirstMate /
  // jumpIntoSecondMate.
  const promptEl = document
    .querySelector(`.pane[data-pane="${paneIndex}"]`)
    ?.querySelector(".pane-composer textarea");
  if (promptEl) {
    promptEl.focus();
    const end = promptEl.value.length;
    promptEl.setSelectionRange(end, end);
  }
}

/**
 * Merges a reloaded transcript with what the pane already had on screen.
 *
 * "Mina promptar försvinner ibland ur flödet ... men ai har registrerat den" (the captain, task
 * 20009fdc). A sent prompt is pushed onto pane.turns IN MEMORY and only reaches the
 * transcript file when the CLI writes it. Reloading did `pane.turns = turns`, a blunt
 * replacement - so a reload that landed in the window before the file caught up erased the
 * prompt from view while the run carried on with it. That is exactly "sometimes", and
 * exactly "the AI got it".
 *
 * So a reload may only ever ADD - but only turns THIS APP created and the file has not got
 * yet. Those carry `pending: true` from the moment they are pushed, and that flag is what
 * makes the rule precise instead of a guess about shapes:
 *
 *   - a prompt sent seconds ago, absent from the file: pending, so it is kept;
 *   - turns a REWIND deliberately cut away: they came from a file, never pending, so they
 *     stay gone - which a shape-based heuristic got wrong, and the test caught;
 *   - a different session opened in this pane: nothing of it is pending either.
 *
 * Matching is on role+kind+text over a generous window of the file's tail rather than only
 * its last entry, because the file can come back with the same turns grouped differently.
 * When in doubt a pending turn is kept, which can in principle show something twice - the
 * right way round to be wrong, since a duplicate is visible and self-corrects on the next
 * reload while a deleted prompt does neither.
 *
 * WHY THIS IS NOT GENERALISED TO "keep any trailing turn the file lacks" (2026-08-04, while
 * chasing task bee52369 - "ibland försvinner det senaste jag och claude outputat"):
 *
 * That rule looks stronger and is wrong. A rewind legitimately SHORTENS the transcript, and a
 * pane whose file came back short cannot tell "the file is behind" from "these turns were cut
 * on purpose" by shape alone - so the generalisation resurrects deliberately removed turns,
 * which the rewind case in test-reload-keeps-sent-prompt.mjs catches immediately.
 *
 * The premise behind wanting it was also wrong: once the file HAS caught up, pane.turns holds
 * the file's own objects and there is nothing local left to lose, so a later short reload is a
 * deliberate act (a rewind, a compaction) rather than a race. The pending flag covers exactly
 * the window where the app holds something the file does not, which is the whole exposure.
 */
const RELOAD_MATCH_WINDOW = 60;
const PENDING_PER_SESSION_CAP = 20;
const turnKey = (t) => `${t?.role}|${t?.kind}|${String(t?.text ?? "")}`;

/**
 * Pending turns per SESSION, deliberately not per pane.
 *
 * This is the part that actually fixes his report, and the first version missed it. Opening
 * a different session builds a brand-new pane object (freshPane), so a pending turn held on
 * the pane dies with the pane - and his path is exactly that: send, go to another session,
 * come back. By then the pane is new, its turn list is empty, and the reload has nothing to
 * merge against. Keyed by session, the sent prompt survives the round trip.
 *
 * Entries are dropped as soon as a reloaded transcript contains them, so this never grows
 * into a second source of truth - and it is capped per session as a backstop in case a
 * session somehow never sees its own turns land.
 *
 * They also have a hard LIFETIME: everything here expires when the next run starts (see
 * expirePendingTurnsFromEarlierRuns). Text matching alone is not enough to empty this -
 * a turn that scrolls out of the file's tail window can never match again - and that is
 * what left one old reply riding along at the bottom of the pane forever.
 */
const pendingTurnsBySession = new Map();

function rememberPendingTurn(sessionId, turn) {
  if (!sessionId || !turn) {
    return;
  }
  const list = pendingTurnsBySession.get(sessionId) || [];
  list.push(turn);
  pendingTurnsBySession.set(sessionId, list.slice(-PENDING_PER_SESSION_CAP));
}

/**
 * Everything still pending from an EARLIER run stops being pending the moment a new
 * run starts. Called from exactly one place: the send path, just before the new
 * prompt is remembered.
 *
 * This is the LIFETIME the pending buffer never had, and its absence is the bug
 * (the captain, task 6bdbcde7: "En output följer hela tiden med och hamnar sist" - his
 * screenshots show the session's FIRST reply re-appended below the newest turn, over
 * and over). A pending entry is only ever meant to cover the window between "sent"
 * and "the file caught up". Nothing bounded it, so it was dropped by only two things:
 *
 *   1. a role+kind+text match against the last RELOAD_MATCH_WINDOW turns of the file.
 *      Once the conversation grows past that window, an early pending turn can never
 *      match again - it is permanently unmatchable, so every later reload re-appends
 *      it at the tail. That is exactly what his screenshots show: the text sits at
 *      entry 34 of 411 in the transcript file, far outside a 60-turn tail.
 *   2. three hand-written deletes, one in each terminal branch of the "done" handler.
 *
 * (2) is the part worth naming: this same symptom has now been fixed three times by
 * adding a delete to whichever branch was found to leak, and it came back because
 * some path still reaches a new run without passing any of them. A rule enforced at
 * N call sites is a rule that a new N+1th call site silently opts out of. Expiring on
 * the NEXT RUN instead is one place that every path must go through to produce more
 * output at all, so no future branch can miss it.
 *
 * Safe against the failure the buffer exists to prevent - losing a just-sent turn the
 * file has not written yet - because by the time a new run starts, the previous run's
 * process has exited and the CLI flushed its transcript before it did. Anything still
 * unmatched at that point is not "the file is behind"; it is a turn the file is never
 * going to grow.
 *
 * Clears the flag on the pane's own turns too, not just the per-session buffer: the
 * merge keeps `prev.filter((x) => x.pending)` as well, so leaving the flag on would
 * re-add them from the other side.
 */
function expirePendingTurnsFromEarlierRuns(pane) {
  if (!pane) {
    return;
  }
  if (pane.sessionId) {
    pendingTurnsBySession.delete(pane.sessionId);
  }
  for (const turn of pane.turns || []) {
    if (turn?.pending) {
      delete turn.pending;
    }
  }
}

function mergeReloadedTurns(previous, fromFile, sessionId = null, { authoritative = false } = {}) {
  const prev = Array.isArray(previous) ? previous : [];
  const file = Array.isArray(fromFile) ? fromFile : [];
  // A completed turn ("done" with a genuine result) has flushed everything to the
  // transcript file, so the file is the whole truth. Keeping the streamed pending turns
  // on top of it is exactly what duplicated output at the end of a conversation:
  // streaming pushes assistant-text blocks live (and never tool turns), then this reload
  // brings the file's own copy - grouped under "Used N tools" - while the live blocks,
  // no longer matched (they fall outside the tail window behind a tool-heavy turn, or
  // differ file-message-vs-streamed-block), got re-appended as naked duplicate bubbles.
  // On an authoritative reload, trust the file completely and drop the pending buffer.
  if (authoritative) {
    if (sessionId) {
      pendingTurnsBySession.delete(sessionId);
    }
    return file;
  }
  const remembered = sessionId ? pendingTurnsBySession.get(sessionId) || [] : [];
  if (prev.length === 0 && remembered.length === 0) {
    return file;
  }
  const inFile = new Set(file.slice(-RELOAD_MATCH_WINDOW).map(turnKey));
  // Order is preserved by filtering in place: pending turns are only ever appended at the
  // tail, so what survives is already in the order it was written. The pane's own list wins
  // over the remembered copy when both have the same turn, so nothing shows twice.
  const seen = new Set();
  const keep = [];
  for (const t of [...prev.filter((x) => x?.pending), ...remembered]) {
    const k = turnKey(t);
    if (inFile.has(k) || seen.has(k)) {
      continue;
    }
    seen.add(k);
    keep.push(t);
  }
  if (sessionId) {
    // Prune what the file has caught up with, so this buffer shrinks back to empty in
    // normal use instead of quietly becoming a parallel transcript.
    if (keep.length === 0) {
      pendingTurnsBySession.delete(sessionId);
    } else {
      pendingTurnsBySession.set(sessionId, keep.slice(-PENDING_PER_SESSION_CAP));
    }
  }
  return keep.length > 0 ? [...file, ...keep] : file;
}

async function loadTranscriptInto(paneIndex, { authoritative = false } = {}) {
  const pane = panes[paneIndex];
  if (!pane || !pane.cliSessionId) {
    return;
  }
  const { turns, hiddenCount, truncated, contextTokens } = await window.helm.getTranscript({
    cliSessionId: pane.cliSessionId,
    sessionId: pane.sessionId,
  });
  if (panes[paneIndex] !== pane) {
    return; // pane was reassigned while loading
  }
  // Additive, never destructive - see mergeReloadedTurns. A reload used to be able to
  // delete a prompt that had been sent but not yet written to the file. The one
  // exception is an authoritative reload (a completed turn), which trusts the file.
  pane.turns = mergeReloadedTurns(pane.turns, turns, pane.sessionId, { authoritative });
  pane.hiddenCount = hiddenCount || 0;
  pane.contextTokens = typeof contextTokens === "number" ? contextTokens : null;
  // The composer was built before this async load finished, so its gauge
  // rendered empty — refresh it now that we have the number.
  pane.els?.renderContextGauge?.();
  // Whether this view is missing earlier turns (turn-cap or byte-tail cap).
  // Rewind needs the full transcript from turn 0 — the rendered index it
  // passes to the fork counts from the first shown bubble, but the fork
  // counts from the file's absolute start, so a truncated view would cut at
  // the wrong message. Rewind is only offered when this is false.
  pane.transcriptTruncated = !!truncated;
  pane.loading = false;
  renderPane(paneIndex);
}

// The session sidebar lived here: the grouped list, its category drag-and-drop, its
// per-session menu and its search. Removed on 2026-08-04 (task 22f85eda - "Vi borde ta bort
// session vyn från chat"), leaving chat as the workspace alone.
//
// Nothing it carried was dropped silently. Rename and Archive already existed on a session's
// row in the Fleet; "Summarize & carry over" was moved there in the same change, because it is
// the session-renewal move the whole ephemeral-session model rests on. "Move to category" is
// gone deliberately - the captain: it "skulle förespråka långlivade sessioner, vilket vi inte vill
// ha" - and so is "Remove from Helm", which was a second way to hide a session that nobody
// could explain ("remove from helm vet jag inte ens vad är"); archiving covers it, and
// anything already hidden stays restorable from the Archive page.

// ============================== Workspace (panes) ==============================

// Minimal, safe markdown: bold, inline code, fenced code blocks, "- " lists.
// Never uses innerHTML with model text — everything goes through
// createElement/textContent so there is no injection surface.
function renderMarkdownInto(container, text) {
  const segments = text.split(/```([\s\S]*?)```/);
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      // The fence's info string is the LANGUAGE, and it used to be thrown away by the
      // same replace that stripped it (task c6094e4f). Captured now and handed to the
      // colouriser, which is the whole reason a code block can look like code.
      // The whole info LINE goes, not just its first token: a fence written
      // ```js title="x" left ` title="x"` sitting in the code as if it were code
      // (found by an independent review). The language is that line's first word.
      const lang = (segment.match(/^[ \t]*([A-Za-z0-9_+#.-]+)/) || [])[1] || "";
      container.append(codeBlockEl(segment.replace(/^[^\n]*\n/, ""), lang));
    } else if (segment) {
      renderTextBlock(container, segment);
    }
  });
}

// ---- Syntax colouring, local and dependency-free ---------------------------
//
// A small tokeniser rather than highlight.js, for one reason that decided it: the
// requirement is "färgaren genererar egna, kontrollerade element" and no innerHTML of
// model text. highlight.js hands back an HTML STRING, which means either innerHTML or
// parsing its output back into nodes - and a highlighter is not worth relaxing that rule
// for. This produces (text, class) pairs which the caller turns into spans.
//
// Honest limits, stated because the alternative is a false impression of completeness:
// it knows the families below, colours comments/strings/numbers/keywords/call names, and
// anything it does not know renders as plain monospace text (which is what happens today
// for everything). It is not a parser: a keyword inside a word is not matched, but a
// pathological construct can still be mis-tinted. Being wrong here costs a colour.
const CODE_LANG_ALIASES = {
  js: "clike", javascript: "clike", jsx: "clike", mjs: "clike", cjs: "clike",
  ts: "clike", typescript: "clike", tsx: "clike",
  c: "clike", cpp: "clike", "c++": "clike", cs: "clike", csharp: "clike", java: "clike", go: "clike", rust: "clike", swift: "clike", kotlin: "clike", php: "clike",
  json: "json", jsonc: "json",
  py: "python", python: "python",
  lua: "lua", luau: "lua",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  ps1: "powershell", powershell: "powershell", pwsh: "powershell",
  css: "css", scss: "css", less: "css",
  html: "markup", xml: "markup", svg: "markup", vue: "markup",
  sql: "sql",
  diff: "diff", patch: "diff",
  yml: "yaml", yaml: "yaml",
};

const CODE_KEYWORDS = {
  // Deliberately NOT the union of every c-like language's keywords. The first version
  // was, and an independent review measured the cost: `res.set(...)`, `str.match(...)`,
  // `map.get(...)`, `x.type` and `from` all came out tinted as keywords, because `set`,
  // `get`, `match`, `type`, `from`, `where`, `use` and `go` are keywords in SOME language
  // in that union. Those are the COMMON case in JavaScript, not a pathological one, so
  // the union made ordinary member calls read as syntax. Words that are only keywords in
  // a language this list also has to serve are left out; a missed colour is cheaper than
  // a wrong one.
  clike:
    "abstract async await break case catch class const constructor continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null override private protected public readonly return static super switch this throw true try typeof undefined var void while yield",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
  lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while self",
  shell: "if then else elif fi for while do done case esac function return export local readonly set unset echo cd exit source",
  powershell: "if else elseif foreach function param process begin end return try catch finally throw switch while do until break continue filter class",
  sql: "select from where group by having order limit offset insert into values update set delete create table alter drop index join left right inner outer on as distinct union all and or not null",
  json: "true false null",
  yaml: "true false null",
};

/**
 * @returns {Array<{ text: string, cls: string }>} cls is "" for uncoloured text.
 */
function highlightCode(code, lang) {
  const family = CODE_LANG_ALIASES[String(lang || "").toLowerCase()] || null;
  const src = String(code == null ? "" : code);
  if (!family) {
    return [{ text: src, cls: "" }];
  }
  if (family === "diff") {
    // A diff is coloured by line, not by token - the leading character IS the meaning.
    return src.split(/(?<=\n)/).map((line) => ({
      text: line,
      cls: /^\+\+\+|^---/.test(line) ? "tok-file" : /^@@/.test(line) ? "tok-hunk" : /^\+/.test(line) ? "tok-add" : /^-/.test(line) ? "tok-del" : "",
    }));
  }
  const lineComment = family === "python" || family === "shell" || family === "powershell" || family === "yaml" ? "#" : family === "lua" ? "--" : family === "sql" ? "--" : "//";
  const kw = new Set((CODE_KEYWORDS[family] || "").split(/\s+/).filter(Boolean));
  const out = [];
  const push = (text, cls) => {
    if (!text) {
      return;
    }
    const last = out[out.length - 1];
    if (last && last.cls === cls) {
      last.text += text;
    } else {
      out.push({ text, cls });
    }
  };

  // One pass, longest-match-first: comments and strings before anything else, so a
  // keyword inside a string is not tinted as code.
  const rules = [
    { cls: "tok-com", re: family === "markup" ? /<!--[\s\S]*?-->/ : /\/\*[\s\S]*?\*\//, when: family === "clike" || family === "css" || family === "markup" },
    { cls: "tok-com", re: family === "lua" ? /--\[\[[\s\S]*?\]\]/ : null, when: family === "lua" },
    { cls: "tok-com", re: new RegExp(`${lineComment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*`), when: family !== "markup" && family !== "json" },
    { cls: "tok-str", re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/, when: true },
    { cls: "tok-num", re: /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/, when: true },
    { cls: "tok-tag", re: /<\/?[A-Za-z][A-Za-z0-9-]*/, when: family === "markup" },
    { cls: "tok-word", re: /[A-Za-z_$@][\w$]*/, when: true },
  ].filter((r) => r.when && r.re);

  let rest = src;
  let guard = 0;
  while (rest.length > 0 && guard++ < 200000) {
    let best = null;
    for (const rule of rules) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, text: m[0], cls: rule.cls };
      }
      if (best && best.index === 0) {
        break;
      }
    }
    if (!best) {
      push(rest, "");
      break;
    }
    push(rest.slice(0, best.index), "");
    if (best.cls === "tok-word") {
      const after = rest.slice(best.index + best.text.length);
      const isCall = /^\s*\(/.test(after);
      const isProp = best.index > 0 && rest[best.index - 1] === ".";
      // PROPERTY POSITION WINS over the keyword list. `x.class`, `x.new`, `x.default` are
      // members, not syntax, and testing the keyword first is how a member came to be
      // tinted as one even after the list was trimmed.
      push(best.text, isProp ? (isCall ? "tok-fn" : "tok-prop") : kw.has(best.text) ? "tok-kw" : isCall ? "tok-fn" : "");
    } else {
      push(best.text, best.cls);
    }
    rest = rest.slice(best.index + best.text.length);
  }
  return out;
}

/**
 * A fenced code block with its own copy button (task 0a8afe16).
 *
 * The reply already has a copy button, but it copies the WHOLE reply - and the case that
 * prompted this is the one where the code block IS the deliverable: a long block of markdown
 * to paste somewhere else, wrapped in a sentence of chat that must not come with it. Selecting
 * it by hand means dragging through a scrolling box.
 *
 * Same icon, states and timing as the reply-level button, and hidden until the block is
 * hovered for the same reason that one is: a control on every block, always visible, reads as
 * noise (which is why the reply's button stopped being a text label).
 */
function codeBlockEl(code, lang = "") {
  const wrap = document.createElement("div");
  wrap.className = "md-code-wrap";
  const pre = document.createElement("pre");
  pre.className = "md-code-block";
  // Coloured into spans this code creates - never innerHTML. An unknown language yields
  // one uncoloured span, i.e. exactly what every block looked like before.
  const tokens = highlightCode(code, lang);
  if (tokens.length === 1 && !tokens[0].cls) {
    pre.textContent = code;
  } else {
    for (const t of tokens) {
      if (!t.cls) {
        pre.append(document.createTextNode(t.text));
        continue;
      }
      const span = document.createElement("span");
      span.className = t.cls;
      span.textContent = t.text;
      pre.append(span);
    }
  }
  // The language, said out loud: it is what tells you whether the colours mean anything,
  // and an unlabelled block gave no way to tell a Lua block from an unrecognised one.
  //
  // In a header ROW above the code, not floated over it. The first version pinned it to the
  // block's top-right corner, where it sat on top of the first line of code - visible in a
  // screenshot immediately, invisible to every assertion I had written.
  if (lang) {
    const head = document.createElement("div");
    head.className = "md-code-head";
    const tag = document.createElement("span");
    tag.className = "md-code-lang";
    tag.textContent = lang;
    head.append(tag);
    wrap.append(head);
    wrap.classList.add("has-lang");
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "code-copy-btn";
  btn.title = "Copy this block";
  btn.textContent = "⧉";
  btn.addEventListener("click", (e) => {
    // The block sits inside a bubble that has its own click handlers (and, for a user turn,
    // an edit affordance) - copying must not also trigger those.
    e.stopPropagation();
    window.helm.copyToClipboard(pre.textContent);
    btn.textContent = "✓";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "⧉";
      btn.classList.remove("copied");
    }, 1200);
  });
  wrap.append(pre, btn);
  return wrap;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Splits a non-code segment into GFM table blocks (rendered as real <table>
// elements, matching the desktop app) and plain lines.
function renderTextBlock(container, text) {
  const lines = text.split("\n");
  let i = 0;
  let plainRun = [];
  const flushPlain = () => {
    if (plainRun.length) {
      renderInlineLines(container, plainRun.join("\n"));
      plainRun = [];
    }
  };
  while (i < lines.length) {
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      flushPlain();
      const tableLines = [lines[i]];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      container.append(tableEl(lines[i], tableLines.slice(1)));
      i = j;
    } else {
      plainRun.push(lines[i]);
      i++;
    }
  }
  flushPlain();
}

// Splits a table row on "|" the way GFM actually requires: a pipe inside an
// inline code span (`...`) or escaped as "\|" is literal cell content, not a
// column delimiter. A naive line.split("|") mangles any cell containing
// either — e.g. a cell showing `Set-Cookie: a|b` would split into two
// columns instead of one, misaligning the whole row.
function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function tableEl(headerLine, bodyLines) {
  const table = document.createElement("table");
  table.className = "md-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  tableCells(headerLine).forEach((cell) => {
    const th = document.createElement("th");
    th.append(...inlineFormat(cell));
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  bodyLines.forEach((line) => {
    const tr = document.createElement("tr");
    tableCells(line).forEach((cell) => {
      const td = document.createElement("td");
      td.append(...inlineFormat(cell));
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  return table;
}

// The block constructs the renderer used to drop on the floor (task c6094e4f). Each is a
// line-level shape, matched here once so both the "is this a block?" test and the renderer
// agree - they disagreed in the first version and a heading got a <br> after it.
const HEADING = /^(#{1,6})\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const isListLine = (line) => /^\s*[-*]\s+/.test(line);
/**
 * A line that renders as its own block element.
 *
 * Everything here is display:block and self-breaks, so a <br> next to one is a doubled
 * gap - the exact bug the bullet handling already carried a comment about.
 */
const isBlockLine = (line) =>
  isListLine(line) || HEADING.test(line) || ORDERED.test(line) || QUOTE.test(line) || RULE.test(line);

// Walks from idx in the given direction (-1 back, +1 forward), skipping
// blank separator lines, and returns the nearest actual content line (or ""
// if the text runs out first). A plain "lines[idx-1]"/"lines[idx+1]" check
// only sees ONE line away — with two-or-more consecutive blank lines
// between a list and the next paragraph (or vice versa), that only catches
// the single blank immediately touching the list, leaving the rest to
// render as ordinary empty lines and reintroduce the doubled-gap problem
// this whole block exists to avoid.
function nearestContentLine(lines, idx, direction) {
  for (let i = idx + direction; i >= 0 && i < lines.length; i += direction) {
    if (lines[i].trim() !== "") {
      return lines[i];
    }
  }
  return "";
}

/**
 * One list item: a marker beside a body that wraps under itself.
 *
 * The content goes in its OWN span, which is what lets the row be a flex row - the first
 * attempt used a negative text-indent to hang the marker, and at the bubble's padding that
 * pulled every marker outside the bubble and clipped it (seen in a screenshot, not
 * reasoned about). With a flex row the marker cannot leave the box, and a wrapped line
 * lines up under the text rather than under the bullet.
 */
function listItemEl(markerText, content, extraClass) {
  const li = document.createElement("div");
  li.className = "md-li" + (extraClass ? ` ${extraClass}` : "");
  const marker = document.createElement("span");
  marker.className = "md-marker";
  marker.textContent = markerText;
  const body = document.createElement("span");
  body.className = "md-li-body";
  body.append(...inlineFormat(content));
  li.append(marker, body);
  return li;
}

function renderInlineLines(container, text) {
  const lines = text.split("\n");
  // Set when a blank line was swallowed as a paragraph break, so the NEXT line can carry
  // the margin instead of an empty element carrying nothing.
  let paragraphBreakPending = false;
  lines.forEach((line, idx) => {
    const nextLine = lines[idx + 1];
    const isBlank = line.trim() === "";
    const isList = isListLine(line);

    // A blank line whose only job in the source markdown is separating list
    // items isn't content — rendering it (an empty <span> + a trailing <br>)
    // both doubled the visible gap AND sat between the two .md-li divs,
    // breaking their sibling adjacency so ".md-li + .md-li" (meant to
    // tighten spacing between bullets) never actually matched anything.
    // Checks the nearest CONTENT line in each direction, not just one line
    // away — two or more consecutive blank lines between a list and the
    // next paragraph would otherwise leave every blank past the first to
    // render as an ordinary empty line, reintroducing the doubled gap.
    // Widened from lists to every BLOCK line for the same reason: a blank line between
    // two bullets, two numbered items, two quote lines or a heading and its paragraph is
    // separator syntax, not content, and rendering it doubles the gap the block's own
    // margin already provides.
    if (isBlank && (isBlockLine(nearestContentLine(lines, idx, -1)) || isBlockLine(nearestContentLine(lines, idx, 1)))) {
      return;
    }

    // A blank line between two PLAIN lines is a paragraph break, and the card asks for
    // "generöst radavstånd + stycke-marginaler". It used to render as an empty span plus a
    // <br>: a blank line's worth of gap, from line-height, with no margin anywhere - which
    // an independent review measured (all margins 0). Now the blank is dropped and the
    // paragraph that follows carries a real top margin, so the gap between paragraphs is
    // deliberate and bigger than the gap between wrapped lines.
    if (isBlank && lines.slice(idx + 1).some((l) => l.trim() !== "")) {
      paragraphBreakPending = true;
      return;
    }

    const heading = HEADING.exec(line);
    const ordered = ORDERED.exec(line);
    const quote = QUOTE.exec(line);

    if (heading) {
      // Levels 1-3 get their own size; deeper ones share the smallest. A chat bubble is
      // not a document, so h1 maps to the bubble's largest heading rather than a page
      // title, and the hierarchy is what matters - it is the anchor the eye comes back to.
      const level = Math.min(heading[1].length, 3);
      const h = document.createElement("div");
      h.className = `md-h md-h${level}`;
      h.append(...inlineFormat(heading[2]));
      container.append(h);
    } else if (RULE.test(line)) {
      const hr = document.createElement("div");
      hr.className = "md-hr";
      container.append(hr);
    } else if (quote) {
      // Consecutive quote lines each render as a row; the CSS joins them into one rail so
      // a multi-line quote does not look like several.
      const q = document.createElement("div");
      q.className = "md-quote";
      q.append(...inlineFormat(quote[1]));
      container.append(q);
    } else if (ordered) {
      // The author's own number, not a re-count: a reply that starts at 3 means 3.
      container.append(listItemEl(ordered[1] + ".", ordered[2], "md-oli"));
    } else if (isList) {
      const listMatch = /^\s*[-*]\s+(.*)$/.exec(line);
      container.append(listItemEl("•", listMatch[1], null));
    } else {
      const lineSpan = document.createElement("span");
      // The transition INTO a list gets a deliberate gap (.md-li's own
      // margin-top). The transition OUT of one got nothing — a plain <span>
      // has no margin rule at all, so the line right after the last bullet
      // sat flush against it with only incidental line-height between them,
      // reading as "tight"/inconsistent next to every other spaced
      // transition. This class gives it the matching gap.
      if (isBlockLine(nearestContentLine(lines, idx, -1))) {
        lineSpan.className = "md-after-list";
      } else if (paragraphBreakPending) {
        // The paragraph margin the swallowed blank line stood for.
        lineSpan.className = "md-para";
      }
      lineSpan.append(...inlineFormat(line));
      container.append(lineSpan);
    }
    paragraphBreakPending = false;

    // A list item is already display:block and self-breaks onto its own
    // line — a <br> touching one on either side is exactly what broke
    // .md-li adjacency above. Only insert one between two plain lines.
    // Widened to every block line: a heading, a numbered item, a quote row and a rule all
    // self-break too, so a <br> beside any of them is a doubled gap.
    if (idx < lines.length - 1 && !isBlockLine(line) && !isBlockLine(nextLine || "")) {
      container.append(document.createElement("br"));
    }
  });
}

/**
 * Inline markdown: bold, inline code, italic, and links.
 *
 * Bold and code were all it did (task c6094e4f) - so an italic word rendered with its
 * asterisks and a link rendered as its own source, both of which are worse than plain
 * text because they look like a mistake.
 *
 * Order in the alternation matters: `**` before `*` (otherwise bold is read as two
 * italics), and code before both so markdown characters inside a code span stay literal.
 * A link's href is not trusted blindly - only http(s) becomes a real link, so a
 * javascript: or file: URL in a reply cannot become a clickable one.
 */
function inlineFormat(text) {
  const nodes = [];
  // Each alternative is narrower than it looks, and the narrowing is the point - an
  // independent review found three ways the first version was wrong:
  //  - a link href may contain ONE level of parentheses. `[x](https://e.com/a_(b)_c)`
  //    stopped at the first ")", so the href silently pointed somewhere else - worse than
  //    the old behaviour of showing the source, because it looked like a working link.
  //  - `2 * 3 * 4` was read as an italic: the asterisks must not be followed or preceded
  //    by whitespace, which is the rule real markdown uses too.
  //  - `**fet *och* kursiv**` left literal asterisks, because bold's content was set as
  //    text. Bold and italic now format their own contents (see below), so nesting works.
  const regex =
    /(`[^`]+`|\*\*(?=\S)[\s\S]*?\S\*\*|__(?=\S)[\s\S]*?\S__|\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\)|(?<![\w*])\*(?=\S)[^*\n]*?\S\*(?![\w*])|(?<![\w_])_(?=\S)[^_\n]*?\S_(?![\w_]))/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text))) {
    if (m.index > lastIndex) {
      nodes.push(document.createTextNode(text.slice(lastIndex, m.index)));
    }
    const token = m[0];
    // The SAME paren-tolerant shape as the alternation above. Leaving this one strict was
    // the actual bug behind the wrong href: the token matched, this did not, and the token
    // fell through to the italic branch - so a link with parentheses rendered as an <em>.
    // Two spellings of one pattern, again.
    const link = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/.exec(token);
    if (token.startsWith("`")) {
      const c = document.createElement("code");
      c.textContent = token.slice(1, -1);
      nodes.push(c);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const b = document.createElement("strong");
      // Its contents are formatted too, so *italic* and `code` inside bold survive
      // instead of showing their own markers. Terminates: the inner text is strictly
      // shorter than the token it came from.
      b.append(...inlineFormat(token.slice(2, -2)));
      nodes.push(b);
    } else if (link) {
      const [, label, href] = link;
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement("a");
        a.className = "md-link";
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.textContent = label;
        a.title = href;
        nodes.push(a);
      } else {
        // A relative path (scripts/e2e/foo.mjs) or anything not http: shown as the label
        // with the target beside it - readable, and not a clickable unknown scheme.
        const span = document.createElement("span");
        span.className = "md-link-plain";
        span.textContent = label;
        span.title = href;
        nodes.push(span);
      }
    } else {
      const em = document.createElement("em");
      em.append(...inlineFormat(token.slice(1, -1)));
      nodes.push(em);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(document.createTextNode(text.slice(lastIndex)));
  }
  return nodes;
}

// MODEL_FIT_ICON / MODEL_FIT_LABEL lived here until 2026-08-30, for the judge's verdict
// line under the composer. The judge is gone; the historical tally it produced is in
// DECISIONS.md and in the analysis view.

// Renders a user turn's text into `bubble`, turning `[Attached image: <path>]`
// marker lines into inline thumbnails (click → lightbox) so pasted images show
// in the transcript instead of the literal marker text. Plain messages (no
// markers) keep the exact previous behavior (`textContent = text`). Covers both
// live-sent turns and reloaded-session turns, since both carry the same raw
// marker in turn.text. DOM is built via createElement/createTextNode (never
// innerHTML for paths) to avoid injection from odd filenames.
function renderUserTurnInto(bubble, text) {
  const segments = parseAttachmentLines(text);
  const hasAttachment = segments.some((s) => s.type === "image" || s.type === "file");
  if (!hasAttachment) {
    bubble.textContent = text;
    return;
  }
  for (const seg of segments) {
    if (seg.type === "image") {
      const img = document.createElement("img");
      img.className = "turn-image";
      img.src = toFileUrl(seg.path);
      img.title = "Click to enlarge";
      img.addEventListener("click", () => showImageLightbox(img.src));
      bubble.append(img);
    } else if (seg.type === "file") {
      const chip = document.createElement("span");
      chip.className = "turn-file-chip";
      const clip = document.createElement("span");
      clip.className = "attachment-clip-icon";
      clip.innerHTML = PAPERCLIP_ICON;
      chip.append(clip);
      const base = seg.path.split(/[\\/]/).pop() || seg.path;
      chip.append(document.createTextNode(base));
      bubble.append(chip);
    } else if (seg.text.trim() !== "") {
      // Skip whitespace-only text segments (e.g. the blank line the composer
      // inserts between markers and typed text) so no stray empty node renders.
      const span = document.createElement("span");
      span.className = "turn-text";
      span.textContent = seg.text;
      bubble.append(span);
    }
  }
}

/**
 * A collapsed "Thought process" row you can open (the captain: "Jag vill kunna expandera för att se
 * thought process - som i desktop appen").
 *
 * Collapsed by DEFAULT and deliberately not a chat bubble. Two reasons it is its own element
 * rather than an assistant bubble:
 *
 *   - the reply is what you read; reasoning is what you go looking for. Expanded by default it
 *     would bury every actual answer under the working that led to it.
 *   - wireDoneButtonOnLastReply and the turn-stats/question decorations all attach to the LAST
 *     `.turn.assistant .turn-bubble` on the page. If reasoning were a bubble, those would
 *     start landing on the thinking block instead of the answer - the Done button would move
 *     somewhere meaningless, silently.
 *
 * The text goes through the markdown renderer, so it reads as prose rather than one block.
 */
function thinkingTurnEl(turn) {
  const wrap = document.createElement("div");
  wrap.className = "turn-thinking";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "turn-thinking-toggle";
  const body = document.createElement("div");
  body.className = "turn-thinking-body hidden";
  renderMarkdownInto(body, turn.text || "");
  const label = () => {
    const open = !body.classList.contains("hidden");
    toggle.textContent = `${open ? "▾" : "▸"} Thought process`;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => {
    body.classList.toggle("hidden");
    label();
  });
  label();
  wrap.append(toggle, body);
  return wrap;
}

function turnEl(turn) {
  if (turn.kind === "tool_result") {
    const el = document.createElement("div");
    el.className = "turn-tool-result";
    el.textContent = turn.text;
    return el;
  }
  if (turn.kind === "task_notification") {
    return taskNotificationEl(turn.text);
  }
  if (turn.kind === "compact_boundary") {
    return compactBoundaryEl(turn);
  }
  if (turn.kind === "thinking") {
    return thinkingTurnEl(turn);
  }
  const wrap = document.createElement("div");
  wrap.className = "turn " + turn.role;
  const bubble = document.createElement("div");
  bubble.className = "turn-bubble";
  if (turn.role === "assistant") {
    renderMarkdownInto(bubble, turn.text);
  } else {
    renderUserTurnInto(bubble, turn.text);
  }
  wrap.append(bubble);

  if (turn.role === "assistant") {
    // Icon-only, shown on hover (was an always-visible "Copy" text button —
    // per feedback that read as too loud sitting under every single reply).
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.title = "Copy";
    copyBtn.textContent = "⧉";
    copyBtn.addEventListener("click", () => {
      window.helm.copyToClipboard(turn.text);
      copyBtn.textContent = "✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "⧉";
        copyBtn.classList.remove("copied");
      }, 1200);
    });
    // A row, not a column — so a "Done" button (added later, only on the
    // LAST reply, by wireDoneButtonOnLastReply) sits BESIDE copy, not
    // stacked under it. Every reply gets this row; only the last one ever
    // gets a second button in it.
    const actions = document.createElement("div");
    actions.className = "turn-actions";
    actions.append(copyBtn);
    wrap.append(actions);
  }

  return wrap;
}

// A run of consecutive tool calls collapses into ONE plain, unboxed
// "Used N tools" line — matching the desktop app's flat "Used 3 tools ›" /
// "Searched code ›" style — instead of a separate bordered box per call
// (which read as heavy/boxy per feedback comparing the two side by side).
// A background task/subagent completion, delivered as raw <task-notification>
// XML — shown as a compact expandable line (like a tool call), not as a
// normal chat bubble, since the captain didn't actually type this.
function taskNotificationEl(rawText) {
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(rawText);
  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(rawText);
  const status = statusMatch ? statusMatch[1].trim() : "unknown";
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "Background task";
  const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : "◔";

  const details = document.createElement("details");
  details.className = "tool-group";
  const summary = document.createElement("summary");
  summary.textContent = `${icon} Background task: ${truncateText(summaryText, 100)}`;
  details.append(summary);
  const pre = document.createElement("pre");
  pre.className = "tool-call-output";
  pre.textContent = rawText;
  details.append(pre);
  return details;
}

function truncateText(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// A centered divider marking where the conversation was compacted — shown
// for ANY compaction found in the transcript: the CLI's own auto-compact
// when the window fills (trigger "auto"), Helm's Fas 3 auto-compact, or a
// manual /compact (both "manual"). Mirrors the desktop app showing where
// context was summarized. The captain's ask: "skriv även ut i chatten med en pill
// att compacting skett."
function compactBoundaryEl(turn) {
  const wrap = document.createElement("div");
  wrap.className = "compact-boundary";
  const pill = document.createElement("span");
  pill.className = "compact-boundary-pill";
  const triggerLabel = turn.trigger === "auto" ? "auto" : "manual";
  const fmt = (n) => (typeof n === "number" ? `${Math.round(n / 1000)}k` : "?");
  const sizePart =
    typeof turn.preTokens === "number" && typeof turn.postTokens === "number"
      ? ` · ${fmt(turn.preTokens)} → ${fmt(turn.postTokens)} tokens`
      : "";
  pill.textContent = `⊟ Context compacted (${triggerLabel})${sizePart}`;
  pill.title = "The conversation before this point was summarized to free up context. The full history is still on disk.";
  wrap.append(pill);
  return wrap;
}

function toolOutputEl(text) {
  const pre = document.createElement("pre");
  pre.className = "tool-call-output";
  pre.textContent = text;
  return pre;
}

function toolGroupEl(pairs) {
  const details = document.createElement("details");
  details.className = "tool-group";
  details.append(document.createElement("summary"));
  const list = document.createElement("div");
  list.className = "tool-group-list";
  details.append(list);
  // The names are kept on the element because the summary line counts ALL the
  // calls in the group, and a group can be extended after it is drawn.
  details._toolNames = [];
  extendToolGroup(details, pairs);
  return details;
}

// Adds tool calls to a group that is already on screen. Used by the append-only
// redraw so a streaming tool run doesn't rebuild the group it belongs to. A
// side benefit that was a real annoyance before: a group the captain had
// expanded snapped shut on every streamed chunk, because the full rebuild
// replaced the <details> element and a new one starts closed.
function extendToolGroup(details, pairs) {
  const list = details.querySelector(".tool-group-list");
  const names = details._toolNames || (details._toolNames = []);
  pairs.forEach(({ useTurn, resultTurn }) => {
    names.push(useTurn.toolName);
    const item = document.createElement("details");
    item.className = "tool-call-item";
    const itemSummary = document.createElement("summary");
    itemSummary.textContent = `${useTurn.toolName}${useTurn.toolInput ? " · " + useTurn.toolInput : ""}`;
    item.append(itemSummary);
    if (resultTurn) {
      item.append(toolOutputEl(resultTurn.text));
    }
    list.append(item);
  });
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
  details.querySelector("summary").textContent =
    (names.length === 1 ? "Used 1 tool" : `Used ${names.length} tools`) + `: ${shown}${extra}`;
}

// Continues an on-screen tool group with turns[from..], and returns the index of
// the first turn it did NOT consume.
//
// Two shapes have to be handled, and getting either wrong loses a turn from the
// transcript rather than just drawing it oddly:
//  - a tool_result for a tool_use that was drawn before the result arrived: it
//    belongs to the item already on screen, not to a new one;
//  - a tool_result with no such item waiting: it is a lone result, which the
//    full rebuild draws as its own block, so leave it to the caller.
function extendToolGroupWithTurns(details, turns, from) {
  const list = details.querySelector(".tool-group-list");
  let i = from;
  if (turns[i].kind === "tool_result") {
    const lastItem = list.lastElementChild;
    if (lastItem && !lastItem.querySelector(".tool-call-output")) {
      lastItem.append(toolOutputEl(turns[i].text));
      i++;
    } else {
      return i;
    }
  }
  const pairs = [];
  while (i < turns.length && turns[i].kind === "tool_use") {
    const useTurn = turns[i];
    const next = turns[i + 1];
    const resultTurn = next && next.kind === "tool_result" ? next : null;
    pairs.push({ useTurn, resultTurn });
    i += resultTurn ? 2 : 1;
  }
  if (pairs.length > 0) {
    extendToolGroup(details, pairs);
  }
  return i;
}

// Renders turns[fromIndex..] into `scroll`, stamping each element with the
// absolute index of the first turn it covers. That stamp is what makes an
// append-only redraw possible (see renderPaneTailOnly): without it there is no
// way to tell which DOM children belong to which turns, so the only safe redraw
// is to throw the whole transcript away and rebuild it.
function appendTurns(scroll, turns, fromIndex = 0) {
  let i = fromIndex;
  while (i < turns.length) {
    const at = i;
    let el;
    if (turns[i].kind === "tool_use") {
      const pairs = [];
      while (i < turns.length && turns[i].kind === "tool_use") {
        const useTurn = turns[i];
        const next = turns[i + 1];
        const resultTurn = next && next.kind === "tool_result" ? next : null;
        pairs.push({ useTurn, resultTurn });
        i += resultTurn ? 2 : 1;
      }
      el = toolGroupEl(pairs);
    } else {
      el = turnEl(turns[i]);
      i++;
    }
    el.dataset.turnFrom = String(at);
    scroll.append(el);
  }
}

// Coalesce renderPane calls per pane onto a deferred task (task f41a7f4e: "input
// lags when Helm is working on something else"). renderPane does a FULL transcript
// rebuild (innerHTML="" + re-append every turn + re-wire + a scrollTop reflow),
// and it fires on every streaming "assistant" event. A busy turn (several
// assistant blocks + usage + tool_use in quick succession) drove several full
// rebuilds back-to-back, synchronously, starving the textarea the user is typing
// in. Deferring (a) collapses a synchronous burst to a SINGLE rebuild and (b)
// yields the main thread so queued keystrokes are dispatched before the rebuild.
// Uses setTimeout(0), NOT requestAnimationFrame: rAF is throttled/paused when the
// Helm window is hidden or unfocused, which would stall live streaming updates for
// a background session until the window regains focus (Helm is a live-monitoring
// app - that regression is worse than the lag). setTimeout fires regardless of
// visibility. Terminal/user-initiated renders still call renderPane directly for
// immediacy; renderPane cancels any pending scheduled render so they never double-run.
const pendingPaneRenders = new Map(); // index -> setTimeout id
function scheduleRenderPane(index) {
  if (pendingPaneRenders.has(index)) {
    return; // a rebuild is already queued for this pane this tick - coalesce
  }
  pendingPaneRenders.set(
    index,
    setTimeout(() => {
      pendingPaneRenders.delete(index);
      renderPane(index);
    }, 0)
  );
}

function renderPane(index) {
  // If a coalesced render was queued for this pane, this direct call supersedes
  // it - drop the pending task so we don't rebuild twice.
  const pendingTimer = pendingPaneRenders.get(index);
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    pendingPaneRenders.delete(index);
  }
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  const pane = panes[index];
  const scroll = paneEl.querySelector(".pane-scroll");
  if (renderPaneTailOnly(index, pane, scroll)) {
    return;
  }
  // A full rebuild from here. Drop the record of what is drawn FIRST, so an
  // early return below (loading) can never leave a stale claim behind that the
  // append-only path would then trust.
  pane.rendered = null;
  scroll.innerHTML = "";

  if (pane.loading) {
    const loading = document.createElement("div");
    loading.className = "pane-empty";
    loading.textContent = "Loading history…";
    scroll.append(loading);
    return;
  }

  if (pane.hiddenCount > 0) {
    const btn = document.createElement("button");
    btn.className = "load-earlier";
    btn.textContent = `Show ${pane.hiddenCount} earlier messages`;
    btn.addEventListener("click", async () => {
      const { turns, hiddenCount, truncated } = await window.helm.getTranscript({
        cliSessionId: pane.cliSessionId,
        sessionId: pane.sessionId,
      });
      // Same additive merge as loadTranscriptInto: expanding the history must not drop a
      // prompt sent seconds ago that the file has not caught up with. This call site had
      // the identical blunt replacement, and fixing only the other one would have left the
      // class open.
      pane.turns = mergeReloadedTurns(pane.turns, turns, pane.sessionId);
      // Reflect the reload's ACTUAL state rather than hardcoding 0 — on a
      // genuinely huge session the reload can still be byte-capped, and
      // pretending it's complete would wrongly re-enable rewind (which needs
      // a from-turn-0 view to index correctly).
      pane.hiddenCount = hiddenCount || 0;
      pane.transcriptTruncated = !!truncated;
      renderPane(index);
    });
    scroll.append(btn);
  }

  if (pane.turns.length === 0 && pane.hiddenCount === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No history yet - start typing below.";
    scroll.append(empty);
  } else {
    appendTurns(scroll, pane.turns);
    wireEditableUserTurns(index, scroll);
    wireLastReplyDecorations(index, scroll);
    markPaneRendered(pane, scroll);
  }
  wireScrollToBottomButton(scroll);
  scroll.scrollTop = scroll.scrollHeight;
}

// What the pane's transcript DOM currently shows. The append-only redraw needs
// to know this to be sure the drawn messages are still the same ones - the tail
// grows during streaming, but a transcript RELOAD replaces every turn object,
// and drawing new text on top of an old prefix would be a corrupted transcript,
// which is worse than a slow one.
function markPaneRendered(pane, scroll) {
  pane.rendered = {
    scrollEl: scroll,
    count: pane.turns.length,
    tail: pane.turns[pane.turns.length - 1],
    hiddenCount: pane.hiddenCount,
    truncated: pane.transcriptTruncated,
    cliSessionId: pane.cliSessionId,
  };
}

// The three decorations that belong to whichever reply is currently LAST, so
// they move when a new reply arrives. Each is recomputed from state on every
// render, so the only thing needed to move them is to take the old ones off.
function wireLastReplyDecorations(index, scroll) {
  wireDoneButtonOnLastReply(index, scroll);
  wireTurnStatsOnLastReply(index, scroll);
  wireQuestionFlagOnLastReply(index, scroll);
}

function clearLastReplyDecorations(scroll) {
  scroll.querySelectorAll(".done-btn, .turn-stats, .needs-input-badge").forEach((el) => el.remove());
  scroll.querySelectorAll(".turn-bubble.needs-input").forEach((el) => el.classList.remove("needs-input"));
}

// The append-only redraw.
//
// A streaming turn only ever ADDS to the end of pane.turns, but the render for
// it tore the whole transcript down and rebuilt it: measured in the real app at
// 11.8ms for 50 turns, 32.6ms at 300 and 97.1ms at 800 - once per streamed
// block, on the one thread that also has to echo the captain's keystrokes. That
// is the input lag (task 9ca4fd1e), and it explains why a session feels heavier
// the longer it has been running: the cost is proportional to the number of
// messages already on screen, none of which changed.
//
// Returns true when it handled the render. Every bail-out below is a case where
// the DOM is NOT simply a shorter version of what should be on screen, and each
// one falls back to the full rebuild rather than guessing.
function renderPaneTailOnly(index, pane, scroll) {
  const drawn = pane.rendered;
  if (
    !drawn ||
    pane.loading ||
    drawn.scrollEl !== scroll || // renderSinglePane built a fresh scroll container
    drawn.count === 0 ||
    drawn.hiddenCount !== pane.hiddenCount || // the "show N earlier messages" button changed
    drawn.truncated !== pane.transcriptTruncated || // decides whether user turns get a rewind button
    drawn.cliSessionId !== pane.cliSessionId || // same: rewind needs a resumable session
    pane.turns.length < drawn.count ||
    pane.turns[drawn.count - 1] !== drawn.tail // a reload replaced the turns - not an append
  ) {
    return false;
  }

  clearLastReplyDecorations(scroll);
  if (pane.turns.length > drawn.count) {
    let from = drawn.count;
    const tailEl = lastDrawnTurnEl(scroll);
    // A tool run is ONE group element covering many turns, so turns that
    // continue that run have to join the group rather than start a second one
    // beside it.
    if (tailEl?.classList.contains("tool-group") && isToolTurn(pane.turns[from])) {
      from = extendToolGroupWithTurns(tailEl, pane.turns, from);
    }
    appendTurns(scroll, pane.turns, from);
    wireEditableUserTurns(index, scroll);
    // Keep the scroll-to-bottom affordance the last child, where the full
    // rebuild leaves it.
    const toBottom = scroll.querySelector(".scroll-to-bottom-wrap");
    if (toBottom) {
      scroll.append(toBottom);
    }
  }
  wireLastReplyDecorations(index, scroll);
  markPaneRendered(pane, scroll);
  scroll.scrollTop = scroll.scrollHeight;
  return true;
}

function isToolTurn(turn) {
  return turn?.kind === "tool_use" || turn?.kind === "tool_result";
}

function lastDrawnTurnEl(scroll) {
  for (let el = scroll.lastElementChild; el; el = el.previousElementSibling) {
    if (el.dataset?.turnFrom !== undefined) {
      return el;
    }
  }
  return null;
}

// A floating "↓" button that appears once the user has manually scrolled
// away from the bottom (e.g. to reread earlier history) and disappears once
// they're back at the bottom. renderPane rebuilds .pane-scroll's innerHTML
// on every call, so this — like the other wireX helpers — has to be
// re-attached every render, not wired once. Deliberately a sticky, zero-
// height wrapper as the LAST child of .pane-scroll rather than an
// absolutely-positioned sibling of the scroll container: it needs to sit
// pinned to the bottom of the SCROLLED viewport (following the user as they
// scroll), not to the pane's own fixed bottom edge.
function wireScrollToBottomButton(scroll) {
  const wrap = document.createElement("div");
  wrap.className = "scroll-to-bottom-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "scroll-to-bottom-btn";
  btn.title = "Scroll to bottom";
  // Inline SVG rather than the "↓" text glyph — text arrows have asymmetric
  // font metrics that no amount of flex-centering fixes (it kept looking
  // slightly high). A viewBox'd SVG is geometrically symmetric, so it
  // centers perfectly.
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  btn.addEventListener("click", () => {
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
  });
  wrap.append(btn);
  scroll.append(wrap);

  // `scroll` (.pane-scroll) is the SAME persistent DOM node across renders —
  // only its innerHTML gets cleared, not the element itself — so a plain
  // addEventListener here would pile up one more "scroll" listener on every
  // single renderPane call (every streamed chunk, every poll-triggered
  // update...) forever, each stale one still referencing its own
  // now-detached `wrap` from a past render. Removing the previous listener
  // (stashed on the element) before attaching the new one keeps exactly one
  // live listener at a time.
  if (scroll._scrollToBottomListener) {
    scroll.removeEventListener("scroll", scroll._scrollToBottomListener);
  }
  const SHOW_THRESHOLD_PX = 80;
  const listener = () => {
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    wrap.classList.toggle("visible", distanceFromBottom > SHOW_THRESHOLD_PX);
  };
  scroll.addEventListener("scroll", listener);
  scroll._scrollToBottomListener = listener;
}

// Double-click ANY past user message to copy it back into the prompt box for
// editing + resend. Does not alter history — the CLI can't retract a turn via
// --resume, so this is "edit and send again" (appends as a new turn), not a
// true rewind/branch like the desktop app's retry icon.
//
// The real "rewind to here" (mirroring the desktop app's own icon) is the
// separate button added below: it replaces the CURRENT pane in place with a
// fresh draft that replays the conversation up to (not including) this
// message, then the message itself. Per the captain's review it stays in the same
// pane (feels like going back in this conversation, not a new pane popping
// up) — but underneath it's a fresh forked session, because --resume can't
// retract turns, so this is the only way to genuinely drop future context
// rather than just hide it.
function wireEditableUserTurns(index, scroll) {
  const pane = panes[index];
  // Correlates 1:1 and in DOM order with ".turn.user .turn-bubble" elements:
  // turnEl() only gives a user turn that plain bubble treatment when its
  // kind is "text" (a tool_result gets a separate .turn-tool-result div, and
  // a task_notification is role "system", not "user").
  const userTextTurns = pane.turns.filter((t) => t.role === "user" && t.kind === "text");
  scroll.querySelectorAll(".turn.user .turn-bubble").forEach((bubble, i) => {
    // `i` stays the correct global ordinal on an append-only redraw because the
    // earlier bubbles are still in the DOM, in order - that is the whole reason
    // this query runs over the entire scroll rather than over the new nodes.
    // But the earlier bubbles already carry their listener and rewind button, so
    // re-wiring them would stack a second dblclick handler and a second ⤺ per
    // streamed chunk.
    if (bubble.dataset.editWired === "1") {
      return;
    }
    bubble.dataset.editWired = "1";
    bubble.classList.add("editable");
    bubble.title = "Double-click to edit and resend";
    bubble.addEventListener("dblclick", () => {
      const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
      const promptEl = paneEl?.querySelector(".pane-composer textarea");
      if (promptEl) {
        promptEl.value = bubble.textContent;
        promptEl.focus();
        promptEl.dispatchEvent(new Event("input"));
      }
    });

    const turn = userTextTurns[i];
    const wrap = bubble.parentElement;
    if (!turn || !wrap) {
      return;
    }
    // `i` is exactly this message's index among real user messages — the same
    // count the main-process fork uses to find the truncation point. Only
    // offer rewind on a real (resumable) session AND when the FULL transcript
    // is loaded from turn 0 — on a truncated (tail-capped) view the rendered
    // index wouldn't match the fork's absolute count, so it'd cut at the
    // wrong message. `turn.pending` rules out a message sent seconds ago that
    // the transcript FILE has not caught up with yet: forkTranscriptAtUserMessage
    // counts user messages straight off disk, so rewinding to one that is not
    // written there yet finds no match and silently forks the whole file
    // untouched instead of truncating - a no-op that reads as "rewind doesn't
    // work" (Jot 19096e2c: "iaf inte om man lämnar sessionen efter att ha
    // skickat men innan svar" - leaving right after sending is exactly the
    // window where the just-sent message is still pending, not yet on disk).
    if (pane.cliSessionId && !pane.transcriptTruncated && !turn.pending) {
      const rewindBtn = document.createElement("button");
      rewindBtn.className = "copy-btn rewind-btn";
      rewindBtn.title = "Rewind to here - go back to this point, dropping everything after it";
      rewindBtn.textContent = "⤺";
      rewindBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        rewindToTurn(index, i, turn.text);
      });
      wrap.append(rewindBtn);
    }
  });
}

// Manual "I'm done with this" — the captain's ask: a session can end with a real
// answer (e.g. "here's what to tell your colleagues") that needs nothing
// further, but still sits in "Needs you" until the attention window expires.
// Per his correction, this lives ON the reply itself ("per svar, inte per
// session") rather than as a sidebar-row pill — only the LAST assistant
// reply gets the button, since that's the one whose ack actually matters
// (session status is derived from the last message's role/age; acking an
// older reply that already has a newer one after it wouldn't change
// anything). Reuses the same config.acknowledgedSessions mechanism as
// before — only the affordance's location changed, not the backend.
function wireDoneButtonOnLastReply(index, scroll) {
  const pane = panes[index];
  const session = sessionById(pane.sessionId);
  if (!session) {
    return;
  }
  // isAcked is an EXACT match against the timestamp stored at ack time (see
  // main.js's status-override loop, which uses >= for the same comparison —
  // exact equality here is the more precise check for "is the reply I'm
  // currently drawing the specific one that got acknowledged," since the ack
  // value can never exceed the current lastActivityAt unless new activity
  // moved it forward, at which point this is correctly false again).
  const isAcked = state.config.acknowledgedSessions?.[session.sessionId] === session.lastActivityAt;
  if (session.status !== "waiting" && !isAcked) {
    return;
  }
  const bubbles = scroll.querySelectorAll(".turn.assistant .turn-bubble");
  const lastBubble = bubbles[bubbles.length - 1];
  const actions = lastBubble?.parentElement.querySelector(".turn-actions");
  if (!actions) {
    return;
  }
  const done = document.createElement("button");
  done.type = "button";
  // "copy-btn" gives it the same hover-only reveal as the Copy button beside
  // it (the captain's ask: "en check ikon bredvid copy ikonen som endast dyker upp
  // på hover"). ".acked" overrides that to always-visible + accent-colored —
  // a persistent checkmark on the reply itself ("när den är checkad dyker en
  // checkmark upp på svaret"), not just a transient hover flash. Toggleable
  // (the captain: "checkmarken bör gå att ta bort också, eller?") — a checkbox you
  // can't uncheck would be an odd affordance, and un-acking is exactly
  // "actually, this does need attention again," the same real state
  // acknowledgedSessions already models.
  let acked = isAcked;
  const applyAckedVisual = () => {
    done.classList.toggle("acked", acked);
    done.title = acked ? "Marked done - click to undo" : "Nothing left to do here - mark done (comes back automatically if new activity happens).";
  };
  done.className = "copy-btn done-btn";
  done.textContent = "✓";
  applyAckedVisual();
  done.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Instant local feedback, same pattern as the copy button's own
    // immediate icon swap, ahead of the async round-trip settling for real.
    acked = !acked;
    applyAckedVisual();
    const acknowledgedSessions = { ...(state.config.acknowledgedSessions || {}) };
    if (acked) {
      acknowledgedSessions[session.sessionId] = session.lastActivityAt;
    } else {
      delete acknowledgedSessions[session.sessionId];
    }
    state.config = await window.helm.setConfig({ acknowledgedSessions });
    refresh();
  });
  // prepend, not append: Done sits BEFORE Copy in the row. With append, the
  // acked (always-visible) checkmark would sit to the RIGHT of Copy's
  // hover-only slot — so on an acked reply, hovering makes Copy pop in to
  // its LEFT, shifting the checkmark sideways. Leading position keeps the
  // checkmark's spot fixed regardless of hover state.
  actions.prepend(done);
}

// "12.3s · 1.2k tokens" readout under the reply that JUST completed —
// the captain's ask, modeled on Claude Desktop's small per-reply stats line. Reuses
// data already flowing through the app rather than adding new plumbing:
// durationMs/totalTokens/costUsd ride along on the "done" event's summary
// (launcher.js's own result-event fields, the same authoritative source
// already used for the usage log and the context-window learning). Only
// meaningful for the reply from the run that JUST finished in THIS pane —
// there's no per-turn usage parsed out of a reloaded transcript (see
// transcript.js), so older replies (and a freshly reopened session) simply
// show no stats line, same as Claude Desktop only ever showing this for the
// turn that just streamed in.
//
// Deliberately NON-destructive (unlike an earlier version of this function,
// which nulled pane.lastTurnStats out the first time it was read): a queued
// prompt can fire and trigger an intermediate renderPane() BEFORE the
// transcript reload that follows a "done" event resolves (see the "done"
// handler — loadTranscriptInto is not awaited before fireQueuedPromptIfAny
// runs). If this function had consumed the stats on that first, intermediate
// render, they'd already be gone by the time the reload's OWN renderPane call
// redraws the same reply from scratch (scroll.innerHTML="" every time) —
// visually flashing the stats in and then losing them. Recomputing on every
// render instead (same pattern as wireDoneButtonOnLastReply's isAcked check)
// makes it reliably reattach until sendFromPane explicitly clears it once a
// NEW turn starts (the point where "the reply that just completed" is no
// longer the last one).
function wireTurnStatsOnLastReply(index, scroll) {
  const pane = panes[index];
  const stats = pane.lastTurnStats;
  if (!stats) {
    return;
  }
  const bubbles = scroll.querySelectorAll(".turn.assistant .turn-bubble");
  const lastBubble = bubbles[bubbles.length - 1];
  const actions = lastBubble?.parentElement.querySelector(".turn-actions");
  if (!actions) {
    return;
  }
  const parts = [];
  if (typeof stats.durationMs === "number") {
    parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof stats.totalTokens === "number") {
    parts.push(stats.totalTokens >= 1000 ? `${(stats.totalTokens / 1000).toFixed(1)}k tokens` : `${stats.totalTokens} tokens`);
  }
  if (parts.length === 0) {
    return;
  }
  const meta = document.createElement("span");
  meta.className = "turn-stats";
  meta.textContent = parts.join(" · ");
  if (typeof stats.costUsd === "number" && stats.costUsd > 0) {
    meta.title = `$${stats.costUsd.toFixed(4)}`;
  }
  actions.append(meta);
}

// Cheap, synchronous heuristic for "is this completed reply actually asking
// the user something." Headless -p mode has NO live pause-and-ask mechanism
// (see DECISIONS.md's 2026-07-03 persistent-process spike — confirmed
// architecturally impossible here, not something to try to build), so a real
// blocking input dialog like Claude Desktop's is off the table. This is the
// agreed approximation: flag it visually so it's not mistaken for an
// ordinary "here's the answer, nothing left to do" reply — the user still
// answers via the normal composer either way, this only changes how the
// reply is drawn. Deliberately NOT an LLM call (keep it cheap/synchronous):
// ends-with-a-question-mark on the last non-empty line, PLUS a couple of
// common phrasings that ask for input without necessarily ending in "?"
// (e.g. "let me know which..."). A text heuristic will have false positives/
// negatives (a rhetorical question, a code snippet ending in "?") — fine for
// a "don't miss this" visual nudge, not a correctness-critical gate.
const QUESTION_PHRASE_RE = /\b(let me know|which (one|option|approach)|should i|do you want|would you like|please (confirm|choose|clarify|specify))\b/i;
function looksLikeQuestion(text) {
  if (!text) {
    return false;
  }
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] || "";
  if (/\?\s*$/.test(lastLine)) {
    return true;
  }
  // Also check the last couple of lines for a common ask-for-input phrasing
  // that doesn't end in "?" (e.g. "Let me know how you'd like to proceed.").
  const tail = lines.slice(-2).join(" ");
  return QUESTION_PHRASE_RE.test(tail);
}

// Flags the LAST assistant reply with a distinct visual treatment when it
// looks like it's asking the user something — see looksLikeQuestion above.
// Restricted to the last reply of a pane that's currently NOT busy (a
// mid-run streamed chunk isn't "a completed turn" yet, and only the final
// reply of a finished turn is the one actually awaiting the user's answer).
// Non-destructive/idempotent like the other wireX helpers here — recomputed
// on every render rather than consumed once, so it survives the same
// queued-prompt intermediate-render hazard documented on
// wireTurnStatsOnLastReply above.
function wireQuestionFlagOnLastReply(index, scroll) {
  const pane = panes[index];
  if (pane.busy) {
    return;
  }
  const bubbles = scroll.querySelectorAll(".turn.assistant .turn-bubble");
  const lastBubble = bubbles[bubbles.length - 1];
  if (!lastBubble) {
    return;
  }
  const lastTurn = pane.turns.filter((t) => t.role === "assistant" && t.kind === "text").at(-1);
  const isQuestion = looksLikeQuestion(lastTurn?.text);
  lastBubble.classList.toggle("needs-input", isQuestion);
  if (isQuestion && !lastBubble.querySelector(".needs-input-badge")) {
    const badge = document.createElement("span");
    badge.className = "needs-input-badge";
    badge.textContent = "❓ Needs your input";
    lastBubble.prepend(badge);
  } else if (!isQuestion) {
    lastBubble.querySelector(".needs-input-badge")?.remove();
  }
}

// Real "rewind to here" via transcript forking (verified in
// spike/test-rewind-fork.mjs): ask main to fork the session's transcript
// truncated to just before user message #userMsgIndex, then load that fork
// IN THE SAME pane. The result is exactly the desktop app's behavior —
// messages before the rewind point stay as real rendered history (they're
// in the forked transcript), everything after is genuinely gone (the model
// never sees it on resume), and the clicked message drops into the composer
// to edit and re-send. `messageText` prefills that composer.
//
// Known limitation: the fork has no desktop local_*.json metadata, so it
// won't appear in the sidebar's session list — it's a working branch,
// resumable in this pane but not (yet) catalogued.
async function rewindToTurn(index, userMsgIndex, messageText) {
  const pane = panes[index];
  const sourcePane = pane; // identity-check the async result against this
  const res = await window.helm.forkSession(pane.cliSessionId, userMsgIndex);
  if (!res.ok) {
    showToast(`Couldn't rewind: ${res.error}`);
    return;
  }
  // Pane may have been reset/reused during the await — don't hijack whatever
  // now occupies this slot.
  if (panes[index] !== sourcePane) {
    return;
  }
  stopLiveStatsTicker(index);
  panes[index] = {
    ...freshPane(),
    sessionId: res.forkId,
    cliSessionId: res.forkId,
    cwd: sourcePane.cwd,
    title: sourcePane.title, // same conversation, just rewound
    loading: true,
  };
  focusedPaneIndex = index;
  renderSinglePane(index); // builds header + empty composer + scroll
  // Prefill the composer with the rewound message to edit/re-send. Safe to
  // do synchronously right after renderSinglePane — loadTranscriptInto below
  // only rebuilds .pane-scroll, never the composer.
  const promptEl = document.querySelector(`.pane[data-pane="${index}"] .pane-composer textarea`);
  if (promptEl) {
    promptEl.value = messageText || "";
    promptEl.focus();
    promptEl.dispatchEvent(new Event("input"));
  }
  loadTranscriptInto(index); // renders the truncated prior history as real bubbles
}

// paneHeaderEl builds `.pane-sub` (the folder path next to the title) ONCE,
// but renderPane() only ever rebuilds the SCROLL area, never the header — so
// picking a new folder, typing one, or completing a root-folder switch never
// updated the visible path (caught via the captain's "path bredvid titeln
// ändrades aldrig" observation). Queries the live DOM for the header's own
// pane-sub span and updates/creates/removes it directly, without touching
// anything else in the header.
function updatePaneSubText(index, cwd) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const header = paneEl?.querySelector(".pane-header");
  if (!header) {
    return;
  }
  let sub = header.querySelector(".pane-sub");
  if (!cwd) {
    sub?.remove();
  } else {
    if (!sub) {
      sub = document.createElement("span");
      sub.className = "pane-sub";
      header.append(sub);
    }
    sub.textContent = cwd;
  }
  updateClaudeMdLinks(header, cwd);
}

// Small clickable affordances to open the captain's global personal CLAUDE.md and
// the current session's own project CLAUDE.md — his ask for easy navigation
// to both from inside the app, matching the existing header icon-button
// pattern (same "icon-btn" class/size as the ←/→ nav and "+"/"✕" buttons
// beside it). Rebuilt whenever the header's own cwd changes (picking a
// folder, typing one, a root-folder switch), same trigger points
// updatePaneSubText already reacts to — a stale project link pointing at the
// PREVIOUS folder would be worse than not showing one.
// Coach nudge in the pane header: when a project's PLAN.md/DECISIONS.md have
// drifted well behind the code (commits since either was last touched), show a
// subtle "docs N behind" pill so the state-of-play gets reconciled on the commit
// cadence rather than going stale under a work flurry (the gap that let PLAN/
// DECISIONS go stale mid-session). Async + best-effort: appends nothing on error
// or when not stale, so it never blocks or clutters the header.
async function maybeShowDocsStaleness(header, cwd) {
  header.querySelector(".docs-stale-pill")?.remove();
  if (!cwd) {
    return;
  }
  let res;
  try {
    res = await window.helm.docsStaleness(cwd);
  } catch {
    return;
  }
  if (!res || !res.ok || !res.stale) {
    return;
  }
  const pill = document.createElement("span");
  pill.className = "docs-stale-pill";
  pill.textContent = `⚠ docs ${res.commitsSince} behind`;
  pill.title = `${res.commitsSince} commits since PLAN.md/DECISIONS.md were last updated - reconcile the state-of-play so this session stays archivable.`;
  header.append(pill);
}

function updateClaudeMdLinks(header, cwd) {
  header.querySelector(".claude-md-links")?.remove();
  const links = document.createElement("span");
  links.className = "claude-md-links";

  const globalBtn = document.createElement("button");
  globalBtn.className = "icon-btn";
  globalBtn.innerHTML = GLOBE_ICON;
  globalBtn.title = "Open your global CLAUDE.md folder";
  globalBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await window.helm.openGlobalClaudeMd();
    if (!res.ok) {
      showToast(res.error || "Couldn't open global CLAUDE.md");
    }
  });
  links.append(globalBtn);

  if (cwd) {
    // Existence is checked before showing the button at all, rather than
    // showing one that errors on click — per the ask, a project without a
    // CLAUDE.md just shouldn't get this affordance.
    window.helm.projectClaudeMdExists(cwd).then((exists) => {
      if (!exists || !links.isConnected) {
        return;
      }
      const projectBtn = document.createElement("button");
      projectBtn.className = "icon-btn";
      projectBtn.innerHTML = DOCUMENT_ICON;
      projectBtn.title = "Open this project's folder";
      projectBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await window.helm.openProjectClaudeMd(cwd);
        if (!res.ok) {
          showToast(res.error || "Couldn't open project CLAUDE.md");
        }
      });
      links.append(projectBtn);
    });
  }
  header.append(links);
}

function paneHeaderEl(index) {
  const pane = panes[index];
  const header = document.createElement("div");
  header.className = "pane-header";

  const title = document.createElement("span");
  title.textContent = pane.title || "New session";
  header.append(title);
  if (pane.isOrchestrator) {
    const tag = document.createElement("span");
    tag.className = "helm-tag";
    tag.textContent = "◆ Helm";
    tag.title = "This is Helm-building work, not a regular project chat";
    header.append(tag);
  }
  if (pane.cwd) {
    const sub = document.createElement("span");
    sub.className = "pane-sub";
    sub.textContent = pane.cwd;
    header.append(sub);
  }
  updateClaudeMdLinks(header, pane.cwd);
  maybeShowDocsStaleness(header, pane.cwd);
  const actions = document.createElement("span");
  actions.className = "pane-actions";
  if (pane.sessionId) {
    const resetBtn = document.createElement("button");
    resetBtn.className = "icon-btn";
    resetBtn.textContent = "+";
    resetBtn.title = "Start a new chat in this pane";
    resetBtn.addEventListener("click", () => {
      panes[index] = freshPane();
      stopLiveStatsTicker(index);
      if (selectedSessionId === pane.sessionId) {
        selectedSessionId = null;
      }
      renderSinglePane(index);
    });
    actions.append(resetBtn);
  }
  // One-click "capture on the go" - append a decision/gotcha to this project's
  // DECISIONS.md the moment it happens (producer side of faithful transfer, see
  // DECISIONS.md "Session-renewal strategy"). Only when the pane has a project
  // cwd to write into.
  if (pane.cwd) {
    const captureBtn = document.createElement("button");
    captureBtn.className = "icon-btn";
    captureBtn.textContent = "✎";
    captureBtn.title = "Capture a decision/gotcha to this project's DECISIONS.md (on the go)";
    captureBtn.addEventListener("click", () => openInlineCapture(actions, captureBtn, pane.cwd));
    actions.append(captureBtn);
  }
  // The chat-global controls (Simple/Advanced, split, background tasks) ride on
  // the PRIMARY pane's header row rather than a dedicated bar - so no extra row,
  // and the top header stays just the primary tabs + gear (the captain design note
  // 2026-07-06: move them down onto the New-session row, drop the extra row).
  // #chatToolbar is a static, once-wired element in index.html; appendChild
  // MOVES it here (listeners intact) and it's re-appended on every pane-0
  // render. margin-left:auto on .chat-toolbar clusters it to the right, left of
  // the pane-specific +/✕ actions. Only pane 0 gets it; the split pane doesn't.
  if (index === 0) {
    const toolbar = document.getElementById("chatToolbar");
    if (toolbar) {
      toolbar.classList.remove("hidden");
      header.append(toolbar);
    }
  }
  header.append(actions);
  return header;
}

// Inline capture input for the pane-header ✎ button: swaps the button for a
// text field (custom UI, never a native prompt - the captain's standing rule), Enter
// saves to DECISIONS.md via captureNote, Esc/blur cancels. The button briefly
// flashes ✓/✕ to confirm without stealing focus or popping a dialog.
function openInlineCapture(actions, button, cwd) {
  if (actions.querySelector(".pane-capture-input")) {
    return;
  }
  button.style.display = "none";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "pane-capture-input";
  input.placeholder = "Capture to DECISIONS.md - Enter to save, Esc to cancel";
  let done = false;
  const close = () => {
    if (done) {
      return;
    }
    done = true;
    input.remove();
    button.style.display = "";
  };
  const flash = (ok, err) => {
    button.textContent = ok ? "✓" : "✕";
    button.title = ok ? "Captured to DECISIONS.md" : "Capture failed: " + (err || "unknown");
    setTimeout(() => {
      button.textContent = "✎";
      button.title = "Capture a decision/gotcha to this project's DECISIONS.md (on the go)";
    }, 1600);
  };
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "Enter") {
      const text = input.value.trim();
      if (!text) {
        close();
        return;
      }
      input.disabled = true;
      const res = await window.helm.captureNote(cwd, text);
      close();
      flash(!!res?.ok, res?.error);
    }
  });
  input.addEventListener("blur", () => close());
  actions.insertBefore(input, button);
  input.focus();
}

// Convention for "this session generated a vision mockup": a Write/Edit to an
// HTML file whose name contains "mockup" (case-insensitive), e.g.
// dashboard-mockup.html. Deliberately narrow so ordinary .html writes don't pop
// the "Open in Plan" banner - the orchestrator/Claude names vision mockups this
// way on purpose.
function isMockupPath(p) {
  if (!p) {
    return false;
  }
  const name = String(p)
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return name.endsWith(".html") && name.includes("mockup");
}

// Fills (or clears) a pane's "Open in Plan" banner from pane.detectedMockup.
// A dedicated element updated in place so it survives without a full composer
// rebuild (which would drop typed text).
function renderMockupBanner(index, el, pane) {
  el.innerHTML = "";
  if (!pane.detectedMockup) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const label = document.createElement("span");
  label.className = "pane-mockup-label";
  label.textContent = `Mockup generated: ${pane.detectedMockup.name}`;
  const openBtn = document.createElement("button");
  openBtn.className = "text-btn";
  openBtn.textContent = "Open in Plan";
  openBtn.addEventListener("click", async () => {
    const res = await openMockupFileInPlan(pane.detectedMockup.path);
    if (!res.ok) {
      label.textContent = "Couldn't open mockup: " + res.error;
    }
  });
  const dismiss = document.createElement("button");
  dismiss.className = "icon-btn pane-mockup-dismiss";
  dismiss.textContent = "✕";
  dismiss.title = "Dismiss";
  dismiss.addEventListener("click", () => {
    pane.detectedMockup = null;
    renderMockupBanner(index, el, pane);
  });
  el.append(label, openBtn, dismiss);
}

// Records a detected mockup on the pane and refreshes its banner live (no full
// rebuild). Called from the tool_use session event.
function showMockupBanner(index, filePath) {
  const pane = panes[index];
  if (!pane) {
    return;
  }
  const name = String(filePath).split(/[\\/]/).pop();
  pane.detectedMockup = { path: filePath, name };
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const el = paneEl?.querySelector(".pane-mockup-banner");
  if (el) {
    renderMockupBanner(index, el, pane);
  }
}

/**
 * Size a composer textarea to its content, bounded below by any height the user
 * dragged it to and above by a share of the pane so it can never swallow the
 * transcript it belongs to.
 *
 * Module-level and self-locating (it finds its own pane) so that ANY code which
 * sets the composer's value programmatically can size it too - a draft loaded
 * from a Jot task, a quoted selection, a handoff. Those assignments do not fire
 * an `input` event, so without this they would drop a long text into a box still
 * sized for the old one.
 */
const COMPOSER_MIN_PX = 34;
// How far it grows ON ITS OWN, and how far you may drag it. The two differ on
// purpose: the automatic ceiling protects the transcript from a long paste, but a
// height you dragged to is an explicit choice and outranks my guess about what you
// want to see. Only the hard ceiling is absolute, so the transcript never vanishes.
const COMPOSER_MAX_SHARE = 0.45;
const COMPOSER_DRAG_MAX_SHARE = 0.85;
// How much transcript a dragged composer must leave visible. The share above is applied to the
// TEXTAREA, but what has to fit in the pane is the composer around it (the controls row, the
// status line, the attachment chips) - so without reserving this, dragging to the top left the
// transcript a 24px sliver and pushed the send button off the bottom of the window (measured by
// review, 2026-08-04). Enough to read the last reply, not so much that the drag feels capped.
const COMPOSER_TRANSCRIPT_FLOOR_PX = 120;

/**
 * What a newline should do when the caret sits on a list item.
 *
 * Returns { from, to, text } - the range to replace and what to put there - or
 * null when the line is not a list item, in which case the browser's own newline
 * is exactly right and nothing should be intercepted.
 *
 * Three behaviours, all of them what the desktop app and every editor do:
 *  - continue the list, carrying the indentation so a nested list stays nested;
 *  - INCREMENT a numbered marker rather than repeating it (the part the captain named);
 *  - on an item with nothing typed in it yet, remove the marker instead of adding
 *    another one - otherwise leaving a list means deleting by hand, and pressing
 *    Enter twice would leave a stray bullet behind.
 *
 * A checkbox item continues UNCHECKED even from a checked one: the next thing you
 * write is a new task, not a done one.
 */
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
function listContinuation(value, caret, caretEnd = caret) {
  if (typeof value !== "string" || typeof caret !== "number" || caret !== caretEnd) {
    return null; // a selection is a replace, not a list continuation
  }
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const m = LIST_ITEM_RE.exec(value.slice(lineStart, caret));
  if (!m) {
    return null;
  }
  const [, indent, marker, gap, checkbox, content] = m;
  if (!content.trim()) {
    // Empty item: drop the marker. The blank line stays, so the caret ends up
    // where a plain newline would have put it.
    return { from: lineStart, to: caret, text: "\n" };
  }
  let nextMarker = marker;
  const num = /^(\d+)([.)])$/.exec(marker);
  if (num) {
    nextMarker = `${Number(num[1]) + 1}${num[2]}`;
  }
  return {
    from: caret,
    to: caret,
    text: `\n${indent}${nextMarker}${gap}${checkbox ? "[ ] " : ""}`,
  };
}

/**
 * Tab indents the list item the caret is on; Shift+Tab takes it back out.
 *
 * "jag vill att 1. space ska indentera raden" (the captain, 2026-08-04, bouncing bd0900eb
 * back). Two spaces per level, which is what Markdown reads as a nested item, so the
 * indentation is not just visual - it means the same thing to whatever reads the prompt.
 *
 * Returns { from, to, text } or null. Null means the caret is NOT on a list item, and
 * then Tab must be left alone: it moves focus, and stealing that from a text box is a
 * real accessibility loss for a feature nobody asked for.
 */
/**
 * Applies one { from, to, text } edit to the composer.
 *
 * Shared by the list-continuation and the indent paths so there is ONE place that knows
 * how to edit this box. It uses the browser's own insert command rather than assigning
 * to .value, because assigning wipes the textarea's native undo stack - one Ctrl+Z would
 * then throw away everything typed instead of the marker just added.
 *
 * keepCaretOffset is for indenting: the caret should stay on the word you were writing,
 * shifted by what the edit added or removed, instead of jumping to the start of the line
 * where the indentation went in.
 */
function applyComposerEdit(promptEl, step, { keepCaretOffset = false } = {}) {
  const caretBefore = promptEl.selectionStart;
  const delta = step.text.length - (step.to - step.from);
  promptEl.setSelectionRange(step.from, step.to);
  if (!document.execCommand("insertText", false, step.text)) {
    const before = promptEl.value.slice(0, step.from);
    const after = promptEl.value.slice(step.to);
    promptEl.value = before + step.text + after;
    promptEl.setSelectionRange(step.from + step.text.length, step.from + step.text.length);
  }
  if (keepCaretOffset) {
    const next = Math.max(step.from, caretBefore + delta);
    promptEl.setSelectionRange(next, next);
  }
  autoSizeComposer(promptEl);
}

const LIST_INDENT = "  ";

/**
 * Starting a list indents it, without pressing anything.
 *
 * "jag menar att jag trodde den skulle autoindentera bulletlist vid skapandet" (the captain,
 * 2026-08-04). Typing "- " or "1. " at the start of a line now insets the item, the way
 * the desktop app's list does, instead of leaving it flush against the margin until Tab
 * is pressed.
 *
 * Two spaces is chosen, not three or four: CommonMark allows up to three spaces before a
 * marker and still reads it as a top-level item, while four would turn it into an
 * indented code block. So this changes how the line LOOKS without changing what it MEANS
 * to whatever reads the prompt - which is the only reason it is safe to do to text the
 * model will see.
 *
 * Returns a step only for the exact moment a marker is completed at a line's start with
 * no indent of its own. Continuation carries the previous line's indent already, so the
 * rest of the list follows the first item without this firing again.
 */
const BARE_MARKER_RE = /^([-*+]|\d+[.)]) $/;
function listAutoIndentStep(value, caret) {
  if (typeof value !== "string" || typeof caret !== "number") {
    return null;
  }
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  // Only the marker and the space it just got - anything else on the line means the user
  // is editing, not starting a list.
  if (!BARE_MARKER_RE.test(value.slice(lineStart, caret))) {
    return null;
  }
  return { from: lineStart, to: lineStart, text: LIST_INDENT };
}

/** Indent width in columns, so a tab and two spaces count as the same level. */
function indentWidth(indent) {
  return String(indent || "").replace(/\t/g, LIST_INDENT).length;
}

/**
 * What number an item at this indent level should carry.
 *
 * A numbered list restarts inside a sublist and RESUMES when it comes back out:
 *
 *   1. first
 *      1. a sub-item, starting over at one
 *      2. and its sibling
 *   2. back out, carrying on from the parent level
 *
 * Helm numbered straight down the lines instead, so the first sub-item came out as 2 and
 * its sibling as 3 (the captain, 2026-08-04: "helm gör inte skillnad på parent - child
 * bullets"). The count therefore has to look for the previous SIBLING - the nearest line
 * above at the same indent - and not merely at the line above.
 *
 * Walking up: a deeper line is part of a sublist and skipped; a shallower line means this
 * level has not started yet, so the answer is 1; anything that is not a list item ends
 * the list entirely, which also means 1.
 */
function previousSiblingNumber(value, lineStart, targetWidth) {
  let at = lineStart;
  while (at > 0) {
    const prevEnd = at - 1;
    const prevStart = value.lastIndexOf("\n", prevEnd - 1) + 1;
    const line = value.slice(prevStart, prevEnd);
    const m = LIST_ITEM_RE.exec(line);
    if (!m) {
      return null; // not a list line - nothing above to continue from
    }
    const width = indentWidth(m[1]);
    if (width === targetWidth) {
      const num = /^(\d+)([.)])$/.exec(m[2]);
      return num ? Number(num[1]) : null;
    }
    if (width < targetWidth) {
      return null; // the parent - so this level is starting fresh
    }
    at = prevStart; // deeper: part of a sublist, keep looking
  }
  return null;
}

function listIndentStep(value, caret, caretEnd = caret, { outdent = false } = {}) {
  if (typeof value !== "string" || typeof caret !== "number") {
    return null;
  }
  const lineStart = value.lastIndexOf("\n", Math.min(caret, caretEnd) - 1) + 1;
  const lineEnd = value.indexOf("\n", lineStart) === -1 ? value.length : value.indexOf("\n", lineStart);
  const m = LIST_ITEM_RE.exec(value.slice(lineStart, lineEnd));
  if (!m) {
    return null;
  }
  const [, indent, marker] = m;
  if (outdent && indent.length === 0) {
    // Already at the left margin. A no-op rather than null: the caller still has to
    // swallow the key, or Shift+Tab would jump focus out of the composer mid-list.
    return { from: lineStart, to: lineStart, text: "", noop: true };
  }
  let nextIndent;
  if (outdent) {
    const drop = indent.startsWith(LIST_INDENT) ? LIST_INDENT.length : indent[0] === "\t" ? 1 : indent.length;
    nextIndent = indent.slice(drop);
  } else {
    nextIndent = indent + LIST_INDENT;
  }
  // Changing level changes which siblings this item has, so a numbered marker has to be
  // recomputed for the level it is moving to. Keeping the old number is what produced
  // "1. / 2. / 3." down a nested list that should have read "1. / 1. / 2.".
  let nextMarker = marker;
  const num = /^(\d+)([.)])$/.exec(marker);
  if (num) {
    const prev = previousSiblingNumber(value, lineStart, indentWidth(nextIndent));
    nextMarker = `${(prev || 0) + 1}${num[2]}`;
  }
  return { from: lineStart, to: lineStart + indent.length + marker.length, text: nextIndent + nextMarker };
}

// How tall each pane is, kept current by a ResizeObserver instead of measured on demand.
//
// autoSizeComposer runs on EVERY keystroke, and it used to start by calling
// getBoundingClientRect() on the whole pane. That is a forced synchronous layout: the
// browser must lay out everything dirty before it can answer, and .pane contains the
// entire transcript. A pane's height changes when the window resizes, not when a letter is
// typed, so it is observed once and read from here for free.
//
// What this does and does not claim, because the measuring was more interesting than the
// fix (all numbers from the running app on a 600-turn transcript, 2026-08-12):
//
//   - It removes one forced full-transcript layout per keystroke. Verified by counting:
//     the pane is now measured ONCE per 20 keystrokes instead of 20 times, and
//     autoSizeComposer's own cost fell to 0.024ms and no longer grows with the transcript.
//   - It did NOT make a synthetic type-200-characters-in-a-tight-loop benchmark faster.
//     That benchmark turned out not to model typing: with no frame between keystrokes the
//     browser batches work differently, and the numbers contradicted each other outright
//     (setting .value alone timed SLOWER than setting it and dispatching the event, which
//     cannot be true - it was measurement ordering, the first benchmark paying for the
//     transcript's initial layout). No claim is made from it.
//   - CSS containment was tried and rejected on evidence, not taste: `contain: layout` on
//     the turns moved 2.84ms to 2.79ms, `contain: layout style paint` to 2.70ms, and
//     `content-visibility: auto` made it 6.03ms - more than twice as slow. Containment on
//     .pane-scroll was worse again (4.3ms). None of it shipped.
//   - Coalescing the resize into requestAnimationFrame was tried and reverted: it changed
//     nothing measurable, and rAF pauses for a non-visible window (the same hazard
//     scheduleRenderPane documents) - it hung the check that was meant to prove it.
//
// A WeakMap because panes are torn down and rebuilt, and this must not keep dead elements
// alive.
const paneHeights = new WeakMap(); // .pane element -> last observed height in px
const paneHeightObserver =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          // borderBoxSize is the modern read; contentRect is the fallback for older
          // engines. Either way this fires OFF the typing path.
          const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height ?? 0;
          if (h > 0) {
            paneHeights.set(entry.target, h);
          }
        }
      })
    : null;

/** Start tracking a pane's height. Safe to call again for an already-observed pane. */
function observePaneHeight(paneEl) {
  if (paneEl && paneHeightObserver) {
    paneHeightObserver.observe(paneEl);
  }
}

function autoSizeComposer(promptEl) {
  if (!promptEl) {
    return;
  }
  const paneEl = promptEl.closest(".pane");
  const pane = paneEl ? panes[Number(paneEl.dataset.pane)] : null;
  // The observed height when we have one. The measure below is only for the first call on
  // a freshly built pane, before the observer's first callback has run - after that this
  // never forces a layout again.
  let paneHeight = paneEl ? paneHeights.get(paneEl) : 0;
  if (!paneHeight && paneEl) {
    paneHeight = paneEl.getBoundingClientRect().height || 0;
    if (paneHeight > 0) {
      paneHeights.set(paneEl, paneHeight);
    }
  }
  const basis = paneHeight || 600;
  const autoMax = Math.max(120, Math.round(basis * COMPOSER_MAX_SHARE));
  const hardMax = Math.max(autoMax, Math.round(basis * COMPOSER_DRAG_MAX_SHARE));
  // Measuring content height requires releasing the explicit height first.
  promptEl.style.height = "auto";
  const content = promptEl.scrollHeight;
  const floor = Math.max(COMPOSER_MIN_PX, pane?.composerHeight || 0);
  // Content is capped by the automatic ceiling; the dragged floor is not, because
  // clamping it there let my ceiling silently undo a size the user had chosen.
  const next = Math.min(Math.max(Math.min(content, autoMax), floor), hardMax);
  promptEl.style.height = `${next}px`;
  // Only scroll internally once it has genuinely run out of room.
  promptEl.style.overflowY = content > next ? "auto" : "hidden";
  promptEl.dataset.autoHeight = String(next);
}

// The model picker's options, shared by every model pill (composer, routines,
// goal). Current-generation models sit at the top level; older ones go behind a
// "More models" submenu so the common list stays short (the captain, task cf96055c:
// "Kunna välja tidigare modeller ... helst i en submeny för att inte plottra"),
// mirroring the desktop app's own model menu. Every id here is one the installed
// `claude` CLI actually resolves - verified against the ids bundled in claude.exe,
// not guessed, so a pick can never become a control that errors on an unknown
// model. Opus 4.8 is kept at the TOP level, not buried in the submenu: it is the
// one older model in active use here (the second-mate default, and the captain's own
// preference over Opus 5 for work whose prompts were written for it).
const MODEL_MENU_OPTIONS = [
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-opus-5", label: "Opus 5" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  {
    label: "More models",
    submenu: [
      { value: "claude-opus-4-7", label: "Opus 4.7" },
      { value: "claude-opus-4-6", label: "Opus 4.6" },
      { value: "claude-opus-4-5", label: "Opus 4.5" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
      { value: "claude-fable-5", label: "Fable 5" },
    ],
  },
];

/** The same menu with an "Auto" entry on top, for pickers that support letting Helm choose. */
function modelMenuWithAuto() {
  return [{ value: "auto", label: "Auto" }, ...MODEL_MENU_OPTIONS];
}

function paneComposerEl(index) {
  const pane = panes[index];
  const wrap = document.createElement("div");
  wrap.className = "pane-composer";

  // "Open in Plan" banner - appears when this session writes a mockup HTML file
  // (see the tool_use handler in onSessionEvent). Persisted on
  // pane.detectedMockup so it survives composer rebuilds; updated in place by
  // showMockupBanner. Sits above the status line so it's noticed.
  const mockupBanner = document.createElement("div");
  mockupBanner.className = "pane-mockup-banner hidden";
  wrap.append(mockupBanner);

  // Prompts queued for THIS session, directly above the box they will be typed into
  // (task c2aae246). Filled by renderScheduledPromptBar, which owns the one fetch and
  // distributes it across the panes.
  const schedQueue = document.createElement("div");
  schedQueue.className = "pane-sched-queue hidden";
  wrap.append(schedQueue);
  renderMockupBanner(index, mockupBanner, pane);

  // Status lives right above the composer (was in the header, easy to miss
  // while your eyes are on the prompt box) — visible exactly where you're
  // already looking while waiting for a reply.
  const status = document.createElement("div");
  status.className = "pane-status";
  wrap.append(status);

  // One unified rounded "shell" (textarea on top, controls below), closer to
  // the desktop app's single-pill composer instead of stacked separate fields.
  const shell = document.createElement("div");
  shell.className = "composer-shell";

  // The whole box is resized by dragging its TOP EDGE (task dce9946c: "kan vi göra
  // promptrutan dragbar för storleken istället för grejen i vänstra hörnet"). Before this,
  // resizing meant finding the textarea's own small native corner grip and, worse, the size
  // was detected AFTER the fact by comparing heights on mouseup - a second, invisible
  // mechanism running beside autoSizeComposer.
  //
  // A full-width edge is the thing you actually reach for when a prompt has got long, and it
  // is where every chat app puts it. Double-click hands the size back to the text.
  const grip = document.createElement("div");
  grip.className = "composer-grip";
  grip.title = "Drag to resize · double-click to fit the text";
  shell.append(grip);

  const promptEl = document.createElement("textarea");
  promptEl.rows = 2;
  promptEl.placeholder = pane.sessionId ? `Continue "${pane.title}"…` : "What should this session do?";
  shell.append(promptEl);

  // Pointer events with capture, so the drag keeps tracking when the cursor leaves the strip -
  // which it does immediately, since dragging up moves away from a 6px-tall element.
  let lastDragMovedAt = 0;
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = promptEl.getBoundingClientRect().height;
    const paneEl = grip.closest(".pane");
    const basis = paneEl?.getBoundingClientRect().height || 600;
    // The ceiling has to leave room for the CONTROLS ROW and for some transcript, because the
    // number being clamped is the textarea's height while what must fit inside the pane is the
    // whole composer around it. Measured by review: 85% of the pane on the textarea put the
    // composer at 99.5% of it, the transcript at a 24px sliver, and the send button 15px BELOW
    // the window's bottom edge - the exact opposite of what the clamp was for.
    const composerEl = grip.closest(".pane-composer");
    const chromeAround = Math.max(0, (composerEl?.getBoundingClientRect().height || startH) - startH);
    const hardMax = Math.max(COMPOSER_MIN_PX, Math.round(basis * COMPOSER_DRAG_MAX_SHARE) - chromeAround - COMPOSER_TRANSCRIPT_FLOOR_PX);
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is no longer active cannot be captured; the drag still works through the
      // listeners below, and throwing here would have made the whole gesture a silent no-op.
    }
    grip.classList.add("dragging");
    // A drag also produces a `click`, so two drags in a row arrive as a dblclick and the reset
    // below threw the size away - which is exactly the fine-tuning gesture (drag, not quite
    // right, drag again). Found by review with real injected input. Tracked here so the reset
    // can tell "clicked twice" from "dragged twice".
    let moved = 0;
    const onMove = (ev) => {
      moved = Math.max(moved, Math.abs(ev.clientY - startY));
      // Up is bigger: the box grows towards the transcript, the way its edge moves.
      const next = Math.min(Math.max(startH + (startY - ev.clientY), COMPOSER_MIN_PX), hardMax);
      pane.composerHeight = Math.round(next);
      promptEl.style.height = `${Math.round(next)}px`;
      promptEl.dataset.autoHeight = String(Math.round(next));
      promptEl.style.overflowY = promptEl.scrollHeight > next ? "auto" : "hidden";
    };
    const onUp = () => {
      grip.classList.remove("dragging");
      lastDragMovedAt = moved > 3 ? Date.now() : 0;
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      grip.removeEventListener("lostpointercapture", onUp);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    // A lost capture (window focus change, an input device disappearing) otherwise left the
    // drag armed: the grip stayed lit and later moves still resized the box.
    grip.addEventListener("lostpointercapture", onUp);
  });
  // Give the size back to the text. Without this a dragged floor is permanent for the pane's
  // life, and the only way back to a small composer would be to drag it down again by eye.
  grip.addEventListener("dblclick", () => {
    // Not after a drag - see `moved` above. A real double-click has no movement between its
    // two presses, so anything that moved is a resize being fine-tuned, not a reset.
    if (Date.now() - lastDragMovedAt < 700) {
      return;
    }
    pane.composerHeight = 0;
    autoSizeComposer(promptEl);
  });

  // The box grows with the text, and can also be dragged (the captain, 2026-08-03:
  // "just nu är det väldigt svårt att se långa texter"). It was two fixed rows
  // with `resize: none`, so a long prompt scrolled inside a two-line slit and
  // neither option was available.
  //
  // A dragged height is a FLOOR, not a lock: the box never gets smaller than
  // what you dragged it to, but still grows past it as the text gets longer. That
  // avoids the usual trap where manual and automatic sizing fight each other and
  // the app needs a mode - and it means there is nothing to switch back off.
  promptEl.addEventListener("input", () => autoSizeComposer(promptEl));
  // Starting a list indents it, with nothing pressed. Gated on a TYPED space
  // (inputType + data), not merely on the text looking right: a paste that happens to end
  // in "- " must not be reformatted, and neither must an undo that lands on the same
  // characters. Both would be the app editing text the user did not just write.
  promptEl.addEventListener("input", (e) => {
    if (e.inputType !== "insertText" || e.data !== " ") {
      return;
    }
    const step = listAutoIndentStep(promptEl.value, promptEl.selectionStart);
    if (step) {
      applyComposerEdit(promptEl, step, { keepCaretOffset: true });
    }
  });
  // The height used ALSO to be inferred here, on every mouseup on the textarea, by noticing
  // that it no longer matched what autoSizeComposer had set - the native corner grip left no
  // other trace. That is gone with the grip: the top-edge handle sets pane.composerHeight
  // directly while dragging, so there is one place that decides the size instead of one
  // deciding and another guessing after the fact.
  // A dozen places already assign `promptEl.value` directly - a draft from a Jot
  // task, a quoted bubble, a queued message, a picked slash command, clearing on
  // send - and none of them fire an `input` event. Patching the property on THIS
  // element (not the prototype) makes every one of them resize, including the
  // next one somebody adds. Enumerating the call sites instead is how the
  // thirteenth gets missed.
  const valueDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(promptEl), "value");
  Object.defineProperty(promptEl, "value", {
    configurable: true,
    get() {
      return valueDesc.get.call(this);
    },
    set(v) {
      valueDesc.set.call(this, v);
      autoSizeComposer(this);
    },
  });
  // Not yet in the document, so scrollHeight is meaningless until after layout.
  requestAnimationFrame(() => autoSizeComposer(promptEl));

  // ---- Slash-command menu -------------------------------------------------
  // Typing `/name` at the very start of the composer opens an autocomplete of
  // the skills + custom commands available to this pane (via slash:list). These
  // DO run through `claude -p "/name"` (verified 2026-07-10), so picking one and
  // sending actually invokes it. Built-in TUI commands are intentionally absent
  // (they no-op through -p). The menu only shows while the text is a bare
  // `/token` with no space yet - once you type args (or a space) it closes.
  const slashMenu = document.createElement("div");
  slashMenu.className = "slash-menu hidden";
  shell.append(slashMenu);
  const slash = { open: false, items: null, itemsCwd: undefined, filtered: [], index: 0 };

  const slashQuery = () => {
    const m = promptEl.value.match(/^\/([\w:-]*)$/);
    return m ? m[1] : null;
  };
  const closeSlashMenu = () => {
    slash.open = false;
    slashMenu.classList.add("hidden");
  };
  const renderSlashMenu = () => {
    slashMenu.replaceChildren();
    if (!slash.filtered.length) {
      closeSlashMenu();
      return;
    }
    slash.index = Math.max(0, Math.min(slash.index, slash.filtered.length - 1));
    slash.filtered.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "slash-item" + (i === slash.index ? " is-selected" : "");
      const nm = document.createElement("span");
      nm.className = "slash-item-name";
      nm.textContent = "/" + item.name;
      const tag = document.createElement("span");
      tag.className = "slash-item-tag";
      tag.textContent = item.kind === "command" ? "command" : item.origin === "project" ? "project skill" : "skill";
      const desc = document.createElement("span");
      desc.className = "slash-item-desc";
      desc.textContent = item.description || "";
      const head = document.createElement("div");
      head.className = "slash-item-head";
      head.append(nm, tag);
      row.append(head, desc);
      row.addEventListener("mouseenter", () => {
        slash.index = i;
        [...slashMenu.children].forEach((c, j) => c.classList.toggle("is-selected", j === i));
      });
      // mousedown (not click) + preventDefault keeps the textarea focused so the
      // blur-close below doesn't fire before selection lands.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectSlash(item);
      });
      slashMenu.append(row);
    });
    slashMenu.classList.remove("hidden");
    slash.open = true;
  };
  const selectSlash = (item) => {
    promptEl.value = "/" + item.name + " ";
    closeSlashMenu();
    promptEl.focus();
    promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
    promptEl.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const updateSlashMenu = async () => {
    const q = slashQuery();
    if (q === null) {
      closeSlashMenu();
      return;
    }
    if (slash.items === null || slash.itemsCwd !== pane.cwd) {
      const res = await window.helm.listSlashItems(pane.cwd);
      slash.items = res && res.ok ? res.items : [];
      slash.itemsCwd = pane.cwd;
    }
    const ql = q.toLowerCase();
    const matches = slash.items.filter((it) => it.name.toLowerCase().includes(ql));
    // Prefix matches first, then substring, each alphabetical (already sorted).
    matches.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(ql) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(ql) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
    slash.filtered = matches;
    slash.index = 0;
    renderSlashMenu();
  };
  // Registered BEFORE the Enter-to-send keydown below so, while the menu is
  // open, nav/select/escape here run first and stopImmediatePropagation keeps
  // the send handler from firing.
  promptEl.addEventListener("keydown", (e) => {
    if (!slash.open) {
      return;
    }
    if (e.key === "ArrowDown") {
      slash.index = Math.min(slash.index + 1, slash.filtered.length - 1);
      renderSlashMenu();
    } else if (e.key === "ArrowUp") {
      slash.index = Math.max(slash.index - 1, 0);
      renderSlashMenu();
    } else if (e.key === "Enter" || e.key === "Tab") {
      const item = slash.filtered[slash.index];
      if (item) {
        selectSlash(item);
      }
    } else if (e.key === "Escape") {
      closeSlashMenu();
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  promptEl.addEventListener("input", () => {
    updateSlashMenu();
  });
  // Clicking away closes the menu; small delay lets an item mousedown land.
  promptEl.addEventListener("blur", () => setTimeout(closeSlashMenu, 120));

  // Attachment chips (pasted images + picked files), shown between the
  // textarea and the control row. Cleared on send.
  const attachmentsEl = document.createElement("div");
  attachmentsEl.className = "composer-attachments";
  shell.append(attachmentsEl);
  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachmentsEl.style.display = pane.pendingAttachments.length ? "flex" : "none";
    pane.pendingAttachments.forEach((att, i) => {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      if (att.isImage) {
        const thumb = document.createElement("img");
        thumb.className = "attachment-thumb";
        thumb.src = toFileUrl(att.path);
        thumb.title = "Click to enlarge";
        thumb.addEventListener("click", () => showImageLightbox(thumb.src));
        chip.append(thumb);
      } else {
        const clip = document.createElement("span");
        clip.className = "attachment-clip-icon";
        clip.innerHTML = PAPERCLIP_ICON;
        chip.append(clip);
      }
      chip.append(document.createTextNode(att.name));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.title = "Remove attachment";
      remove.addEventListener("click", () => {
        pane.pendingAttachments.splice(i, 1);
        renderAttachments();
      });
      chip.append(remove);
      attachmentsEl.append(chip);
    });
  }
  renderAttachments();

  // "Flika in vs efteråt" scenario 2: queue a follow-up prompt to run
  // automatically once the CURRENT run finishes, for when you're stepping
  // away and want to be sure the next thing you wanted done actually
  // happens. (Scenario 1 — inject info into the run that's happening RIGHT
  // NOW — needs the persistent-process architecture, still an open
  // decision; this half doesn't, since it's just "the next -p call.")
  const queuedEl = document.createElement("div");
  queuedEl.className = "queued-prompt";
  shell.append(queuedEl);
  function renderQueuedPrompt() {
    queuedEl.innerHTML = "";
    if (!pane.queuedPrompt) {
      queuedEl.style.display = "none";
      return;
    }
    queuedEl.style.display = "flex";
    const label = document.createElement("span");
    label.textContent = `⏭ Queued: ${pane.queuedPrompt}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "attachment-remove";
    cancel.textContent = "×";
    cancel.title = "Cancel queued prompt";
    cancel.addEventListener("click", () => {
      pane.queuedPrompt = null;
      if (pane.cliSessionId) {
        queuedPromptBySession.delete(pane.cliSessionId);
      }
      renderQueuedPrompt();
    });
    queuedEl.append(label, cancel);
  }
  renderQueuedPrompt();

  // Saves a pasted image to disk and attaches its path — Claude Code's own
  // Read tool picks up an image from a plain file-path mention in the prompt
  // text, verified in spike/test-image-via-path.mjs. No base64-in-stream-json,
  // no SDK migration; the existing -p/--resume flow is untouched.
  promptEl.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    const imageItems = Array.from(items).filter((it) => it.type && it.type.startsWith("image/"));
    if (imageItems.length === 0) {
      return;
    }
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1] || "";
      const res = await window.helm.saveImage(base64, ext);
      // Pane may have been reset/reused while the save round-tripped through
      // main — don't attach a stale paste to whatever now occupies this slot.
      if (res.ok && panes[index] === pane) {
        pane.pendingAttachments.push({ path: res.path, name: file.name || `pasted.${ext}`, isImage: true });
        renderAttachments();
      }
    }
  });

  // DROP an image onto the composer, not only paste it (task 90251904 - "kan inte drag
  // and droppa bilder in till prompten"). It had never worked: nothing in the renderer
  // handled `drop`, so Chromium's default took over - which for a file dropped on a
  // page is to NAVIGATE to it, i.e. the app window replaced itself with the image. That
  // is worse than nothing happening, and it is why dragover must be prevented too:
  // without it the drop event never reaches us at all.
  //
  // Same path as the paste handler on purpose - read to a data URL, hand the base64 to
  // main, attach the saved path - so the two cannot drift into behaving differently.
  const attachImageFiles = async (files) => {
    for (const file of files) {
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      let dataUrl;
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
      } catch {
        showToast(`Couldn't read "${file.name || "that image"}".`);
        continue;
      }
      const base64 = String(dataUrl).split(",")[1] || "";
      const res = await window.helm.saveImage(base64, ext);
      // The pane may have been reset or reused while the save round-tripped through
      // main - the same guard the paste handler has, for the same reason.
      if (res?.ok && panes[index] === pane) {
        pane.pendingAttachments.push({ path: res.path, name: file.name || `dropped.${ext}`, isImage: true });
        renderAttachments();
      } else if (!res?.ok) {
        showToast(`Couldn't attach "${file.name || "that image"}": ${res?.error || "unknown error"}`);
      }
    }
  };

  // A NON-image file dropped on the composer (task c24f18b8 - "dra filer till prompten ska
  // också fungera (nu fungerar bara bilder)"). Nothing needs saving: the file is already on
  // disk, so this attaches its path exactly like the paperclip does, and the send path already
  // renders a non-image attachment as `[Attached file: <path>]`.
  //
  // A dropped file does not always HAVE a path - dragged out of a browser, out of an archive,
  // or synthesised - and attaching an empty one would produce a mention pointing nowhere, which
  // reads as the app losing the file. So that case is named instead.
  const attachDroppedFiles = async (files) => {
    for (const file of files) {
      const filePath = window.helm.pathForFile ? window.helm.pathForFile(file) : "";
      if (!filePath) {
        showToast(`"${file.name || "That file"}" has no path on disk - save it somewhere first, then drop it.`);
        continue;
      }
      if (panes[index] !== pane) {
        return; // the pane was reused while this ran
      }
      pane.pendingAttachments.push({ path: filePath, name: file.name || filePath.split(/[\\/]/).pop(), isImage: false });
      renderAttachments();
    }
  };

  const isImageDrag = (e) => Array.from(e.dataTransfer?.items || []).some((it) => it.kind === "file");
  promptEl.addEventListener("dragover", (e) => {
    if (!isImageDrag(e)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    promptEl.classList.add("drop-target");
  });
  promptEl.addEventListener("dragleave", () => promptEl.classList.remove("drop-target"));
  promptEl.addEventListener("drop", async (e) => {
    const all = Array.from(e.dataTransfer?.files || []);
    promptEl.classList.remove("drop-target");
    if (all.length === 0) {
      return;
    }
    // Always prevented, whatever the file is: Chromium's default for a file dropped on a page
    // is to NAVIGATE to it, which replaces the app window with the file.
    e.preventDefault();
    // An image is read and saved so it survives being moved or deleted; anything else is
    // referenced where it already lives. Both end up as an attachment chip either way.
    const images = all.filter((f) => f.type && f.type.startsWith("image/"));
    const others = all.filter((f) => !(f.type && f.type.startsWith("image/")));
    if (images.length > 0) {
      await attachImageFiles(images);
    }
    if (others.length > 0) {
      await attachDroppedFiles(others);
    }
  });

  const controls = document.createElement("div");
  controls.className = "composer-controls";

  const cwdInput = document.createElement("input");
  cwdInput.type = "text";
  cwdInput.className = "cwd-input";
  cwdInput.placeholder = "Repo folder (required to send)";
  cwdInput.value = pane.cwd || "";
  cwdInput.title = pane.cwd || "Repo folder this session roots in";
  cwdInput.addEventListener("input", (e) => {
    pane.cwd = e.target.value;
    cwdInput.title = e.target.value;
    cwdInput.classList.remove("cwd-missing");
    updatePaneSubText(index, e.target.value);
  });
  const pickBtn = document.createElement("button");
  pickBtn.className = "icon-btn";
  pickBtn.textContent = "…";
  pickBtn.title = "Pick repo folder";
  pickBtn.addEventListener("click", async () => {
    const folder = await window.helm.pickFolder();
    // The dialog can stay open indefinitely — same guard as the attach-file
    // and paste-image handlers, so a folder pick doesn't land on a pane that
    // was reset/reused while the dialog was up.
    if (folder && panes[index] === pane) {
      pane.cwd = folder;
      cwdInput.value = folder;
      cwdInput.title = folder;
      updatePaneSubText(index, folder);
    }
  });

  // "Auto" lets Helm pick per-prompt (resolved at send time from the
  // current text); picking a specific value locks it in and stops the
  // suggestion from silently overriding your choice. A pane may carry a
  // modelDefault (e.g. a first-mate/orchestrator session defaults to Sonnet -
  // the delegate/summarize tier per model-per-tier), still fully overridable
  // here; everything else defaults to "auto".
  const modelDD = dropdownPill(pane.modelDefault || "auto", modelMenuWithAuto(), () => {});
  const effortDD = dropdownPill(
    "auto",
    [
      { value: "auto", label: "Auto" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" },
    ],
    () => {}
  );

  // Matches the desktop app's mode picker (Ask permissions / Accept edits /
  // Plan mode / Auto mode / Bypass permissions). Helm's -p invocation has
  // no live channel to answer an interactive approval prompt, so a mode that
  // genuinely needs to ask mid-run could still stall — tested "default" in
  // this environment and it did not (the captain's existing broad allowlists let
  // tools through), but that is not a general guarantee for every setup.
  // Note: this "auto" is a literal CLI permission mode name, unrelated to the
  // model/effort "Auto" above (let Helm pick) — they just share the word.
  const permissionDD = dropdownPill(
    "auto",
    [
      { value: "default", label: "Ask permissions" },
      { value: "acceptEdits", label: "Accept edits" },
      { value: "plan", label: "Plan mode" },
      { value: "auto", label: "Auto mode" },
      { value: "bypassPermissions", label: "Bypass permissions" },
    ],
    () => {}
  );

  // Same mechanism as pasting an image, just picked via a dialog instead of
  // the clipboard — a plain file (any type) attached by path. Read tool
  // handles whatever it can from there; Helm doesn't need to know the type.
  const attachBtn = document.createElement("button");
  attachBtn.className = "icon-btn";
  attachBtn.innerHTML = PAPERCLIP_ICON;
  attachBtn.title = "Attach a file";
  attachBtn.addEventListener("click", async () => {
    const filePaths = await window.helm.pickFiles();
    // The dialog is modal and can sit open a long time — the pane may have
    // been reset while it was up. Same guard as the paste handler.
    if (!filePaths?.length || panes[index] !== pane) {
      return;
    }
    for (const filePath of filePaths) {
      const name = filePath.split(/[\\/]/).pop();
      pane.pendingAttachments.push({ path: filePath, name, isImage: /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) });
    }
    renderAttachments();
  });

  // Voice input (PLAN.md Phase 4) — v1 scope is deliberately minimal: record,
  // transcribe locally (offline Whisper, see src/lib/voice.js), insert into
  // the composer.
  //
  // Hold-to-record (the captain's feedback on v1's click-to-toggle: "Jag vill ha en
  // hold to record function. Typ alt knappen eller någon enkel kombination.").
  // Two equivalent ways to hold, both calling the same start/stop pair so
  // they can never leave the button in a "half held" state:
  // 1. Press-and-hold the mic button itself (mousedown/mouseup). mouseleave
  //    also stops it — dragging the mouse off the button while held must not
  //    leave a recording stuck active with no way to release it.
  // 2. Hold Alt while focus is inside THIS pane's composer textarea.
  //    Confirmed no collision before picking Alt: grepped the whole renderer
  //    for existing keydown handlers (Enter-to-send, Escape-to-close-menu/
  //    lightbox, inline-rename Enter/Escape) — none use Alt or check
  //    e.altKey, and main.js sets no custom accelerators/globalShortcut. The
  //    one real interaction is Electron's own default application menu
  //    (no custom Menu is set, so the OS-default File/Edit/View/Window/Help
  //    bar is present) — bare Alt normally shifts focus to it. preventDefault
  //    on keydown suppresses that reliably in Chromium/Electron, so Alt stays
  //    free to reuse here without stealing focus from the composer.
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "icon-btn";
  micBtn.innerHTML = MIC_ICON_IDLE;
  micBtn.title = "Hold to record voice input (transcribed locally, offline) - or hold Alt in the composer";
  micBtn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // don't steal focus from the composer on mousedown
    startVoiceRecording(index, micBtn, promptEl);
  });
  micBtn.addEventListener("mouseup", () => stopVoiceRecording(index));
  micBtn.addEventListener("mouseleave", () => stopVoiceRecording(index));

  promptEl.addEventListener("keydown", (e) => {
    if (e.key !== "Alt" || e.repeat) {
      return;
    }
    e.preventDefault();
    startVoiceRecording(index, micBtn, promptEl);
  });
  promptEl.addEventListener("keyup", (e) => {
    if (e.key !== "Alt") {
      return;
    }
    stopVoiceRecording(index);
  });
  // Alt-tabbing away, or any other focus loss, blurs the textarea without a
  // matching keyup ever firing — same "don't leave it stuck" concern as
  // mouseleave above, just for the keyboard path.
  promptEl.addEventListener("blur", () => stopVoiceRecording(index));

  // Transcription language for the mic button. A single GLOBAL setting
  // (config.voiceLanguage), not per-pane — v1 keeps one language for all
  // panes. Reuses the exact same dropdownPill component as the model/effort/
  // permission pills so it looks and behaves identically. The `value` passed
  // through to voice.js must be the full lowercase language NAME transformers.js
  // accepts ("swedish"/"english"/…) or "auto" for auto-detect; the labels are
  // just nicer display text. Default "swedish" preserves the pre-picker forced-
  // Swedish behavior (the captain's primary language).
  const languageDD = dropdownPill(
    state.config?.voiceLanguage || "swedish",
    [
      { value: "auto", label: "Auto-detect" },
      { value: "swedish", label: "Svenska" },
      { value: "english", label: "English" },
    ],
    async (value) => {
      // Persist globally via the same setConfig IPC every other setting uses.
      state.config = await window.helm.setConfig({ voiceLanguage: value });
    }
  );
  languageDD.el.title = "Voice transcription language";

  const sendBtn = document.createElement("button");
  sendBtn.className = "send-btn";
  sendBtn.textContent = "➤";
  sendBtn.title = pane.sessionId ? "Continue (Enter)" : "Start session (Enter)";

  // Send-later control (task 7d9d2188). It used to be an accent-coloured slab
  // glued to the right of the send button, which is a 26px CIRCLE - so it read as
  // a broken piece of the send button rather than a control (the captain: "ful knapp").
  // Now it is a plain .icon-btn like the paperclip and the mic, placed BEFORE the
  // send button so the accent circle stays the last thing in the row and the only
  // coloured one - colour marks the primary action, not a modifier.
  const scheduleBtn = document.createElement("button");
  scheduleBtn.className = "icon-btn";
  scheduleBtn.type = "button";
  scheduleBtn.innerHTML = CLOCK_ICON;
  scheduleBtn.title = "Send this later (e.g. when the quota resets)";
  scheduleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    scheduleSendMenu(scheduleBtn, pane, promptEl.value, {
      model: modelDD.value === "auto" ? "" : modelDD.value,
      effort: effortDD.value === "auto" ? "" : effortDD.value,
      clear: () => {
        promptEl.value = "";
      },
    });
  });

  controls.append(pickBtn, cwdInput, attachBtn, permissionDD.el, modelDD.el, effortDD.el, languageDD.el, micBtn, scheduleBtn, sendBtn);
  shell.append(controls);

  // Repo scripts (task 8bfae7a0): appended asynchronously (it has to read the
  // folder's package.json) and inserted before the mic so the send controls stay
  // rightmost. Absent entirely when the folder has no scripts.
  repoScriptsPill(pane.cwd)
    .then((pill) => {
      if (pill && controls.isConnected) {
        controls.insertBefore(pill, micBtn);
      }
    })
    .catch(() => {
      // a missing/unreadable package.json just means no pill
    });

  // Context-size gauge — a bar + %, under the model/effort row (the captain's
  // placement). Clicking it opens a popover with the context detail AND the
  // quota, mirroring Claude Code's combined readout. Its own render closure
  // because the composer is built once but pane.contextTokens arrives later,
  // async, from loadTranscriptInto (which calls this to fill it in).
  const contextGauge = document.createElement("button");
  contextGauge.type = "button";
  contextGauge.className = "composer-context";
  // First-mate refresh nudge, shown next to the gauge when a first mate is
  // getting full and is NOT mid-task (so the handoff lands at a sensible
  // moment). Updated in lockstep with the gauge.
  const handoffEl = document.createElement("div");
  handoffEl.className = "first-mate-handoff hidden";
  const renderContextGauge = () => {
    if (typeof pane.contextTokens !== "number") {
      contextGauge.style.display = "none";
      handoffEl.classList.add("hidden");
      return;
    }
    contextGauge.style.display = "";
    const windowTokens = contextWindowForPane(pane);
    const pct = Math.min(100, Math.round((pane.contextTokens / windowTokens) * 100));
    contextGauge.innerHTML = "";
    const bar = document.createElement("span");
    bar.className = "ctx-bar";
    const fill = document.createElement("span");
    fill.className = "ctx-fill" + (pct >= 85 ? " high" : "");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = `${pct}%`;
    contextGauge.append(bar, label);
    contextGauge.title = "Context in use for this session - click for detail + quota";

    // First-mate refresh pipe: a first mate stays thin. When this IS a first
    // mate, it's saturating, and it's idle (not mid-task), surface a one-click
    // handoff + fire a one-time attention notification so the captain is pulled
    // back even if on another page.
    const showHandoff = pane.isOrchestrator && !!pane.sessionId && !pane.busy && pct >= FIRST_MATE_HANDOFF_PCT;
    handoffEl.classList.toggle("hidden", !showHandoff);
    if (showHandoff) {
      handoffEl.innerHTML = "";
      const msg = document.createElement("span");
      msg.className = "first-mate-handoff-msg";
      msg.textContent = `First mate ${pct}% full - `;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "text-btn";
      btn.textContent = "hand off to a fresh one";
      btn.title = "Summarize this first mate to a fresh session (continuity via files)";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const s = sessionById(pane.sessionId);
        if (s) {
          summarizeAndCarryOver(s);
        }
      });
      handoffEl.append(msg, btn);
      if (!firstMateHandoffNotified.has(pane.sessionId)) {
        firstMateHandoffNotified.add(pane.sessionId);
        window.helm.notifyAttention({ title: "Helm — your first mate is filling up", body: "Hand off to a fresh first mate to keep it sharp." });
      }
    }
  };
  renderContextGauge();
  contextGauge.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleContextPopover(contextGauge, pane);
  });

  // Visible reasoning, not just a hover tooltip — a suggestion nobody reads
  // isn't a suggestion. Explicitly says so even when it just confirms your
  // current pick, per "always decide, and if it's already right, say so."
  const suggestHint = document.createElement("div");
  suggestHint.className = "suggest-hint";

  // the captain's ask: put the suggestion hint and the context gauge on the SAME
  // row instead of stacking them (they were two separate full-width lines).
  const metaRow = document.createElement("div");
  metaRow.className = "composer-meta-row";
  metaRow.append(suggestHint, contextGauge);
  shell.append(metaRow);
  shell.append(handoffEl);
  wrap.append(shell);

  const els = { cwdInput, promptEl, modelDD, effortDD, permissionDD, sendBtn, renderAttachments, renderQueuedPrompt, renderContextGauge };
  // Lets the "done" event handler (which only has the pane object, not this
  // composer's closure) trigger a queued prompt through the exact same send
  // path — reusing sendFromPane's cwd/attachment/suggestion handling instead
  // of duplicating it. Rebuilt every time this composer is (re)created, so
  // it always points at the currently-live set of elements.
  pane.els = els;
  const handleSendOrStop = async () => {
    if (pane.busy) {
      if (pane.currentLaunchId) {
        pane.stopRequested = true;
        setPaneBusyUI(index, "Stopping…");
        const res = await window.helm.stopSession(pane.currentLaunchId);
        // The process may have finished naturally in the tiny window between
        // the click and this call landing in main — its "done" event is then
        // already queued and will clear busy shortly, but don't leave the
        // button stuck on "Stopping…" waiting for that if it does not.
        if (!res.ok && panes[index] === pane && pane.busy) {
          pane.busy = false;
          pane.stopRequested = false;
          pane.currentLaunchId = null;
          stopLiveStatsTicker(index);
          setPaneBusyUI(index, "");
        } else if (res.ok) {
          // The kill signal landed (killChildTree's forceful taskkill /T /F on
          // Windows), but that alone doesn't guarantee this pane ever hears back:
          // Node's "close" event - which is what the main process waits on before
          // sending "done" - only fires once the child's stdio pipes actually
          // close, and a descendant that inherited those pipes without itself
          // being tracked in the killed process tree (some shapes of a spawned
          // tool subprocess, e.g. Bash) can keep them open indefinitely even
          // after the tree above it is dead. That left the pane stuck on
          // "Stopping…" forever - "Stop knappen på en prompt verkar inte alltid
          // fungera... kan ha att göra med när något tool körs, typ bash" (Jot
          // 93835691). The kill was already issued as forcefully as this app
          // can issue it, so if nothing terminal arrives within a few seconds,
          // there is nothing more waiting to accomplish - treat it as stopped.
          // A genuine "done" that does still show up later clears this same
          // timer first and is handled completely normally either way.
          clearTimeout(pane.stopWatchdogTimer);
          const launchId = pane.currentLaunchId;
          pane.stopWatchdogTimer = setTimeout(() => {
            if (panes[index] !== pane || pane.currentLaunchId !== launchId || !pane.busy) {
              return; // a real "done" (or a fresh launch in this pane) already resolved this
            }
            pane.busy = false;
            pane.stopRequested = false;
            pane.currentLaunchId = null;
            stopLiveStatsTicker(index);
            setPaneBusyUI(index, "");
            pane.turns.push({ role: "assistant", kind: "text", text: "⏹ Stopped (still shutting down in the background)." });
            bumpSessionActivity(pane.sessionId);
            renderPane(index);
          }, 6000);
        }
      }
    } else {
      sendFromPane(index, els);
    }
  };
  sendBtn.addEventListener("click", handleSendOrStop);

  // This is a text-pattern heuristic (keywords + length), not a real reading
  // of the task — the label says "Suggesting," not "Analyzed and decided,"
  // on purpose. Only updates the hint text; it never overwrites a manual
  // model/effort pick anymore (that silently discarding your choice was the
  // actual bug — "auto" is now its own explicit option instead).
  let suggestTimer = null;
  promptEl.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const suggestion = await window.helm.suggestModelEffort(promptEl.value);
      const modelLabel = suggestion.model.replace("claude-", "");
      const usingAuto = modelDD.value === "auto" && effortDD.value === "auto";
      suggestHint.textContent = usingAuto
        ? `→ Auto-picking ${modelLabel} · ${suggestion.effort} — ${suggestion.reason}`
        : `Heuristic guess: ${modelLabel} · ${suggestion.effort} — ${suggestion.reason} (using your manual pick instead)`;
    }, 300);
  });

  // A new line inside a list continues the list (task bd0900eb: "i prompten på
  // claude desktop appen kan man göra ordentliga bulletlists som då automatiskt
  // incrementerar"). Shift+Enter is the newline key here - Enter sends - so this
  // hangs off Shift+Enter and cannot affect sending.
  promptEl.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    // Tab indents the list item you are on, Shift+Tab takes it back out. Only ever on a
    // list item: on ordinary text Tab keeps moving focus, because taking that away from
    // a text box costs more than this feature is worth.
    if (e.key === "Tab") {
      const indentStep = listIndentStep(promptEl.value, promptEl.selectionStart, promptEl.selectionEnd, { outdent: e.shiftKey });
      if (!indentStep) {
        return;
      }
      e.preventDefault();
      if (indentStep.noop) {
        return;
      }
      applyComposerEdit(promptEl, indentStep, { keepCaretOffset: true });
      return;
    }
    if (e.key !== "Enter" || !e.shiftKey) {
      return;
    }
    const step = listContinuation(promptEl.value, promptEl.selectionStart, promptEl.selectionEnd);
    if (!step) {
      return; // not in a list - let the browser insert its own newline
    }
    e.preventDefault();
    applyComposerEdit(promptEl, step);
  });

  // Enter sends; Shift+Enter inserts a newline (matches the desktop app).
  // While busy, Enter can't "send" (there's no live channel mid-turn — see
  // the interject architecture note above) — but it can QUEUE the typed
  // text to auto-send once the current run finishes. Previously, typing
  // here and hitting Enter while busy silently discarded the text AND
  // stopped the run (handleSendOrStop ignores promptEl.value entirely while
  // busy) — an easy way to accidentally kill a long run. Stop now only ever
  // happens via an explicit click on the button.
  promptEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) {
      return;
    }
    e.preventDefault();
    if (pane.busy) {
      const text = promptEl.value.trim();
      if (text) {
        pane.queuedPrompt = text;
        if (pane.cliSessionId) {
          queuedPromptBySession.set(pane.cliSessionId, text);
        }
        promptEl.value = "";
        renderQueuedPrompt();
      }
      return;
    }
    handleSendOrStop();
  });

  if (pane.busy) {
    sendBtn.textContent = "■";
    sendBtn.title = "Stop";
    sendBtn.classList.add("stopping");
    // No per-pane status text survives a DOM rebuild (it's only ever pushed
    // live via setPaneBusyUI as events stream in) — "Working…" is the same
    // generic fallback sendFromPane itself uses the instant a send starts,
    // so a pane rebuilt mid-run (e.g. by renderWorkspace) still shows the
    // thinking indicator instead of a blank status row until the next event.
    status.append(Object.assign(document.createElement("span"), { className: "pane-status-icon" }));
    status.append(document.createTextNode("Working…"));
    // A DOM rebuild mid-run (e.g. split-view toggle) tears down whatever
    // ticker was targeting the OLD .pane-status node — restart it against the
    // freshly-built one so the live readout keeps ticking instead of freezing
    // at whatever it last showed. runStartedAt/liveTokens survive on the pane
    // object itself, so this picks up exactly where it left off.
    if (pane.runStartedAt) {
      startLiveStatsTicker(index);
      renderLiveStats(index, pane);
    }
  }

  return wrap;
}

// Makes the "thinking" dot visibly react to a new event landing (tool_use,
// incremental usage, or an assistant text chunk) instead of just running a
// fixed generic CSS pulse forever — the captain's ask for the indicator to "feel
// more alive." Briefly swaps in a faster/bigger "ping" animation via a class
// toggle, then lets it fall back to the normal ambient pulse. Simplest thing
// that reads as "reacting to activity," no per-event-type variation needed.
function pulsePaneStatusIcon(index) {
  const dot = document.querySelector(`.pane[data-pane="${index}"] .pane-status-icon`);
  if (!dot) {
    return;
  }
  dot.classList.remove("pane-status-icon-ping");
  // Force a reflow so re-adding the class restarts the animation even if an
  // event landed while the previous ping was still playing.
  void dot.offsetWidth;
  dot.classList.add("pane-status-icon-ping");
}

// Toggles the Send/Stop button + status text for a pane without rebuilding
// its DOM (which would drop typed-but-unsent text in that pane). Also draws
// the "thinking" indicator (a small pulsing dot, Claude Desktop-style) next
// to the status text while pane.busy is true — the exact same busy flag the
// send/stop button already reflects, not a separate signal.
function setPaneBusyUI(index, statusText) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  const pane = panes[index];
  const btn = paneEl.querySelector(".pane-composer .send-btn");
  const status = paneEl.querySelector(".pane-status");
  if (btn) {
    btn.textContent = pane.busy ? "■" : "➤";
    btn.title = pane.busy ? "Stop" : pane.sessionId ? "Continue (Enter)" : "Start session (Enter)";
    btn.classList.toggle("stopping", pane.busy);
  }
  if (status) {
    // Built as child nodes (not a plain textContent string) only when there's
    // something to show — an empty .pane-status has zero children, so the
    // CSS :empty rule that hides the row entirely still applies unchanged.
    status.innerHTML = "";
    if (statusText) {
      if (pane.busy) {
        const dot = document.createElement("span");
        dot.className = "pane-status-icon";
        status.append(dot);
      }
      status.append(document.createTextNode(statusText));
    }
  }
  // setPaneBusyUI wipes .pane-status's innerHTML above, which would otherwise
  // erase the live "Ns · Nk tokens" ticker span every time a tool_use event
  // updates the status text (e.g. "Working — Read"). Re-append it immediately
  // whenever busy, rather than waiting up to 250ms for the next tick.
  if (pane.busy && pane.runStartedAt) {
    renderLiveStats(index, pane);
  }
}

// Surfaces what "Auto" actually resolved to, at the moment it's resolved for
// THIS send - replacing the as-you-type guess (which can go stale between
// typing and hitting Send) so the last thing shown before the run starts is
// the real pick, not a debounced heuristic. Per PLAN.md 9/10: suggest AND let
// the user choose, which requires seeing the resolved choice before paying
// for the run.
function setResolvedAutoHint(index, modelLabel, effort) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const hint = paneEl?.querySelector(".suggest-hint");
  if (!hint) {
    return;
  }
  hint.textContent = `Auto → ${modelLabel} · ${effort}`;
}

async function sendFromPane(index, els) {
  const pane = panes[index];
  const cwd = els.cwdInput.value.trim();
  const typedText = els.promptEl.value.trim();
  if (pane.busy) {
    return;
  }
  if (!cwd) {
    // Was a SILENT no-op before — indistinguishable from "sending is broken".
    // Make the block visible instead of dropping the click on the floor.
    els.cwdInput.classList.add("cwd-missing");
    els.cwdInput.focus();
    return;
  }
  if (!typedText && pane.pendingAttachments.length === 0) {
    return;
  }
  // Image attachments become plain file-path mentions ahead of the typed
  // text — Claude Code's own Read tool fetches them from there (see
  // spike/test-image-via-path.mjs). This is what actually gets sent AND what
  // gets shown in history, so the turn matches what the model received.
  const attachmentPrefix = pane.pendingAttachments
    .map((att) => `[Attached ${att.isImage ? "image" : "file"}: ${att.path}]`)
    .join("\n");
  const prompt = attachmentPrefix ? `${attachmentPrefix}\n\n${typedText}` : typedText;
  // Kept so a failed start below can restore exactly what the user had typed
  // and attached, instead of forcing a full retype (the attachments array
  // itself gets replaced with [] right after, not mutated, so this reference
  // stays intact).
  const sentAttachments = pane.pendingAttachments;
  pane.pendingAttachments = [];
  els.renderAttachments();
  pane.cwd = cwd;
  updatePaneSubText(index, cwd);
  // A new run starts here, so nothing left pending from an EARLIER run can still be
  // legitimate - that run's process has exited and flushed its transcript. Expiring
  // them at this one choke point is what stops a permanently-unmatchable turn riding
  // along at the bottom of the pane forever (task 6bdbcde7); see the function.
  expirePendingTurnsFromEarlierRuns(pane);
  // pending: this turn exists only in memory until the CLI writes it to the transcript, and
  // a reload landing in that window used to delete it (task 20009fdc). The flag is what lets
  // mergeReloadedTurns tell "the file has not caught up yet" apart from "these turns were
  // deliberately cut away".
  const sentTurn = { role: "user", kind: "text", text: prompt, pending: true };
  pane.turns.push(sentTurn);
  // ALSO remembered per session, because the pane object does not survive opening another
  // session and coming back - which is the exact path in his report.
  rememberPendingTurn(pane.sessionId, sentTurn);
  els.promptEl.value = "";
  pane.busy = true;
  // A new turn is starting — whatever reply lastTurnStats described is no
  // longer "the last one," so its stats readout must not keep reattaching to
  // it (wireTurnStatsOnLastReply is otherwise non-destructive and would
  // happily redraw it on every render forever).
  pane.lastTurnStats = null;
  // Drives the LIVE "Ns · Nk tokens" ticker (renderLiveStats) — stamped here,
  // at the true start of the run, not inside setPaneBusyUI (which also fires
  // on every intermediate tool_use/assistant event and must not reset the
  // clock each time). liveTokens resets per run; incremental "usage" events
  // (see the event switch below) add to it as the turn streams in.
  pane.runStartedAt = Date.now();
  pane.liveTokens = 0;
  startLiveStatsTicker(index);
  setPaneBusyUI(index, "Working…");
  renderPane(index);

  // Resolved fresh from the FINAL prompt text at send time (not the debounced
  // background suggestion, which could be stale) — used to fill in any "Auto"
  // picks, and always logged as the suggestion regardless of whether you
  // followed it, so usage-log's followedSuggestion stays meaningful.
  const suggestion = await window.helm.suggestModelEffort(prompt);
  const model = els.modelDD.value === "auto" ? suggestion.model : els.modelDD.value;
  const effort = els.effortDD.value === "auto" ? suggestion.effort : els.effortDD.value;
  if (els.modelDD.value === "auto" || els.effortDD.value === "auto") {
    // Shown just before startSession fires below - the resolved pick, not the
    // debounced as-you-type guess, so there's a real moment to notice/override
    // before the run (and its cost) actually begins.
    setResolvedAutoHint(index, model.replace("claude-", ""), effort);
  }

  // "Switch root folder" (the captain's question about the "…" picker on an
  // EXISTING session — it silently broke the next send with "No conversation
  // found," since --resume scopes lookup by cwd; see DECISIONS.md). If this
  // is a resumed session and the folder was changed since it was opened,
  // copy the transcript into the new folder's project dir FIRST so --resume
  // can actually find it there.
  if (pane.cliSessionId && sessionById(pane.sessionId)?.cwd && sessionById(pane.sessionId).cwd !== cwd) {
    const switchRes = await window.helm.switchSessionRootFolder(pane.cliSessionId, pane.sessionId, cwd);
    if (!switchRes.ok) {
      if (panes[index] === pane) {
        pane.busy = false;
        stopLiveStatsTicker(index);
        setPaneBusyUI(index, "");
        pane.turns.push({ role: "assistant", kind: "text", text: "⚠ Couldn't switch to the new folder: " + switchRes.error });
        // Same restore as the startSession failure branch below — don't make
        // the user retype after a failed folder switch either.
        els.promptEl.value = typedText;
        pane.pendingAttachments = sentAttachments;
        els.renderAttachments();
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
      }
      return;
    }
    // Same guard every other await boundary in this function uses (the
    // failure branch above, the startSession failure branch below) — the
    // pane may have been reset ("+" new chat) or reassigned during the
    // switch's await. Caught in review for consistency: without it, a
    // resumed-but-abandoned pane would still spawn a real CLI process using
    // stale model/effort/session values.
    if (panes[index] !== pane) {
      return;
    }
  }

  const res = await window.helm.startSession({
    cwd,
    prompt,
    model,
    effort,
    permissionMode: els.permissionDD.value,
    resumeSessionId: pane.cliSessionId,
    suggestedModel: suggestion.model,
    suggestedEffort: suggestion.effort,
    // Named mates: a first-mate pane carries its mateId so session:start attaches
    // the dispatch mcp-config bound to THAT mate (not just "the meta-home mate").
    mateId: pane.mateId,
    // Phase-2 Slice 2: a second-mate pane carries its secondMateId so session:start
    // attaches the crew-dispatch tools bound to THAT second mate.
    secondMateId: pane.secondMateId,
  });
  if (!res.ok) {
    if (panes[index] === pane) {
      pane.busy = false;
      stopLiveStatsTicker(index);
      setPaneBusyUI(index, "");
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ Failed to start: " + res.error });
      // A transient failure (e.g. claude.exe momentarily locked) shouldn't
      // force a full retype — the composer was already cleared above, so
      // restore the typed text and re-attach whatever was attached, leaving
      // the pane exactly as it was before Send was pressed (minus the error
      // turn now visible in history).
      els.promptEl.value = typedText;
      pane.pendingAttachments = sentAttachments;
      els.renderAttachments();
      bumpSessionActivity(pane.sessionId);
      renderPane(index);
    }
    return;
  }
  // The pane slot may have been reset/reused during the two awaits above
  // (e.g. the user hit "+" for a new chat before the round-trip finished).
  // Don't wire this launch's live events to whatever now occupies `index` —
  // that would bleed the orphaned launch's reply into the unrelated new
  // session. The underlying process keeps running and completes on its own
  // (still logged/judged main-process side); it's just not shown live.
  if (panes[index] !== pane) {
    return;
  }
  pane.currentLaunchId = res.launchId;
  // Stores the pane OBJECT, not just the index — every launch-scoped event
  // (session/tool_use/assistant/error/done) is routed through this
  // one map with an identity check, so a pane reused before a late event
  // arrives can never have that event misattributed to it.
  launchPaneHistory.set(res.launchId, { index, pane, startedAt: Date.now() });
}

// Fires a prompt queued while the pane was busy (see the Enter-key handler
// in paneComposerEl), through the exact same sendFromPane path used for a
// normal manual send — no duplicated cwd/attachment/suggestion logic. Called
// synchronously from the "done" case, so `panes[index] === pane` is still
// guaranteed true here (no await has happened since the identity check at
// the top of the event switch).
function fireQueuedPromptIfAny(index, pane) {
  if (!pane.queuedPrompt || !pane.els) {
    return;
  }
  const queued = pane.queuedPrompt;
  pane.queuedPrompt = null;
  if (pane.cliSessionId) {
    queuedPromptBySession.delete(pane.cliSessionId);
  }
  pane.els.renderQueuedPrompt();
  pane.els.promptEl.value = queued;
  sendFromPane(index, pane.els);
}

// Rebuilds every pane's DOM. Only call this when the NUMBER of panes changes
// (split on/off) — it discards any in-progress typing in every pane.
function renderWorkspace() {
  // Split view was removed (2026-07-07): a single pane is the model - jumping in
  // from the Fleet always meant "take me to this", not "open beside", and the
  // two-pane machinery carried real bugs (orphaned launch on toolbar-close,
  // same session in both panes, cross-pane task conflation) for a feature the
  // owner was ambivalent about. The workspace always renders exactly one pane.
  const workspace = document.getElementById("workspace");
  workspace.innerHTML = "";
  const paneEl = document.createElement("section");
  paneEl.className = "pane";
  paneEl.dataset.pane = "0";
  workspace.append(paneEl);
  // Track its height from here on, so the composer never has to measure it mid-keystroke.
  observePaneHeight(paneEl);
  focusedPaneIndex = 0;
  renderSinglePane(0);
}

// Rebuilds ONE pane's header/scroll/composer in place. Use this for anything
// that doesn't add or remove a pane (opening a session, resetting to new),
// so typing in the OTHER pane is left untouched.
function renderSinglePane(index) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  paneEl.innerHTML = "";
  paneEl.append(paneHeaderEl(index), scrollContainer(), paneComposerEl(index));
  renderPane(index);
}

function scrollContainer() {
  const div = document.createElement("div");
  div.className = "pane-scroll";
  return div;
}

// ============================== Quota + top controls ==============================

// Quota moved out of the header into the context-gauge popover (the captain's ask:
// "flytta ner quota menyn dit också"). state.quota still flows via refresh();
// the popover reads it directly on open. This is now just a defensive no-op
// kept so the existing refresh() call site doesn't need touching / can't
// throw if the header element is gone.
function renderQuota() {
  // intentionally empty — see comment above
}

// Dashboard token-quota chip (6ed0b09e). Reads state.quota (the same source the
// context-gauge popover uses) into the topbar chip. No-op when the dashboard
// isn't rendered; hidden when there's no quota data yet. Live-updated from the
// poll tick (fillDashboardSections) and the quota stream event.
async function renderDashQuota() {
  const chip = document.getElementById("dashQuotaChip");
  if (!chip) {
    return;
  }
  // Summarize the most-constrained FRESH window across all accumulated limits
  // (bc6786c7), not just whichever window fired last. Falls back to the single
  // latest reading when the accumulator is empty (older persisted state).
  const rows = quotaPanelRows(state.quotaWindows, Date.now());
  let r = worstFreshQuotaRow(rows);
  if (!r && state.quota) {
    const single = quotaReadout(state.quota, Date.now());
    // Same lower-bound treatment as the accumulator path - see the context
    // popover's fallback. Three surfaces read this shape; a qualifier applied to
    // two of them is how the app comes to disagree with itself about one number.
    const singleAge = typeof state.quotaAt === "number" && state.quotaAt > 0 ? Math.max(0, Date.now() - state.quotaAt) : null;
    r = single && !single.stale ? { ...single, ...quotaLowerBound(single, singleAge) } : null;
  }
  if (r && !r.stale) {
    // Real quota signal: a % when the API reports utilization, otherwise the limit
    // status + reset time (the API dropped the utilization field, so the old
    // `q.utilization || 0` always read a fabricated 0% - bug 1975093d).
    chip.textContent = r.chipText;
    chip.title = r.title;
    chip.className = "dash-quota-chip" + (r.level === "hot" ? " hot" : r.level === "warm" ? " warm" : "");
    return;
  }
  // No fresh quota (never read this session, OR the last reading is STALE - its
  // window elapsed, bug bc6786c7): don't show a confident "OK" from a dead reading.
  // Fall through to Helm's OWN usage log, which is always current.
  // Fallback so the chip is never blank (bug 6ed0b09e: "I still don't see it" -
  // the API quota % is only present near a limit, so for a user with headroom it
  // was always empty -> hidden). Helm's OWN usage log (readUsageSummary) is
  // always available: show cumulative tracked spend + run count. Labeled "Usage"
  // (not "Quota") so it's not mistaken for the subscription %.
  try {
    const res = await window.helm.getUsageSummary();
    const cost = Number(res?.totalCostUsd) || 0;
    const runs = Number(res?.totalRuns) || 0;
    if (cost > 0 || runs > 0) {
      chip.textContent = `Usage $${cost.toFixed(2)}`;
      chip.title = `Helm-tracked spend across ${runs} run${runs === 1 ? "" : "s"} (your subscription quota % only shows when the API reports it, near a limit).`;
      chip.className = "dash-quota-chip";
      return;
    }
  } catch {
    // fall through to empty
  }
  chip.textContent = "";
  chip.title = "";
  chip.className = "dash-quota-chip";
}

// Pure display model for the Fleet-spend chip, extracted so it can be unit-tested
// without the app (renderDashOrchestration just paints what this returns).
// The dollar figure confuses subscription users (task 18d4c9f4: "what is fleet
// spend? where does the $25 come from - I'm on a subscription, not pay-by-usage?").
// It is Helm's OWN estimate of what the fleet's model usage WOULD cost at API
// rates (summed from each run's reported token cost), used only as the guardrail
// behind the Stop button + the $ ceiling - NOT a charge against the subscription.
// So: an explicit "(est.)" qualifier on the label + a tooltip that says so.
const FLEET_SPEND_TOOLTIP =
  "Estimated fleet cost, not a bill. Helm sums what each run's tokens WOULD cost at API rates - it's the guardrail the Stop button and the $ ceiling use to cap a runaway fleet. On your Claude subscription nothing is charged per use; this number is only an internal budget estimate.";
function orchestrationChipContent(budget) {
  if (!budget) {
    return { hidden: true };
  }
  const spent = Number(budget.spentUsd) || 0;
  const ceiling = typeof budget.ceilingUsd === "number" ? budget.ceilingUsd : null;
  const over = ceiling != null && spent >= ceiling;
  const stopped = !!budget.killed;
  // Idle + nothing spent + not stopped: stay out of the way (hidden).
  if (!stopped && !over && spent <= 0) {
    return { hidden: true };
  }
  let labelText;
  if (stopped) {
    labelText = "⏸ Fleet stopped";
  } else if (over) {
    labelText = `Budget reached · ~$${spent.toFixed(2)} est.`;
  } else {
    // "(est.)" so the figure never reads as real billing (18d4c9f4).
    labelText = ceiling != null ? `Fleet spend (est.) ~$${spent.toFixed(2)} / $${ceiling.toFixed(0)}` : `Fleet spend (est.) ~$${spent.toFixed(2)}`;
  }
  return { hidden: false, stopped, over, labelText, title: FLEET_SPEND_TOOLTIP };
}

// Phase-2 orchestration guardrail control (Slice 0): a budget readout + a kill/
// resume toggle on the Dashboard. Subtle when idle; amber when stopped or over
// budget. No-op if the chip isn't rendered.
async function renderDashOrchestration() {
  const chip = document.getElementById("dashOrchestrationChip");
  if (!chip) {
    return;
  }
  let budget = null;
  try {
    const res = await window.helm.getOrchestrationBudget();
    budget = res && res.ok ? res.budget : null;
  } catch {
    budget = null;
  }
  chip.textContent = "";
  chip.className = "dash-orch-chip";
  const content = orchestrationChipContent(budget);
  if (content.hidden) {
    return;
  }
  const spent = Number(budget.spentUsd) || 0;
  const over = content.over;
  const stopped = content.stopped;
  chip.title = content.title;
  const label = document.createElement("span");
  label.className = "dash-orch-label";
  if (stopped || over) {
    chip.classList.add("stopped");
  }
  label.textContent = content.labelText;
  chip.append(label);
  const btn = document.createElement("button");
  btn.className = "dash-orch-btn";
  if (stopped || over) {
    btn.textContent = "Resume";
    btn.title = "Clear the stop + reset spend so new work can start (keeps the ceiling)";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await window.helm.resumeOrchestration();
      renderDashOrchestration();
    });
  } else {
    btn.textContent = "Stop";
    btn.title = "Stop everything: halt the whole fleet (cancels live runs; blocks new work from starting)";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await window.helm.killOrchestration();
      showToast(res && res.ok ? `Fleet stopped (${res.cancelled} live run${res.cancelled === 1 ? "" : "s"} cancelled).` : "Couldn't stop the fleet - try again.");
      renderDashOrchestration();
    });
  }
  chip.append(btn);
}

async function refresh() {
  const [data, matesResult, secondMatesResult] = await Promise.all([
    window.helm.getSessions(),
    window.helm.listMates(),
    window.helm.listSecondMates(),
  ]);
  // Map a bound second-mate session -> its second mate, so the needs-you queue
  // can show a second mate by its FLEET name ("2nd mate · helm") instead of its
  // raw first-prompt title ("You are the second mate for..."), which read as a
  // different thing entirely (bug 2992bcfd).
  secondMateBySessionId = new Map(
    ((secondMatesResult?.ok ? secondMatesResult.secondMates : secondMatesResult) || [])
      .filter((sm) => sm && sm.sessionId)
      .map((sm) => [sm.sessionId, sm])
  );
  // Which sessions are ACTUALLY a first mate: the ones bound to an active mate
  // (mate.sessionId), not merely rooted at the meta-home. A personal chat the
  // captain happens to root in the meta-home dir (e.g. the Claude rules folder)
  // is NOT a first mate - keying off cwd alone wrongly tagged it "◆ Helm" and
  // showed the "first mate X% full" nudge on it. (Bug: "vissa sessioner i
  // direct verkar klassas som first mate".)
  const activeMatesForBinding = (matesResult?.ok ? matesResult.active : []).filter((m) => m.sessionId);
  mateSessionIds = new Set(activeMatesForBinding.map((m) => m.sessionId));
  mateBySessionId = new Map(activeMatesForBinding.map((m) => [m.sessionId, m]));
  // Detect sessions newly transitioning INTO the needs-you "waiting" state (not
  // already there before this poll) for away-from-desk attention delivery - fire
  // once per transition, not on every poll tick.
  // NOTE (Epic f3d096fa): keyed on lifecycleState, not raw status. This is a small
  // INTENTIONAL behaviour change (not a pure equivalence): a session that went
  // wrapped (classifier said "done", toast suppressed) and then flips back to
  // waiting - the async Fas-3 sweep re-tagging it "waiting_for_input" while status
  // stays "waiting" - now fires the toast. The old status-keyed set silently
  // swallowed that (it counted as "already waiting"), which was a false NEGATIVE -
  // exactly the miss the prefer-false-positives rule says is the worse failure. So
  // this surfaces a genuine wrapped->needs-you transition instead of hiding it.
  const previouslyWaiting = new Set(state.sessions.filter((s) => s.lifecycleState === "waiting").map((s) => s.sessionId));
  // A session "removed from Helm" must not fire an OS attention toast - that's
  // the most intrusive way a hidden session could leak back. Read the freshly
  // fetched config (data.config), not state.config, so a hide applied this very
  // poll is honored immediately.
  const hiddenNow = new Set(data.config?.hiddenSessions || []);
  for (const session of data.sessions) {
    if (
      // FSM 'waiting' = turn ended, awaiting input, NOT done - so it replaces the
      // status==="waiting" && !classifierSaysSessionDone pair (Epic f3d096fa).
      session.lifecycleState === "waiting" &&
      !previouslyWaiting.has(session.sessionId) &&
      !hiddenNow.has(session.sessionId) &&
      // A first mate that ends its turn only to await crew that is STILL RUNNING
      // isn't waiting on you - don't fire the intrusive "needs input" toast for it
      // (bug 9c0c7209).
      //
      // Keyed on `live`, not `has`. `has` is also true once the crew has FINISHED,
      // which suppressed the toast at exactly the moment there was something to say.
      // Finished crew is announced separately below, because by then this session
      // transition has usually already happened and cannot fire twice.
      !mateCrewWait(firstMateForSession(session)).live
    ) {
      window.helm.notifyAttention({ title: "Helm - session needs input", body: sessionDisplayName(session) });
    }
  }
  // Crew that has just SETTLED - the arrival the card calls "0 tokens": Helm already
  // knows, because it wrote the report itself the moment the run ended. Nothing was
  // doing anything with that. No model is asked anything here; this only says that
  // something came back and whether it looks like trouble.
  for (const mate of activeMatesForBinding) {
    const wait = mateCrewWait(mate);
    if (wait.live) {
      matesWithLiveCrew.add(mate.mateId);
      continue;
    }
    const wasLive = matesWithLiveCrew.delete(mate.mateId);
    if (wasLive && (wait.reports || wait.alarm)) {
      const notice = crewSettledNotice(mate, wait);
      // BOTH, the same way a failed run already does it. The OS toast is gated on the
      // window not being focused - deliberately, so it does not nag while he is already
      // looking at Helm - which means it says nothing at all when he IS looking. An
      // in-app notice is what covers that, and it can carry somewhere to go.
      showNotice(`${notice.title.replace(/^Helm - /, "")}: ${notice.body}`, {
        actions: [{ label: "Open Dashboard", onClick: () => navigateToPage("dashboard") }],
      });
      window.helm.notifyAttention(notice);
    }
  }

  state.sessions = data.sessions;
  state.config = data.config;
  state.quota = data.quota;
  state.quotaWindows = data.quotaWindows || [];
  state.quotaAt = data.quotaAt || null;
  updateAttentionTaskbarCount();
  applyViewMode();
  applyTheme(state.config?.theme);
  renderQuota(state.quota);
  pruneStaleLaunchHistory();
  pruneStaleBackgroundTasks();
  renderBackgroundTasksBadge();
  // The dashboard updates per-section (refreshDashboardIfVisible ->
  // fillDashboardSections), re-rendering only the sections whose data changed,
  // so calling it every tick is cheap and never tears down the whole page.
  refreshDashboardIfVisible();
}

// First-load: land on the Dashboard, not on any specific chat. PLAN.md's
// orchestrator-lifespan redesign retired the old behavior here (auto-opening
// the most-recently-active "orchestrator" session in pane 0) — there is no
// privileged session to land on anymore. The Dashboard (overview + attention
// spotlight) is the home now; Chat is one destination among the page tabs,
// reached the same way any other page is.
async function startup() {
  // Resolve the orchestrator meta-home once so isOrchestratorSession (called
  // synchronously in every sidebar/dashboard render) can compare cwds without
  // an async round-trip. Fetched before the first refresh so the initial
  // render already tags orchestrator sessions correctly.
  try {
    const oi = await window.helm.getOrchestratorInfo();
    if (oi.ok) {
      state.orchestratorHome = oi.cwd;
    }
  } catch {
    // Leaves state.orchestratorHome as-is (""); nothing tags as orchestrator
    // until it resolves, which is a safe default.
  }
  await rehydrateGoalRuns();
  await refresh();
  updateRunningIndicator();
  // Runs already in flight when the app opens count too - a badge that only
  // appeared once a NEW event arrived would read zero after every restart.
  paintAutopilotBadge();
  // startup: the default landing page, NOT an override of a page you already
  // picked while this was still loading.
  navigateToPage("dashboard", { startup: true });
}

// Seeds goalRuns from the persisted index (src/lib/goalRunHistory.js) so past
// runs still show on the Goal page after a restart, instead of the in-memory
// Map silently starting empty every time. Only the compact fields main.js
// wrote are available (no iteration list/plan — those live in the worktree's
// own .helm-goal/notes.md), so each rehydrated entry renders as a plain
// finished/interrupted summary rather than the richer live-run view. Runs
// left "running" have already been downgraded to "interrupted" by the
// goal:history handler if no live process backs them.
async function rehydrateGoalRuns() {
  let records = [];
  try {
    records = await window.helm.getGoalRunHistory();
  } catch {
    return;
  }
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }
  // Oldest first, so ordinals ("Run 1", "Run 2", ...) read in the order the
  // runs actually happened, same as goalRunSeq's live increment does.
  for (const record of records) {
    goalRuns.set(record.goalRunId, {
      goalRunId: record.goalRunId,
      ordinal: ++goalRunSeq,
      goal: record.goal,
      projectPath: record.projectPath,
      // Carry the dispatch metadata so a dispatched run keeps its mate grouping
      // in the Fleet view across restarts (else it falls under "Direct").
      dispatchedBy: record.dispatchedBy || null,
      tier: record.tier || null,
      maxIterations: undefined,
      model: undefined,
      effort: undefined,
      verifyCommand: undefined,
      escalationConfig: undefined,
      // "running"/"done"/"error"/"interrupted" — matches the live status
      // model exactly (an escalated stop is still status "done", with the
      // distinction carried by `escalation`, same as goalRunDetailEl already
      // expects). goalRunDetailEl only renders a Cancel button for
      // status === "running", so a rehydrated "interrupted" run correctly
      // shows no Cancel affordance.
      status: record.status,
      iterations: [],
      result:
        record.status === "done"
          ? {
              worktreePath: record.worktreePath,
              branchName: record.branchName,
              commitCount: record.commitCount,
              stoppedReason: record.stoppedReason,
              // The run's OWN output, carried across a restart. Persisting it on the
              // record was only half the fix: nothing read it back, so a plan-only
              // run's plan - its entire deliverable, and no longer committed now that
              // .helm-goal/ is gitignored - was still gone after a restart (found by
              // independent review, 2026-08-03, on a fix I had called done).
              plan: record.plan || null,
              notes: record.notes || null,
              // The model the CLI actually resolved to, distinct from the
              // requested `model` field above (which stays undefined here -
              // model/effort aren't persisted on rehydration at all, a
              // pre-existing gap out of scope for this fix). `resolvedModel`
              // IS persisted (see main.js startGoalRun), so it survives.
              resolvedModel: record.resolvedModel || null,
            }
          : null,
      error: record.error || null,
      escalation: record.escalation || null,
      latestPlan: record.plan || null,
      latestNotes: record.notes || null,
      latestModel: record.resolvedModel || null,
      // When this run reached its terminal state, carried across a restart so a
      // report-back nudge can scope itself to work that landed SINCE the mate last
      // looked. Without it every rehydrated run looks equally fresh forever, which is
      // how one mate was handed 27 runs to merge, most of them days old and already
      // merged (found live 2026-08-18).
      finishedAt: record.updatedAt || record.startedAt || null,
      persisted: true,
    });
  }
}

// This is now the ONLY thing that cleans up launchPaneHistory. It was written as a backstop
// for the model-fit judge failing to emit its event; the judge was removed on 2026-08-30, so
// the backstop is the mechanism. Nothing else bounds this map over a long-running session.
//
// This map is now also the ONLY routing table for every live event
// (session/tool_use/assistant/error/done), so pruning by age alone would be
// a real regression: a long xhigh-effort prompt can easily run past a fixed
// cutoff while still genuinely in progress, and pruning its entry mid-run
// would silently drop its remaining events. Only prune once the launch can
// no longer matter — either the attached pane is done with it (busy: false)
// or the pane was already reset/reused elsewhere (identity mismatch), in
// which case nothing could ever reach this entry again regardless of age.
function pruneStaleLaunchHistory() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [launchId, entry] of launchPaneHistory) {
    const stillAttachedAndBusy = panes[entry.index] === entry.pane && entry.pane.busy;
    if (stillAttachedAndBusy) {
      continue;
    }
    if ((entry.startedAt || 0) < cutoff) {
      launchPaneHistory.delete(launchId);
    }
  }
}

// Backstop for backgroundTasks — "Clear finished" is the normal way entries
// go away, but a session that never clicks it (or forgets to) grows this map
// forever. Only removes tasks that already reached a terminal state and are
// old enough that nobody's still looking at them; a still-"running" task is
// never touched here regardless of age (its own task_updated/task_done will
// resolve it, or it'll age out once THAT lands).
function pruneStaleBackgroundTasks() {
  const cutoff = Date.now() - BACKGROUND_TASK_MAX_AGE_MS;
  for (const [taskId, t] of backgroundTasks) {
    if (TERMINAL_TASK_STATUSES.has(t.status) && (t.startedAt || 0) < cutoff) {
      backgroundTasks.delete(taskId);
    }
  }
}

// Selectable app themes. Each id has a matching :root[data-theme="<id>"] var-map
// in style.css; applyTheme just stamps the id on <html>. Add a theme by adding
// a CSS block + an entry here. The app picks its theme explicitly (persisted in
// config.theme), not from prefers-color-scheme.
// A theme carries not just a color map (the :root[data-theme] block in
// style.css) but an IDENTITY: its icons here, and its mate name pool in
// mates.js. The nautical themes (dark/brass) share the ship's-wheel logo +
// anchor; space swaps them for a satellite + rocket. `logo` is either an image
// asset or an emoji glyph.
const NAUTICAL_ICONS = { anchor: "⚓", logo: { asset: "assets/helm-logo.png" } };
const THEMES = [
  // `id` stays "dark"/"brass" (persisted in config.theme, CSS [data-theme], the
  // nautical name-pool set) - only the human label changes. dark + brass are
  // both the nautical family; space is its own.
  { id: "dark", label: "Nautical (dark)", icons: NAUTICAL_ICONS },
  { id: "brass", label: "Brass (light)", icons: NAUTICAL_ICONS },
  { id: "space", label: "Space (dark)", icons: { anchor: "🚀", logo: { glyph: "🛰️" } } },
  { id: "adventure", label: "Adventure (dark)", icons: { anchor: "🧭", logo: { glyph: "🗺️" } } },
  { id: "anime", label: "Anime (dark)", icons: { anchor: "🌸", logo: { glyph: "⭐" } } },
  { id: "game", label: "Game (dark)", icons: { anchor: "🎮", logo: { glyph: "🕹️" } } },
  { id: "fantasy", label: "Fantasy (dark)", icons: { anchor: "🗡️", logo: { glyph: "🐉" } } },
  { id: "superhero", label: "Superhero (dark)", icons: { anchor: "🛡️", logo: { glyph: "🦸" } } },
  { id: "cyberpunk", label: "Cyberpunk (dark)", icons: { anchor: "⚡", logo: { glyph: "🤖" } } },
  { id: "western", label: "Western (dark)", icons: { anchor: "🐎", logo: { glyph: "🤠" } } },
  { id: "noir", label: "Noir (dark)", icons: { anchor: "🔍", logo: { glyph: "🕵️" } } },
  { id: "evil", label: "Evil (dark)", icons: { anchor: "💀", logo: { glyph: "😈" } } },
];
function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}
function currentThemeId() {
  return document.documentElement.dataset.theme || state.config?.theme || "dark";
}
function themeIcons() {
  return themeById(currentThemeId()).icons;
}
function applyTheme(themeId) {
  const id = THEMES.some((t) => t.id === themeId) ? themeId : "dark";
  document.documentElement.dataset.theme = id;
  updateBrandLogo(id);
}
// The header brand logo follows the theme: an <img> for asset logos (the
// helm wheel), a glyph <span> for emoji logos (space). Swaps the element in
// place, keeping the .logo class so CSS sizing applies to both.
function updateBrandLogo(id) {
  const brand = document.querySelector(".brand");
  const existing = brand && brand.querySelector(".logo");
  if (!existing) {
    return;
  }
  const logo = themeById(id).icons.logo;
  let node;
  if (logo.asset) {
    node = document.createElement("img");
    node.src = logo.asset;
    node.alt = "Helm";
  } else {
    node = document.createElement("span");
    node.textContent = logo.glyph;
  }
  node.className = "logo";
  existing.replaceWith(node);
}

function applyViewMode() {
  document.body.classList.toggle("advanced", state.config.viewMode === "advanced");
  // Scoped to #viewToggle specifically — a bare ".view-toggle button" also
  // matches the page tabs and sidebar mode toggle (same shared class), which
  // was wiping their active state every time this ran.
  document.querySelectorAll("#viewToggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.config.viewMode || "simple"));
  });
}

// The session sidebar's controls lived here - a search field, a "new category" button, a
// collapse rail and "+ New chat". All five elements are gone with the panel (task 22f85eda),
// and so are their listeners: an addEventListener on a getElementById that now returns null
// throws at module scope, which takes the whole renderer down before it draws anything. That is
// the failure mode a deletion like this actually has, and `node --check` cannot see it - which
// is why the removal is verified by booting the app and rendering every view.
//
// Starting a fresh chat now comes from the Dashboard's "New session" section or the command
// palette; the palette's own entry no longer clicks a button that does not exist.

// ============================== Focus page (Point 8) ==============================
// A goal-to-tasks focus view, BACKED BY JOT — not a second task system. It
// reads the same todos.json the sidebar's category matching reads (via
// jot.js's loadGoals) and answers "of my several active goals, which should I
// work on right now?" by ranking top-level goals on the same kind of signals
// sessions.js scores sessions with (deadline proximity, in-progress status,
// priority). Read-only ranking is the core; each goal can be expanded to see
// its subtasks and to add new ones (the one Jot write, via the safe atomic
// path in jot.js). Deliberately NOT goal-to-session dispatch, auto-scheduling,
// or drag-reprioritization — those are later (PLAN.md Phase 3).

// Deadline label for the Focus page. Unlike deadlineChipText (which hides
// anything past 7 days to avoid cluttering sidebar rows), a goal's own
// breakdown should always state its deadline when it has one.
function goalDeadlineText(ms) {
  if (typeof ms !== "number") {
    return "";
  }
  const DAY = 24 * 60 * 60 * 1000;
  const msLeft = ms - Date.now();
  if (msLeft < 0) {
    return "overdue";
  }
  if (msLeft < DAY) {
    return "due today";
  }
  const days = Math.round(msLeft / DAY);
  return `due in ${days}d`;
}

const SUBTASK_STATUS_LABEL = {
  open: "○ open",
  "in-progress": "◐ in progress",
  review: "◎ review",
  done: "● done",
};

// ============================== Dashboard page (Variant A, now the default landing page) ==============================
//
// Approved design "Variant A (attention-first)" - see the mock this was built
// from for the exact target layout/structure. This is now the app's home
// page (see startup() below) per PLAN.md's orchestrator-lifespan redesign:
// there is no privileged "orchestrator session" to land on anymore, so the
// app opens on this overview instead. Chat is still fully functional and
// reachable via its own page tab exactly as before - nothing about starting,
// opening, or running a session was removed, only the old default-to-a-
// specific-chat behavior.
//
// Variant A's structural change from the earlier v2 shape: the old separate
// "In motion" and "Orchestrator proposes" sections are now ONE merged,
// prioritized list ("Needs you & in motion") - items needing a click
// (approvals, waiting-for-input sessions) sort to the top, running work below,
// ordered by urgency rather than by section/chronology. Goals stays a
// separate, calmer browsing section below it. "New session" drops the manual
// load-context checklist for a passive one-line strip describing what already
// auto-loads.
//
// Real data used here: state.sessions (attention queue) and jot:goals (Goals
// - the same IPC the goal surfaces used). Anything without existing plumbing
// (background worktree telemetry, a real work/private domain tag on Jot
// goals, actual session-start-from-dashboard) is rendered as a clearly
// labeled placeholder rather than invented data - see the individual section
// comments below.
let dashboardSelectedChip = null; // which "New session" project chip is selected (a cwd string)

function isDashboardVisible() {
  return !document.getElementById("dashboardPage").classList.contains("hidden");
}

// Keeps the Dashboard live from the 30s refresh() tick (and after
// dashboard-mutating actions) WITHOUT a full-page rebuild. Once the shell is
// built (by renderDashboardPage on navigation), this updates each section in
// place via fillDashboardSections, re-rendering only the sections whose data
// changed - so an idle tick repaints nothing and a single session's status
// change repaints just the queue. A no-op when the page isn't open.
function refreshDashboardIfVisible(opts = {}) {
  if (isDashboardVisible()) {
    fillDashboardSections(opts);
  }
}

// Per-section fingerprints so fillDashboardSections can skip sections whose
// source data is unchanged. Reset on each full renderDashboardPage.




// What the widget dashboard is a picture OF. Deliberately cheap and synchronous:
// it runs on every poll tick, so it must not fetch anything. Sessions carry the
// bulk of it because the fleet widgets are derived from them - a new session is
// a new node, and a status change is a changed badge.
let lastWidgetDashboardFingerprint = null;
function widgetDashboardFingerprint() {
  const sessions = (state.sessions || [])
    .filter((s) => !s.isArchived)
    .map((s) => `${s.sessionId}:${s.status}:${s.startedBy || "-"}:${s.lastActivityAt || 0}`)
    .sort()
    .join("|");
  // Iteration count, for the same reason. A new iteration on a still-"running"
  // run does not change its status, so keying runs on `goalRunId:status` alone
  // made the fingerprint byte-identical before/after onGoalEvent pushed the new
  // record - the repaint gate skipped, and the crew row's `iter N` label sat
  // frozen until an unrelated repaint (e.g. switching views and back) happened
  // (the captain, 2026-08-11: "den här renderas inte om förän jag byter vy och
  // tillbaka"). Keyed on the in-memory length only - cheap and synchronous, no IPC.
  const runs = [...goalRuns.values()]
    .map((r) => `${r.goalRunId}:${r.status}:${r.iterations?.length || 0}`)
    .sort()
    .join("|");
  const layout = (state.config?.dashboardWidgets?.layout || []).map((w) => `${w.id}:${w.span}`).join("|");
  // VIEW state, not just data. The fingerprint's job is "would the rendered
  // output differ", and an expand/collapse toggle changes the output without
  // changing a single session. Leaving it out made the archive group's "Review"
  // button do nothing on the widget dashboard: the click flipped the flag and
  // asked for a repaint, the fingerprint said nothing had changed, and the
  // repaint was skipped (the captain, 2026-08-03: "review gör ingenting i needs you
  // widgeten"). Any future toggle that repaints belongs here too - the bug is
  // silent, because a button that does nothing looks identical to a button whose
  // work you cannot see.
  const view = `arch:${dashboardArchiveGroupExpanded ? 1 : 0}`;
  // Quota, for the same reason. A fresh reading arrives on its own event and only
  // repainted the top-bar chip, so the Quota widget's numbers sat frozen until
  // something unrelated changed - which is what "den verkar inte uppdateras så
  // konsekvent" (the captain, 2026-08-03) actually was. Keyed on the reading itself,
  // not its timestamp, so an identical re-read still costs nothing.
  const quota = (state.quotaWindows || [])
    .map((w) => `${w?.info?.rateLimitType || "?"}:${w?.info?.utilization ?? "-"}:${w?.info?.status || "-"}:${w?.info?.resetsAt || 0}`)
    .sort()
    .join("|");
  return [sessions, runs, layout, state.config?.autoCaptain?.enabled === true, view, quota].join("##");
}


// The Fleet: the orchestration model made visible as three columns (the locked
// mock). Two NAMED first mates (sessions you jump into) + Direct. Under each
// first mate, its second mates (per-project SESSIONS, also jumpable); under each
// second mate, its crew (the autonomous Autopilot runs, expandable + followable).
// first mate / second mate = sessions (💬, jump in); crew = background tasks
// (⚙, follow). Always shown - the two mates always exist (ensureMates).

// Merge a crew run's persisted history record with its live in-memory run (if
// still running) so status/commits reflect reality.
function crewLiveRun(rec) {
  return goalRuns.get(rec.goalRunId) || rec;
}

/** How much of a run's goal a crew row shows before it is cut. */
const CREW_HEADLINE_MAX = 58;

/**
 * A one-line headline for a crew row, out of a run's whole goal prompt.
 *
 * The row used to print the entire prompt. For an auto-started run that prompt is
 * "Task from the board: <card title>\n\n<the whole description>\n\n<the standing
 * instructions about branches and not merging>" - so five rows in one project all
 * began with the same words, the card title appeared twice, and whatever actually
 * distinguished them sat past the ellipsis (the captain, 2026-08-03, on first seeing the
 * tree work: "radetiketterna är obrukbara").
 *
 * A helper for exactly this was written and then deleted the same morning as dead
 * code. It WAS uncalled - but that meant it had never been wired up, not that the
 * problem was gone, and the problem only became visible once the rows themselves
 * finally rendered. Cut on a word boundary, with an ellipsis so a truncated title is
 * never mistaken for the whole thing; the full prompt moves to the row's tooltip.
 */
function crewRunHeadline(goal) {
  const first =
    String(goal || "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) || "(no goal)";
  const stripped = first.replace(/^Task from the board:\s*/i, "").trim() || first;
  if (stripped.length <= CREW_HEADLINE_MAX) {
    return stripped;
  }
  const cut = stripped.slice(0, CREW_HEADLINE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > CREW_HEADLINE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
function crewCommitCount(r) {
  return (typeof r.result?.commitCount === "number" ? r.result.commitCount : r.commitCount) || 0;
}
function crewNeedsCaptain(r) {
  return !!r.escalation || r.status === "error" || (r.status === "done" && crewCommitCount(r) > 0);
}
function crewRunning(r) {
  return r.status === "running" && !r.escalation;
}
// A first mate is "waiting on crew" (not on you) when its own turn has ended
// but it still has >=1 live dispatched crew run in flight. Crew runs carry
// dispatchedBy === the first mate's mateId (same grouping the crew rows use,
// see pendingSecondMateReviewNudge / terminalRunsBy); crewRunning() is the
// exact predicate behind the "N crew working" crew-row badge. Single-source
// this so the card badge and the top queue agree on when a mate is merely
// awaiting its own dispatched work vs genuinely waiting on the user.
function mateHasLiveCrew(mate) {
  if (!mate || !mate.mateId) {
    return false;
  }
  return [...goalRuns.values()].some((r) => r.dispatchedBy === mate.mateId && crewRunning(r));
}

// Classify a WAITING first mate's relationship to its own dispatched crew, so
// the card badge, the top-queue row, the needs-a-click count, and the OS-notify
// guard all agree. The point (bug 9c0c7209): a first mate whose turn ended after
// dispatching crew is NOT blocked on your INPUT - it's awaiting its crew's
// outcome, which flows back up through its second mates. That's true even when
// the crew ERRORED/escalated: the action then lives on the crew (its own
// needs-you attention rows + the second mate's "crew needs a decision"), not as
// "type something to the first mate". So a mate with ANY crew (live, clean-
// reported, or errored) reads as a crew state, never the alarm "needs you". Only
// a mate genuinely awaiting your reply with NO crew to explain the wait is
// "needs input". Returns { has, live, alarm, reports }.
function mateCrewWait(mate) {
  if (!mate || !mate.mateId) {
    return { has: false, live: false, alarm: false, reports: false };
  }
  const live = mateHasLiveCrew(mate);
  const terminal = terminalRunsBy(mate.mateId);
  const alarm = terminal.some((r) => r.status === "error" || !!r.escalation);
  return { has: live || terminal.length > 0, live, alarm, reports: !live && !alarm && terminal.length > 0 };
}

/**
 * What to say when a mate's crew has come back.
 *
 * Deliberately says whether it looks like trouble, and nothing more. Reading the
 * reports to decide what they MEAN is the next step in the design and it costs a
 * model call; this one is free, and free is what makes it safe to fire every time.
 *
 * @param {any} mate
 * @param {{ alarm: boolean, reports: boolean }} wait
 */
function crewSettledNotice(mate, wait) {
  const runs = terminalRunsBy(mate.mateId);
  const bad = runs.filter((r) => r.status === "error" || !!r.escalation).length;
  const where = mate.name ? ` (${mate.name})` : "";
  const many = runs.length === 1 ? "A crew run" : `${runs.length} crew runs`;
  return wait.alarm
    ? {
        title: "Helm - crew came back with a problem",
        body: `${many} finished${where}; ${bad} needs a decision.`,
      }
    : {
        title: "Helm - crew finished",
        body: `${many} finished${where} and nobody has read the report yet.`,
      };
}

// A small themed, centered confirm modal (never the native window.confirm -
// the captain's standing rule). Calls onConfirm only if the user confirms; clicking
// the backdrop or Cancel dismisses. Reusable for any destructive action.
/**
 * `deliberate: true` focuses CANCEL rather than OK.
 *
 * The default focuses OK, so click-then-Enter/Space confirms - and for the review
 * flow this dialog is the ONLY guard in the whole path, which makes a reflex keypress
 * enough to sign off work whose checks are failing. Escape and the backdrop still
 * dismiss; the point is only that the destructive answer is never the one your hands
 * are already on.
 */
// `extraEl` is an element placed between the message and the buttons, for a confirm that
// needs a CHOICE rather than only a yes - the reviewer dispatch needs a model picker, and
// a second dialog implementation would be a second set of escape/backdrop/settle bugs.
function customConfirm(message, confirmLabel, onConfirm, { deliberate = false, onCancel = null, extraEl = null } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  const box = document.createElement("div");
  box.className = "confirm-box";
  const msg = document.createElement("div");
  msg.className = "confirm-msg";
  msg.textContent = message;
  const row = document.createElement("div");
  row.className = "confirm-row";
  const cancel = document.createElement("button");
  cancel.className = "confirm-cancel";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "confirm-ok";
  ok.textContent = confirmLabel;
  // close() unconditionally removes the keydown listener, so dismissing via
  // Cancel/OK/backdrop doesn't leak an esc listener on document (review: both
  // agents) - same shape as showImageLightbox.
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      close();
    }
  };
  // Every dismissal path funnels through close(), and onCancel fires exactly once -
  // otherwise a caller awaiting an answer hangs on Escape. (This block was written
  // once already and a blunt string-replacement put it in showImageLightbox instead,
  // where `onCancel` is not in scope: a live ReferenceError on Escape, and this guard
  // silently absent. Third time today that a scripted replace hit the wrong site.)
  let settled = false;
  const close = (confirmed = false) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (settled) {
      return;
    }
    settled = true;
    if (!confirmed && onCancel) {
      onCancel();
    }
  };
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  ok.addEventListener("click", (e) => {
    e.stopPropagation();
    close(true);
    onConfirm();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
    }
  });
  document.addEventListener("keydown", onKey);
  row.append(cancel, ok);
  box.append(msg);
  if (extraEl) {
    box.append(extraEl);
  }
  box.append(row);
  overlay.append(box);
  document.body.append(overlay);
  // See the deliberate flag: for a destructive confirm the focus goes to Cancel, so
  // a reflex Enter cannot complete it.
  (deliberate ? cancel : ok).focus();
}

/**
 * Ask for a line of text, in-app.
 *
 * window.prompt is disabled in Electron - it returns undefined immediately - so a
 * button that called it did nothing at all, with no error and no hint. "Send back"
 * on the review page had never worked for exactly that reason (task ebb4e567,
 * the captain: "Trycker på send back, inget händer"), and silence is the worst failure a
 * button can have: it reads as the app ignoring you. The codebase already knew the
 * trap - the mate rename button carries a comment about it - but there was no text
 * equivalent of customConfirm to reach for, so this call site kept the dead API.
 *
 * Deliberately the same shell as customConfirm: same overlay, same escape/backdrop
 * dismissal, same one-shot settling so a caller awaiting an answer cannot hang.
 * Calls onSubmit(text) with a trimmed, non-empty string, or onCancel() - never both,
 * and never with an empty string, since every caller so far needs a real reason.
 */
function customPrompt(message, onSubmit, { confirmLabel = "Save", placeholder = "", multiline = true, onCancel = null, extraEl = null, onField = null } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  const box = document.createElement("div");
  box.className = "confirm-box prompt-box";
  const msg = document.createElement("div");
  msg.className = "confirm-msg";
  msg.textContent = message;
  const field = document.createElement(multiline ? "textarea" : "input");
  field.className = "prompt-field";
  field.placeholder = placeholder;
  if (multiline) {
    field.rows = 4;
  }
  const row = document.createElement("div");
  row.className = "confirm-row";
  const cancel = document.createElement("button");
  cancel.className = "confirm-cancel";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "confirm-ok";
  ok.textContent = confirmLabel;

  let settled = false;
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      close();
    }
  };
  const close = (submitted = false) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (settled) {
      return;
    }
    settled = true;
    if (!submitted && onCancel) {
      onCancel();
    }
  };
  const submit = () => {
    const text = field.value.trim();
    if (!text) {
      // Say why nothing happened rather than closing on an empty answer - the whole
      // point of this dialog is that a button never fails in silence again.
      field.classList.add("prompt-field-empty");
      field.focus();
      return;
    }
    close(true);
    onSubmit(text);
  };
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  ok.addEventListener("click", (e) => {
    e.stopPropagation();
    submit();
  });
  field.addEventListener("input", () => field.classList.remove("prompt-field-empty"));
  // Enter submits, Shift+Enter is a newline - the same pair as the composer, so the
  // muscle memory carries over.
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
    }
  });
  document.addEventListener("keydown", onKey);
  row.append(cancel, ok);
  box.append(msg, field);
  // Optional extra content (e.g. an image-attach zone) between the field and the
  // buttons - the caller owns it and reads whatever it collected inside onSubmit.
  if (extraEl) {
    box.append(extraEl);
  }
  box.append(row);
  overlay.append(box);
  document.body.append(overlay);
  field.focus();
  // Hand the field to the caller so it can wire behaviour that belongs to the focused
  // input - e.g. the Send back dialog attaches its image-paste handler here, so a pasted
  // screenshot lands while typing the note (task 1116b7ef), exactly like the composer.
  onField?.(field);
}

// Second mates are DERIVED from run history (main.js), which only surfaces
// projects a run touched. But the captain works from ONE cwd (the meta-home) across
// many topics, so grouping by project-cwd collapsed all his real sessions into
// nothing. Per his choice ("list sessions, not projects"): every non-archived
// session becomes its OWN resumable Direct node, named by its title - meta-home
// sessions included. Sessions already bound to a first mate's second mate are
// skipped (they show under that mate). The run-derived Direct nodes (autonomous
// runs with commits to review) are kept as-is alongside.
/**
 * THE ONE PLACE that turns raw second-mate bindings into the fleet model both
 * dashboards render from.
 *
 * Why it is shared. The widget dashboard skipped this entirely and passed
 * listSecondMates() straight to the widgets - so its Captain widget was EMPTY
 * (the captain, 2026-07-28: "Captain är tom trots att den inte ska vara det"). The
 * captain's own sessions are not bindings at all; they are nodes this function
 * derives from state.sessions. The first-mate widgets were missing their live
 * crew and context gauges for the same reason, and archived second mates would
 * have reappeared there after being archived on the classic board.
 *
 * Two dashboards deriving the same model separately is the same failure as the
 * three archive menus and the eight file writers. One builder, both callers.
 *
 * Mutates the returned nodes' `crew` and refreshes contextTokensBySession, which
 * is what the synchronous card renderers read.
 */
async function buildFleetModel(activeMates, rawSecondMates) {
  // Exclude second mates the captain archived (bug 05166d55 / retire teardown):
  // the archivedSecondMates overlay keeps a node out of the Fleet even when it
  // would otherwise re-derive from goal-run history.
  const archivedSecondMateIds = new Set(state.config.archivedSecondMates || []);
  const secondMates = augmentSecondMatesWithSessions(rawSecondMates || [], activeMates || []).filter(
    (s) => !archivedSecondMateIds.has(s.secondMateId)
  );
  // Trigger layer 3: the Jot board state of the projects the mates work, so the
  // retire nudge can strengthen (boards clear) or dampen (urgent task queued).
  const projectPaths = [...new Set(secondMates.map((s) => s.projectPath).filter(Boolean))];
  let boardSummary = {};
  if (projectPaths.length) {
    try {
      const boardResult = await window.helm.getJotBoardSummary(projectPaths);
      boardSummary = boardResult?.ok ? boardResult.summary || {} : {};
    } catch {
      boardSummary = {};
    }
  }
  // Live sub-agents as crew: only for session nodes whose session is actively
  // working (an idle session has none), so we tail-read only a couple of
  // transcripts, not all ~15.
  const activeSessionNodes = secondMates
    // Nodes with no crew of their own, so a registered run (an auto-captain
    // dispatch) also shows its live sub-agents instead of reading "crew idle"
    // while it works. Never for a node that already HAS crew from its dispatch
    // history - that would overwrite the real rows with a live snapshot.
    .filter((sm) => isLiveWorkNode(sm) && sm.sessionId && (sm.crew || []).length === 0)
    .map((sm) => ({ sm, sess: state.sessions.find((s) => (s.cliSessionId || s.sessionId) === sm.sessionId) }))
    .filter((x) => x.sess && x.sess.status === "active");
  if (activeSessionNodes.length) {
    try {
      const saRes = await window.helm.getLiveSubAgents(activeSessionNodes.map((x) => ({ cliSessionId: x.sess.cliSessionId, sessionId: x.sess.sessionId })));
      const saMap = saRes?.ok ? saRes.subAgents : {};
      for (const { sm, sess } of activeSessionNodes) {
        sm.crew = (saMap[sess.sessionId] || []).map((a) => ({ isSubAgent: true, id: a.id, goal: a.description, status: "running" }));
      }
    } catch {
      // crew is decoration; never let it take the fleet down with it
    }
  }
  // Context gauge for EVERY first mate: tail-read each mate session's last-known
  // context size (keyed on mate.sessionId), stashed for the synchronous fleet
  // render. The gauge prefers a live pane value when open; this is the fallback
  // so both mates show a gauge (bug bf1ea538).
  const mateCtxSessions = (activeMates || []).filter((m) => m.sessionId).map((m) => ({ cliSessionId: m.sessionId, sessionId: m.sessionId }));
  if (mateCtxSessions.length) {
    try {
      const ctxRes = await window.helm.getContextTokens(mateCtxSessions);
      if (ctxRes?.ok) {
        contextTokensBySession = ctxRes.contextTokens || {};
      }
      // A failed read KEEPS the last-known values. Blanking them on a transient
      // failure resets every first mate's context gauge to zero for a tick, which
      // is bug bf1ea538 all over again ("both mates show a gauge"). A slightly old
      // number is a better answer than a wrong one. Found by the pre-release review.
    } catch {
      // same: keep what we had
    }
  } else {
    contextTokensBySession = {};
  }
  return { secondMates, boardSummary };
}

/**
 * Does this node have a real session behind it - one the captain can jump into?
 *
 * `isSessionNode` used to be the proxy for that, because the only way a piece of
 * Direct work existed was as a synthetic node derived from the session list. The
 * auto-captain now REGISTERS its run as a second mate before starting it (so the
 * run carries the project's name instead of the prompt's first line), and a
 * registered node is not a synthetic one - so every filter written as
 * `isSessionNode` silently stopped matching the auto runs. The work ran, the
 * board moved, and both the Auto column and the Direct column stayed empty
 * (the captain, 2026-08-03: "den hamnar fortfarande inte i auto captenens widget").
 *
 * Ask the property, not the proxy: a node is live work if a session is bound to
 * it, however that node came to exist.
 */
function isLiveWorkNode(sm) {
  return !!(sm.isSessionNode || sm.sessionId);
}

/** An auto-captain run, as opposed to something the captain started by hand. */
function isAutoStartedNode(sm) {
  return sm.startedBy === "auto";
}

/**
 * Is there anything under this node worth showing, even with no session bound?
 *
 * `isLiveWorkNode` alone was the SECOND time this exact widget went blank. After the
 * reshape an auto task is an autopilot run under the project's second mate, and that
 * node is only ever "proposed" - no session of its own, ever. So a filter that
 * insists on a session excludes precisely the shape the feature now produces, and
 * the widget said "Nothing started yet" while a paid unattended run was editing a
 * repo (independent review, 2026-08-03).
 *
 * The general lesson, worth more than the fix: a filter is only as good as whether
 * the app can still PRODUCE the state it asks for.
 */
function hasWorkUnderNode(sm) {
  return isLiveWorkNode(sm) || (Array.isArray(sm.crew) && sm.crew.length > 0);
}

function augmentSecondMatesWithSessions(secondMates, mates = []) {
  // Who started it lives on the SESSION, not on the second mate - a registered
  // node has no such field of its own. Carry it across so the Auto column can
  // tell an auto run apart from the captain's own work regardless of which of
  // the two kinds of node it is looking at.
  const list = secondMates.map((s) => {
    if (s.startedBy || !s.sessionId) {
      return s;
    }
    const bound = state.sessions.find((x) => (x.cliSessionId || x.sessionId) === s.sessionId);
    return bound?.startedBy ? { ...s, startedBy: bound.startedBy } : s;
  });
  const boundIds = new Set(list.map((s) => s.sessionId).filter(Boolean));
  // A first mate's OWN session IS that mate (its card's "jump in" resumes it),
  // not a piece of Direct work - so exclude it, or a session started while
  // inside a first mate (e.g. jumping into Sinbad and typing a prompt) wrongly
  // shows a second time under Captain/Direct. (Bug: "sessioner startade i 1st
  // mate hamnar under direct".)
  for (const m of mates) {
    if (m.sessionId) {
      boundIds.add(m.sessionId);
    }
  }
  const sessions = state.sessions
    .filter((s) => s.cwd && !s.isArchived && !isHiddenFromHelm(s))
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  for (const sess of sessions) {
    const sid = sess.cliSessionId || sess.sessionId;
    if (boundIds.has(sid) || secondMateForSession(sess)) {
      // Skip if already a first mate's own session, OR if this session resolves
      // to a REGISTERED second mate. boundIds only holds the single sm.sessionId
      // form, but secondMateForSession matches on cliSessionId OR sessionId - so
      // a registered second mate whose id form differs from the session's slipped
      // through and got emitted as a synthetic prompt-title node, diverging from
      // the real fleet name the chat header shows (bug c48a4a22). Now it's
      // attributed to the registered second mate (its .name), single-sourced.
      continue;
    }
    list.push({
      secondMateId: "sess_" + sid,
      firstMateId: "direct",
      projectPath: sess.cwd,
      name: sess.title || sess.cwd.split(/[\\/]/).filter(Boolean).pop() || sess.cwd,
      sessionId: sid,
      crew: [],
      // Carried through so the Auto column can pick its own runs out. Without it
      // the column had no populated field to filter on and could never show
      // anything at all.
      startedBy: sess.startedBy || null,
      isSessionNode: true,
    });
    boundIds.add(sid);
  }
  return list;
}

// Persona catalog (personas.js, fetched via IPC) - loaded once and cached. The
// renderer is a classic script and can't import the ES module, so it pulls
// key/label/blurb for the picker; the overlay text stays server-side.
let personaCatalog = null;
async function ensurePersonaCatalog() {
  if (personaCatalog === null) {
    try {
      personaCatalog = await window.helm.listPersonas();
    } catch {
      personaCatalog = [];
    }
  }
  return personaCatalog;
}
function personaLabel(key) {
  if (!key) {
    return "Coordinator";
  }
  const p = (personaCatalog || []).find((x) => x.key === key);
  return p ? p.label : key;
}

// "Gå igenom personas och beskriv vad de gör" (the captain, task 1ffbe001). The descriptions
// existed all along - every persona carries a blurb, and listPersonas already sends it
// across - and the picker threw it away, offering five bare names. buildMenuItems has had a
// `hint` slot for exactly this since it was written: "for a menu of NAMES that stand for
// something else, the name alone makes the menu a guess."
//
// Coordinator is the odd one out: it is the ABSENCE of a persona, so there was no object to
// carry a blurb, and it is also the one he sees most - the default every fresh mate starts
// on and every respawn resets to. Describing it here rather than in personas.js keeps that
// module's list to real personas, which is what its overlay lookups iterate.
const COORDINATOR_BLURB = "No overlay - the plain first-mate manual: plans, dispatches to second mates, and hands off. The default, and what a respawn resets to.";
function personaBlurb(key) {
  if (!key) {
    return COORDINATOR_BLURB;
  }
  return (personaCatalog || []).find((x) => x.key === key)?.blurb || "";
}

// Persona control on a first-mate card. Fresh mate (no session) -> set the
// persona directly. Running mate -> switching means the overlay is already in
// its context, so it routes through retire-with-handoff + respawn into the new
// persona (the same faithful-transfer path as a normal retire).
function fleetPersonaEl(mate) {
  const running = !!mate.sessionId;
  const cur = mate.persona || null;
  const row = document.createElement("div");
  row.className = "fleet-persona";
  // No row-level stopPropagation: it swallowed every click across the persona
  // row (empty area + label), so clicks to the right of the dropdown "did
  // nothing" instead of jumping into the card like the rest of it. The dropdown
  // button below keeps its OWN stopPropagation, so opening the picker still
  // doesn't jump in. (From the dispatched persona-row-click fix, goal-bc2be26e.)

  const tag = document.createElement("span");
  tag.className = "fleet-persona-tag";
  tag.textContent = "persona";

  const btn = document.createElement("button");
  btn.className = "fleet-persona-btn" + (cur ? " is-set" : "");
  // The tooltip leads with what this mate IS, then what clicking does. Hovering the closed
  // picker was the one place that could have answered "what is this mate doing" and it only
  // described the button's mechanics.
  btn.title =
    `${personaLabel(cur)} - ${personaBlurb(cur)}\n\n` +
    (running ? "Switching retires this mate with a handoff and respawns a fresh one." : "Click to choose this mate's persona.");
  btn.textContent = personaLabel(cur) + " ▾";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const options = [{ key: null, label: "Coordinator" }, ...(personaCatalog || [])];
    const items = options.map((p) => ({
      label: (p.key === cur ? "✓ " : "") + p.label,
      // The blurb, not just the name - picking a temperament off five bare words was a guess.
      description: personaBlurb(p.key),
      onClick: () => choosePersona(mate, p.key, running),
    }));
    showContextMenu(e.clientX, e.clientY, items);
  });
  row.append(tag, btn);
  return row;
}

function choosePersona(mate, key, running) {
  const cur = mate.persona || null;
  const next = key || null;
  if (cur === next) {
    return;
  }
  if (!running) {
    window.helm.setMatePersona(mate.mateId, next).then(() => fillDashboardSections({ force: true }));
    return;
  }
  const label = personaLabel(next);
  customConfirm(
    `Switch ${mate.name} to ${label}? This retires the current mate (saving a handoff) and hands off to a fresh ${label} in its place.`,
    "Switch persona",
    () => retireMateWithCarryOver(mate, next)
  );
}

/**
 * The Dashboard's one-line subtitle, DERIVED from who is actually on watch.
 *
 * Both dashboards call this once they have the mates, because both already fetch
 * them - and because the alternative (a constant string) is what produced a page
 * that claimed no first mate was on watch while naming two of them a few hundred
 * pixels lower down.
 *
 * When mates ARE on watch it names them and says where to act on them, which is
 * the page's actual top-level state. When none are, the old explanation of what
 * a first mate is becomes true again, so it is kept for exactly that case.
 */
// Last known first mates, so a re-render can fill the subtitle IMMEDIATELY instead
// of depending on an async fetch landing after the element exists. Getting that
// ordering wrong left the line permanently blank in the widget dashboard.
let lastKnownMates = null;

function paintDashboardSubtitle(mates = null) {
  if (Array.isArray(mates)) {
    lastKnownMates = mates;
  }
  const el = document.getElementById("dashSubtitle");
  if (!el) {
    return;
  }
  const known = Array.isArray(mates) ? mates : lastKnownMates;
  if (!Array.isArray(known)) {
    el.textContent = ""; // genuinely unknown yet - say nothing rather than guess
    return;
  }
  const names = known.map((m) => m.name).filter(Boolean);
  if (names.length === 0) {
    el.textContent =
      "No first mate on watch right now. It's a role you fill when you need it, not a session that stays open - start one fresh whenever you like.";
    return;
  }
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  el.textContent = `${listed} ${names.length === 1 ? "is" : "are"} on watch. Retire, rename or hand one off from the Fleet below.`;
}



// A first-mate card: anchor + name (+ rename/retire), context gauge if its
// session is open, a dual-trigger retire nudge (saturated OR work wrapped), and
// its second mates.
// Dims a fleet card and adds a "Saving handoff…" spinner row while its
// retire/archive handoff-summarize is in flight (handoffBusyIds).
function markCardHandoffBusy(el) {
  el.classList.add("card-handoff-busy");
  const badge = document.createElement("div");
  badge.className = "card-handoff-badge";
  const spin = document.createElement("span");
  spin.className = "toast-spin";
  badge.append(spin, document.createTextNode("Saving handoff…"));
  el.append(badge);
}

// A first mate's report-back roll-up: the crew runs IT dispatched that have
// finished, collected under its card. The mate is the first responder for its
// own crew (docs/orchestration-model.md "Tiered report-back") - the captain's
// board only carries the ones a mate escalates. Compact by default: a one-line
// count that expands to the individual report rows for drill-down. Runs that
// need the captain also bubble up to the Dashboard Report-back, but they stay
// here too so the mate's own view of its crew is complete.
// Persist which fleet nodes (crew report rollups, 2nd-mate branches) the captain
// has expanded, keyed by a stable id, so a FORCED dashboard rebuild (e.g. after
// marking an autopilot Done, which force-refreshes) doesn't collapse the whole
// tree back to its default state (bug 36dda656). Survives rebuilds because it's
// module state, not DOM state.
const openFleetNodes = new Set();
function fleetNodeToggler(el, key) {
  if (openFleetNodes.has(key)) {
    el.classList.add("open");
  }
  return () => {
    if (el.classList.toggle("open")) {
      openFleetNodes.add(key);
    } else {
      openFleetNodes.delete(key);
    }
  };
}

function fleetMateReportRollupEl(mate, sms) {
  return fleetReportRollupEl(mate.mateId, "rollup:" + mate.mateId, "Crew reported back", runIdsShownUnderNodes(sms));
}

// The runs that are ALREADY rows under the project nodes this card is about to
// render.
//
// A terminal run the captain has not acknowledged is kept as a crew row by
// fleetSecondMateEl, so the card's roll-up listed the same finished run a second
// time - and on the captain's card under the wrong owner entirely, because that
// roll-up's bucket is "runs with no dispatcher" and an auto-captain run has no
// dispatcher either. That is what the captain was looking at: "det ser ut som
// autopilots - borde de inte ligga under respektive 2nd mate som äger dem?"
// (task 86fefa68). He decided per project, "precis som i auto widgeten" - which
// is where they already are: deriveSecondMates groups every run with a
// projectPath onto its project's node.
//
// Derived from the nodes the card is rendering, and asking the NODE'S OWN
// visibility rule rather than restating it, so the two surfaces cannot drift into
// disagreeing about the same run - the failure that produced the un-clearable
// crew row and the stuck amber frame.
//
// A run that no node claims still has to appear in the roll-up. A finished run
// nobody is told about is worse than one reported in a slightly odd place.
function runIdsShownUnderNodes(sms) {
  const ids = new Set();
  for (const sm of sms || []) {
    for (const rec of sm.crew || []) {
      const view = crewLiveRun(rec);
      if (!view?.goalRunId) {
        continue;
      }
      if (isTerminalRun(view) && isGoalRunAcknowledged(view.goalRunId)) {
        continue; // the node drops these too - so the roll-up must not claim them
      }
      ids.add(view.goalRunId);
    }
  }
  return ids;
}

// The report roll-up for one owner's terminal runs. ownerId === null means the
// captain's OWN (Direct/Autopilot-launched) runs - those aren't "crew", so the
// verb differs. Extracted so the Direct card gets the same review surface mate
// cards have had all along (flow review P1: captain-launched runs used to vanish
// from the Dashboard the moment they stopped running).
function fleetReportRollupEl(ownerId, toggleKey, verb, shownUnderNodes = null) {
  const runs = terminalRunsBy(ownerId).filter((r) => !shownUnderNodes?.has(r.goalRunId));
  if (runs.length === 0) {
    return null;
  }
  const needs = runs.filter(runNeedsCaptain).length;
  const wrap = document.createElement("div");
  wrap.className = "fleet-report-rollup" + (needs > 0 ? " has-needs" : "");
  // Clicks inside the roll-up must not bubble to the card's jump-in handler.
  wrap.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "fleet-report-rollup-head";
  const chev = document.createElement("span");
  chev.className = "fleet-chev";
  chev.textContent = "▶";
  const label = document.createElement("span");
  label.className = "fleet-report-rollup-label";
  const clear = needs > 0 ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : " · all clear";
  label.textContent = `${verb}: ${runs.length}${clear}`;
  head.append(chev, label);
  // Persisted expand state (bug 36dda656): survives the force-rebuild on Done.
  head.addEventListener("click", fleetNodeToggler(wrap, toggleKey));

  const rows = document.createElement("div");
  rows.className = "fleet-report-rows";
  runs.slice(0, REPORT_BACK_LIMIT).forEach((r) => rows.append(dashReportRowEl(r)));
  wrap.append(head, rows);
  return wrap;
}

// "Continue on mobile" affordance: hands this conversation off to a Remote
// Control session in a new terminal so it can be driven from the Claude mobile
// app / claude.ai/code (see lib/remoteControl.js). Returns a compact icon
// button that stops propagation so it never triggers the enclosing card/row
// jump-in. `session` needs { cwd, cliSessionId|sessionId, title }.
function continueOnMobileBtn(session, { title } = {}) {
  const btn = document.createElement("button");
  btn.className = "fleet-btn fleet-mobile-btn";
  btn.title = "Continue this session on your phone (opens a Remote Control terminal)";
  // A clear monochrome WIFI icon (bug ca32567c: the ✆/↗ glyphs were unreadable -
  // "go with a wifi symbol"). Inline SVG on currentColor so it matches the other
  // fleet buttons' colour + hover, and is unambiguous at this size.
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M4 11a13 13 0 0 1 16 0"/>' +
    '<path d="M7.5 14.5a8 8 0 0 1 9 0"/>' +
    '<circle cx="12" cy="18.5" r="1.1" fill="currentColor" stroke="none"/>' +
    "</svg>";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const cwd = session?.cwd || "";
    const cliSessionId = session?.cliSessionId || session?.sessionId || "";
    const name = title || session?.title || "Helm session";
    btn.disabled = true;
    try {
      const res = await window.helm.continueOnMobile({ cwd, cliSessionId, title: name });
      if (res && res.ok) {
        showToast("Opening a Remote Control terminal - scan the QR / URL there from the Claude app.");
      } else {
        showToast(`Couldn't open the Remote Control terminal: ${res?.error || "unknown error"}`);
      }
    } catch (err) {
      showToast(`Couldn't open the Remote Control terminal: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function fleetMateCardEl(mate, sms, boardSummary = {}) {
  const card = document.createElement("div");
  card.className = "fleet-mate-card";
  card.addEventListener("click", () => jumpIntoFirstMate(mate));

  const top = document.createElement("div");
  top.className = "fleet-mate-top";
  const anchor = document.createElement("span");
  anchor.className = "fleet-anchor";
  anchor.textContent = themeIcons().anchor;
  const idBox = document.createElement("div");
  idBox.className = "fleet-mate-idbox";
  const name = document.createElement("div");
  name.className = "fleet-mate-name";
  name.textContent = mate.name;
  // The mate's OWN session status (its bound session). Previously the card never
  // reflected this - it only showed the second-mate count or "idle", so a first
  // mate WAITING on you had no marker at all. Show a "needs you" / "working"
  // badge and accent the card when it needs you.
  const boundSession = mate.sessionId
    ? state.sessions.find((s) => (s.cliSessionId || s.sessionId) === mate.sessionId)
    : null;
  const mateStatus = boundSession?.status;
  // A mate whose turn has ended after dispatching crew is not blocked on YOU -
  // it's awaiting its crew's outcome (bug 9c0c7209). This holds even when the
  // crew ERRORED: the action then lives on the crew (its own needs-you rows +
  // the 2nd mate's "crew needs a decision"), so the mate shows a calm crew state
  // - "crew needs a decision" - NOT the alarm "needs you". Reserve "needs you"
  // (+ the amber card accent) for a mate genuinely awaiting your reply with NO
  // crew to explain the wait. mateCrewWait single-sources this with the queue.
  const cw = mateCrewWait(mate);
  const kind = document.createElement("span");
  kind.className = "fleet-kind session";
  kind.textContent = "💬 session";
  const role = document.createElement("div");
  role.className = "fleet-mate-role";
  // Whether this card is genuinely blocked on the captain is decided ONCE, here, and
  // both surfaces that show it - the "needs you" chip and the amber bar down the
  // card's left edge - read that one decision.
  //
  // They used to be decided separately, and disagreed: the chip asked the
  // session's STATUS (which honours the "done" acknowledgement and the other
  // status overrides), the bar asked the raw lifecycle state, which stays
  // "waiting" regardless. So acknowledging a reply took the chip away and left
  // the bar burning - an amber marker with no word anywhere on the card to say
  // what it meant, permanently on ("varför är den här ramen där hela tiden?",
  // task 8d14d861). The bar is not being removed; it is being tied to the thing
  // that already decides whether there is something to say.
  let needsYou = false;
  if (mateStatus === "waiting" || mateStatus === "active" || cw.has) {
    const badge = document.createElement("span");
    let bkind;
    let btext;
    if (cw.live) {
      bkind = "run";
      btext = "waiting on crew";
    } else if (cw.alarm) {
      bkind = "run";
      btext = "crew needs a decision";
    } else if (cw.reports) {
      bkind = "ok";
      btext = "reports ready";
    } else if (mateStatus === "active") {
      bkind = "run";
      btext = "working";
    } else if (boundSession?.lifecycleState === "wrapped") {
      // FSM 'wrapped' = the turn ended and finished (not awaiting input) - a calm
      // "done" chip, not the "needs you" alarm (Epic f3d096fa reader migration).
      bkind = "ok";
      btext = "done";
    } else {
      bkind = "need";
      btext = "needs you";
      needsYou = true;
    }
    badge.className = "fleet-badge " + bkind;
    badge.textContent = btext;
    role.append(badge);
  }
  role.append(kind, document.createTextNode(sms.length ? ` ${sms.length} second mate${sms.length === 1 ? "" : "s"}` : " idle"));
  idBox.append(name, role);
  // Amber accent for exactly the mate that showed the "needs you" chip above: a
  // mate genuinely awaiting your reply with no crew to explain the wait. A
  // crew-waiting mate (including one whose crew errored) stays calm here - the
  // crew rows carry that alarm.
  if (needsYou) {
    card.classList.add("fleet-mate-needs");
    card.title = "This mate is waiting on your reply.";
  }
  const actions = document.createElement("div");
  actions.className = "fleet-mate-actions";
  // Rename = inline edit (window.prompt is disabled in Electron + the captain never
  // wants native dialogs). Clicking ✎ swaps the name for an input.
  const renameBtn = document.createElement("button");
  renameBtn.className = "fleet-btn";
  renameBtn.title = "Rename this mate";
  renameBtn.textContent = "✎";
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const input = document.createElement("input");
    input.className = "fleet-rename-input";
    input.value = mate.name;
    input.addEventListener("click", (ev) => ev.stopPropagation());
    let done = false;
    const commit = (save) => {
      if (done) {
        return;
      }
      done = true;
      const v = input.value.trim();
      if (save && v && v !== mate.name) {
        window.helm.renameMate(mate.mateId, v).then(() => fillDashboardSections({ force: true }));
      } else {
        fillDashboardSections({ force: true }); // restore the label
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        commit(true);
      } else if (ev.key === "Escape") {
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
    name.replaceChildren(input);
    input.focus();
    input.select();
  });
  // Retire = custom inline confirm (no native window.confirm).
  const retireBtn = document.createElement("button");
  retireBtn.className = "fleet-btn";
  retireBtn.title = "Retire this mate (carry the thread over, or start fresh)";
  retireBtn.textContent = "↻";
  retireBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    offerRetireChoice(e.clientX, e.clientY, mate);
  });
  actions.append(renameBtn, retireBtn);
  // Continue on mobile: only when this mate has a bound session to hand off.
  if (boundSession) {
    actions.append(continueOnMobileBtn(boundSession, { title: mate.name }));
  }
  top.append(anchor, idBox, actions);
  card.append(top);

  // Persona control: the temperament this mate brings to coordination.
  card.append(fleetPersonaEl(mate));

  // Context gauge for this mate. Prefer the live per-pane value when its session
  // is open (freshest); otherwise fall back to the per-poll estimate fetched for
  // every mate, so BOTH first mates show a gauge - not only the open one (bug
  // bf1ea538). The % also drives the "ctx" retire nudge below, so this now fires
  // for a saturated mate even when its session isn't open in a pane.
  const openPane = panes.find((p) => p && p.cliSessionId && p.cliSessionId === mate.sessionId && typeof p.contextTokens === "number");
  const ctxTokens = openPane ? openPane.contextTokens : contextTokensBySession[mate.sessionId];
  let pct = null;
  if (typeof ctxTokens === "number") {
    pct = Math.min(100, Math.round((ctxTokens / contextWindowForModel(sessionForMate(mate)?.model)) * 100));
    const gauge = document.createElement("div");
    gauge.className = "fleet-gauge";
    const bar = document.createElement("span");
    bar.className = "fleet-gauge-bar";
    const fill = document.createElement("span");
    fill.className = "fleet-gauge-fill" + (pct >= FIRST_MATE_HANDOFF_PCT ? " warn" : "");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const lbl = document.createElement("span");
    lbl.className = "fleet-gauge-pct";
    lbl.textContent = `${pct}%`;
    gauge.append(bar, lbl);
    card.append(gauge);
  }

  // Retire nudge - three triggers, in priority order:
  //  ctx   : context saturated (the hard reason to hand off) - always wins.
  //  hold  : work wrapped BUT an urgent task is still queued on a project the
  //          mate works (Jot minActivePriority < 0) - DAMPEN: advise against
  //          retiring, don't offer the button.
  //  done  : work wrapped and nothing urgent - a clean moment to retire,
  //          strengthened when the boards are entirely clear.
  // Same acknowledged-filter as the crew rows (fleetSecondMateEl): a run the
  // captain marked Done must stop counting as "needs you" here too, so the mate
  // goes quiet + the work-wrapped retire nudge can fire once all crew is handled.
  // dispatchedEver stays over the FULL set (it did dispatch work at some point).
  const keepCrew = (r) => !(isTerminalRun(r) && isGoalRunAcknowledged(r.goalRunId));
  const dispatchedEver = sms.some((s) => s.crew.length > 0);
  // Same ordering as fleetSecondMateEl, and for the same reason: keepCrew must judge
  // the run the row will actually show, not the record behind it.
  const crew = sms.flatMap((s) => s.crew.map(crewLiveRun).filter(keepCrew));
  const anyLive = crew.some(crewRunning);
  const anyNeeds = crew.some(crewNeedsCaptain);
  const saturated = pct != null && pct >= FIRST_MATE_HANDOFF_PCT;
  const mateTurns = sessionForMate(mate)?.completedTurns || 0;
  const hot = !saturated && mateTurns >= FIRST_MATE_HOT_TURNS;
  const workWrapped = dispatchedEver && !anyLive && !anyNeeds;
  const boards = [...new Set(sms.map((s) => s.projectPath).filter(Boolean))].map((p) => boardSummary[p]).filter((b) => b && b.matched);
  const hasUrgent = boards.some((b) => typeof b.minActivePriority === "number" && b.minActivePriority < 0);
  const boardsClear = boards.length > 0 && boards.every((b) => b.open + b.inProgress === 0);
  if (saturated) {
    card.append(fleetNudgeEl(mate, "ctx", { pct }));
  } else if (hot) {
    card.append(fleetNudgeEl(mate, "hot", { turns: mateTurns }));
  } else if (workWrapped && hasUrgent) {
    card.append(fleetNudgeEl(mate, "hold", { boards }));
  } else if (workWrapped) {
    card.append(fleetNudgeEl(mate, "done", { boardsClear }));
  }

  // Second mates.
  const list = document.createElement("div");
  list.className = "fleet-branches";
  if (sms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fleet-empty";
    empty.textContent = "No second mates yet - hand a project some work and it shows up here.";
    list.append(empty);
  } else {
    for (const sm of sms) {
      list.append(fleetSecondMateEl(sm));
    }
  }
  card.append(list);
  const rollup = fleetMateReportRollupEl(mate, sms);
  if (rollup) {
    card.append(rollup);
  }
  if (handoffBusyIds.has(mate.mateId)) {
    markCardHandoffBusy(card);
  }
  return card;
}

function fleetNudgeEl(mate, kind, opts = {}) {
  const nudge = document.createElement("div");
  nudge.className = "fleet-nudge " + kind;
  nudge.addEventListener("click", (e) => e.stopPropagation());
  const txt = document.createElement("span");
  txt.className = "fleet-nudge-txt";
  const tag = document.createElement("span");
  tag.className = "fleet-nudge-tag";

  let offerRetire = true;
  if (kind === "ctx") {
    tag.textContent = "Getting full";
    txt.append(tag, document.createTextNode(` ${mate.name} is ${opts.pct}% full - hand off to a fresh mate.`));
  } else if (kind === "hot") {
    tag.textContent = "Been at it a while";
    txt.append(tag, document.createTextNode(` ${mate.name} has run ${opts.turns} turns this session - hand off to a fresh mate to reset its context.`));
  } else if (kind === "hold") {
    // Dampened: urgent work is still queued - advise against retiring, no button.
    offerRetire = false;
    tag.textContent = "Hold off";
    const proj = opts.boards?.find((b) => typeof b.minActivePriority === "number" && b.minActivePriority < 0);
    const where = proj ? ` ${proj.category}` : " a project";
    txt.append(tag, document.createTextNode(` ${mate.name}'s crew is idle, but${where} still has an urgent task open - maybe finish that before retiring.`));
  } else {
    tag.textContent = "Work wrapped";
    const clear = opts.boardsClear ? " and its boards are clear" : " and nothing's in flight";
    txt.append(tag, document.createTextNode(` ${mate.name}'s crew reported back${clear} - good moment to retire.`));
  }
  nudge.append(txt);
  if (offerRetire) {
    const btn = document.createElement("button");
    btn.className = "fleet-btn fleet-btn-accent";
    btn.textContent = "Retire";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Same choice menu as the header retire icon (carry over vs start fresh).
      offerRetireChoice(e.clientX, e.clientY, mate);
    });
    nudge.append(btn);
  }
  return nudge;
}

// After a second mate's session is archived (with or without a handoff), drop the
// second-mate NODE too: archive its id (server overlay + binding removal) and
// reflect it in the local config so it leaves the Fleet immediately instead of
// re-deriving from its crew runs on the next refresh (bug 05166d55). The handoff,
// if any, was already saved by the archive path that ran just before this.
async function finishSecondMateArchive(sm) {
  if (!sm || !sm.secondMateId) {
    return;
  }
  await window.helm.archiveSecondMate(sm.secondMateId);
  if (!Array.isArray(state.config.archivedSecondMates)) {
    state.config.archivedSecondMates = [];
  }
  if (!state.config.archivedSecondMates.includes(sm.secondMateId)) {
    state.config.archivedSecondMates.push(sm.secondMateId);
  }
  refreshDashboardIfVisible();
}

// A second mate: a project SESSION (jumpable) with an expandable crew list.
function fleetSecondMateEl(sm) {
  // Drop crew runs the captain has already marked Done (acknowledged terminal
  // runs). Without this, a handled/errored run stays under its second mate
  // FOREVER - the fleet crew list was never acknowledged-filtered, so "Done"
  // removed the button but not the row, leaving no way to clear them (the captain:
  // "I don't know what to do with them - I can't get rid of them"). Live runs
  // and sub-agents are never hidden this way.
  // MAP FIRST, THEN FILTER. The two steps used to disagree about the same run: the
  // filter read the PERSISTED record while the row rendered the LIVE/rehydrated view,
  // and those differ exactly when a run was interrupted - the record still says
  // "running" (no process ever wrote a terminal status), the view has already
  // reclassified it as "interrupted". So an acknowledged interrupted run was kept by
  // the filter (not terminal, said the record) and got no Done button (already
  // acknowledged, said the row): a row with no way to clear it (the captain, 2026-08-03,
  // pointing at the last one left: "vet inte hur jag ska göra med den").
  //
  // The comment below this used to describe the same dead end in its other shape,
  // fixed then for the record's own statuses only. One instance closed, the class
  // left open - so now everything downstream sees ONE view of a run, the one the user
  // is looking at.
  const crew = sm.crew
    .map(crewLiveRun)
    .filter((r) => !(isTerminalRun(r) && isGoalRunAcknowledged(r.goalRunId)));
  const anyLive = crew.some(crewRunning);
  const anyNeeds = crew.some(crewNeedsCaptain);
  const branch = document.createElement("div");
  branch.className = "fleet-branch secondmate";
  // Catch-all so NO click anywhere in the 2nd-mate node falls through to the
  // enclosing first-mate card (which would jumpIntoFirstMate). Any click on the
  // node's own padding / empty areas / crew-row gaps now routes to the 2nd mate,
  // not the 1st. Inner controls (chevron toggle, rename/archive/mobile buttons,
  // crew rows) keep their own handlers + stopPropagation, so this only catches
  // the gaps. (Bug 9f957394: "clicks not near jump-in jump into 1st mate".)
  branch.addEventListener("click", (e) => {
    e.stopPropagation();
    jumpIntoSecondMate(sm);
  });

  const head = document.createElement("div");
  head.className = "fleet-branch-head";
  const chev = document.createElement("span");
  chev.className = "fleet-chev";
  chev.textContent = "▶";
  chev.style.visibility = crew.length ? "visible" : "hidden";
  // Persisted expand state (bug 36dda656): survives the force-rebuild on Done.
  const toggleBranch = fleetNodeToggler(branch, "branch:" + sm.secondMateId);
  chev.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleBranch();
  });
  const body = document.createElement("div");
  body.className = "fleet-branch-body";
  body.addEventListener("click", (e) => {
    // Stop the click bubbling to the enclosing first-mate card's handler, which
    // would then run jumpIntoFirstMate and overwrite pane 0 - so a second-mate
    // click used to land on the FIRST mate. (Review: both agents, HIGH.)
    e.stopPropagation();
    jumpIntoSecondMate(sm);
  });

  // The session behind this node (Direct session nodes + bound second mates).
  const sess = sm.sessionId ? state.sessions.find((s) => (s.cliSessionId || s.sessionId) === sm.sessionId) : null;

  const topRow = document.createElement("div");
  topRow.className = "fleet-branch-top";
  const badge = document.createElement("span");
  // A session node reflects the SESSION's own status (matches the "needs you /
  // in motion" list above); a run-derived node reflects its crew.
  // A PROPOSED second mate (Phase-2 Slice 1): laid out by the first mate but no
  // session spun up yet - it exists only as a lazy proposal. Distinct calm badge;
  // jumping in is the "first engagement" that creates it.
  const isProposed = sm.status === "proposed" && !sm.sessionId && crew.length === 0;
  let badgeKind, badgeText;
  if (isProposed) {
    badgeKind = "ok";
    badgeText = "proposed";
  } else if (sm.isSessionNode) {
    const st = sess?.status;
    badgeKind = st === "waiting" ? "need" : st === "active" ? "run" : "ok";
    badgeText = st === "waiting" ? "needs you" : st === "active" ? "working" : "idle";
  } else {
    // Reflect the second mate's OWN session status first - it showed as working
    // in the "needs you / in motion" list above while reading "idle" here because
    // this branch looked only at crew (bug 9ad82c28). Fall back to crew state when
    // there is no live session.
    const st = sess?.status;
    if (st === "active") {
      badgeKind = "run";
      badgeText = "working";
    } else if (st === "waiting") {
      badgeKind = "need";
      badgeText = "needs you";
    } else {
      badgeKind = anyNeeds ? "need" : anyLive ? "run" : "ok";
      badgeText = anyNeeds ? "needs you" : anyLive ? "busy" : "idle";
    }
  }
  badge.className = "fleet-badge " + badgeKind;
  badge.textContent = badgeText;
  const proj = document.createElement("span");
  proj.className = "fleet-branch-proj";
  proj.textContent = sm.name;
  const mk = document.createElement("span");
  mk.className = "fleet-mini-kind";
  mk.textContent = "💬 2nd mate";
  topRow.append(badge, proj, mk);
  const now = document.createElement("div");
  now.className = "fleet-branch-now";
  // Which project this session runs against (task 0c4494ce: "det borde framkomma
  // vilket projekt de här kör mot i captain vyn"). The row's name is the session
  // TOPIC, which only hints at the repo - so show the actual folder it is rooted
  // in, with the full path on hover to tell two same-named folders apart.
  const rootPath = sess?.cwd || sm.projectPath || "";
  if (rootPath) {
    const proj = rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath;
    const projTag = document.createElement("span");
    projTag.className = "fleet-branch-cwd";
    projTag.textContent = proj;
    projTag.title = rootPath;
    now.append(projTag, document.createTextNode(" · "));
  }
  const liveN = crew.filter(crewRunning).length;
  if (isProposed) {
    now.append(document.createTextNode((sm.brief ? `${sm.brief.length > 60 ? sm.brief.slice(0, 60) + "…" : sm.brief} · ` : "") + "proposed - engage to start · "));
  } else if (sm.isSessionNode) {
    // Read lifecycleState, not raw status (Epic f3d096fa): a genuine open question
    // that aged past the attention window decays to status "idle" but projects to
    // lifecycleState "waiting", so this now says "waiting on you" instead of
    // burying it as "idle" (bug 4cd7d592).
    const ls = sess?.lifecycleState;
    if (isWorkingLifecycle(ls)) {
      const spin = document.createElement("span");
      spin.className = "fleet-spin";
      now.append(spin, document.createTextNode("working · "));
    } else if (ls === "waiting") {
      now.append(document.createTextNode("waiting on you · "));
    } else {
      now.append(document.createTextNode("idle · "));
    }
  } else if (isWorkingLifecycle(sess?.lifecycleState)) {
    // The second mate's own session is running a turn - show that first, like the
    // in-motion list does, instead of a crew-only "idle" (bug 9ad82c28).
    const spin = document.createElement("span");
    spin.className = "fleet-spin";
    now.append(spin, document.createTextNode("working · "));
  } else if (sess?.lifecycleState === "waiting") {
    now.append(document.createTextNode("waiting on you · "));
  } else if (liveN > 0) {
    const spin = document.createElement("span");
    spin.className = "fleet-spin";
    now.append(spin, document.createTextNode(`${liveN} crew working · `));
  } else if (anyNeeds) {
    const commits = crew.reduce((a, r) => a + crewCommitCount(r), 0);
    now.append(document.createTextNode(commits > 0 ? `crew left ${commits} commit${commits === 1 ? "" : "s"} to review · ` : "crew needs a decision · "));
  } else {
    now.append(document.createTextNode("crew idle · "));
  }
  const jump = document.createElement("span");
  jump.className = "fleet-jumpin";
  jump.textContent = "jump in →";
  now.append(jump);
  body.append(topRow, now);
  head.append(chev, body);
  // Archive: only for a second mate backed by a real session.
  const backingSession = sess;
  if (backingSession) {
    // Rename: display-only title override (same mechanism as the sidebar), so
    // a second-mate session can be renamed from the Fleet too. (Bug: "kan inte
    // döpa om second mate sessioner".) Editing swaps the name for an input.
    const renameBtn = document.createElement("button");
    renameBtn.className = "fleet-btn";
    renameBtn.title = "Rename this session";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      makeInlineEditable(proj, sm.name, async (v) => {
        await renameSessionTo(backingSession, v);
        refreshDashboardIfVisible();
      });
    });
    head.append(renameBtn);
    // A "Carry over" button sat here for a day, added when the chat sidebar was removed because
    // that panel's menu had been its only home. The captain, 2026-08-05: "carry over är överflödigt tror
    // jag, vi kan ta bort det" - and he is right, for a reason worth keeping written down.
    //
    // The move already has two better entry points. Archive's own menu offers "Save handoff to
    // HANDOFF.md + archive", which summarises to a FILE a fresh session reads first - the
    // file-based continuity this whole app is built on. And a first mate that is filling up grows
    // its own "hand off to a fresh one" nudge, at the moment it actually matters. A third door,
    // always visible on every row, only made the row busier: pasting a summary into a composer is
    // a weaker copy of what the file already does.
    head.append(continueOnMobileBtn(backingSession, { title: sm.name }));
    const archiveBtn = document.createElement("button");
    archiveBtn.className = "fleet-btn fleet-archive-btn";
    archiveBtn.title = "Archive this session";
    archiveBtn.textContent = "Archive";
    archiveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Optimistic plain-archive (no forced REFETCH). The flicker before was:
      // remove the node, then fillDashboardSections re-derived from a freshly
      // refetched state.sessions that STILL had the session - so it reappeared
      // until a later refresh. Fix: optimistic in-memory mutation + an in-place
      // repaint (no refetch), so it can't reintroduce that bug.
      const doPlainArchive = async () => {
        const s = state.sessions.find((x) => x.sessionId === backingSession.sessionId);
        if (s) {
          s.isArchived = true; // the app's real archived flag (not status)
        }
        branch.remove();
        refreshDashboardIfVisible();
        const res = await window.helm.archiveSession(backingSession.sessionId, true);
        if (!res.ok) {
          console.error("[helm] archive failed:", res.error);
          showToast(`Couldn't archive "${backingSession.title}": ${res.error}`);
          if (s) {
            s.isArchived = false;
          }
          refreshDashboardIfVisible();
        }
      };
      // Shared builder, so this Fleet button can't drift back into being a
      // silent no-handoff path for a session with no project folder - which is
      // precisely what it was. `after` drops the fleet node either way.
      showContextMenu(
        e.clientX,
        e.clientY,
        archiveMenuItems(backingSession, { plainArchive: doPlainArchive, after: () => finishSecondMateArchive(sm) })
      );
    });
    head.append(archiveBtn);
  } else {
    // A node with NO session still needs a way off the board. The auto lane's project
    // row is exactly that: a grouping row for its autopilot runs, never a session - so
    // it had no controls at all, and the captain's question was the plain consequence ("hur
    // jag arkiverar 2nd maten (helm) från auto?"). Answer, until now: you cannot.
    //
    // There is nothing to archive session-wise, so this parks the ROW: the overlay
    // plus dropping the binding, which is what archiveSecondMateIds already does and
    // has never needed a session. Safe now in a way it was not this morning - a later
    // dispatch un-archives it (unarchiveSecondMateForNewWork), so parking a project's
    // row hides it until there is new work rather than swallowing every future run.
    const parkBtn = document.createElement("button");
    parkBtn.className = "fleet-btn fleet-archive-btn";
    parkBtn.textContent = "Archive";
    parkBtn.title = "Park this project's row. It comes back on its own the next time work is dispatched here.";
    const doPark = async () => {
      parkBtn.disabled = true;
      const res = await window.helm.archiveSecondMate(sm.secondMateId);
      if (!res?.ok) {
        parkBtn.disabled = false;
        showToast(`Couldn't archive "${sm.name}": ${res?.error || "unknown error"}`);
        return;
      }
      // The optimistic half of finishSecondMateArchive, inline - calling that would
      // send the same archive request a second time. Idempotent, but a redundant
      // round-trip is still a thing a reader has to stop and check.
      if (!Array.isArray(state.config.archivedSecondMates)) {
        state.config.archivedSecondMates = [];
      }
      if (!state.config.archivedSecondMates.includes(sm.secondMateId)) {
        state.config.archivedSecondMates.push(sm.secondMateId);
      }
      refreshDashboardIfVisible();
    };
    parkBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Archive-before-worktree guard (task a827cc95: "vad händer om jag arkiverar
      // den här innan jag rensar autopilots worktree - jag råkade nyss göra det").
      // Archiving hides the row AND its manual "clean worktree" button; the worktree
      // and run record survive (the housekeeping sweep still reclaims a clean,
      // terminal one), but a captain who wanted to clean it by hand just lost the
      // control. So if a run under this node still has a worktree ON DISK, warn
      // first - and offer to open it so they can deal with it before it goes.
      const candidatePaths = [
        ...new Set(
          (sm.crew || [])
            .map(crewLiveRun)
            .map((r) => r?.result?.worktreePath || r?.worktreePath)
            .filter(Boolean)
        ),
      ];
      let present = [];
      if (candidatePaths.length) {
        try {
          const res = await window.helm.existingWorktrees(candidatePaths);
          present = res?.existing || [];
        } catch {
          present = [];
        }
      }
      if (present.length) {
        const one = present[0];
        customConfirm(
          `"${sm.name}" still has ${present.length === 1 ? "an autopilot worktree" : `${present.length} autopilot worktrees`} on disk (e.g. ${one}). ` +
            `Archiving hides this row and its "clean worktree" button. The worktree isn't deleted - Helm's housekeeping sweep still reclaims it once the run is finished and clean - but you won't be able to clean it by hand from here. Archive anyway?`,
          "Archive anyway",
          () => doPark(),
          {
            deliberate: true,
            extraEl: (() => {
              const openBtn = document.createElement("button");
              openBtn.type = "button";
              openBtn.className = "text-btn";
              openBtn.textContent = "Open the worktree folder";
              openBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                window.helm.openGoalWorktree(one);
              });
              return openBtn;
            })(),
          }
        );
        return;
      }
      doPark();
    });
    head.append(parkBtn);
  }
  branch.append(head);

  const crewWrap = document.createElement("div");
  crewWrap.className = "fleet-crew";
  for (const r of crew) {
    crewWrap.append(fleetCrewItemEl(r));
  }
  branch.append(crewWrap);
  if (sm.sessionId && handoffBusyIds.has(sm.sessionId)) {
    markCardHandoffBusy(branch);
  }
  return branch;
}

// A crew member: an autonomous run (background task). The whole row is the click
// target and opens that run's Autopilot detail (bug ef303a82: "remove the View
// button, clicking the row should take me to the autopilot").
function fleetCrewItemEl(run) {
  const item = document.createElement("div");
  item.className = "fleet-crew-item";
  if (!run.isSubAgent) {
    item.classList.add("is-clickable");
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      openGoalRun(run.goalRunId);
    });
  }
  // Color-code the state so a problem crew item reads at a glance (review:
  // was always plain --text-faint). error/escalated -> needs, running -> run.
  const needs = run.status === "error" || !!run.escalation;
  if (needs) {
    item.classList.add("crew-needs");
  } else if (crewRunning(run)) {
    item.classList.add("crew-run");
  }
  const g = document.createElement("span");
  g.className = "fleet-crew-g";
  const running = crewRunning(run);
  g.textContent = running ? "⚙" : run.status === "error" ? "✕" : "✓";
  const label = document.createElement("span");
  label.className = "fleet-crew-label";
  label.textContent = (run.isSubAgent ? "agent · " : "autopilot · ") + crewRunHeadline(run.goal);
  // The whole prompt is still one hover away - it just isn't what the row is FOR.
  item.title = String(run.goal || "").trim();
  const stateEl = document.createElement("span"); // NOT `state` - that's the app-wide global (review: shadowing footgun)
  stateEl.className = "fleet-crew-state";
  const n = run.iterations?.length || 0;
  const commits = crewCommitCount(run);
  stateEl.textContent = run.isSubAgent
    ? "running"
    : run.escalation
      ? "paused"
      : running
        ? `iter ${n}`
        : run.status === "done" && commits
          ? `${commits} commit${commits === 1 ? "" : "s"}`
          : run.status;
  item.append(g, label, stateEl);
  // A finished autopilot run gets the same "Done" control the Dashboard report
  // rows use, right here on the crew row (bug cffdeeb8: "I don't understand what
  // to do with these - there's no done"). Only for terminal, non-sub-agent runs
  // (a live run has nothing to acknowledge; a sub-agent isn't captain-ackable).
  // reportRowDoneBtn stops propagation, so it won't also jump into the run.
  if (!run.isSubAgent && isTerminalRun(run) && !isGoalRunAcknowledged(run.goalRunId)) {
    const doneBtn = reportRowDoneBtn(run);
    doneBtn.classList.add("fleet-crew-done");
    item.append(doneBtn);
  }
  // No separate View/Follow button - the row itself is clickable (above) and
  // deep-links into this run's Autopilot detail (ef303a82).
  return item;
}

// Direct column: project sessions the captain started himself (grouped as
// "direct" second mates). Same shape, minus a first-mate header.
/**
 * The Captain's own card - and, with `as: "auto"`, the same card for the
 * auto-captain's runs. The captain asked for the Auto widget to look exactly like the
 * captain's, which it now literally does; what it must NOT do is keep the
 * captain's wording, or it would label work nobody started as "work you drive
 * yourself" and offer a "+ Session" button that starts something by hand in the
 * column whose whole point is that it doesn't.
 */
// "+ Session" went straight to the operating system's folder browser, so
// starting a session in the folder used most often meant clicking through a
// dialog every single time (task 0d9599bd). These are the quick picks: the home
// folder Helm already resolves for itself (the one holding the CLAUDE.md that
// every session inherits), then the projects Helm has actually seen, most
// recently worked in first. Browsing is still there, one item down.
//
// Every item carries its full path as a hint, because the folder NAME alone is a
// guess - "claude", "helm" and "scripts" all exist in more than one place here.
const NEW_SESSION_RECENT_PICKS = 5;
async function newSessionFolderMenuItems() {
  const items = [];
  const seen = new Set();
  const norm = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  // Must be a real cwd: augmentSecondMatesWithSessions filters sessions on
  // `s.cwd` truthy, so a session opened with cwd="" can never be matched back
  // into the Direct list - it starts, but is unfindable from the fleet tree ever
  // after ("new session hamnar inte under captain - hittar inte tillbaka").
  const add = (cwd) => {
    if (!cwd || seen.has(norm(cwd))) {
      return false;
    }
    seen.add(norm(cwd));
    items.push({
      label: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
      hint: truncatePathForMenu(cwd),
      onClick: () => {
        openFreshDraftInPane(cwd, "", { forceIndex: 0 });
        navigateToPage("chat");
      },
    });
    return true;
  };

  let home = null;
  try {
    home = (await window.helm.getOrchestratorInfo())?.cwd || null;
  } catch {
    // No home resolved - the recents and Browse below still stand on their own.
  }
  if (add(home)) {
    items.push({ sep: true });
  }

  const recents = state.sessions
    .filter((s) => s.cwd)
    .slice()
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  let added = 0;
  for (const s of recents) {
    if (added >= NEW_SESSION_RECENT_PICKS) {
      break;
    }
    if (add(s.cwd)) {
      added++;
    }
  }
  if (added > 0) {
    items.push({ sep: true });
  }

  items.push({
    label: "Browse…",
    onClick: async () => {
      const folder = await window.helm.pickFolder();
      if (!folder) {
        return;
      }
      openFreshDraftInPane(folder, "", { forceIndex: 0 });
      navigateToPage("chat");
    },
  });
  return items;
}

// Keeps a long path readable in a menu without hiding the part that identifies
// it: the tail (…\Repo\Tools\helm) is what tells two same-named folders apart,
// so that is the end that is kept.
function truncatePathForMenu(p, max = 46) {
  return p.length <= max ? p : "…" + p.slice(p.length - max + 1);
}

function fleetDirectCardEl(sms, { as = "captain" } = {}) {
  const isAuto = as === "auto";
  const card = document.createElement("div");
  card.className = "fleet-mate-card direct";
  const top = document.createElement("div");
  top.className = "fleet-mate-top";
  const anchor = document.createElement("span");
  anchor.className = "fleet-anchor direct";
  // The captain's home mark - follows the theme (nautical wheel asset, or the
  // space theme's satellite glyph).
  const logo = themeIcons().logo;
  if (logo.asset) {
    const anchorImg = document.createElement("img");
    anchorImg.className = "fleet-anchor-img";
    anchorImg.src = logo.asset;
    anchorImg.alt = "";
    anchor.append(anchorImg);
  } else {
    anchor.textContent = logo.glyph;
  }
  const idBox = document.createElement("div");
  idBox.className = "fleet-mate-idbox";
  const name = document.createElement("div");
  name.className = "fleet-mate-name";
  name.textContent = isAuto ? "Auto-captain" : "Captain";
  const role = document.createElement("div");
  role.className = "fleet-mate-role";
  role.textContent = isAuto ? "started from the board, lands in review" : "work you drive yourself";
  idBox.append(name, role);
  const startBtn = document.createElement("button");
  startBtn.className = "fleet-btn";
  startBtn.textContent = "+ Session";
  startBtn.title = "Start a fresh session - pick from your usual folders, or browse";
  startBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const rect = startBtn.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, await newSessionFolderMenuItems());
  });
  top.append(anchor, idBox);
  if (!isAuto) {
    top.append(startBtn);
  }
  card.append(top);

  const list = document.createElement("div");
  list.className = "fleet-branches";
  if (sms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fleet-empty";
    empty.textContent = isAuto
      ? "Nothing running. A task tagged \"auto\" starts here."
      : "Project sessions you start yourself land here.";
    list.append(empty);
  } else {
    for (const sm of sms) {
      list.append(fleetSecondMateEl(sm));
    }
  }
  card.append(list);

  // Report roll-up for the captain's OWN finished runs (ownerId null). Without
  // this a Direct/Autopilot run you launched yourself dropped off the Dashboard
  // the moment it stopped running - no report row, no needs-you (flow review P1).
  // Captain only: rendering it twice would give both copies the same persisted
  // expand key, so opening one would open the other.
  //
  // It now carries only what is NOT already a row under a project node above it.
  // The comment that used to sit here said the auto-captain never creates goal
  // runs; that stopped being true with the reshape on 2026-08-03, which is exactly
  // how auto runs ended up reported under the captain (task 86fefa68).
  const rollup = isAuto ? null : fleetReportRollupEl(null, "rollup:direct", "Your runs finished", runIdsShownUnderNodes(sms));
  if (rollup) {
    card.append(rollup);
  }
  return card;
}

// Jump into a first mate: resume its bound session if it has one, else start a
// fresh orchestrator session (meta-home root, Sonnet, tagged with its mateId so
// session:start attaches the dispatch tools and the session binds back to it).
// A triage nudge for a first mate that has crew reports waiting. It directs the
// mate to pull its dispatched runs' reports (helm_collect_reports - the on-disk
// report inbox already exists, see dispatchQueue.js) and triage them: note the
// clean ones done, roll up anything that needs the captain into a summary for
// the captain. This is the tiered report-back's "the mate is first responder for its
// own crew" made active - the report loop already delivers to the inbox, this
// just gets the mate to consume + act on it the moment you engage it. Seeded
// into a FRESH mate session's composer only (mirrors pendingHandoff), so it
// never clobbers a resumed session's own context or an in-progress draft.
// Empty when the mate has nothing waiting.
function pendingTriageNudge(mate) {
  const runs = terminalRunsBy(mate.mateId);
  if (runs.length === 0) {
    return "";
  }
  const needs = runs.filter(runNeedsCaptain).length;
  const lines = runs.slice(0, REPORT_BACK_LIMIT).map((r) => {
    const rep = goalRunReport(r);
    return `- "${r.goal}" — ${rep.status}${rep.needsCaptain ? ` (needs you: ${rep.needsCaptain})` : ""}`;
  });
  return (
    `You have ${runs.length} crew report${runs.length === 1 ? "" : "s"} waiting from runs you dispatched` +
    (needs > 0 ? ` (${needs} need the captain)` : "") +
    `. Run helm_collect_reports to pull them, then triage: note the clean ones done, and roll up anything that needs the captain into a short summary for him. Waiting:\n${lines.join("\n")}`
  );
}

function jumpIntoFirstMate(mate) {
  // Navigate to chat FIRST, before opening: openSessionInPane / openFreshDraftInPane
  // focus the composer, and focus() no-ops while #chatPage is still hidden. Doing
  // this before the open guarantees the pane is visible when the focus runs.
  navigateToPage("chat");
  const existing = mate.sessionId ? state.sessions.find((s) => (s.cliSessionId || s.sessionId) === mate.sessionId) : null;
  if (existing) {
    // Always land in the primary pane (0), overwriting it - never split. Jumping
    // in from the Fleet is "take me to this mate", not "open beside".
    openSessionInPane(existing, 0);
  } else {
    // A freshly respawned mate carries a one-shot handoff from its retired
    // predecessor: seed the composer with it so the cross-project thread
    // continues under the new name, then consume it so a later reopen is clean.
    let seed = "";
    if (mate.pendingHandoff) {
      seed = `You are ${mate.name}, a fresh first mate taking over from a retired predecessor. Their handoff:\n\n${mate.pendingHandoff}\n\nContinue the cross-project thread from here.`;
      window.helm.consumeMateHandoff(mate.mateId);
    }
    // If this mate has crew reports waiting, seed a triage nudge too (see
    // pendingTriageNudge). Combined with any handoff above.
    const triage = pendingTriageNudge(mate);
    if (triage) {
      seed = seed ? `${seed}\n\n${triage}` : triage;
    }
    openFreshDraftInPane(state.orchestratorHome, seed, {
      forceIndex: 0,
      // Title the fresh chat after the mate, so opening Hector Barbossa reads as
      // "Hector Barbossa", not a nameless new chat.
      paneOverrides: { isOrchestrator: true, modelDefault: "claude-sonnet-5", mateId: mate.mateId, title: mate.name },
    });
  }
}

// The most recently active non-archived session rooted at a project path, or
// null. Used as the jump-in fallback for a second mate with no bound session
// (e.g. a direct/derived one, or a session that predates the binding).
function mostRecentSessionForCwd(cwd) {
  if (!cwd) {
    return null;
  }
  return (
    state.sessions
      .filter((s) => !s.isArchived && !isHiddenFromHelm(s) && samePath(s.cwd, cwd))
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0] || null
  );
}

// A review nudge for a second mate that has crew reports waiting. Mirrors the
// first mate's pendingTriageNudge, but for the JUDGMENT tier: the second mate's
// job is to review the crew's per-branch work and merge what holds. Without this
// a fresh second-mate jump-in opened a BLANK session with no idea the crew had
// just landed commits on branches (the "2nd mate is empty" report). Scoped to
// this project's dispatched, terminal, not-yet-acknowledged runs. Empty when
// there's nothing waiting.
function pendingSecondMateReviewNudge(sm) {
  // WHAT COUNTS AS "WAITING". Everything terminal and unacknowledged used to, which is
  // wrong in a way that got worse the longer a project ran: on 2026-08-18 this handed the
  // skiff mate 27 runs with the instruction to merge them, most days old and already
  // merged to master. An instruction to re-merge finished work is not noise, it is a
  // hazard. So the boundary is the mate's own last turn: work that landed while it was
  // away is news, work it has already sat through is not.
  const lastLookedAt = secondMateLastLookedAt(sm);
  const eligible = [...goalRuns.values()]
    .filter(isTerminalRun)
    .filter((r) => !isGoalRunAcknowledged(r.goalRunId))
    .filter((r) => samePath(r.projectPath, sm.projectPath))
    // "direct" AND "auto" are top-of-chain project nodes: their crew is ALL the project's
    // dispatched runs (the auto crew is dispatched under the auto second mate's own sm_ id,
    // never the literal "auto"), so scoping by dispatchedBy === firstMateId would filter every
    // auto run out and open the auto second mate BLANK. Only a real first-mate parent scopes.
    .filter((r) => (sm.firstMateId && sm.firstMateId !== "direct" && sm.firstMateId !== "auto" ? r.dispatchedBy === sm.firstMateId : true));
  // A run with no finish time is one this app session watched start, so it is new by
  // construction. A mate with no session yet has never looked at anything, so everything
  // unacknowledged is news to it - that is the blank-session case this nudge exists for.
  const runs = eligible
    .filter((r) => !lastLookedAt || !r.finishedAt || r.finishedAt > lastLookedAt)
    .sort((a, b) => (b.ordinal || 0) - (a.ordinal || 0));
  if (runs.length === 0) {
    return "";
  }
  const shown = runs.slice(0, REPORT_BACK_LIMIT);
  const lines = shown.map((r) => {
    const rep = goalRunReport(r);
    const branch = rep.branchName ? ` [branch ${rep.branchName}, ${rep.commitCount || 0} commit(s)]` : "";
    // A crew brief can be hundreds of lines. Pasting them whole made the nudge itself the
    // biggest thing in the mate's context before it had done anything.
    const goal = String(r.goal || "").replace(/\s+/g, " ").trim();
    const brief = goal.length > 140 ? goal.slice(0, 140) + "…" : goal;
    return `- "${brief}" — ${rep.status}${branch}${rep.needsCaptain ? ` — ${rep.needsCaptain}` : ""}`;
  });
  // The headline used to say runs.length while listing only REPORT_BACK_LIMIT of them, so
  // it announced 27 and showed 6 with no hint the rest existed.
  const more = runs.length - shown.length;
  const tail = more > 0 ? ` (${more} older one${more === 1 ? "" : "s"} not listed - use the Autopilot page for the full set)` : "";
  return (
    `You are the second mate for this project - the judgment tier. Since your last turn, ${runs.length} crew run${runs.length === 1 ? "" : "s"} reported back, each on its OWN branch + worktree${tail}. ` +
    `For each: check whether its branch is already merged (skip it if so), inspect its commits, verify the fix actually holds - don't trust the run's own claim - then merge the ones that hold and say clearly which you merged. ` +
    `For any that failed or look wrong, say what you'd re-dispatch or fix instead - do not merge those. Crew work waiting:\n${lines.join("\n")}`
  );
}

/**
 * When this second mate last had a turn - the boundary between "landed while you were
 * away" and "you have already seen this".
 *
 * Read off the bound session's own last activity, because that is the same clock the
 * runs are stamped against and it survives a restart. A mate with no session has never
 * looked at anything, so callers treat 0 as "everything is news".
 */
function secondMateLastLookedAt(sm) {
  if (!sm?.sessionId) {
    return 0;
  }
  const sess = state.sessions.find((s) => (s.cliSessionId || s.sessionId) === sm.sessionId);
  return sess?.lastActivityAt || 0;
}

// Jump into a second mate: resume its bound project session; else the most
// recent existing session in that project (the fix for direct/derived second
// mates, whose sessionId was never bound - they used to always open fresh);
// else start a fresh one rooted in the project (Opus, tagged so it binds back),
// seeded with a crew-review nudge so it opens with the work to do, not blank.
async function jumpIntoSecondMate(sm) {
  // Navigate to chat FIRST (see jumpIntoFirstMate) - the composer focus in
  // openSessionInPane / openFreshDraftInPane no-ops while chat is hidden.
  navigateToPage("chat");
  const boundRaw = sm.sessionId ? state.sessions.find((s) => (s.cliSessionId || s.sessionId) === sm.sessionId) : null;
  // Never resume a bound session the user has ARCHIVED (or that's hidden from Helm):
  // archiving it is precisely the signal "don't continue this". Because the second
  // mate id is deterministic per (first mate, project), a fresh second mate for a
  // project whose prior second-mate session was archived can still carry that stale
  // binding; without this guard, jumping in resurrects the archived session instead
  // of starting fresh (the captain, 2026-08-12). main.js clears the binding on archive too,
  // but this also covers a session archived in another Helm instance or mid-session.
  const bound = boundRaw && !boundRaw.isArchived && !isHiddenFromHelm(boundRaw) ? boundRaw : null;
  // The fallback reconnects a second mate to its OWN previously-unbound session, but
  // mostRecentSessionForCwd picks the most recent session for the PROJECT - which may
  // belong to ANOTHER node: a Captain "direct" second mate, or a different first
  // mate's second mate for the same repo. Adopting it binds it here, and
  // bindSecondMateSession then clears it from the other node - i.e. it STEALS an
  // active Captain/other-mate session (the captain, 2026-08-12: "kommer den ta över en
  // annan session ... under captain?"). So only adopt a session NOT already claimed
  // by another second mate. If we can't tell (the lookup failed), start FRESH rather
  // than risk a steal - a fresh draft is still a proper second-mate session.
  // (Auto runs live in worktrees with a different cwd, so they never match here.)
  let fallback = null;
  if (!bound) {
    const recent = mostRecentSessionForCwd(sm.projectPath);
    if (recent) {
      const recentIds = [recent.cliSessionId, recent.sessionId].filter(Boolean);
      let claimedElsewhere = true;
      try {
        const res = await window.helm.listSecondMates();
        claimedElsewhere = (res?.secondMates || []).some(
          (o) => o.secondMateId !== sm.secondMateId && o.sessionId && recentIds.includes(o.sessionId)
        );
      } catch {
        claimedElsewhere = true; // safe default: don't adopt a session we can't prove is loose
      }
      fallback = claimedElsewhere ? null : recent;
    }
  }
  const existing = bound || fallback;
  if (existing) {
    // Thread the second-mate id through the RESUME path too. A direct/derived second mate's
    // session was never bound, so openSessionInPane can't recover its id on its own - without
    // this it resumed as a PLAIN session (no helm_dispatch, no delegate manual) and did every
    // task itself instead of dispatching autopilots. Bind it now so future resolves (and a
    // later pane rebuild) recognise the session as this second mate.
    const resumeId = existing.cliSessionId || existing.sessionId;
    // Pass the project too: for a session node the id is a display key and main
    // needs the project to translate it into a real second mate (task 99089c59).
    if (sm.secondMateId && resumeId) {
      window.helm.bindSecondMateSession(sm.secondMateId, resumeId, sm.projectPath);
    }
    // Crew that finished has to be SURFACED here too, not only on a fresh session.
    //
    // the captain, task 28db596e: "autopilots (crewmates) rapporterar inte tillbaka till 2nd
    // mate ordentligt." The report loop was never broken - runs write to the inbox and
    // helm_collect_reports would return them. What was broken is that nothing told the
    // second mate to look. The nudge was seeded only by the branch below, so it worked
    // exactly once per second mate: the first jump-in, when no session existed yet. Every
    // jump-in after that resumed silently, and the finished crew sat in the inbox with
    // nobody prompted to read it. That is the same shape as the manual only reaching a
    // fresh turn - a signal attached to session creation, for a tier that is resumed far
    // more often than it is created.
    //
    // Seeded as a DRAFT, not sent: the captain may have jumped in to say something else,
    // and an auto-sent turn would spend Opus tokens on a decision he had not made. An
    // existing draft always wins - his half-typed message is never worth a nudge.
    const nudge = pendingSecondMateReviewNudge(sm);
    if (nudge && resumeId && !queuedPromptBySession.get(resumeId)) {
      queuedPromptBySession.set(resumeId, nudge);
    }
    openSessionInPane(existing, 0, { secondMateId: sm.secondMateId });
  } else {
    openFreshDraftInPane(sm.projectPath, pendingSecondMateReviewNudge(sm), {
      forceIndex: 0,
      paneOverrides: { modelDefault: "claude-opus-4-8", secondMateId: sm.secondMateId, title: sm.name },
    });
  }
}

// Re-render only the sections whose data changed, into their existing slots.
// This is the anti-flicker path: it never touches page.innerHTML, so unchanged
// sections (and the whole page when nothing changed) stay put. A full rebuild
// (renderDashboardPage) only happens on navigation or when the shell is missing.
// Write into one of the classic dashboard's section slots, tolerating the slot
// having disappeared. This function awaits IPC between its entry check and each
// write, and the widget dashboard commits its page swap in one go - so a slot
// that existed at entry can legitimately be gone by the time we write to it
// (observed as "Cannot read properties of null (reading 'replaceChildren')"
// while toggling into widget mode).
function writeDashSlot(id, ...nodes) {
  const slot = document.getElementById(id);
  if (slot) {
    slot.replaceChildren(...nodes);
  }
}

async function fillDashboardSections({ force = false } = {}) {
  // Don't swap a slot out from under a pressed pointer (see the pointer-held
  // guard near the mouse-nav handler) - it tears the card out from under an
  // in-flight click. This function is ASYNC (awaits several IPCs), so it's not
  // enough to check once at entry: a refresh that started BEFORE a press can
  // reach a replaceChildren mid-press when its awaits resolve. So re-check
  // before EVERY slot mutation and bail (queuing a fresh refresh for release)
  // if the pointer went down meanwhile. This applies to FORCED refreshes too:
  // the async forced fill from navigating back to the Dashboard can still be
  // resolving when the next card is pressed (see the guard's header comment).
  // A deferred forced refresh keeps its force through the flush (dashQueuedForce).
  const bailIfPressed = () => {
    if (dashPointerHeld) {
      dashRefreshQueued = true;
      if (force) {
        dashQueuedForce = true;
      }
      return true;
    }
    return false;
  };
  if (bailIfPressed()) {
    return;
  }
  // Widget dashboard owns its own rendering (4bf2421c) and has no section slots,
  // so none of the per-slot work below applies to it.
  //
  // It used to return here outright, which meant the widget dashboard NEVER
  // repainted on a poll: once rendered it was frozen until something called
  // renderDashboardPage by hand. A fleet view that only updates when you click
  // something is wrong on its own terms - sessions finish, statuses change - and
  // it is why the Auto widget stayed empty rather than filling in a moment later
  // (the captain, 2026-08-02: "Auto widgeten är fortfarande tillsynes tom").
  //
  // So: repaint, but only when something actually changed, and never mid-drag -
  // being torn out while rearranging was the real reason for the original guard,
  // and that reason is preserved exactly.
  // The Dashboard is always the widget grid now (task 337895ce). This repaint
  // path is the only one; the classic section-slot tail below it is unreachable
  // and removed with the rest of the classic layout.
  {
    if (widgetDragId || !isDashboardVisible()) {
      return;
    }
    const fp = widgetDashboardFingerprint();
    if (!force && fp === lastWidgetDashboardFingerprint) {
      return;
    }
    lastWidgetDashboardFingerprint = fp;
    await renderDashboardPage();
    // Recompute AFTER the render: it refreshes state.sessions itself, so the
    // fingerprint taken before it would be stale and every tick would repaint.
    lastWidgetDashboardFingerprint = widgetDashboardFingerprint();
    return;
  }
}


/**
 * The quiet line under the list: what was deliberately left out, and why. The captain
 * parked or aged-out projects still have to be VISIBLE somewhere, or "nothing to
 * reconcile" starts meaning "nothing I chose to look at" without saying so.
 */
function driftFootnote(res) {
  if (!res?.ok) {
    return null;
  }
  const bits = [];
  if (res.parked > 0) {
    bits.push(`${res.parked} parked`);
  }
  if (res.dormant > 0) {
    bits.push(`${res.dormant} untouched for over ${res.dormantDays} days`);
  }
  return bits.length ? `Not counted: ${bits.join(", ")}.` : null;
}


/**
 * The footnote, with un-parking attached to it. The un-park control lives HERE
 * rather than in Settings because this is the only place the concept is visible -
 * telling him to go find it somewhere else is how a reversible decision becomes
 * an irreversible one in practice.
 */
/**
 * Repaint whichever dashboard is actually on screen.
 *
 * refreshDashboardIfVisible drives the CLASSIC sections and returns immediately
 * when the widget dashboard is enabled, so anything that called it from a widget
 * (Park, un-park) showed its toast and then changed nothing on screen until the
 * user navigated away and back. Found by the pre-release review.
 */
function repaintDashboard() {
  // One dashboard now (widgets), so always re-render it (task 337895ce).
  renderDashboardPage();
}

function driftFootEl(text, parkedCount = 0) {
  const note = document.createElement("div");
  note.className = "wd-drift-foot";
  note.textContent = text;
  if (parkedCount > 0) {
    const undo = document.createElement("button");
    undo.className = "wd-drift-park";
    undo.textContent = "show parked";
    undo.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await window.helm.parkedDocsProjects();
      const list = res?.parked || [];
      if (!list.length) {
        showToast("Nothing is parked.");
        return;
      }
      showContextMenu(
        e.clientX,
        e.clientY,
        list.map((p) => ({
          label: `Un-park ${p.name}`,
          hint: p.path,
          onClick: async () => {
            const r = await window.helm.parkDocsProject(p.path, false);
            if (!r?.ok) {
              showToast(`Couldn't un-park it: ${r?.error || "unknown"}`);
              return;
            }
            showToast(`"${p.name}" is back in the docs-drift check.`);
            repaintDashboard();
          },
        }))
      );
    });
    note.append(" ", undo);
  }
  return note;
}

// ======================= Widget dashboard (task 4bf2421c) =======================
// The Dashboard as a drag-and-drop grid of widgets instead of the fixed section
// stack, per the mock the captain approved: quota, needs-you, captain+auto, one widget
// PER first mate (add as many as you like), autopilot/goals. Lives behind
// config.dashboardWidgets.enabled with the classic dashboard untouched beside
// it, so switching is reversible and the daily surface is never destroyed.
//
// The widgets deliberately reuse the SAME data the classic sections read
// (dashboardInMotionRows, listMates, getJotGoals, quotaPanelRows,
// orchestrationChipContent) - this is a re-presentation, not a second source of
// truth that could drift from what the rest of the app shows.

// Widget catalogue. `perMate` types are instantiated once per first mate and
// carry a mateId; everything else is a singleton.
// Widget bodies EMBED the existing dashboard renderers (fleetMateCardEl,
// fleetDirectCardEl, dashboardQueueSection) rather than
// re-summarising their data. The first pass rebuilt simplified bodies and lost
// everything that makes those modules useful - a first mate's persona picker,
// context gauge, and its second mates with their badges/jump-in/Archive (the captain:
// "nu har vi förlorat massor av detaljer"). Quota is the deliberate exception:
// it is a purpose-built widget readout, which is what he wanted there.
const WIDGET_CATALOG = {
  quota: { label: "Quota", span: 4, accent: "grn", singleton: true },
  needsYou: { label: "Needs you", span: 8, accent: "acc", singleton: true },
  captain: { label: "Captain", span: 4, accent: "mate", singleton: true },
  auto: { label: "Auto", span: 4, accent: "mate", singleton: true },
  firstMate: { label: "First mate", span: 4, accent: "mate", perMate: true },
  docsDrift: { label: "Docs drift", span: 4, accent: "acc", singleton: true },
  review: { label: "Review", span: 4, accent: "acc", singleton: true },
  // Layout-only entries, so a row can be left deliberately short instead of the
  // grid packing every widget against the previous one (the captain: "jag kan inte
  // lämna tomt på rad 1 för att börja på rad 2"). They are ordinary layout
  // entries - draggable, resizable, removable - not a separate mechanism.
  blank: { label: "Blank space", span: 4, layoutOnly: true },
  break: { label: "Row break", span: 12, layoutOnly: true },
};
// Every width the 12-column grid can express. The old list stopped at 8 and the
// CSS only implemented up to 7, so half the menu was inert.
const WIDGET_SPANS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12];

let widgetDragId = null;

/** Lowest free instance number for a repeatable widget type, so ids stay unique. */
function nextWidgetInstanceId(layout, type) {
  let n = 1;
  const taken = new Set((layout || []).map((w) => w.id));
  while (taken.has(`w-${type}-${n}`)) {
    n += 1;
  }
  return n;
}

/** The saved layout, or a seeded default (one first-mate widget per active mate). */
function widgetLayout(mates) {
  const saved = state.config?.dashboardWidgets?.layout;
  if (Array.isArray(saved) && saved.length > 0) {
    return saved;
  }
  const layout = [
    { id: "w-needs", type: "needsYou", span: 8, orientation: "horizontal" },
    { id: "w-quota", type: "quota", span: 4 },
  ];
  for (const mate of mates || []) {
    layout.push({ id: `w-mate-${mate.mateId}`, type: "firstMate", span: 4, mateId: mate.mateId });
  }
  layout.push(
    { id: "w-captain", type: "captain", span: 4 },
    { id: "w-auto", type: "auto", span: 4 },
    { id: "w-docsDrift", type: "docsDrift", span: 4 },
  );
  return layout;
}

/**
 * Which first mate each first-mate widget shows.
 *
 * A first-mate widget used to be welded to one mateId, so retiring that mate left a
 * dead widget on the board and the only way forward was to remove it and add another
 * (the captain, task acb34a24: "när man retirerar en first mate måste man byta ut widgeten,
 * det är ganska störigt"). A first mate is short-lived by design - that made the
 * widget's binding the most fragile thing about the board.
 *
 * The binding is now a PREFERENCE, resolved against who is actually on watch:
 *  - a widget whose mate is still there keeps it, so nothing you arranged moves;
 *  - a widget whose mate is gone adopts, in board order, a mate no other widget has
 *    claimed - which is exactly the replacement he was doing by hand;
 *  - a widget with nobody left to adopt keeps its slot and says so, rather than
 *    stealing a mate that another widget already shows.
 *
 * Pure, and separate from the render, so the decision can be tested without a
 * dashboard: the "which widget shows whom" bugs in this app have all been assignment
 * bugs, not drawing bugs.
 */
function resolveFirstMateWidgetMates(layout, mates) {
  const order = (mates || []).map((m) => m.mateId);
  const live = new Set(order);
  const widgets = (layout || []).filter((w) => w.type === "firstMate");
  const claimed = new Set(widgets.map((w) => w.mateId).filter((id) => live.has(id)));
  const unclaimed = order.filter((id) => !claimed.has(id));
  const out = new Map();
  let next = 0;
  for (const w of widgets) {
    if (live.has(w.mateId)) {
      out.set(w.id, w.mateId);
      continue;
    }
    out.set(w.id, next < unclaimed.length ? unclaimed[next++] : null);
  }
  return out;
}

/**
 * The same layout with every first-mate widget pointed at the mate it will show.
 * `changed` says whether anything was adopted, so the caller can persist it once
 * instead of re-deciding on every repaint.
 */
function rebindFirstMateWidgets(layout, mates) {
  const resolved = resolveFirstMateWidgetMates(layout, mates);
  let changed = false;
  const next = (layout || []).map((w) => {
    if (w.type !== "firstMate") {
      return w;
    }
    const mateId = resolved.get(w.id);
    if (!mateId || mateId === w.mateId) {
      return w;
    }
    changed = true;
    return { ...w, mateId };
  });
  return { layout: next, changed };
}

/**
 * Seeds a NEW widget type onto an already-saved layout, exactly once (task
 * 0831417b). A widget added to the default layout is invisible to anyone who has
 * already arranged their board - and an attention signal you have to go find in
 * the Add-widget menu isn't much of a nudge.
 *
 * Gated on a per-type flag rather than "is it in the layout": otherwise removing
 * the widget would just make it come back, which is the app overriding a decision
 * you made on purpose. Seeded once, then yours.
 */
// `save` is injectable for the same reason as widgetBodyDocsDrift's fetcher: a
// test must be able to observe what this WOULD persist without writing config.
async function seedNewWidgets(save = (patch) => window.helm.setConfig(patch)) {
  const dw = state.config?.dashboardWidgets;
  const saved = dw?.layout;
  if (!Array.isArray(saved) || saved.length === 0) {
    return; // no saved layout: the default already includes everything.
  }
  const seeded = dw?.seeded || {};
  const toSeed = ["docsDrift"].filter((type) => !seeded[type] && !saved.some((w) => w.type === type));
  const alreadyPresent = ["docsDrift"].filter((type) => !seeded[type] && saved.some((w) => w.type === type));
  if (toSeed.length === 0 && alreadyPresent.length === 0) {
    return;
  }
  const layout = [...saved];
  for (const type of toSeed) {
    layout.push({ id: `w-${type}`, type, span: WIDGET_CATALOG[type]?.span || 4 });
  }
  // Mark every candidate as seeded, including ones already on the board, so this
  // never runs twice for the same type.
  const nextSeeded = { ...seeded };
  for (const type of [...toSeed, ...alreadyPresent]) {
    nextSeeded[type] = true;
  }
  const next = { ...(dw || {}), layout, seeded: nextSeeded };
  state.config = { ...state.config, dashboardWidgets: next };
  await save({ dashboardWidgets: next });
}

async function saveWidgetLayout(layout) {
  const next = { ...(state.config?.dashboardWidgets || {}), layout };
  state.config = { ...state.config, dashboardWidgets: next };
  await window.helm.setConfig({ dashboardWidgets: next });
}


/** A labelled stat block ("4 / own sessions"). */
function widgetStat(label, value, note, variant) {
  const col = document.createElement("div");
  col.className = "wd-stat" + (variant ? ` ${variant}` : "");
  const l = document.createElement("div");
  l.className = "wd-stat-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "wd-stat-value";
  v.textContent = value;
  const n = document.createElement("div");
  n.className = "wd-stat-note";
  n.textContent = note;
  col.append(l, v, n);
  return col;
}

function widgetEmpty(text) {
  const d = document.createElement("div");
  d.className = "wd-empty";
  d.textContent = text;
  return d;
}

// --- per-type body builders. Each gets the shared data bundle. ---
function widgetBodyQuota(data) {
  const frag = document.createDocumentFragment();
  const rows = quotaPanelRows(state.quotaWindows, Date.now());
  const worst = worstFreshQuotaRow(rows);
  const head = document.createElement("div");
  head.className = "wd-quota-head";
  // NAME the window. `chipText` is written for the cramped top-bar chip, where it
  // reads "Quota 36%" with no room to say which limit that is - and the widget was
  // reusing it as its headline. The effect: the weekly window, being the most
  // constrained one, became the unlabelled headline while the labelled rows below
  // showed only the 5-hour limit, so the weekly quota looked absent (the captain,
  // 2026-08-03: "ingen veckokvot t.ex"). It was there the whole time, just
  // anonymous.
  // The "≥" on an hours-old reading has to survive into the headline too. This line
  // builds its own text from label+pct rather than using chipText, so a qualifier
  // added to chipText alone would show on the small rows and silently vanish from
  // the largest number in the widget - the one surface that actually gets read.
  head.textContent = worst
    ? worst.hasPct
      ? `${worst.label} ${worst.atLeast ? "≥" : ""}${worst.pct}%`
      : worst.chipText
    : "No current reading";
  // COLOUR THE STATE. "5-hour limit - limited" was rendered in the same neutral
  // headline colour as a comfortable 12%, so the one reading that changes what you can
  // do looked like any other (the captain: "Limited borde synas tydligare"). Colour only for
  // the state, never the whole row - the same rule the rest of the app follows.
  if (worst && (worst.level === "hot" || worst.level === "warm")) {
    head.classList.add(worst.level === "hot" ? "crit" : "warn");
  }
  const sub = document.createElement("div");
  sub.className = "wd-quota-sub";
  const resetSuffix = worst?.resetText ? ` · resets in ${worst.resetText}` : "";
  // HOW OLD THE NUMBER IS. Helm never polls for quota - it only records what arrives
  // on a rate-limit event from a running session, so a window's figure is exactly as
  // old as the last turn that happened to report it. quotaPanelRows already computes
  // that age, the context popover already shows it, and this widget threw it away:
  // it printed a 26-hour-old weekly reading as though it were current. That is why
  // the captain's Helm said 36% while Claude Desktop said 29% "på samma" - not a rounding
  // difference, a day-old number presented as live. An unlabelled stale number is
  // worse than no number, because you act on it.
  const agePrefix = worst?.freshness ? `${worst.freshness} · ` : "";
  sub.textContent = worst ? agePrefix + worst.barValueText + resetSuffix : "run a turn to get a fresh reading";
  frag.append(head, sub);
  if (worst && worst.hasPct) {
    frag.append(quotaBar(worst.pct, worst.level));
  } else if (worst && !worst.stale && (worst.level === "hot" || worst.level === "warm")) {
    // A definite limited/near state with no percentage still gets a full bar, so the
    // severity reads without a number - exactly what the context popover already does
    // (cpopWindowRow). The widget had neither the colour nor the bar, which is how the
    // most consequential reading became the least visible one.
    frag.append(quotaBar(100, worst.level));
  }
  // Every other accumulated window, compact - the desktop-style stack (bc6786c7).
  for (const row of rows) {
    if (worst && row.type === worst.type) {
      continue;
    }
    const line = document.createElement("div");
    line.className = "wd-quota-line";
    const l = document.createElement("span");
    l.textContent = row.label;
    const v = document.createElement("span");
    v.className = "wd-quota-val" + (row.level === "hot" ? " crit" : row.level === "warm" ? " warn" : row.stale ? " faint" : "");
    v.textContent = row.barValueText;
    // Same for the secondary rows: the age belongs next to the number, not only in a
    // tooltip nobody hovers.
    if (row.freshness) {
      const age = document.createElement("span");
      age.className = "wd-quota-age";
      age.textContent = row.freshness;
      l.append(age);
    }
    line.append(l, v);
    if (row.title) {
      line.title = row.title + (row.freshness ? ` · ${row.freshness}` : "");
    }
    frag.append(line);
  }
  const spend = orchestrationChipContent(data.budget);
  if (!spend.hidden) {
    const line = document.createElement("div");
    line.className = "wd-quota-line spend";
    const l = document.createElement("span");
    l.textContent = "Fleet spend (est.)";
    const v = document.createElement("span");
    v.className = "wd-quota-val" + (spend.stopped || spend.over ? " crit" : "");
    v.textContent = spend.labelText.replace(/^Fleet spend \(est\.\)\s*/, "");
    v.title = spend.title;
    line.append(l, v);
    frag.append(line);
    // The widget dashboard dropped the old header chip's Resume/Stop control
    // when it replaced the classic dashboard (the captain, 2026-08-11: the button
    // "fanns i förra dashboarden ... nu saknas den"). Reused instead of
    // recreated: same IPC calls the old dashOrchestrationChip made.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "text-btn wd-quota-spend-btn";
    if (spend.stopped || spend.over) {
      btn.textContent = "Resume";
      btn.title = "Clear the stop + reset spend so new work can start (keeps the ceiling)";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        await window.helm.resumeOrchestration();
        await renderDashboardPage();
      });
    } else {
      btn.textContent = "Stop";
      btn.title = "Stop everything: halt the whole fleet (cancels live runs; blocks new work from starting)";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        const res = await window.helm.killOrchestration();
        showToast(res && res.ok ? `Fleet stopped (${res.cancelled} live run${res.cancelled === 1 ? "" : "s"} cancelled).` : "Couldn't stop the fleet - try again.");
        await renderDashboardPage();
      });
    }
    frag.append(btn);
  }
  return frag;
}

// Lifts the BODY out of one of the classic dashboard sections so a widget shows
// the real module, not a re-summary. The widget head already carries the title,
// so the section's own dashBoardHead is dropped.
function widgetSectionBody(section) {
  const body = section?.querySelector?.(".dash-board-body");
  if (body) {
    body.classList.add("wd-embedded");
    return body;
  }
  // dash-fleet and friends keep their content directly under the section; take
  // everything after the head rather than losing it.
  const frag = document.createDocumentFragment();
  for (const child of [...(section?.children || [])]) {
    if (child.classList?.contains("dash-board-head")) {
      continue;
    }
    frag.append(child);
  }
  return frag;
}

function widgetBodyNeedsYou(data, widget) {
  // The real "Needs you & in motion" module, so the rows keep their warning
  // icon, "needs input" badge, model and age - not a stripped-down list.
  const body = widgetSectionBody(dashboardQueueSection());
  // Vertical vs horizontal is per-widget (the captain asked for the choice): the
  // classic module lays its rows out as a grid across the width; vertical
  // stacks them one per row for a narrow column.
  if (widget?.orientation === "vertical" && body.querySelector) {
    body.querySelectorAll(".dash-queue-grid").forEach((g) => g.classList.add("wd-stacked"));
  }
  return body;
}

function widgetBodyFirstMate(data, widget) {
  const mate = (data.mates || []).find((m) => m.mateId === widget.mateId);
  if (!mate) {
    // Only reachable when there is no unclaimed mate left to adopt (see
    // resolveFirstMateWidgetMates) - so this is an empty SLOT, not a stale binding, and
    // it fills itself the moment a first mate joins the fleet.
    return widgetEmpty("No first mate for this slot yet - it takes the next one that joins the fleet. Add one from \"+ Add widget\", or remove the slot.");
  }
  // The REAL first-mate card: persona picker, context gauge, retire nudge, and
  // its second mates with their own badges / jump-in / Archive.
  const sms = (data.secondMates || []).filter((s) => s.firstMateId === mate.mateId);
  return fleetMateCardEl(mate, sms, data.boardSummary || {});
}

function widgetBodyCaptain(data) {
  // "Direct - your own work": the captain's own sessions, exactly as the Fleet
  // section renders them (+ Session button, per-session jump-in and Archive).
  const directSms = (data.secondMates || []).filter(
    (s) => s.firstMateId === "direct" && isLiveWorkNode(s) && !isAutoStartedNode(s)
  );
  return fleetDirectCardEl(directSms);
}

function widgetBodyAuto(data) {
  // Same shape as the captain widget, but scoped to AUTO-STARTED sessions - the
  // auto captain's own column (the captain: "auto ska vara en separat widget som ser
  // precis ut som captain men med autostartade sessioner").
  //
  const autoSms = (data.secondMates || []).filter((s) => isAutoStartedNode(s) && hasWorkUnderNode(s));
  const frag = document.createDocumentFragment();
  frag.append(autoCaptainControlsEl());
  // What a pass LOOKED AT and declined, before the empty state gets to claim that
  // nothing has happened - because for a card set aside as unclear, something did.
  frag.append(autoSetAsideEl());
  if (autoSms.length === 0) {
    frag.append(
      widgetEmpty(
        state.config?.autoCaptain?.enabled === true
          ? "Nothing started yet. Tag a task \"auto\" in Jot and it gets picked up within a minute."
          : "Off. Nothing starts by itself until you turn this on."
      )
    );
    return frag;
  }
  frag.append(fleetDirectCardEl(autoSms, { as: "auto" }));
  return frag;
}

/**
 * The cards the last pass looked at and did NOT start, each with its reason.
 *
 * Without this the only visible output of a pass that examined a card and decided
 * against it was nothing at all. The captain ran a pass, watched the widget stay empty,
 * and reasonably concluded the feature was broken (2026-08-03) - while the card sat
 * there, set aside, permanently skipped because the verdict is remembered against
 * its wording. A transient toast saying "1 waiting" is not the same thing: it is gone
 * a moment later and it reads like "queued, be patient".
 *
 * Fetches on creation and repaints itself, rather than riding the dashboard's
 * fingerprint - that fingerprint is computed from data this element does not have,
 * and a repaint-requesting button that does nothing is a bug this app has shipped
 * before.
 */
function autoSetAsideEl() {
  const wrap = document.createElement("div");
  wrap.className = "wd-auto-setaside";
  wrap.id = "autoSetAside";
  paintAutoSetAside(wrap);
  return wrap;
}

async function paintAutoSetAside(el = document.getElementById("autoSetAside")) {
  if (!el) {
    return;
  }
  let status = null;
  try {
    status = await window.helm.autoCaptainStatus();
  } catch {
    return; // leave whatever is there; never blank the widget over a failed read
  }
  const setAside = status?.lastTick?.setAside || [];
  el.textContent = "";
  if (setAside.length === 0) {
    return;
  }
  const head = document.createElement("div");
  head.className = "wd-auto-setaside-head";
  head.textContent = `Looked at and not started: ${setAside.length}`;
  el.append(head);
  for (const item of setAside) {
    const row = document.createElement("div");
    row.className = "wd-auto-setaside-row";
    const title = document.createElement("span");
    title.className = "wd-auto-setaside-title";
    title.textContent = item.title;
    const why = document.createElement("span");
    why.className = "wd-auto-setaside-why";
    why.textContent = item.reason;
    row.append(title, why);
    row.title = `${item.title}\n${item.reason}\n\nThe full explanation is on the card in Jot. Remove its "needs-clarification" tag, or edit its wording, and it will be judged again.`;
    el.append(row);
  }
}

/**
 * The auto-captain's own controls, inside its widget: the on/off switch, and a
 * "run one pass now" that works even while it is off.
 *
 * The switch lives here rather than in Settings on purpose. This is the one
 * feature in Helm that spends money and changes a repo without being asked each
 * time, so the control belongs next to the list of what it has actually started -
 * you cannot turn it on without seeing its output, and you cannot look at its
 * output without seeing that it is on.
 */
function autoCaptainControlsEl() {
  const row = document.createElement("div");
  row.className = "wd-auto-controls";
  const on = state.config?.autoCaptain?.enabled === true;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "text-btn" + (on ? " has-running" : "");
  toggle.textContent = on ? "On" : "Off";
  toggle.title = on
    ? "Auto-captain is watching for tasks tagged \"auto\". Click to stop."
    : "Turn on to let tasks tagged \"auto\" start themselves. Work always lands in review, never done.";
  toggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !on;
    // Turning it ON is the consequential direction, so it is the one that asks.
    const apply = async () => {
      toggle.disabled = true;
      const res = await window.helm.setAutoCaptainEnabled(next);
      if (!res?.ok) {
        toggle.disabled = false;
        showToast(`Couldn't change that: ${res?.error || "unknown"}`);
        return;
      }
      state.config = { ...state.config, autoCaptain: { ...(state.config?.autoCaptain || {}), enabled: next } };
      showToast(next ? "Auto-captain is on. Tasks tagged \"auto\" will start themselves." : "Auto-captain is off.");
      repaintDashboard();
    };
    if (next) {
      customConfirm(
        "Turn on the auto-captain? Tasks tagged \"auto\" in Jot will start real sessions by themselves, up to 3 at a time. Work always lands in review - it never marks anything done.",
        "Turn on",
        apply,
        { deliberate: true }
      );
      return;
    }
    apply();
  });

  const runNow = document.createElement("button");
  runNow.type = "button";
  runNow.className = "text-btn";
  runNow.textContent = "Run one pass";
  runNow.title = "Check the board once, right now - even while the auto-captain is off. This is how to watch the first run.";
  runNow.addEventListener("click", async (e) => {
    e.stopPropagation();
    runNow.disabled = true;
    runNow.textContent = "Checking…";
    const res = await window.helm.runAutoCaptainNow({ force: true });
    runNow.disabled = false;
    runNow.textContent = "Run one pass";
    if (!res?.ok) {
      showToast(`Auto-captain: ${res?.error || "that didn't work"}`);
      return;
    }
    if (res.skipped) {
      showToast(`Auto-captain did nothing: ${res.skipped}.`);
      return;
    }
    const bits = [];
    if (res.acted) {
      bits.push(`started ${res.acted}`);
    }
    if (res.held) {
      bits.push(`held back ${res.held} for clarification`);
    }
    if (res.waiting) {
      bits.push(`${res.waiting} waiting`);
    }
    // Reported separately from "held back": a card we could not judge is our
    // failure, not a verdict about the card, and saying "held back for
    // clarification" about it blames the wording for our own timeout.
    if (res.triageFailed) {
      bits.push(`${res.triageFailed} could not be judged - will retry`);
    }
    showToast(bits.length ? `Auto-captain: ${bits.join(", ")}.` : "Auto-captain: nothing tagged \"auto\" is queued.");
    // Repaint the set-aside list from the pass that just ran, explicitly. The toast
    // is transient; this is the part that has to still be there in a minute.
    void paintAutoSetAside();
    repaintDashboard();
  });

  row.append(toggle, runNow);
  return row;
}

// The ACTIVE half of the docs-drift signal (task 0831417b). The pane-header pill
// only tells you once you've already opened the project - backwards for drift on a
// project you've stopped thinking about. This lists the projects whose
// PLAN/DECISIONS have fallen behind, worst first, with jump-in.
//
// Jump-in only, by design: it points, it does not reconcile. An unsupervised
// rewrite of a project's DECISIONS.md would quietly corrupt the durable record
// this nudge exists to protect.
//
// `fetchStale` is injectable purely so a test can drive the render paths (drift,
// no drift, failed read) with known data: window.helm is contextBridge-exposed and
// therefore NOT writable, so a test cannot stub the call any other way - and a
// widget that only ever renders whatever this machine happens to have today is a
// widget whose empty and error states go unverified.
async function widgetBodyDocsDrift(_data, _widget, fetchStale = () => window.helm.staleProjects()) {
  const frag = document.createDocumentFragment();
  let res;
  try {
    res = await fetchStale();
  } catch {
    frag.append(widgetEmpty("Couldn't read docs drift."));
    return frag;
  }
  if (!res?.ok) {
    frag.append(widgetEmpty(res?.error ? `Couldn't read docs drift: ${res.error}` : "Couldn't read docs drift."));
    return frag;
  }
  if (res.pending) {
    // Nothing has been measured yet (the sweep runs in the background so it can't
    // block the main process). "Checking" is the truth; "current" would not be.
    frag.append(widgetEmpty("Checking docs drift…"));
    return frag;
  }
  const rows = res.rows || [];
  for (const row of rows) {
    frag.append(driftLineEl(row));
  }
  // Never fold a failed look into the all-clear - and name the projects, so the
  // line is something he can act on rather than a count he has to trust.
  for (const u of res.uncheckedPaths || []) {
    frag.append(driftLineEl({ path: u.path, name: u.name, unreadable: u.reason }));
  }
  if (!(res.uncheckedPaths || []).length && res.unchecked > 0) {
    // Same safety net as the classic board: a count with no names still beats
    // rendering the all-clear.
    frag.append(widgetEmpty(`${res.unchecked} of ${res.considered} project${res.considered === 1 ? "" : "s"} couldn't be checked - treat as unknown, not current.`));
  } else if (rows.length === 0 && !(res.uncheckedPaths || []).length) {
    // Said as reassurance, not as an empty state - "nothing here" should read as
    // good news for a nudge whose whole job is to be quiet when there's no drift.
    frag.append(widgetEmpty("Docs are current across your projects."));
  }
  const foot = driftFootnote(res);
  if (foot) {
    frag.append(driftFootEl(foot, res.parked || 0));
  }
  return frag;
}

/**
 * One drift row, shared by the widget and the classic dashboard section.
 *
 * Two kinds of row: a project whose docs are N commits behind, and a project that
 * could not be read at all (`unreadable` holds the reason). Both get the same
 * Park control - a row you can never act on is the thing that kills the signal.
 */
/**
 * The job the Reconcile button writes into the composer.
 *
 * Written out in full rather than left as "reconcile the docs" on purpose: the
 * whole complaint was not knowing what to do, and a vague prompt just moves that
 * problem one step to the right. It names the range to read, what belongs in
 * each file, and the trap - DECISIONS.md is not a changelog of commits, git
 * already has that, and an entry a later decision has overruled has to be
 * corrected rather than left to mislead.
 */
function docsReconcilePrompt(row) {
  return [
    `This project's durable docs are behind its code: ${row.commitsSince} commits have landed since DECISIONS.md / PLAN.md were last touched.`,
    "",
    "Reconcile them:",
    "1. Find where they diverged: `git log -1 --format=%H -- DECISIONS.md PLAN.md`, then read `git log <sha>..HEAD -p` for whichever docs exist here.",
    "2. Add to DECISIONS.md any DECISION in that range that is not recorded yet - dated, with the alternatives considered and why they lost. NOT a changelog of the commits; git already has those.",
    "3. Update PLAN.md so its status section matches where the project actually is now.",
    "4. Where a later decision has superseded an earlier entry, correct or annotate the old one so it cannot mislead.",
    "",
    "Commit the doc update on its own, then tell me in plain words what had gone unrecorded.",
  ].join("\n");
}

function driftLineEl(row) {
  const line = document.createElement("div");
  line.className = "wd-drift-line";
  const name = document.createElement("span");
  name.className = "wd-drift-name";
  name.textContent = row.name || row.path;
  name.title = row.path;
  const count = document.createElement("span");
  if (row.unreadable) {
    count.className = "wd-drift-count crit";
    count.textContent = "couldn't read";
    count.title = `${row.path}\n${row.unreadable}\nTreat as unknown, not as current.`;
  } else {
    count.className = "wd-drift-count" + (row.commitsSince >= row.threshold * 3 ? " crit" : "");
    count.textContent = `${row.commitsSince} behind`;
    count.title = `${row.commitsSince} commits since PLAN.md/DECISIONS.md were last touched (nudges at ${row.threshold}).`;
  }
  line.append(name, count);

  // Park: stop nudging about this project. For a work repo he cannot touch, or a
  // project he has decided not to reconcile. Reversible from Settings, and the
  // count of parked projects stays on screen so this never hides drift silently.
  const park = document.createElement("button");
  park.className = "wd-drift-park";
  park.textContent = "Park";
  park.title = "Stop nudging about this project. Reversible - use \"show parked\" at the bottom of this section.";
  park.addEventListener("click", async (e) => {
    e.stopPropagation();
    park.disabled = true;
    const res = await window.helm.parkDocsProject(row.path, true);
    if (!res?.ok) {
      park.disabled = false;
      showToast(`Couldn't park it: ${res?.error || "unknown"}`);
      return;
    }
    // Say where to undo it. The first version of this said "un-park it in Settings",
    // and there is no parking UI in Settings at all - the control is the "show
    // parked" link in this section's own footnote.
    showToast(`Parked "${row.name || row.path}" - undo with "show parked" below.`);
    repaintDashboard();
  });
  line.append(park);

  // Reconcile: the answer to "jag vet fortfarande inte vad jag ska göra med
  // denna? Borde det finnas en fix-knapp?" (the captain, 2026-08-02, his SECOND round
  // of the same complaint).
  //
  // The original design chose jump-in only, on the grounds that dispatching a
  // reconcile turn was the riskier option. That was the wrong trade. A row
  // saying "loom, 15 behind" and offering only a way into an unrelated
  // conversation leaves him holding the entire job: remember what reconciling
  // means, find the range of commits, and type it out. Twice now he has read the
  // row and not known what it wanted from him. A signal nobody can act on is not
  // a safe signal, it is noise with a number on it.
  //
  // It lands in the COMPOSER rather than sending: this spends real money in a
  // repo, and a nudge on a dashboard should never be one stray click away from
  // that. He reads the prompt and presses Enter.
  if (!row.unreadable) {
    const fix = document.createElement("button");
    fix.className = "wd-drift-jump";
    fix.textContent = "Reconcile";
    fix.title = "Open a session in this project with the doc-reconcile job already written out. Nothing is sent until you press Enter.";
    fix.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateToPage("chat");
      openFreshDraftInPane(row.path, docsReconcilePrompt(row));
    });
    line.append(fix);
  }

  // Jump in only if there is a session to jump into. A project with drift but no
  // session left on the board is still worth SHOWING - that is drift with nothing
  // holding the context, which is the worst case, not a reason to hide it.
  if (row.sessionId) {
    const btn = document.createElement("button");
    btn.className = "wd-drift-jump";
    btn.textContent = "Jump in";
    btn.title = "Open the most recent session in this project so you can reconcile its docs.";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const session = (state.sessions || []).find((s) => s.sessionId === row.sessionId);
      if (!session) {
        showToast("That session is no longer on the board.");
        return;
      }
      // Navigate FIRST. openSessionInPane writes into #chatPage and focuses the
      // composer, both of which no-op while chat is hidden - so from the Dashboard
      // the button silently did nothing at all. Every other jump-in does this.
      navigateToPage("chat");
      openSessionInPane(session, focusedPaneIndex);
    });
    line.append(btn);
  }
  return line;
}

/**
 * The Review widget: how many items are waiting, split by what they need, and one
 * click to the page (task 06c79d8a - "en review widget med antalet i review och snabb
 * navigering dit").
 *
 * Fetches its own tally rather than taking one from the dashboard's data bundle: the
 * review queue is not part of that bundle, and threading it through would couple every
 * dashboard repaint to a board read. Repaints itself, so the numbers cannot sit frozen
 * behind a fingerprint computed from data this widget does not use.
 */
function widgetBodyReview() {
  const wrap = document.createElement("div");
  wrap.className = "wd-review";
  wrap.id = "widgetReviewBody";
  void paintReviewWidget(wrap);
  return wrap;
}

async function paintReviewWidget(el = document.getElementById("widgetReviewBody")) {
  if (!el) {
    return;
  }
  let res = null;
  try {
    // Same reasoning as the badge: this is a summary, not the page, so a recent result
    // is the right trade against blocking the main process on every repaint.
    res = await window.helm.listReviews({ maxAgeMs: 20_000 });
  } catch {
    return; // leave what is there; never blank a count on a hiccup
  }
  // The same rows, filter and tally the Review page uses - not res.tally, which counts the
  // WHOLE queue including everything the page's repo filter holds back. That is how this
  // widget came to say "12 need you" above a page showing one row (task daa4245f).
  const allRows = res?.rows || [];
  const rows = visibleReviewRows(allRows);
  const tally = reviewTallyFromRows(rows);
  const hidden = allRows.length - rows.length;
  const needs = reviewAttentionCount(tally);
  el.textContent = "";

  const head = document.createElement("div");
  head.className = "wd-review-head" + (needs > 0 ? " warn" : "");
  head.textContent = needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : "Nothing waiting";
  const sub = document.createElement("div");
  sub.className = "wd-review-sub";
  // The SAME wording the Review page's own subtitle uses, so the two never describe
  // the same board differently.
  sub.textContent =
    (tally.total || 0) === 0
      ? hidden > 0
        ? `Nothing in a repo is waiting. ${hidden} held back by your filter.`
        : "Move something to review on the Jot board and it lands here."
      : `${tally.stamp || 0} ready to stamp · ${tally.total || 0} in review`;
  el.append(head, sub);

  // What the filter holds back is stated rather than silently missing: the number is real
  // work, and a count that just quietly shrank is the reason the two surfaces disagreed in
  // the first place. Clicking through goes to the page where the toggle lives.
  if (hidden > 0 && (tally.total || 0) > 0) {
    const held = document.createElement("div");
    held.className = "wd-review-sub";
    held.textContent = `${hidden} more held back by your filter`;
    el.append(held);
  }

  // The breakdown, only for the bands that are non-zero - a row of zeroes is noise.
  const BANDS = [
    ["judgment", "need your judgment"],
    ["unconfirmed", "claimed but unconfirmed"],
    ["incomplete", "below the bar"],
    ["unrecorded", "no record at all"],
    ["stamp", "ready to stamp"],
  ];
  for (const [key, label] of BANDS) {
    const n = tally[key] || 0;
    if (n === 0) {
      continue;
    }
    const line = document.createElement("div");
    line.className = "wd-review-line";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "wd-review-val" + (key === "judgment" || key === "unrecorded" ? " warn" : "");
    v.textContent = String(n);
    line.append(l, v);
    el.append(line);
  }

  const go = document.createElement("button");
  go.type = "button";
  go.className = "text-btn";
  go.textContent = "Open review →";
  go.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateToPage("review");
  });
  el.append(go);
}

const WIDGET_BODIES = {
  quota: widgetBodyQuota,
  needsYou: widgetBodyNeedsYou,
  captain: widgetBodyCaptain,
  auto: widgetBodyAuto,
  firstMate: widgetBodyFirstMate,
  docsDrift: widgetBodyDocsDrift,
  review: widgetBodyReview,
};

/**
 * One widget card: a head (drag grip, title, options menu) + the real module in
 * its body. There is NO edit mode: rearranging is always available from the
 * corner grip (the captain: "Arrange - done arranging ska inte behövas"). Only the
 * grip is a drag source, so clicking anything inside a widget still works.
 */
async function widgetEl(widget, data) {
  const spec = WIDGET_CATALOG[widget.type];
  const el = document.createElement("section");
  // A break and a blank are ordinary widget elements with a different skin, NOT a
  // second rendering path - so they inherit the drag, resize and remove wiring
  // below for free and cannot drift away from it.
  el.className = "wd" + (widget.type === "blank" ? " wd-blank" : widget.type === "break" ? " wd-break" : "");
  // Inline custom property, not a class per width - see the note in style.css.
  el.style.setProperty("--wd-span", String(widget.span || spec?.span || 4));
  el.dataset.widgetId = widget.id;
  el.dataset.widgetSpan = String(widget.span || spec?.span || 4);

  const head = document.createElement("div");
  head.className = "wd-head";
  const grip = document.createElement("span");
  grip.className = "wd-grip";
  grip.textContent = "⠿";
  grip.title = "Drag to rearrange";
  grip.draggable = true;
  grip.addEventListener("dragstart", (e) => {
    widgetDragId = widget.id;
    el.classList.add("wd-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", widget.id);
  });
  grip.addEventListener("dragend", () => {
    widgetDragId = null;
    el.classList.remove("wd-dragging");
    document.querySelectorAll(".wd-drop-before, .wd-drop-after").forEach((n) => n.classList.remove("wd-drop-before", "wd-drop-after"));
  });
  head.append(grip);

  const title = document.createElement("span");
  title.className = `wd-title ${spec?.accent || ""}`;
  let label = spec?.label || widget.type;
  if (widget.type === "firstMate") {
    const mate = (data.mates || []).find((m) => m.mateId === widget.mateId);
    label = mate ? `First mate · ${mate.name}` : "First mate";
  }
  title.textContent = label;
  head.append(title);

  // Options live behind one quiet "⋯" so the controls are always reachable
  // without a mode, and without cluttering every head with three controls.
  const opts = document.createElement("button");
  opts.type = "button";
  opts.className = "wd-opts";
  opts.textContent = "⋯";
  opts.title = "Widget options";
  opts.addEventListener("click", async (e) => {
    e.stopPropagation();
    const layout = widgetLayout(data.mates);
    // A row break is always full width - offering it a width picker would be a
    // control that visibly does nothing, which is the bug this task started with.
    const items = widget.type === "break"
      ? []
      : WIDGET_SPANS.map((span) => ({
          label: `${span === 12 ? "Full width" : `Width ${span}/12`}${(widget.span || spec?.span) === span ? " ✓" : ""}`,
          onClick: async () => {
            await saveWidgetLayout(layout.map((w) => (w.id === widget.id ? { ...w, span } : w)));
            await renderDashboardPage();
          },
        }));
    if (widget.type === "needsYou") {
      const next = widget.orientation === "vertical" ? "horizontal" : "vertical";
      items.push({ sep: true }, {
        label: `Lay out ${next}ly`,
        onClick: async () => {
          await saveWidgetLayout(layout.map((w) => (w.id === widget.id ? { ...w, orientation: next } : w)));
          await renderDashboardPage();
        },
      });
    }
    // No leading divider when there is nothing above it (a row break has no width
    // picker, so its menu opened with a stray rule and then one item).
    if (items.length > 0) {
      items.push({ sep: true });
    }
    items.push({
      label: "Remove widget",
      danger: true,
      onClick: async () => {
        await saveWidgetLayout(layout.filter((w) => w.id !== widget.id));
        await renderDashboardPage();
      },
    });
    // Removing the WIDGET leaves the mate on watch; this removes the mate itself.
    // Worded so the difference is unmistakable, and confirmed, because it retires
    // a real coordinator and tears down its second mates.
    if (widget.type === "firstMate" && widget.mateId) {
      const mate = (data.mates || []).find((m) => m.mateId === widget.mateId);
      items.push({
        label: `Dismiss ${mate?.name || "this first mate"} from the fleet`,
        danger: true,
        onClick: () => {
          customConfirm(
            `Dismiss ${mate?.name || "this first mate"}? Its second mates are torn down and it does not respawn. The widget goes too.`,
            "Dismiss",
            async () => {
              const res = await window.helm.removeMate(widget.mateId);
              if (!res?.ok) {
                showToast(res?.error || "Couldn't dismiss that first mate.");
                return;
              }
              await saveWidgetLayout(layout.filter((w) => w.id !== widget.id));
              showToast(`${mate?.name || "First mate"} left the fleet.`);
              await renderDashboardPage();
            },
            { deliberate: true }
          );
        },
      });
    }
    const rect = opts.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, items);
  });
  head.append(opts);
  el.append(head);

  const body = document.createElement("div");
  body.className = "wd-body";
  const build = WIDGET_BODIES[widget.type];
  if (spec?.layoutOnly) {
    body.append(widgetEmpty("Empty on purpose - resize or drag it like any widget."));
  } else if (build) {
    try {
      body.append(await build(data, widget));
    } catch (err) {
      // One failing widget must never blank the whole dashboard.
      body.append(widgetEmpty(`This widget failed to render: ${err.message}`));
    }
  } else {
    body.append(widgetEmpty(`Unknown widget "${widget.type}".`));
  }
  el.append(body);

  // The widget itself is only a DROP target - the grip is the drag source.
  el.addEventListener("dragover", (e) => {
    if (!widgetDragId || widgetDragId === widget.id) {
      return;
    }
    e.preventDefault();
    // Insertion side from the pointer's position within this widget, so the line
    // marks exactly where it will land (same lesson as Jot 67ebdd45).
    const rect = el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    el.classList.toggle("wd-drop-after", after);
    el.classList.toggle("wd-drop-before", !after);
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("wd-drop-before", "wd-drop-after");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    const after = el.classList.contains("wd-drop-after");
    el.classList.remove("wd-drop-before", "wd-drop-after");
    if (!widgetDragId || widgetDragId === widget.id) {
      return;
    }
    const layout = widgetLayout(data.mates);
    const from = layout.findIndex((w) => w.id === widgetDragId);
    if (from === -1) {
      return;
    }
    const moved = layout[from];
    const rest = layout.filter((_, i) => i !== from);
    const at = rest.findIndex((w) => w.id === widget.id);
    if (at === -1) {
      return;
    }
    rest.splice(at + (after ? 1 : 0), 0, moved);
    await saveWidgetLayout(rest);
    await renderDashboardPage();
  });
  return el;
}

/** The "+ Add widget" tile and its picker. Always available (no edit mode). */
function widgetAddTile(data) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "wd-add";
  tile.textContent = "+ Add widget";
  tile.addEventListener("click", (e) => {
    e.stopPropagation();
    const layout = rebindFirstMateWidgets(widgetLayout(data.mates), data.mates).layout;
    const items = [];
    // Which mates a widget already shows, by BINDING rather than by widget id: after a
    // widget adopts a mate its id still carries the retired mate's, so an id check would
    // offer the adopted mate again and put a second widget on the board for it.
    const shown = new Set(layout.filter((w) => w.type === "firstMate").map((w) => w.mateId));
    for (const [type, spec] of Object.entries(WIDGET_CATALOG)) {
      if (spec.perMate) {
        for (const mate of data.mates || []) {
          const id = `w-mate-${mate.mateId}`;
          if (shown.has(mate.mateId) || layout.some((w) => w.id === id)) {
            continue;
          }
          items.push({
            label: `First mate · ${mate.name}`,
            onClick: async () => {
              await saveWidgetLayout([...layout, { id, type: "firstMate", span: spec.span, mateId: mate.mateId }]);
              await renderDashboardPage();
            },
          });
        }
        // The fleet used to be hard-capped at two first mates, so this menu could
        // only ever offer the two that already existed - which read as "the widget
        // dashboard limits me to two" (the captain, 2026-07-28). A first mate is a real
        // coordinator, so ADDING one is a fleet action, not a widget action; it
        // happens here because this is where he went looking for it.
        items.push({
          label: "New first mate…",
          hint: "adds to the fleet",
          onClick: async () => {
            const res = await window.helm.addMate();
            if (!res?.ok) {
              showToast(res?.error || "Couldn't add a first mate.");
              return;
            }
            const added = (res.active || []).find((m) => !(data.mates || []).some((x) => x.mateId === m.mateId));
            if (added) {
              await saveWidgetLayout([...layout, { id: `w-mate-${added.mateId}`, type: "firstMate", span: spec.span, mateId: added.mateId }]);
              showToast(`${added.name} joined the fleet.`);
            }
            await renderDashboardPage();
          },
        });
        continue;
      }
      if (spec.singleton && layout.some((w) => w.type === type)) {
        continue;
      }
      items.push({
        label: spec.label,
        hint: spec.layoutOnly ? "layout only" : undefined,
        onClick: async () => {
          // Non-singletons (blank, break) can appear many times, so the id has to
          // be unique per instance - a fixed `w-<type>` would give two entries the
          // same id and the drag/remove/resize handlers all key on id.
          const id = spec.singleton ? `w-${type}` : `w-${type}-${nextWidgetInstanceId(layout, type)}`;
          await saveWidgetLayout([...layout, { id, type, span: spec.span }]);
          await renderDashboardPage();
        },
      });
    }
    if (items.length === 0) {
      items.push({ label: "Every widget is already on the board", onClick: () => {} });
    }
    const rect = tile.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, items);
  });
  return tile;
}

// Monotonic token so only the newest widget render commits. The render awaits
// IPC and each widget body, so two overlapping calls (a manual toggle plus a
// poll tick) could otherwise interleave - one clearing the page while the other
// was still building, leaving the dashboard blank. Caught while verifying the
// rework: the grid rendered fine in isolation but came up empty under a
// concurrent refresh.
let widgetRenderToken = 0;

/** Builds the whole widget grid into #dashboardPage. */
async function renderWidgetDashboard(page) {
  const token = ++widgetRenderToken;
  // Before reading the layout, so a newly-shipped widget reaches an already-
  // arranged board once (task 0831417b). Best-effort: a failed seed must not stop
  // the dashboard from rendering.
  try {
    await seedNewWidgets();
  } catch {}
  // getSessions is in here for a reason. Every OTHER store this render needs is
  // fetched fresh, but the sessions were read out of renderer memory - and the
  // fleet is DERIVED from sessions (a captain's or auto-captain's session is a
  // derived node, not a binding). So a repaint triggered by the very thing that
  // just created a session rendered without it.
  //
  // That is exactly what "Run one pass" did on 2026-08-02: the pass started a
  // real session, did the work, moved the card - and the Auto widget it repainted
  // immediately afterwards was empty, because the session it was looking for had
  // been created a second earlier in the main process and nobody had asked for it.
  // Same shape as the Captain-widget bug fixed here before: a repaint that reads a
  // store nobody refreshed.
  const [sessionData, matesResult, secondMatesResult, goalsResult, budget] = await Promise.all([
    window.helm.getSessions(),
    window.helm.listMates(),
    window.helm.listSecondMates(),
    window.helm.getJotGoals(),
    window.helm.getOrchestrationBudget?.() ?? Promise.resolve(null),
  ]);
  if (sessionData?.sessions) {
    state.sessions = sessionData.sessions;
  }
  const mates = matesResult?.ok ? matesResult.active : [];
  paintDashboardSubtitle(mates);
  // The SAME derivation the classic Fleet uses. Passing the raw bindings here is
  // what left the Captain widget empty: the captain's own sessions are derived
  // nodes, not bindings, so they only exist after buildFleetModel runs.
  const { secondMates, boardSummary } = await buildFleetModel(
    mates,
    secondMatesResult?.ok ? secondMatesResult.secondMates || [] : []
  );
  await ensurePersonaCatalog();
  const data = {
    mates,
    secondMates,
    boardSummary,
    goalsResult,
    goals: goalsResult?.ok ? goalsResult.goals || [] : [],
    inMotion: dashboardInMotionRows(),
    budget: budget?.ok ? budget.budget : budget,
  };

  const topbar = document.createElement("div");
  topbar.className = "dash-topbar";
  const heading = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "Dashboard";
  // The subtitle that names the first mates on watch (or the cold-start line when
  // none are). paintDashboardSubtitle already runs above; it needs this element to
  // write into - the classic topbar used to own it, and it moved here with the
  // classic layout's removal (task 337895ce) rather than being dropped.
  const sub = document.createElement("div");
  sub.className = "analysis-totals";
  sub.style.marginBottom = "0";
  sub.id = "dashSubtitle";
  heading.append(h2, sub);
  // The "Classic layout" toggle is gone - there is no classic layout to switch to
  // anymore (task 337895ce). Add-widget lives on the grid's own add tile.
  topbar.append(heading);

  const grid = document.createElement("div");
  grid.className = "wd-grid";
  // A first-mate widget adopts a mate on watch when the one it was bound to is gone
  // (task acb34a24). Persisted when it actually happens, so the adoption is stable and
  // the Add-widget menu offers the same answer this render just drew.
  const rebound = rebindFirstMateWidgets(widgetLayout(mates), mates);
  const layout = rebound.layout;
  if (rebound.changed) {
    try {
      await saveWidgetLayout(layout);
    } catch {
      // A failed write must not stop the board from drawing - the widgets below are
      // already pointed at the right mates for this render either way.
    }
  }
  for (const widget of layout) {
    grid.append(await widgetEl(widget, data));
  }
  grid.append(widgetAddTile(data));

  // Commit in ONE swap, and only if this is still the newest render - so the
  // dashboard never shows a half-built or blank state.
  if (token !== widgetRenderToken) {
    return;
  }
  page.replaceChildren(topbar, grid);
  // Now that the topbar (with #dashSubtitle) is on the page, fill the subtitle -
  // the earlier paintDashboardSubtitle ran before this element existed (task
  // 337895ce moved the subtitle onto the widget topbar).
  paintDashboardSubtitle(mates);
}

async function renderDashboardPage() {
  const page = document.getElementById("dashboardPage");
  page.className = "analysis-page dashboard-page";

  // The Dashboard IS the widget grid now - the classic section stack was removed
  // once the widget view had been in daily use (task 337895ce). renderWidgetDashboard
  // commits its own atomic swap, so the page is not cleared here: an overlapping
  // render can't leave it blank.
  await renderWidgetDashboard(page);
}

// Shared between dashboardProposalSessions() below and the sidebar's
// per-row "Archive?" pill (see renderSessionRow / row-orchestrator-tag
// area) so the two lists can never drift on what counts as dismissed.
// A dismissed proposal stays hidden only while the session is unchanged
// since the dismissal ("not now", not "never") - if lastActivityAt has
// moved on, the dismissal is stale and the session is re-proposed.
function isArchiveProposalDismissed(session) {
  const dismissed = state.config.dismissedArchiveProposals || {};
  return dismissed[session.sessionId] === session.lastActivityAt;
}

function dashboardProposalSessions() {
  const hasOpenJotWork = (s) => s.jot && (s.jot.review > 0 || s.jot.inProgress > 0 || s.jot.open > 0);
  const suggestionsEnabled = state.config.archiveSuggestions?.enabled === true;
  if (!suggestionsEnabled) {
    return [];
  }
  const proposalSessions = state.sessions.filter(
    (s) =>
      !s.isArchived &&
      !isHiddenFromHelm(s) &&
      // A first mate is retired (with a handoff), never archived - keep it out
      // of the archive-suggestion pile entirely (the captain 2026-07-11).
      !isOrchestratorSession(s) &&
      // lifecycleState, not raw status (Epic f3d096fa): don't offer a promoted
      // needs-you session (lifecycleState "waiting") for archive (bug 4cd7d592).
      (s.lifecycleState === "idle" || s.lifecycleState === "wrapped") &&
      !hasOpenJotWork(s) &&
      !isArchiveProposalDismissed(s)
  );
  return sortByAttention(proposalSessions);
}

// Goal runs that need attention (errored or escalated/paused) but have no
// row anywhere else - the amber Dashboard-tab badge (updateGoalAttentionBadge)
// flags that *something* needs attention, but previously gave no way to get
// FROM that badge TO the actual run, which lives under Dashboard > Goal. These
// rows are the fix: same needs-you priority as a "waiting" session, clicking
// one just switches to the Goal facet where goalRunDetailEl renders the run.
function dashboardGoalAttentionRuns() {
  // Exclude acknowledged runs so marking one Done actually clears it from the
  // needs-you queue (bug 7328fcba: a failed run stayed as needs-you forever).
  return [...goalRuns.values()].filter((r) => (r.status === "error" || r.escalation) && !isGoalRunAcknowledged(r.goalRunId));
}

// Runs actively working right now (not the attention ones above). Previously
// these had NO Dashboard presence - a run was invisible until it errored or
// escalated - so there was no "it's running" signal (the captain's task 2dd992c8).
// DISPATCHED (crew) runs are excluded: they already show as a live crew row
// under their second mate in the Fleet section right below the queue, so
// listing them here too was pure duplication (flow review P3). A captain-
// launched Direct run (no dispatchedBy) has no crew row, so it stays here - the
// queue is its only live home.
function dashboardRunningRuns() {
  return [...goalRuns.values()].filter((r) => r.status === "running" && !r.escalation && !r.dispatchedBy);
}

// (The former classifierSaysSessionDone gate is gone - every needs-you surface
// now reads session.lifecycleState === "waiting" instead of combining status +
// the done-tag itself. The false-positive-bias logic it encoded lives in the FSM
// projection: a waiting turn stays "waiting" until the classifier is confident
// it's done, at which point it becomes "wrapped". See sessionState.js. Epic f3d096fa.)

function dashboardInMotionRows() {
  const inMotionSessions = state.sessions.filter(
    (s) => !s.isArchived && !isHiddenFromHelm(s) && (s.status === "active" || s.status === "waiting")
  );
  const sessionRows = sortByAttention(inMotionSessions).map((s) => ({
    kind: "session",
    session: s,
    // A first mate that dispatched crew - live, reported-back, OR errored - isn't
    // a click waiting on YOU: any action lives on the crew itself (errored crew
    // get their own needs-you rows below). Keep it out of the "N need a click"
    // count so it doesn't double-flag as "first mate needs input" (bug 9c0c7209).
    // Only a waiting mate with NO crew is a genuine needs-you click. The FSM's
    // `waiting` state already means "turn ended, awaiting input, NOT done" - i.e.
    // status waiting minus the classifier's done verdict - so it replaces the two
    // predicates this used to combine (Epic f3d096fa, reader migration).
    needsAction: s.lifecycleState === "waiting" && !mateCrewWait(firstMateForSession(s)).has,
  }));
  // Attention goal runs (errored/escalated) need a click; running ones are
  // just visibility ("it's working").
  const attentionRunRows = dashboardGoalAttentionRuns().map((run) => ({ kind: "goalRun", run, needsAction: true }));
  const runningRunRows = dashboardRunningRuns().map((run) => ({ kind: "goalRun", run, needsAction: false }));
  // Needs-you first (attention runs + waiting sessions), then working
  // (running runs + active sessions) - same ordering rule the rest of the
  // queue uses, just now including live runs so they're actually visible.
  const all = [...attentionRunRows, ...runningRunRows, ...sessionRows];
  return [...all.filter((r) => r.needsAction), ...all.filter((r) => !r.needsAction)];
}

function dashboardQueueSection() {
  const proposalSessions = dashboardProposalSessions();
  const inMotion = dashboardInMotionRows();
  const suggestionsEnabled = state.config.archiveSuggestions?.enabled === true;

  // Needs-action count: the whole archive group counts as ONE click (the
  // "Archive all" button), not one per proposal - it should read as the
  // small number of distinct decisions actually waiting on you, not the
  // number of individual sessions that happen to share the same decision.
  const waitingSessionCount = inMotion.filter((r) => r.needsAction).length;
  const needsActionCount = (proposalSessions.length > 0 ? 1 : 0) + waitingSessionCount;
  const totalRows = proposalSessions.length + inMotion.length;

  const countLabel = totalRows === 0 ? null : needsActionCount > 0 ? `${needsActionCount} need a click` : "all clear";

  const section = document.createElement("section");
  section.className = "dash-board";
  section.append(
    dashBoardHead("Needs you & in motion", countLabel, "One list, ordered by how much you need to act - nothing here happens without you", {
      urgent: needsActionCount > 0,
    })
  );

  const body = document.createElement("div");
  body.className = "dash-board-body";
  if (totalRows === 0) {
    body.append(
      dashEmpty(
        suggestionsEnabled
          ? "Nothing needs you right now, and nothing is in motion."
          : 'Nothing in motion right now. (Archive suggestions are off - Settings > "Suggest archiving idle sessions".)'
      )
    );
  } else {
    // Grid so the in-motion rows lay across the width (the captain's "kolumnformat för
    // needs you"). The archive-proposal nudge stays a full-width row (spans all
    // columns) - it's a wide, expandable actionable block, not a glance card
    // (the captain: "behåll arkiveringsnudgen som horisontell").
    const grid = document.createElement("div");
    grid.className = "dash-queue-grid";
    if (proposalSessions.length > 0) {
      const group = dashArchiveGroupEl(proposalSessions);
      group.classList.add("dash-queue-fullspan");
      grid.append(group);
    }
    inMotion.forEach((row) => grid.append(row.kind === "goalRun" ? dashGoalRunRowEl(row.run) : dashSessionRowEl(row.session)));
    body.append(grid);
  }
  section.append(body);
  return section;
}

// One collapsed row standing in for every archive proposal. Expands in place
// (no navigation) into the same per-session Archive/Dismiss rows the old
// flat list used, via dashProposeRowEl - "Review" doesn't change what each
// row can do, only whether all of them are shown at once by default.
function dashArchiveGroupEl(proposalSessions) {
  const wrap = document.createElement("div");
  wrap.className = "dash-archive-group";

  const row = document.createElement("div");
  row.className = "dash-queue-row dash-archive-group-row";
  row.append(dashQueueStateIcon("proposal", null));

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = `${proposalSessions.length} session${proposalSessions.length === 1 ? "" : "s"} ready to archive`;
  top.append(title);
  qbody.append(top);
  const why = document.createElement("div");
  why.className = "dash-q-why";
  why.textContent = "No activity, no open Jot work - looks wrapped up. Grouped so real needs-you items stay visible above.";
  qbody.append(why);
  row.append(qbody);

  const actions = document.createElement("div");
  actions.className = "dash-queue-actions";
  const archiveAll = document.createElement("button");
  archiveAll.className = "text-btn";
  archiveAll.textContent = "Archive all";
  archiveAll.addEventListener("click", (e) => {
    e.stopPropagation();
    // Bulk archive does NOT save per-session handoffs (that would be N Sonnet
    // summaries); state it honestly in a one-step confirm. Transcripts survive
    // and each session stays unarchivable/resumable, so nothing is destroyed -
    // just not promoted into the durable layer. To capture a handoff, archive
    // that session individually.
    showContextMenu(e.clientX, e.clientY, [
      {
        label: `Archive all ${proposalSessions.length} (no handoffs saved - bulk)`,
        danger: true,
        onClick: async () => {
          archiveAll.disabled = true;
          for (const session of proposalSessions) {
            await archiveSession(session);
          }
          refreshDashboardIfVisible();
        },
      },
    ]);
  });
  const review = document.createElement("button");
  review.className = "text-btn";
  review.textContent = dashboardArchiveGroupExpanded ? "Hide" : "Review";
  review.addEventListener("click", (e) => {
    e.stopPropagation();
    dashboardArchiveGroupExpanded = !dashboardArchiveGroupExpanded;
    refreshDashboardIfVisible();
  });
  actions.append(archiveAll, review);
  row.append(actions);
  wrap.append(row);

  if (dashboardArchiveGroupExpanded) {
    const expanded = document.createElement("div");
    expanded.className = "dash-archive-group-expanded";
    proposalSessions.forEach((session) => expanded.append(dashProposeRowEl(session)));
    wrap.append(expanded);
  }

  return wrap;
}

function dashQueueStateIcon(kind, session) {
  const ic = document.createElement("div");
  if (kind === "proposal") {
    ic.className = "dash-state-ic dash-state-needs";
    ic.textContent = "\u{1F4C1}"; // folder - archive proposal
    return ic;
  }
  if (kind === "goalRun") {
    // For goalRun the `session` param carries the run. A running run gets the
    // working pulse dot; an errored/escalated one gets the needs-you warning.
    if (session && session.status === "running" && !session.escalation) {
      ic.className = "dash-state-ic dash-state-working";
      const dot = document.createElement("span");
      dot.className = "dash-pulse-dot";
      ic.append(dot);
      return ic;
    }
    ic.className = "dash-state-ic dash-state-needs";
    ic.textContent = "⚠"; // warning - errored/escalated goal run needs you
    return ic;
  }
  if (session.status === "waiting") {
    // A first mate merely awaiting its dispatched crew (live, reported, or
    // errored) isn't waiting on YOUR input - show the calm working dot, not the
    // amber ⚠, so it doesn't read as "needs input" (bug 9c0c7209). Genuine
    // needs-input (a waiting mate with no crew, or a plain session) keeps the ⚠.
    if (!mateCrewWait(firstMateForSession(session)).has) {
      ic.className = "dash-state-ic dash-state-needs";
      ic.textContent = "⚠"; // warning - needs your input
      return ic;
    }
  }
  ic.className = "dash-state-ic dash-state-working";
  const dot = document.createElement("span");
  dot.className = "dash-pulse-dot";
  ic.append(dot);
  return ic;
}

function dashProposeRowEl(session) {
  const row = document.createElement("div");
  row.className = "dash-queue-row";
  row.append(dashQueueStateIcon("proposal", session));

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  if (session.jot?.category) {
    const tag = document.createElement("span");
    tag.className = "dash-goal-tag";
    tag.textContent = session.jot.category;
    top.append(tag);
  }
  const title = document.createElement("span");
  title.className = "dash-q-title";
  // Fleet name, not the raw prompt title, so this row matches the Fleet card for
  // the same session (bug 953bbafb).
  title.textContent = `Archive finished session: "${sessionDisplayName(session)}"`;
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  why.textContent = session.orchestratorTag?.reason || "No activity, no open Jot work - looks wrapped up.";
  qbody.append(why);
  row.append(qbody);

  const actions = document.createElement("div");
  actions.className = "dash-queue-actions";
  const approve = document.createElement("button");
  approve.className = "text-btn";
  approve.textContent = "Archive";
  approve.addEventListener("click", (e) => {
    e.stopPropagation();
    offerArchiveChoice(e.clientX, e.clientY, session, async () => {
      await archiveSession(session);
      refreshDashboardIfVisible();
    });
  });
  const dismiss = document.createElement("button");
  dismiss.className = "text-btn";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", async (e) => {
    e.stopPropagation();
    row.classList.add("dash-resolved");
    state.config = await window.helm.setConfig({
      dismissedArchiveProposals: {
        ...(state.config.dismissedArchiveProposals || {}),
        [session.sessionId]: session.lastActivityAt,
      },
    });
    refreshDashboardIfVisible();
  });
  actions.append(approve, dismiss);
  row.append(actions);
  return row;
}

function dashSessionRowEl(session) {
  const row = document.createElement("div");
  row.className = "dash-queue-row";
  row.addEventListener("click", () => {
    navigateToPage("chat");
    openSessionInPane(session, focusedPaneIndex);
  });
  row.append(dashQueueStateIcon("session", session));

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  // A first-mate session is named after its first prompt once it runs, which is
  // unrecognizable in this queue. Show it as the mate ("1st mate · <name>")
  // instead, and keep the prompt title as context on the why line below.
  const mate = firstMateForSession(session);
  // A second mate is named after its first prompt too, which is unrecognizable
  // here - show it by its fleet name ("2nd mate · <project>") so it matches the
  // Fleet view instead of reading as a different thing (bug 2992bcfd).
  const secondMate = mate ? null : secondMateForSession(session);
  if (mate) {
    const tag = document.createElement("span");
    tag.className = "dash-goal-tag";
    tag.textContent = "1st mate";
    top.append(tag);
  } else if (secondMate) {
    const tag = document.createElement("span");
    tag.className = "dash-goal-tag";
    tag.textContent = "2nd mate";
    top.append(tag);
  } else if (session.jot?.category) {
    const tag = document.createElement("span");
    tag.className = "dash-goal-tag";
    tag.textContent = session.jot.category;
    top.append(tag);
  }
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = sessionDisplayName(session);
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  const bits = [session.model ? session.model.replace("claude-", "") : "model unknown", relTime(session.lastActivityAt)];
  // Note: context-budget + worktree path are intentionally omitted until that
  // telemetry is actually wired - a placeholder suffix here read as clutter.
  // For a first-mate session, keep the prompt-derived title as context here so
  // its identity (title above) and topic (here) are both legible.
  const contextTitle = mate && session.title && session.title !== mate.name ? `${session.title} · ` : "";
  // A first mate that dispatched crew and is waiting isn't blocked on YOUR input
  // (bug 9c0c7209) - it's awaiting its crew's outcome. Read a calm crew state,
  // never the alarming "Waiting on you / needs input", even when crew errored
  // (the errored crew surface as their OWN needs-you rows + under the 2nd mate,
  // so re-flagging the first mate as "needs input" was misleading - "nothing I
  // can do here"). Only a mate with NO crew reads as a genuine needs-input.
  const cw = mate ? mateCrewWait(mate) : { has: false };
  const isWaiting = session.status === "waiting";
  const crewLabel = cw.live ? "waiting on crew" : cw.alarm ? "crew needs a decision" : cw.reports ? "reports ready" : null;
  const waitPrefix = isWaiting
    ? crewLabel
      ? crewLabel.charAt(0).toUpperCase() + crewLabel.slice(1) + " · "
      : "Waiting on you · "
    : "";
  why.textContent = waitPrefix + contextTitle + bits.join(" · ");
  qbody.append(why);
  row.append(qbody);

  if (isWaiting) {
    const meta = document.createElement("div");
    meta.className = "dash-q-meta" + (crewLabel ? " crew" : "");
    meta.textContent = crewLabel || "needs input";
    row.append(meta);
  }

  return row;
}

// Row for a goal run that needs attention (errored or escalated), rendered
// alongside the session rows above. Same .dash-queue-row/.dash-q-* shell as
// dashSessionRowEl; clicking just switches to the Goal facet (navigateToPage)
// where goalRunDetailEl already renders the run itself, with its own attention
// accent (see .goal-run-detail-attention in style.css) making it easy to spot.
function dashGoalRunRowEl(run) {
  const row = document.createElement("div");
  row.className = "dash-queue-row";
  row.addEventListener("click", () => navigateToPage("goal"));
  row.append(dashQueueStateIcon("goalRun", run));

  const isRunning = run.status === "running" && !run.escalation;

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  const goalSnippet = run.goal.length > 60 ? run.goal.slice(0, 60) + "…" : run.goal;
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = isRunning
    ? `Autopilot run "${goalSnippet}" - working`
    : run.status === "error"
      ? `Autopilot run "${goalSnippet}" - failed`
      : `Autopilot run "${goalSnippet}" - paused, needs you`;
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  if (isRunning) {
    const n = run.iterations?.length || 0;
    const phase = n > 0 ? run.iterations[n - 1]?.phase : null;
    why.textContent = n > 0 ? `Iteration ${n}${phase ? ` (${phase})` : ""} - running in an isolated worktree.` : "Starting - running in an isolated worktree.";
  } else {
    why.textContent = run.status === "error" ? run.error || "Run ended with an error." : "Escalated - waiting on your input.";
  }
  qbody.append(why);
  row.append(qbody);

  const meta = document.createElement("div");
  meta.className = "dash-q-meta";
  meta.textContent = isRunning ? "running" : "needs input";
  row.append(meta);

  // A terminal attention run (errored/escalated) needs a way to be cleared right
  // here - a failed run with no worktree had no Done affordance on either surface
  // and got stuck as needs-you (bug 7328fcba). reportRowDoneBtn handles the no-
  // worktree case as a plain acknowledge; a running run uses Cancel, not Done.
  if (!isRunning) {
    row.append(reportRowDoneBtn(run));
  }

  return row;
}

// --- Report-back -----------------------------------------------------------
// Orchestration-model phase 2 ("Structured report-back"): a dispatched/autopilot
// run should report a COMPACT result up to the Dashboard - status, one-line what
// changed, whether it needs the captain - so results are visible without opening
// each run's worktree or expanding the Fleet tree.
//
// The queue above ("Needs you & in motion") already surfaces LIVE runs (running)
// and act-now attention runs (errored/escalated). The gap this fills is the
// FINISHED run: a run that completed cleanly with commits to review had no
// compact Dashboard presence at all - it lived only as a collapsed crew node
// under a second mate in the Fleet tree. This section is the consolidated
// "what came back" view over every TERMINAL run (done, escalated, errored,
// interrupted), newest first, each rendered as one compact report row.

// Compact report derived from a goalRuns entry, deliberately mirroring main.js's
// buildDispatchReport (same three load-bearing fields: status / summary /
// needsCaptain) so the Dashboard report matches what a dispatched run writes
// back to its first mate. Renderer-side + read-only over goalRuns - it invents
// no new data and never touches the orchestrator.
function goalRunReport(run) {
  const escalated = !!run.escalation;
  const commitCount = crewCommitCount(run);
  const branchName = run.result?.branchName || null;
  // The run's own verify command, if it had one. Read only by the goal_reached outcome, to
  // say whether "it is done" was checked by anything. Both spellings, because a live run
  // carries it on its result and a rehydrated one on the record itself.
  const verifyCommand = run.result?.verifyCommand || run.verifyCommand || null;
  // Newest implement-phase iteration's own one-sentence summary is the honest
  // "what changed" line (same source buildDispatchReport uses). Rehydrated runs
  // carry no iteration list, so this is absent for them and we fall back below.
  const lastImplement = [...(run.iterations || [])]
    .reverse()
    .find((r) => r.ok && r.result && r.phase === "implement");

  if (run.status === "error") {
    return {
      status: "errored",
      changed: run.error || "The run ended with an error.",
      needsCaptain: "Errored - inspect and re-dispatch.",
      commitCount,
      branchName,
    };
  }
  if (run.status === "interrupted") {
    return {
      status: "interrupted",
      changed: "Interrupted by an app restart - outcome unknown.",
      needsCaptain: "Check the worktree/branch on disk for what it left behind.",
      commitCount,
      branchName,
    };
  }
  if (escalated) {
    const detail = run.escalation?.detail || "Run paused for a human decision.";
    return { status: "paused", changed: detail, needsCaptain: detail, commitCount, branchName };
  }
  // The loop ended without crashing - which is NOT the same as reaching the goal, and used
  // to be reported as though it were. This branch returned status "done" for every
  // stoppedReason, so a run that died after failing twice in a row drew a green check and,
  // with nothing committed, a null needsCaptain - meaning it never bubbled up to the
  // captain's board either. Measured on the skiff board 2026-08-18: 22 of 23 runs shown
  // as done, none of which had reached its goal.
  //
  // MIRROR of classifyRunOutcome in src/lib/runOutcome.js - the renderer is a classic
  // script and cannot import an ES module (same constraint as MODEL_MENU_OPTIONS and
  // WORKING_LIFECYCLE_STATES). test-run-outcome-truthful.mjs asserts the two vocabularies
  // stay in step, because a mirror nobody checks is how three copies of this drifted apart.
  const reason = run.result?.stoppedReason || null;
  const ready = commitCount > 0 ? `${commitCount} commit${commitCount === 1 ? "" : "s"} ready for review${branchName ? ` in ${branchName}` : ""}.` : null;
  const OUTCOMES = {
    // The one successful outcome, and therefore the one that raises NO alarm.
    // `needs` is an alarm - something went wrong, or something critical wants a
    // decision - and until 2026-08-20 this branch put "N commits ready for review"
    // there, so every clean run counted toward the needs-you tally and the queue
    // flagged everything. The commits are still announced, on `waiting` instead.
    // The only reason that means FINISHED rather than merely over (2026-08-21). Mirrored
    // from src/lib/runOutcome.js, which this classic script cannot import;
    // test-run-outcome-truthful pins the two copies against each other.
    goal_reached: commitCount
      ? {
          status: "done",
          // Two different things reach this outcome and must not read the same: a run whose
          // own check passed on the result, and a run that simply said so. Neither is an
          // alarm; only one of them was checked by anything.
          why: verifyCommand
            ? `Finished: the goal is met and its own check passed (${verifyCommand}).`
            : "Finished: it says the goal is met. Nothing checked that.",
          needs: null,
          waiting: ready,
        }
      : {
          status: "no_changes",
          why: "Reports the goal is met, but committed nothing.",
          needs: "It says the goal is met and changed no files. Check whether it was already met, or whether it decided that wrongly.",
        },
    no_op_convergence: commitCount
      ? { status: "done", why: "Converged: it stopped making further changes.", needs: null, waiting: ready }
      : { status: "no_changes", why: "Stopped without changing anything - either the goal was already met, or it was stuck.", needs: "Finished without committing anything. Check whether the goal was already met or the run was stuck." },
    two_consecutive_failures: { status: "failed", why: "Stopped after two iterations failed in a row - it did NOT reach the goal.", needs: ready || "Failed twice in a row and committed nothing." },
    max_iterations_reached: { status: "incomplete", why: "Ran out of iterations before reaching the goal.", needs: ready || "Hit its iteration cap and committed nothing." },
    quota_exhausted: { status: "interrupted", why: "Stopped early: the token quota ran out. This run is resumable.", needs: ready || "Ran out of quota before finishing - resume it." },
    cancelled: { status: "cancelled", why: "Cancelled before it finished.", needs: ready || "Cancelled before finishing." },
  };
  const outcome = OUTCOMES[reason] || {
    status: "unknown",
    why: `Stopped for an unrecognised reason${reason ? ` (${reason})` : ""}.`,
    needs: `Stopped for a reason Helm does not recognise${reason ? ` (${reason})` : ""} - check the worktree.`,
  };
  // The last implement step's own line is useful detail but must never stand alone as the
  // verdict: for a run that died it describes the last thing that WORKED.
  const step = lastImplement?.result?.summary || null;
  const changed = outcome.status === "done" ? step || `${commitCount} commit${commitCount === 1 ? "" : "s"} landed.` : step ? `${outcome.why} Last completed step: ${step}` : outcome.why;
  return {
    status: outcome.status,
    changed,
    needsCaptain: outcome.needs,
    // Landed work nobody has read yet. Not an alarm, and not discarded either -
    // unreviewed commits have no other surface, and 117 of them reached
    // skiff's master unread.
    awaitingReview: outcome.waiting || null,
    commitCount,
    branchName,
  };
}

// A run has reached a terminal state (its outcome is final, ready to report).
function isTerminalRun(r) {
  return r.status === "done" || r.status === "error" || r.status === "interrupted";
}
// The captain has marked this run "done" from a report-back row - it drops off
// the report-back glance surfaces (but stays in history + on the Goal page).
function isGoalRunAcknowledged(id) {
  return (state.config?.acknowledgedGoalRuns || []).includes(id);
}
// Does this terminal run need the captain personally? An ALARM only: an
// escalation/pause, an error, a run that gave up or ran out of iterations, or an
// interrupted run of unknown outcome. This is the signal that bubbles a
// mate-dispatched run UP to the captain's board.
//
// A SUCCESSFUL run with commits deliberately does NOT count any more. It used to,
// and the comment here used to say "commits to review" first - which is how the
// board came to flag everything, and a board that flags everything is one nobody
// reads. Those commits are now carried on `awaitingReview` and belong on a quiet
// list, not in the alarm queue.
function runNeedsCaptain(r) {
  return !!goalRunReport(r).needsCaptain;
}
// Terminal runs dispatched by a given owner, newest-first. ownerId === null
// means captain/Autopilot-initiated (no dispatching mate).
function terminalRunsBy(ownerId) {
  return [...goalRuns.values()]
    .filter(isTerminalRun)
    .filter((r) => !isGoalRunAcknowledged(r.goalRunId))
    .filter((r) => (ownerId === null ? !r.dispatchedBy : r.dispatchedBy === ownerId))
    .sort((a, b) => (b.ordinal || 0) - (a.ordinal || 0));
}

// Terminal-run report rows are capped so a mate's roll-up stays a compact
// glance rather than an ever-growing history (the Goal page is the full log).
// Also reused by pendingTriageNudge. There is no separate captain Report-back
// section anymore - reports live under their dispatcher (fleetMateReportRollupEl)
// and escalations surface in the Needs-you queue (the captain 2026-07-11).
const REPORT_BACK_LIMIT = 6;

// One compact report row. Reuses the queue-row structure/classes so it reads as
// part of the same Dashboard system. Clicking jumps to the Goal page (same as a
// queue goal-run row), where goalRunDetailEl renders the full run + worktree
// actions.
// Mark a run "done" from a report-back row: soft-acknowledge it (drops it from
// the report-back glance surfaces, keeps it in history + on the Goal page).
// Mirrors acknowledgedSessions. Force-refresh so BOTH the Dashboard report and
// the fleet card roll-up repaint (the fleet fingerprint doesn't track ack
// state, so a plain refresh wouldn't rebuild the roll-up).
async function acknowledgeGoalRun(goalRunId) {
  const acked = [...new Set([...(state.config.acknowledgedGoalRuns || []), goalRunId])];
  state.config = await window.helm.setConfig({ acknowledgedGoalRuns: acked });
  // Also drop it from the unseen-attention set + badge, so acknowledging an
  // errored/escalated run actually clears its "needs you" everywhere, not just
  // the report glance (bug 7328fcba: a failed run stayed as needs-you).
  unseenGoalAttention.delete(goalRunId);
  updateGoalAttentionBadge();
  await fillDashboardSections({ force: true });
}

// A run's worktree/branch live under `.result` on a live Goal-page run, but at
// the TOP LEVEL on a rehydrated/dispatched history record (the shape the fleet
// crew rows carry). Read both, or the crew-row "Done" never offers to clean the
// worktree and dispatched runs' worktrees orphan (the captain: "4 worktrees I don't
// know what to do with").
function runWorktreePath(run) {
  return run?.result?.worktreePath || run?.worktreePath || null;
}
function runBranchName(run) {
  return run?.result?.branchName || run?.branchName || null;
}

// "Done + clean up": remove the run's worktree and delete its branch, but only
// when the branch is merged (unmerged branches are kept - see goal:cleanupRun).
// Returns true when cleanup succeeded (fully, or as far as it safely could -
// e.g. an unmerged branch kept is still a success). Returns false on a hard
// failure (e.g. worktree removal refused on uncommitted changes) so the caller
// can leave the row in place for a retry instead of acknowledging a no-op.
async function cleanupGoalRunWorktree(run) {
  const res = await window.helm.cleanupGoalRun({
    projectPath: run.projectPath,
    worktreePath: runWorktreePath(run),
    branchName: runBranchName(run),
  });
  if (!res || !res.ok) {
    showToast(`Cleanup failed: ${res?.error || "unknown error"}. The worktree was kept - remove it by hand if needed.`);
    return false;
  }
  if (res.note) {
    showToast(res.note);
  } else if (res.branchDeleted) {
    showToast(`Cleaned up the worktree + deleted merged branch "${runBranchName(run)}".`);
  } else if (res.worktreeRemoved) {
    showToast("Cleaned up the worktree.");
  }
  return true;
}

// The report-row "Done" control. No worktree -> a plain acknowledge. With a
// worktree -> a small choice: acknowledge + clean up (worktree + gated branch
// delete), or acknowledge and keep the worktree. Never a native dialog.
function reportRowDoneBtn(run) {
  const btn = document.createElement("button");
  btn.className = "dash-report-done";
  btn.textContent = "Done";
  const worktreePath = runWorktreePath(run);
  // Set expectations up front (flow review P3): "Done" acknowledges the run and
  // KEEPS its worktree by default. A run that left a worktree gets an explicit
  // keep-vs-remove choice on click; one that didn't is a plain acknowledge.
  btn.title = worktreePath
    ? "Mark this run done - you'll choose to keep or remove its worktree"
    : "Mark this run done (clears it from report-back)";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!worktreePath) {
      acknowledgeGoalRun(run.goalRunId);
      return;
    }
    showContextMenu(e.clientX, e.clientY, [
      {
        // Primary + safe: pure acknowledge, no git. Never errors - clears the
        // report from the glance and leaves the worktree/branch on disk for a
        // manual merge/review. This is the non-trapping default (the previous
        // menu led with the worktree-removal option, which fail-closes on an
        // uncommitted/dirty worktree and then refused to acknowledge at all -
        // the "Done errors because it's uncommitted" trap).
        label: "Done (keep worktree)",
        onClick: () => acknowledgeGoalRun(run.goalRunId),
      },
      {
        label: "Done + remove worktree",
        onClick: async () => {
          // Try the cleanup, but acknowledge REGARDLESS: "Done" is the captain
          // asserting this run is handled, so a cleanup failure (e.g. a dirty
          // worktree) must not trap the run in the glance. cleanupGoalRunWorktree
          // already toasts why it kept the worktree; the commits are what matter,
          // the worktree is scratch.
          await cleanupGoalRunWorktree(run);
          await acknowledgeGoalRun(run.goalRunId);
        },
      },
    ]);
  });
  return btn;
}

function dashReportRowEl(run) {
  const report = goalRunReport(run);
  const row = document.createElement("div");
  row.className = "dash-queue-row" + (report.needsCaptain ? " dash-report-needs" : "");
  // Whole row is the click target and it deep-links INTO this autopilot run's
  // detail (scroll + highlight), not just to the goal list (bug 9f957394).
  row.addEventListener("click", () => openGoalRun(run.goalRunId));

  // Left icon: needs-you warning when the captain must act; a done check
  // otherwise. Own markup (dashQueueStateIcon's goalRun path assumes a live/
  // attention run, not a clean finish) but the same .dash-state-* tokens.
  const ic = document.createElement("div");
  ic.className = "dash-state-ic " + (report.needsCaptain ? "dash-state-needs" : "dash-state-done");
  ic.textContent = report.needsCaptain ? "⚠" : "✓";
  row.append(ic);

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  const goalSnippet = run.goal.length > 60 ? run.goal.slice(0, 60) + "…" : run.goal;
  const title = document.createElement("span");
  title.className = "dash-q-title";
  const origin = run.dispatchedBy ? "Dispatched" : "Autopilot";
  title.textContent = `${origin}: "${goalSnippet}" - ${report.status}`;
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  // "What changed" one-liner; append the needs-captain nudge when it adds info
  // beyond the change line itself (e.g. the commit-review count).
  why.textContent =
    report.needsCaptain && report.needsCaptain !== report.changed
      ? `${report.changed} · ${report.needsCaptain}`
      : report.changed;
  qbody.append(why);
  row.append(qbody);

  const meta = document.createElement("div");
  meta.className = "dash-q-meta";
  meta.textContent = report.needsCaptain ? "needs you" : report.commitCount > 0 ? `${report.commitCount} commit${report.commitCount === 1 ? "" : "s"}` : "done";
  row.append(meta);

  row.append(reportRowDoneBtn(run));

  return row;
}

// Repo chips get a folder icon; a registered life-domain project gets its own. The icon is
// also how dashAutoContextStripEl tells the two kinds apart.
const REPO_CHIP_ICON = "\u{1F4C1}"; // folder

// Local UI state for the archive-suggestion group, reset on reload.
let dashboardArchiveGroupExpanded = false;



// Minimal "register a new domain" flow. Folder comes from the native picker
// (which can also create a new folder); the name defaults to the folder's
// basename and is confirmed/renamed via the same inline-editable text input
// used everywhere else in the sidebar (makeInlineEditable) rather than
// window.prompt() - a documented-unreliable native dialog in this Electron
// build (see the Category CRUD comment above). Kept intentionally simple per
// the task's "keep it simple" - no dedicated modal/form. A domain's
// CLAUDE.md is optional, so nothing here requires or creates one.
//
// "+ other..." vs "+ new domain..." reads as two buttons doing the same
// thing (a folder picker) unless you already know a domain is a PERSISTENT,
// non-repo project (gym, kombucha, ...) while "other" is a one-off pick for
// this session only. Guard here so picking an already-known repo folder
// (the mistake that's easy to make - "I just wanted to use Helm's own
// folder") doesn't silently create a permanent, confusing duplicate chip
// with no obvious way back - point at "+ other..." instead.
async function promptRegisterDomain() {
  const folder = await window.helm.pickDomainFolder();
  if (!folder) {
    return;
  }
  const knownRepos = [...new Set(state.sessions.filter((s) => s.cwd).map((s) => s.cwd))];
  if (knownRepos.some((repo) => samePath(repo, folder))) {
    showToast('That folder is already a project - use "+ other..." instead of "+ new domain...".');
    return;
  }
  const defaultName = folder.split(/[\\/]/).filter(Boolean).pop() || folder;

  // Render a temporary chip holding the inline-edit input so the flow stays
  // visually consistent with the chip grid instead of popping a dialog.
  const chipGrid = document.querySelector(".dash-chip-grid");
  if (!chipGrid) {
    return;
  }
  const placeholder = document.createElement("span");
  placeholder.textContent = defaultName;
  const tempChip = document.createElement("div");
  tempChip.className = "dash-chip";
  tempChip.append(placeholder);
  chipGrid.append(tempChip);

  makeInlineEditable(placeholder, defaultName, async (finalName) => {
    tempChip.remove();
    if (!finalName) {
      return;
    }
    const result = await window.helm.registerDomain({ name: finalName, path: folder });
    if (!result.ok) {
      showToast(result.error || "Couldn't register domain.");
      return;
    }
    dashboardSelectedChip = result.domain.path;
    fillDashboardSections();
  });
}


// --- Shared small pieces ----------------------------------------------

// One board-header builder (was two near-identical fns). `count` may be a
// number (shown always, incl "0") or a string label (shown when truthy);
// null/undefined hides the pill. opts.urgent tints it.
function dashBoardHead(title, count, hint, { urgent = false } = {}) {
  const head = document.createElement("div");
  head.className = "dash-board-head";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const label = typeof count === "number" ? String(count) : count || null;
  if (label != null) {
    const c = document.createElement("span");
    c.className = "dash-count" + (urgent ? " dash-count-urgent" : "");
    c.textContent = label;
    h3.append(c);
  }
  const hintEl = document.createElement("span");
  hintEl.className = "dash-hint";
  hintEl.textContent = hint;
  head.append(h3, hintEl);
  return head;
}

function dashEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "pane-empty";
  empty.textContent = text;
  return empty;
}

/**
 * One line on the Autopilot page saying what the last housekeeping sweep did,
 * and - the part that matters - what it deliberately did NOT clean, with the
 * reason for each.
 *
 * A sweep that reported only its successes would read as "everything is tidy"
 * while an unmerged branch sat there forever, which is the exact failure this
 * whole feature exists to fix (three of them accumulated unseen until the captain
 * found them by hand). So the kept items are the prominent half, and "Sweep
 * now" is here because a stale report you cannot refresh is not information.
 */
function housekeepingLineEl() {
  const wrap = document.createElement("div");
  wrap.className = "goal-housekeeping";

  const line = document.createElement("div");
  line.className = "goal-housekeeping-line";
  wrap.append(line);

  const sweepBtn = document.createElement("button");
  sweepBtn.type = "button";
  sweepBtn.className = "text-btn";
  sweepBtn.textContent = "Sweep now";
  sweepBtn.title =
    "Remove finished runs' worktrees and delete Helm branches that are fully merged. Never touches uncommitted work, an unmerged branch, or a branch you made yourself.";

  const paint = (report, { pending = false } = {}) => {
    line.innerHTML = "";
    if (!report) {
      // "Checking" while the report is still in flight, NOT "no sweep has run
      // yet" - the startup sweep has almost always already run by the time this
      // renders, and a placeholder that states the opposite is a lie the user has
      // no way to tell from the truth. Only say a sweep is missing once we know.
      line.append(
        document.createTextNode(pending ? "Housekeeping: checking… " : "Housekeeping: no sweep has run yet. ")
      );
      line.append(sweepBtn);
      return;
    }
    const removedWt = (report.removed || []).filter((r) => r.kind === "worktree").length;
    const removedBr = (report.removed || []).filter((r) => r.kind === "branch").length;
    const bits = [];
    if (removedWt) {
      bits.push(`removed ${removedWt} finished worktree${removedWt === 1 ? "" : "s"}`);
    }
    if (removedBr) {
      bits.push(`deleted ${removedBr} merged branch${removedBr === 1 ? "" : "es"}`);
    }
    line.append(document.createTextNode(`Housekeeping: ${bits.length ? bits.join(", ") : "nothing to clean"}. `));
    line.append(sweepBtn);

    const kept = report.kept || [];
    const failed = report.failed || [];
    if (kept.length || failed.length) {
      const details = document.createElement("details");
      details.className = "tool-group";
      const summary = document.createElement("summary");
      summary.textContent = `Kept ${kept.length}${failed.length ? ` · ${failed.length} could not be removed` : ""}`;
      details.append(summary);
      const list = document.createElement("div");
      list.className = "goal-housekeeping-kept";
      for (const item of [...kept, ...failed]) {
        const row = document.createElement("div");
        // Path-tail only: the full worktree path made an earlier menu unusable
        // (bug 58bb6ca7), and the tail is what identifies the run.
        const name = String(item.target || "").split(/[\\/]/).filter(Boolean).pop() || item.target;
        row.textContent = `${item.kind === "branch" ? "branch" : "worktree"} ${name} - ${item.reason}`;
        row.title = item.target;
        list.append(row);
      }
      details.append(list);
      wrap.append(details);
    }
  };

  sweepBtn.addEventListener("click", async () => {
    sweepBtn.disabled = true;
    sweepBtn.textContent = "Sweeping…";
    const res = await window.helm.sweepWorktrees();
    sweepBtn.disabled = false;
    sweepBtn.textContent = "Sweep now";
    if (!res?.ok) {
      showToast(`Housekeeping failed: ${res?.error || "unknown"}`);
      return;
    }
    paint(res.report);
    showToast(`Housekeeping: ${(res.report?.removed || []).length} removed, ${(res.report?.kept || []).length} kept.`);
    renderGoalPage();
  });

  // The startup sweep's report, fetched without blocking the page render.
  paint(null, { pending: true });
  window.helm
    .getWorktreeSweepReport()
    // `pending` means the first sweep is scheduled but has not fired yet (it is
    // deliberately deferred off the startup path). Saying "no sweep has run yet"
    // then would be a lie with a several-second window.
    .then((res) => paint(res?.report || null, { pending: Boolean(res?.pending) }))
    .catch(() => paint(null));
  return wrap;
}

function renderGoalPage() {
  const page = document.getElementById("goalPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Autopilot";
  page.append(header);

  const intro = document.createElement("div");
  intro.className = "analysis-totals";
  intro.textContent =
    "Describe what you want done and in which project - the crew settings (how to verify, how many iterations, model) are filled in for you, and you approve before it runs (open Advanced to override any of them). It works through fresh autonomous claude iterations in an isolated git worktree, commits each successful step, and never pushes or merges - the work is left for you to review. Several runs can go at once.";
  page.append(intro);
  page.append(housekeepingLineEl());

  // ---- Launcher form: starts a NEW run (several may run concurrently) ----
  const form = document.createElement("div");
  form.className = "goal-form";

  const goalLabel = document.createElement("label");
  goalLabel.className = "goal-field-label";
  goalLabel.textContent = "Goal";
  const goalInput = document.createElement("textarea");
  goalInput.className = "goal-textarea";
  goalInput.placeholder = "Describe the goal for the autonomous run…";
  goalInput.rows = 4;

  const cwdLabel = document.createElement("label");
  cwdLabel.className = "goal-field-label";
  cwdLabel.textContent = "Project folder";
  const cwdRow = document.createElement("div");
  cwdRow.className = "goal-cwd-row";
  const cwdInput = document.createElement("input");
  cwdInput.type = "text";
  cwdInput.className = "cwd-input";
  cwdInput.placeholder = "Repo folder to run the goal against";
  // Default to the focused pane's cwd when it has one — matching the composer's
  // own rooting default so the common case needs no folder pick.
  cwdInput.value = panes[focusedPaneIndex]?.cwd || "";
  const pickBtn = document.createElement("button");
  pickBtn.className = "icon-btn";
  pickBtn.textContent = "…";
  pickBtn.title = "Pick project folder";
  pickBtn.addEventListener("click", async () => {
    const folder = await window.helm.pickFolder();
    if (folder) {
      cwdInput.value = folder;
      await suggestVerifyCommandFor(folder);
    }
  });
  cwdRow.append(cwdInput, pickBtn);

  const iterLabel = document.createElement("label");
  iterLabel.className = "goal-field-label";
  iterLabel.textContent = "Max iterations";
  const iterInput = document.createElement("input");
  iterInput.type = "number";
  iterInput.className = "goal-iter-input";
  iterInput.min = "1";
  iterInput.max = "20";
  iterInput.value = 5;

  // Model + effort for the autonomous iterations. "Auto" leaves it to the CLI's
  // own default (runGoal treats undefined as "no override"). Reuses the exact
  // dropdownPill component + option lists the composer uses, for consistency.
  const modelEffortLabel = document.createElement("label");
  modelEffortLabel.className = "goal-field-label";
  modelEffortLabel.textContent = "Model / effort (optional)";
  const modelEffortRow = document.createElement("div");
  modelEffortRow.className = "goal-cwd-row goal-model-row";
  const modelDD = dropdownPill("auto", modelMenuWithAuto(), () => {});
  const effortDD = dropdownPill(
    "auto",
    [
      { value: "auto", label: "Auto" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" },
    ],
    () => {}
  );
  modelEffortRow.append(modelDD.el, effortDD.el);

  const verifyLabel = document.createElement("label");
  verifyLabel.className = "goal-field-label";
  verifyLabel.textContent = "Verify command (optional)";
  const verifyInput = document.createElement("input");
  verifyInput.type = "text";
  verifyInput.className = "goal-verify-input";
  verifyInput.placeholder = "e.g. npm test or npm run build";
  verifyInput.value = "";
  const verifyHint = document.createElement("div");
  verifyHint.className = "goal-field-hint";
  verifyHint.textContent =
    "Runs after each iteration; the change is only kept if this passes.";

  // Auto-suggest a default the first time a project folder is picked/typed:
  // "npm test" if package.json has a test script, else "npm run build" if it
  // has a build script, else leave the field empty. Only prefills an EMPTY
  // field - never overwrites something the user already typed/edited.
  async function suggestVerifyCommandFor(folder) {
    if (!folder || verifyInput.value.trim()) {
      return;
    }
    const res = await window.helm.suggestVerifyCommand(folder);
    if (res && res.ok && res.command && !verifyInput.value.trim()) {
      verifyInput.value = res.command;
    }
  }
  if (cwdInput.value.trim() && !verifyInput.value.trim()) {
    suggestVerifyCommandFor(cwdInput.value.trim());
  }
  cwdInput.addEventListener("change", () => {
    suggestVerifyCommandFor(cwdInput.value.trim());
  });

  // Point 12 Phase-0 escalation (opt-in, default OFF, mirrors verifyCommand's
  // own opt-in shape) — a checkbox rather than a field of thresholds, since
  // Phase-0 is deliberately "free Tier-1 signals with sane defaults", not a
  // tuning panel. Checking it sends `escalationConfig: {}` on goal:run, which
  // enables escalation with all of goalOrchestrator.js's defaults.
  const escalateRow = document.createElement("label");
  escalateRow.className = "settings-toggle-row goal-escalate-row";
  const escalateCheckbox = document.createElement("input");
  escalateCheckbox.type = "checkbox";
  escalateCheckbox.checked = goalEscalateOnTrouble;
  escalateCheckbox.addEventListener("change", () => {
    goalEscalateOnTrouble = escalateCheckbox.checked;
  });
  const escalateText = document.createElement("div");
  escalateText.className = "settings-toggle-text";
  const escalateTitle = document.createElement("div");
  escalateTitle.className = "settings-toggle-title";
  escalateTitle.textContent = "Escalate on trouble";
  const escalateDesc = document.createElement("div");
  escalateDesc.className = "settings-toggle-desc";
  escalateDesc.textContent =
    "Pause the run for you to review instead of continuing blind, when it repeats the same verify failure, reports an ambiguity it can't resolve, an iteration's cost spikes, or several iterations in a row land no new commits.";
  escalateText.append(escalateTitle, escalateDesc);
  escalateRow.append(escalateCheckbox, escalateText);

  const err = document.createElement("div");
  err.className = "goal-error";

  const actionRow = document.createElement("div");
  actionRow.className = "goal-action-row";
  const startBtn = document.createElement("button");
  startBtn.className = "goal-start-btn";
  startBtn.textContent = "Start Autopilot run";
  startBtn.addEventListener("click", async () => {
    const goal = goalInput.value.trim();
    const projectPath = cwdInput.value.trim();
    err.textContent = "";
    if (!goal) {
      err.textContent = "Enter a goal first.";
      return;
    }
    if (!projectPath) {
      err.textContent = "Pick a project folder first.";
      return;
    }
    // C2: a project-rooted pass reads the repo + the goal and PROPOSES the crew
    // config (a lightweight "second mate" translating intent), so verify /
    // iterations aren't hand-set. It populates the (Advanced) fields; a manual
    // Advanced override still wins below.
    const busy = showBusyToast("Reading the project to set up the run…");
    startBtn.disabled = true;
    let rationale = "";
    let proposedModel = "";
    let proposedEffort = "";
    try {
      const res = await window.helm.proposeAutopilotConfig(projectPath, goal);
      const c = res && res.ok ? res.config : null;
      if (c) {
        if (c.verifyCommand && !verifyInput.value.trim()) {
          verifyInput.value = c.verifyCommand;
        }
        if (c.maxIterations) {
          iterInput.value = c.maxIterations;
        }
        escalateCheckbox.checked = !!c.escalate;
        goalEscalateOnTrouble = !!c.escalate;
        rationale = c.rationale || "";
        proposedModel = c.model || "";
        proposedEffort = c.effort || "";
      }
    } catch {
      // fall through to defaults - the run can still start
    }
    busy.done();
    startBtn.disabled = false;

    // Read the (now-populated) config; a manual Advanced pick wins over the proposal.
    const maxIterations = parseInt(iterInput.value, 10) || 5;
    const verifyCommand = verifyInput.value.trim();
    const model = modelDD.value !== "auto" ? modelDD.value : proposedModel || undefined;
    const effort = effortDD.value !== "auto" ? effortDD.value : proposedEffort || undefined;
    const escalationConfig = escalateCheckbox.checked ? {} : undefined;

    // Approve-first: show the proposed plan + config for a one-click OK before
    // the run starts. Overrides live under Advanced.
    const proj = projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
    const summary =
      (rationale ? `Plan: ${rationale}  ` : "") +
      `Run autopilot in "${proj}" — verify: ${verifyCommand || "none"}; up to ${maxIterations} iteration(s); ` +
      `model: ${model || "auto"}${effort ? " / " + effort : ""}; escalate on trouble: ${escalationConfig ? "yes" : "no"}. ` +
      `Runs in an isolated worktree and never pushes. Start?`;
    customConfirm(summary, "Start run", async () => {
      const res = await window.helm.runGoal({ projectPath, goal, maxIterations, model, effort, verifyCommand, escalationConfig });
      if (!res || !res.ok) {
        err.textContent = "Failed to start: " + (res?.error || "unknown error");
        return;
      }
      goalRuns.set(res.goalRunId, {
        goalRunId: res.goalRunId,
        ordinal: ++goalRunSeq,
        goal,
        projectPath,
        maxIterations,
        model,
        effort,
        verifyCommand,
        escalationConfig,
        status: "running",
        iterations: [],
        result: null,
        error: null,
        escalation: null,
        latestPlan: null,
        latestModel: null,
      });
      // Clear only the goal field so the launcher is ready for the next run;
      // folder / verify / model picks usually carry over between runs.
      goalInput.value = "";
      updateRunningIndicator();
      paintAutopilotBadge();
      renderGoalPage();
    });
  });
  actionRow.append(startBtn);

  // Intent-first (C1 rework): the captain gives WHAT + WHERE (goal + folder);
  // the crew knobs (verify, iterations, model, escalation) are auto-derived
  // (verify is detected from the project) and tucked into an "Advanced" section,
  // collapsed by default - you only open it to override. Start shows the derived
  // config for a one-click approve before the run (see the click handler).
  const advanced = document.createElement("details");
  advanced.className = "goal-advanced";
  const advSummary = document.createElement("summary");
  advSummary.textContent = "Advanced - override verify, iterations, model, escalation";
  advanced.append(
    advSummary,
    iterLabel,
    iterInput,
    modelEffortLabel,
    modelEffortRow,
    verifyLabel,
    verifyInput,
    verifyHint,
    escalateRow
  );

  form.append(goalLabel, goalInput, cwdLabel, cwdRow, advanced, err, actionRow);
  page.append(form);

  // ---- Runs (newest first) ----
  // Acknowledged (Done) runs are hidden here - Done clears them from this page
  // (dce61455 "when are the runs cleared?": they persist in history + git, but
  // Done removes them from the view). Terminal runs render COLLAPSED to a
  // one-line summary so the list stays scannable (b72fcd1f); live/attention runs
  // and the deep-link target render expanded.
  const allRuns = [...goalRuns.values()];
  const runs = allRuns.filter((r) => !isGoalRunAcknowledged(r.goalRunId));
  const hiddenDone = allRuns.length - runs.length;
  if (runs.length) {
    const runsWrap = document.createElement("div");
    runsWrap.className = "goal-runs";
    for (const run of runs.reverse()) {
      const live = run.status === "running" || !!run.escalation;
      const expanded = live || goalRunExpanded.has(run.goalRunId) || pendingGoalScrollId === run.goalRunId;
      runsWrap.append(expanded ? goalRunDetailEl(run) : goalRunSummaryEl(run));
    }
    page.append(runsWrap);
  }
  if (hiddenDone > 0) {
    const note = document.createElement("div");
    note.className = "analysis-totals";
    note.style.marginTop = "10px";
    note.textContent = `${hiddenDone} completed run${hiddenDone === 1 ? "" : "s"} cleared from view (marked Done). They stay on disk + in git.`;
    page.append(note);
  }

  // Deep-link target: a crew report row asked to open a SPECIFIC run (see
  // openGoalRun). Scroll it into view and flash a highlight so the eye lands on
  // it among several run blocks, then clear the one-shot target.
  if (pendingGoalScrollId) {
    const target = document.getElementById("goalrun-" + pendingGoalScrollId);
    pendingGoalScrollId = null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.add("goal-run-deeplinked");
      setTimeout(() => target.classList.remove("goal-run-deeplinked"), 2000);
    }
  }
}

// One-shot deep-link: the goal run a Dashboard crew-report row wants opened.
// renderGoalPage consumes + clears it after scrolling that run into view.
let pendingGoalScrollId = null;

// Which terminal runs the captain has manually expanded on the Autopilot page
// (b72fcd1f: terminal runs render collapsed to a summary by default). Module
// state so it survives a re-render; live/attention runs are always expanded.
const goalRunExpanded = new Set();

// Collapsed one-line summary of a terminal run on the Autopilot page (b72fcd1f).
// Click anywhere on it to expand into the full goalRunDetailEl - keeps a long
// run list scannable so you can open just the one you care about.
function goalRunSummaryEl(run) {
  const report = goalRunReport(run);
  const row = document.createElement("div");
  row.className = "goal-run-summary" + (report.needsCaptain ? " goal-run-summary-needs" : "");
  row.title = "Click to expand this run";
  row.addEventListener("click", () => {
    goalRunExpanded.add(run.goalRunId);
    renderGoalPage();
  });
  const chev = document.createElement("span");
  chev.className = "goal-run-summary-chev";
  chev.textContent = "▶";
  const glyph = document.createElement("span");
  glyph.className = "goal-run-summary-ic";
  glyph.textContent = run.status === "error" ? "✕" : run.escalation ? "⚠" : "✓";
  const title = document.createElement("span");
  title.className = "goal-run-summary-title";
  const goal = run.goal || "(run)";
  title.textContent = goal.length > 72 ? goal.slice(0, 72) + "…" : goal;
  const meta = document.createElement("span");
  meta.className = "goal-run-summary-meta";
  meta.textContent = report.commitCount > 0 ? `${report.commitCount} commit${report.commitCount === 1 ? "" : "s"}` : report.status;
  row.append(chev, glyph, title, meta);
  return row;
}

// Navigate to the Autopilot page focused on a specific run ("into the autopilot"
// from a crew report row), rather than dumping the user on the run list.
function openGoalRun(goalRunId) {
  pendingGoalScrollId = goalRunId || null;
  goalRunExpanded.add(goalRunId); // deep-linking into a run expands it
  navigateToPage("goal");
}

// One run's live block: heading (ordinal + goal, so concurrent runs are
// tellable apart) + per-run cancel, then status line, plan, iteration cards,
// escalation, and final summary/error. Extracted from the old single-run
// rendering so the Goal page can show several runs at once.
// Human label for a run's model + effort (task e5273837). Reuses the shared
// model menu so the label matches the picker ("Opus 4.8" not "claude-opus-4-8");
// "Auto model" when the run left the choice to the CLI.
function goalModelEffortLabel(run) {
  const labelFor = (id) => flattenModelOptions(MODEL_MENU_OPTIONS).find((o) => o.value === id)?.label || id.replace(/^claude-/, "");
  let modelLabel;
  if (run.model) {
    modelLabel = labelFor(run.model);
  } else {
    // Auto run: no --model was requested, so show the model the CLI ACTUALLY
    // resolved to (captured from the run's usage - see resolvedModel in
    // goalOrchestrator.js), which is the point of task a3ff4a06 ("see which model
    // the autopilot used"). run.latestModel is the live-mirrored/rehydrated value;
    // run.result.resolvedModel is the finished run's. "Auto model" until the first
    // iteration reports one.
    const resolved = run.latestModel || run.result?.resolvedModel || null;
    modelLabel = resolved ? `Auto -> ${labelFor(resolved)}` : "Auto model";
  }
  return run.effort ? `${modelLabel} · ${run.effort} effort` : modelLabel;
}

function goalRunDetailEl(run) {
  const wrap = document.createElement("div");
  // id so a crew report row on the Dashboard can deep-link straight to THIS
  // run's detail (scroll + highlight) instead of dumping the user on the goal
  // list - "into the autopilot", not just "view" (bug 9f957394).
  wrap.id = "goalrun-" + run.goalRunId;
  // Subtle amber accent (see .goal-run-detail-attention in style.css) so a
  // run needing attention is visible at a glance among several run blocks,
  // not just discoverable by reading each status line.
  wrap.className = "goal-run-detail" + (run.status === "error" || run.escalation ? " goal-run-detail-attention" : "");

  const head = document.createElement("div");
  head.className = "goal-run-head";
  // Collapse control (bug b72fcd1f: an expanded run couldn't be collapsed again).
  // Placed as a ▾ chevron at the FAR LEFT of the head - the SAME spot the ▶
  // expand chevron sits on the collapsed summary row - so toggling doesn't make
  // the control jump around the header (bug d8b36df6: the captain - "collapse should
  // be in the same place the expand button is"). Only for a run the captain
  // MANUALLY expanded (in goalRunExpanded); a live/escalated run is force-
  // expanded and can't be collapsed, so it shows no chevron.
  if (goalRunExpanded.has(run.goalRunId)) {
    const collapseChev = document.createElement("button");
    collapseChev.className = "goal-collapse-chev";
    collapseChev.textContent = "▾";
    collapseChev.title = "Collapse this run back to a one-line summary";
    collapseChev.addEventListener("click", () => {
      goalRunExpanded.delete(run.goalRunId);
      renderGoalPage();
    });
    head.append(collapseChev);
  }
  const title = document.createElement("span");
  title.className = "goal-run-title";
  const goalSnippet = run.goal.length > 80 ? run.goal.slice(0, 80) + "…" : run.goal;
  title.textContent = `Run ${run.ordinal}: ${goalSnippet}`;
  head.append(title);
  // The remaining controls (cancel / worktree actions) cluster in ONE right-
  // aligned group.
  const right = document.createElement("div");
  right.className = "goal-run-head-right";
  if (run.status === "running") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "goal-cancel-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling after current iteration…";
      await window.helm.cancelGoal(run.goalRunId);
    });
    right.append(cancelBtn);
  } else {
    // Worktree cleanup actions - only once the run is no longer live (a
    // "running" run's worktree is still in use by the in-flight iteration)
    // and only when a worktree path is actually known (a run that errored
    // before ever creating one has neither). Covers both live-finished runs
    // (run.result.worktreePath) and rehydrated-from-disk ones (same shape,
    // see rehydrateGoalRuns), which is exactly the population that leaves
    // orphaned worktrees behind with no other way to clean them up.
    const worktreePath = run.result?.worktreePath;
    if (worktreePath) {
      right.append(goalWorktreeActionsEl(run, worktreePath));
    }
  }
  head.append(right);
  wrap.append(head);

  // Which model + effort the run's iterations used (task e5273837: "Jag vill att
  // det ska visas vilken model+effort som användes"). A muted meta line under the
  // title. "Auto" when the run left the pick to the CLI. All iterations run at the
  // run's model/effort, so this is a run-level fact, not per-iteration.
  const meta = document.createElement("div");
  meta.className = "goal-run-meta";
  meta.textContent = goalModelEffortLabel(run);
  wrap.append(meta);

  const progress = document.createElement("div");
  progress.className = "goal-progress";

  const statusLine = document.createElement("div");
  statusLine.className = "goal-status-line";
  if (run.status === "running") {
    // A LIVE (not escalated) run gets an animated spinner + pulsing text so it
    // reads as actively working, not hung - "Running · 0 iteration(s) so far…"
    // as static text looked stuck (bug 7bacc349).
    if (!run.escalation) {
      const spin = document.createElement("span");
      spin.className = "goal-status-spin";
      const label = document.createElement("span");
      label.className = "goal-status-working";
      label.textContent = `Running · ${run.iterations.length} iteration(s) so far…`;
      statusLine.append(spin, label);
    } else {
      statusLine.textContent = `Paused · ${run.iterations.length} iteration(s) so far…`;
    }
  } else if (run.status === "done") {
    // A clearer verdict than a bare "Run finished" (task e5273837: "verdict på
    // den"): say the outcome and what it left - how many commits, and whether it
    // is waiting on you. goalRunReport is the same source the Dashboard report
    // row uses, so the two agree.
    if (run.escalation) {
      statusLine.textContent = "Run paused for you.";
    } else {
      const report = goalRunReport(run);
      const commits = report.commitCount || 0;
      const commitPart = commits > 0 ? `${commits} commit${commits === 1 ? "" : "s"} to review` : "no commits";
      statusLine.textContent = `Finished · ${commitPart} · ${run.iterations.length} iteration${run.iterations.length === 1 ? "" : "s"}`;
    }
  } else if (run.status === "error") {
    statusLine.textContent = "Run ended with an error.";
  } else if (run.status === "interrupted") {
    // Rehydrated from disk (see goalRunHistory.js/goal:history): the run was
    // still "running" when Helm last shut down, so there is no live
    // process behind it anymore - its actual outcome is unknown, not "done".
    statusLine.textContent =
      "Interrupted when Helm restarted. Resume to re-attach to its worktree and continue, or open the worktree to see what it left behind.";
  }
  progress.append(statusLine);
  // An interrupted run kept its worktree, so it can be resumed straight from
  // here (goal:resume validates it's actually resumable and toasts if not).
  if (run.status === "interrupted") {
    const resumeRow = document.createElement("div");
    resumeRow.className = "goal-summary-actions goal-interrupted-actions";
    resumeRow.append(goalResumeButton(run.goalRunId));
    progress.append(resumeRow);
  }
  // A run that ran OUT OF TOKENS (or hit a rate limit) finishes as "done" +
  // resumable, not "interrupted" - it kept its worktree and can be picked up once
  // the limit resets. Give it the same one-click Resume the interrupted case has,
  // so the user doesn't have to reach for the fleet-wide "fortsätt" from a first
  // mate (task b67107c8: "Autopilots fortsätt-knapp om något blir fel"). Escalated
  // (paused) runs get their Resume from the escalation card below, so exclude them
  // here to avoid showing two.
  if (run.status !== "interrupted" && run.result?.resumable && !run.escalation) {
    const resumeRow = document.createElement("div");
    resumeRow.className = "goal-summary-actions goal-resumable-actions";
    const why = document.createElement("div");
    why.className = "goal-status-line goal-fresh-context-note";
    why.textContent =
      "This run stopped on a token/quota limit. Resume to continue in its kept worktree once your limit resets.";
    resumeRow.append(goalResumeButton(run.goalRunId), why);
    progress.append(resumeRow);
  }

  // Fresh-context honesty label: each iteration is a separate `claude -p` with
  // no accumulated context - continuity between iterations is carried only via
  // notes.md (see goalOrchestrator.js). Stated plainly so the reader knows an
  // iteration did not inherit the prior one's in-memory context. A muted
  // one-liner (reuses .goal-summary-note's muted styling), not a control.
  const freshNote = document.createElement("div");
  freshNote.className = "goal-status-line goal-fresh-context-note";
  freshNote.textContent = "Each iteration runs in fresh context (no carried-over memory); continuity is via notes.md.";
  progress.append(freshNote);

  // RPI phase (research -> plan -> implement, see goalOrchestrator.js): the
  // plan itself is the plan-phase's one durable artifact, so surface it as soon
  // as any iteration has reached/passed the plan phase - a plain expandable
  // block (the app's existing `.tool-group` <details> pattern), not its own
  // card, since it is reference material for the run rather than an event.
  const planContent = run.result?.plan ?? run.latestPlan ?? null;
  if (planContent) {
    progress.append(goalPlanBlock(planContent));
  }
  // notes.md is the run's continuity between iterations (each one starts in fresh
  // context), which makes it the record of what it believed as it went - and since
  // .helm-goal/ is gitignored it is no longer committed anywhere either. It was being
  // persisted AND read back across a restart, and then rendered nowhere at all, so
  // the user-visible symptom was untouched by both halves of the earlier fix
  // (independent review, 2026-08-03: "persisting is not restoring" - and restoring is
  // not showing).
  const notesContent = run.result?.notes ?? run.latestNotes ?? null;
  if (notesContent) {
    progress.append(goalPlanBlock(notesContent, "Notes (.helm-goal/notes.md)"));
  }

  run.iterations.forEach((rec) => {
    progress.append(goalIterationCard(rec));
  });
  wrap.append(progress);

  // Escalation (Point 12 Phase-0, opt-in) - shown as soon as the escalation
  // event arrives (it precedes "done"), so a human-gated pause is visible
  // immediately rather than only once the run winds down.
  if (run.escalation) {
    wrap.append(goalEscalationCard(run.escalation, run.goalRunId));
  }

  if (run.status === "done" && run.result && run.result.stoppedReason !== "escalated") {
    wrap.append(goalSummaryCard(run.result));
  }
  if (run.status === "error") {
    const errCard = document.createElement("div");
    errCard.className = "goal-summary-card goal-summary-error";
    errCard.textContent = "Error: " + (run.error || "unknown error");
    wrap.append(errCard);
  }

  return wrap;
}

// Open/Delete actions for a finished (non-running) run's worktree - the
// worktree + branch a goal-orchestrator run leaves on disk for human review
// (see goalOrchestrator.js) but which otherwise has no in-app way to inspect
// or clean up, so orphaned worktrees pile up over daily use. Delete goes
// through a two-step inline confirm (showContextMenu's existing
// "Confirm X" re-open pattern - see e.g. archive/delete-category handlers -
// rather than a native window.confirm(), which is unreliable in this build.
function goalWorktreeActionsEl(run, worktreePath) {
  const wrap = document.createElement("span");
  wrap.className = "goal-worktree-actions";

  const openBtn = document.createElement("button");
  openBtn.className = "text-btn";
  openBtn.textContent = "Open worktree";
  openBtn.title = worktreePath;
  openBtn.addEventListener("click", async () => {
    const res = await window.helm.openGoalWorktree(worktreePath);
    if (res && !res.ok) {
      showToast(res.error || "Couldn't open the worktree.");
    }
  });
  wrap.append(openBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "text-btn";
  deleteBtn.textContent = "Delete worktree";
  deleteBtn.title = worktreePath;
  // Perform the delete. force=false is the safe default (fails closed on
  // uncommitted changes); force=true discards uncommitted work and is only
  // reached after a second, explicitly-worded confirm (bug f9a11d56).
  const runDelete = async (force) => {
    deleteBtn.disabled = true;
    openBtn.disabled = true;
    const res = await window.helm.deleteGoalWorktree({
      goalRunId: run.goalRunId,
      projectPath: run.projectPath,
      worktreePath,
      force,
    });
    if (!res || !res.ok) {
      // Dirty worktree on a non-force attempt: offer force-discard rather than
      // leaving the user at a dead-end error (which was the whole complaint).
      if (res?.uncommitted && !force) {
        deleteBtn.disabled = false;
        openBtn.disabled = false;
        forceMode = true;
        deleteBtn.textContent = "Discard + delete";
        deleteBtn.classList.add("danger");
        showToast("Worktree has uncommitted changes - click \"Discard + delete\" to remove it anyway.");
        return;
      }
      showToast(`Failed to delete worktree: ${res?.error || "unknown error"}`);
      deleteBtn.disabled = false;
      openBtn.disabled = false;
      return;
    }
    if (res.alreadyGone) {
      showToast("Worktree was already gone - cleared the entry.");
    }
    goalRuns.delete(run.goalRunId);
    renderGoalPage();
  };

  // Once a non-force delete reports uncommitted changes, the button flips into
  // force-discard mode so the next click discards instead of re-confirming.
  let forceMode = false;
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Keep the confirm label SHORT (bug 58bb6ca7: the full worktree path + full
    // branch name made a giant menu item). Reference the run + note the branch is
    // kept, without dumping the long path/branch (both are on the buttons' title
    // tooltips + the run detail above). removeWorktree only removes the checkout,
    // never the branch ref (lib/worktree.js), so the copy must stay accurate.
    const label = forceMode
      ? `Discard uncommitted changes and delete Run ${run.ordinal}'s worktree`
      : `Confirm delete Run ${run.ordinal}'s worktree${run.result?.branchName ? " (branch kept)" : ""}`;
    showContextMenu(e.clientX, e.clientY, [
      {
        label,
        danger: true,
        onClick: () => runDelete(forceMode),
      },
    ]);
  });
  wrap.append(deleteBtn);

  return wrap;
}

// RPI phase (research/plan/implement) display labels - short and title-cased
// for the iteration card, matching the app's other compact-label conventions.
const GOAL_PHASE_LABELS = { research: "Research", plan: "Plan", implement: "Implement" };

// An expandable block showing the current `.helm-goal/plan.md` content -
// reuses the same <details>/.tool-group pattern as tool-call output elsewhere
// in the app, rather than inventing a new expandable widget.
function goalPlanBlock(planContent, label = "Plan (.helm-goal/plan.md)") {
  const details = document.createElement("details");
  details.className = "tool-group goal-plan-block";
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary);
  const pre = document.createElement("pre");
  pre.className = "tool-call-output goal-plan-content";
  pre.textContent = planContent;
  details.append(pre);
  return details;
}

// The exact delegation prompt an iteration was given (record.contract). Reuses
// goalPlanBlock's <details>/.tool-group/<pre> pattern so it reads as the same
// kind of expandable reference block, plus a small copy affordance matching the
// app's existing .copy-btn (icon → ✓) convention. Makes a green result
// trustworthy: the reviewer can see what the delegate was actually asked to do,
// not just its self-reported summary.
function goalContractBlock(contract) {
  const details = document.createElement("details");
  details.className = "tool-group goal-contract-block";
  const summary = document.createElement("summary");
  summary.textContent = "Contract sent to this iteration";
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.title = "Copy";
  copyBtn.textContent = "⧉";
  copyBtn.addEventListener("click", (e) => {
    // Don't toggle the <details> when the copy icon (inside <summary>) is clicked.
    e.preventDefault();
    e.stopPropagation();
    window.helm.copyToClipboard(contract);
    copyBtn.textContent = "✓";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "⧉";
      copyBtn.classList.remove("copied");
    }, 1200);
  });
  summary.append(copyBtn);
  details.append(summary);
  const pre = document.createElement("pre");
  pre.className = "tool-call-output goal-contract-content";
  pre.textContent = contract;
  details.append(pre);
  return details;
}

// Verify evidence for an iteration (record.verify = { command, passed, output }).
// Backs the pass/fail badge with the actual command + captured output tail so
// "verified" is not a bare assertion. Same expandable <details>/.tool-group/<pre>
// pattern as the plan/contract blocks.
function goalVerifyBlock(verify) {
  const details = document.createElement("details");
  details.className = "tool-group goal-verify-block";
  const summary = document.createElement("summary");
  summary.textContent = `Verify evidence · ${verify.passed ? "passed" : "failed"}`;
  details.append(summary);
  const cmd = document.createElement("div");
  cmd.className = "goal-iter-sublabel";
  cmd.textContent = `Command: ${verify.command}`;
  details.append(cmd);
  const pre = document.createElement("pre");
  pre.className = "tool-call-output goal-verify-content";
  pre.textContent = verify.output || "(no output captured)";
  details.append(pre);
  return details;
}

function goalIterationCard(rec) {
  const card = document.createElement("div");
  const ok = rec.ok && rec.result && rec.result.success;
  card.className = "goal-iter-card" + (ok ? " goal-iter-ok" : " goal-iter-fail");

  const head = document.createElement("div");
  head.className = "goal-iter-head";
  const num = document.createElement("span");
  num.className = "goal-iter-num";
  num.textContent = `Iteration ${rec.iteration}`;
  head.append(num);

  // RPI phase (research/plan/implement) - a small muted label, same slot as
  // the committed/discarded/error badge but visually distinct (no border)
  // since it is descriptive, not a status.
  if (rec.phase && GOAL_PHASE_LABELS[rec.phase]) {
    const phaseLabel = document.createElement("span");
    phaseLabel.className = "goal-iter-phase";
    phaseLabel.textContent = GOAL_PHASE_LABELS[rec.phase];
    head.append(phaseLabel);
  }

  const badge = document.createElement("span");
  badge.className = "goal-iter-badge";
  if (rec.ok && rec.result) {
    badge.textContent = rec.result.success ? "committed" : "discarded";
  } else {
    badge.textContent = "error";
  }
  head.append(badge);

  // Context-fill KPI (praktiker #2) - muted normally, attention color once it
  // crosses the same "dumb zone" threshold goalOrchestrator.js itself flags
  // via `contextBudgetWarning`. Only shown when a fill percentage is actually
  // available (null when the model's context window wasn't reported).
  if (typeof rec.fillPct === "number") {
    const fillBadge = document.createElement("span");
    fillBadge.className = "goal-iter-badge goal-iter-fill" + (rec.contextBudgetWarning ? " goal-iter-fill-warn" : "");
    fillBadge.textContent = `${Math.round(rec.fillPct * 100)}% ctx`;
    if (typeof rec.costUsd === "number") {
      fillBadge.title = `$${rec.costUsd.toFixed(4)} this iteration`;
    }
    head.append(fillBadge);
  } else if (typeof rec.costUsd === "number" && rec.costUsd > 0) {
    // No context-window readout for this model, but cost is still known -
    // show it alone rather than silently dropping the only KPI available.
    const costBadge = document.createElement("span");
    costBadge.className = "goal-iter-badge goal-iter-fill";
    costBadge.textContent = `$${rec.costUsd.toFixed(3)}`;
    head.append(costBadge);
  }

  card.append(head);

  if (rec.ok && rec.result) {
    const summary = document.createElement("div");
    summary.className = "goal-iter-summary";
    summary.textContent = rec.result.summary || "(no summary)";
    card.append(summary);

    if (Array.isArray(rec.result.keyChanges) && rec.result.keyChanges.length) {
      const label = document.createElement("div");
      label.className = "goal-iter-sublabel";
      label.textContent = "Key changes";
      const ul = document.createElement("ul");
      ul.className = "goal-iter-list";
      rec.result.keyChanges.forEach((c) => {
        const li = document.createElement("li");
        li.textContent = c;
        ul.append(li);
      });
      card.append(label, ul);
    }
  } else {
    const errText = document.createElement("div");
    errText.className = "goal-iter-summary";
    errText.textContent = rec.error || "Iteration failed.";
    card.append(errText);
  }

  // Verify evidence (implement-phase iterations that ran the verify gate) -
  // the actual command + captured output behind the pass/fail badge.
  if (rec.verify) {
    card.append(goalVerifyBlock(rec.verify));
  }

  // The delegation contract - the exact prompt this iteration was given.
  if (rec.contract) {
    card.append(goalContractBlock(rec.contract));
  }

  return card;
}

function goalSummaryCard(result) {
  const card = document.createElement("div");
  card.className = "goal-summary-card";

  const title = document.createElement("div");
  title.className = "goal-summary-title";
  title.textContent = "Run complete - review the work in its isolated worktree";
  card.append(title);

  const rows = [
    ["Commits", String(result.commitCount ?? 0)],
    ["Branch", result.branchName || "(unknown)"],
    ["Worktree", result.worktreePath || "(unknown)"],
    ["Stopped because", result.stoppedReason || "(unknown)"],
  ];
  rows.forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "goal-summary-row";
    const key = document.createElement("span");
    key.className = "goal-summary-key";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "goal-summary-val";
    val.textContent = v;
    row.append(key, val);
    card.append(row);
  });

  const note = document.createElement("div");
  note.className = "goal-summary-note";
  note.textContent =
    "This run did NOT push or merge. All work lives in the isolated worktree and branch above, for you to review and merge (or discard) by hand.";
  card.append(note);

  return card;
}

// Human-readable labels for the Point 12 Phase-0 signal names
// (detectEscalationSignal in goalOrchestrator.js) - the raw signal string is
// still shown (in the detail line) for anyone who wants the exact mechanism,
// this is just a friendlier headline.
const GOAL_ESCALATION_SIGNAL_LABELS = {
  repeated_verify_failure: "Stuck on the same verify failure",
  ambiguity_reported: "Reported an ambiguity it can't resolve",
  cost_soft_cap: "An iteration's cost spiked",
  no_net_progress: "Several iterations landed no new commits",
};

// A human-gated card for a Point 12 Phase-0 escalation (opt-in - see the
// "Escalate on trouble" checkbox and goalOrchestrator.js's runGoal doc
// comment). Visually a variant of .goal-summary-card (same shape: title, key/
// value rows, a closing note) but with the --waiting amber the rest of the
// app already uses for "needs you" states, so it reads as a distinct,
// attention-worthy pause rather than a normal completion.
//
// One-click Resume for a paused/interrupted run. goal:resume (resumeGoalRunById)
// re-attaches runGoal to the run's EXISTING worktree/branch/baseCommit (Phase 2
// Slice 5) instead of forking a fresh one, and is gated server-side on
// resumable + kill switch + budget + width cap. So the button just fires the
// intent and surfaces whatever the backend decides; the same run then streams
// its own goal:events as it continues. This is the per-run twin of the first
// mate's "fortsätt" cascade (resumeFleet) - same engine, captain-initiated from
// the card instead of from the mate.
function goalResumeButton(goalRunId) {
  const btn = document.createElement("button");
  btn.className = "goal-resume-btn";
  btn.textContent = "Resume run";
  btn.title = "Re-attach to this run's existing worktree and continue it";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = "Resuming…";
    // preload signature is resumeGoalRun(goalRunId) - a BARE id, not an object
    // (passing { goalRunId } double-wraps it and the handler can't find the run).
    const res = await window.helm.resumeGoalRun(goalRunId);
    if (!res || !res.ok) {
      // atCap is a soft, expected outcome (the mate is already at its concurrent
      // cap); everything else is a real reason the run can't resume.
      showToast(
        res?.atCap
          ? "At the concurrent-run cap for this mate - resume again once one finishes."
          : `Couldn't resume: ${res?.error || "unknown error"}`
      );
      btn.disabled = false;
      btn.textContent = "Resume run";
      return;
    }
    // The resumed run streams into its own (possibly new) goalRunId; drop this
    // terminal card so the live one takes over on the next render.
    goalRuns.delete(goalRunId);
    renderGoalPage();
  });
  return btn;
}

// The paused-run card. A run pauses (escalation) rather than aborting precisely
// so it can be continued: goal:resume re-attaches to its preserved worktree, so
// the card offers a one-click Resume alongside the preserved worktree/branch for
// hand inspection.
function goalEscalationCard(escalation, goalRunId) {
  const card = document.createElement("div");
  card.className = "goal-summary-card goal-escalation-card";

  const title = document.createElement("div");
  title.className = "goal-summary-title goal-escalation-title";
  title.textContent =
    "Paused for you - " + (GOAL_ESCALATION_SIGNAL_LABELS[escalation.signal] || escalation.signal || "escalation");
  card.append(title);

  if (escalation.detail) {
    const detail = document.createElement("div");
    detail.className = "goal-iter-summary goal-escalation-detail";
    detail.textContent = escalation.detail;
    card.append(detail);
  }

  const rows = [
    ["Paused at iteration", String(escalation.iteration ?? "?")],
    ["Signal", escalation.signal || "(unknown)"],
    ["Branch", escalation.branchName || "(unknown)"],
    ["Worktree", escalation.worktreePath || "(unknown)"],
  ];
  rows.forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "goal-summary-row";
    const key = document.createElement("span");
    key.className = "goal-summary-key";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "goal-summary-val";
    val.textContent = v;
    row.append(key, val);
    card.append(row);
  });

  const note = document.createElement("div");
  note.className = "goal-summary-note";
  note.textContent =
    "The run paused here rather than continuing blind - nothing was discarded. Its worktree, branch, notes.md and plan.md are all preserved above. Resume to re-attach to that worktree and continue where it left off, or open the worktree to carry on by hand.";
  card.append(note);

  // One-click resume (goal:resume re-attaches to the preserved worktree). Only
  // when we know the run id (always, on the Goal page; the dashboard queue row
  // has its own resume affordance).
  if (goalRunId) {
    const actions = document.createElement("div");
    actions.className = "goal-summary-actions";
    actions.append(goalResumeButton(goalRunId));
    card.append(actions);
  }

  return card;
}

// Live goal-run events (own channel, parallel to session events). Each payload
// Scheduled prompts (7d9d2188): keep the queued-prompt bar current - the main
// process pushes a change when one fires or gets pushed out to a later reset.
window.helm.onScheduledPromptsChanged(() => renderScheduledPromptBar());
renderScheduledPromptBar();
// Also refresh it on a slow tick so a countdown label ("in 2h") doesn't go stale
// while nothing else happens.
setInterval(renderScheduledPromptBar, 60 * 1000);

// A file dropped ANYWHERE but the composer must not navigate the window.
//
// Chromium's default for a file dropped on a page is to open it, which replaces the whole app
// with the file - and the only guard was on the textarea itself, which at rest is a ~48px strip
// with a 7px resize handle now sitting on top of it. Dropping a file onto the transcript, the
// controls row, or slightly high, therefore threw the app away. Raised by review, which also
// made the point that letting files be dropped at all is exactly what makes this likely.
//
// Deliberately at the document, capture phase, and NOT preventing anything else: the composer's
// own handlers still run and still attach what was dropped on them. This only stops the default
// for everything they did not claim.
for (const type of ["dragover", "drop"]) {
  document.addEventListener(
    type,
    (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    },
    false
  );
}

// The review badge, on the same footing: painted at startup and kept current on a
// slow tick, so the number exists BEFORE you visit the page it points at. It used to
// be written only by renderReviewPage, which meant the nudge appeared after you had
// already followed it (the captain: "siffran över review syns inte förrän man öppnar
// review"). One board read a minute, in a renderer that already polls for more than
// that - and the same call runs after any review action, so it never lags behind a
// stamp by a whole tick.
// The FIRST paint waits, deliberately. Startup is the busiest moment the main process
// has (the housekeeping sweep alone blocks it, measured), and a badge nobody is looking
// at in the first seconds is not worth adding to that queue.
setTimeout(() => {
  void paintReviewBadge();
}, 15 * 1000);
setInterval(() => {
  void paintReviewBadge();
}, 60 * 1000);

/**
 * Paint the subnav's Autopilot badge: how many runs are working RIGHT NOW.
 *
 * the captain, task 8180e733: "kan vi lägga en markör över autopilot också som visar hur många
 * jobb som körs nu", with a screenshot of the Review badge as the reference.
 *
 * It reads the same live view every crew surface reads (crewLiveRun + crewRunning), so the
 * tab count cannot disagree with the rows underneath it - the failure that made the review
 * badge worth writing a paragraph about. Unlike Review's, this number is cheap: it comes off
 * goal-run state the renderer already holds, so it repaints on every goal event instead of
 * on a slow tick, and a run that starts is visible immediately rather than up to a minute
 * later.
 *
 * Deliberately NOT the same colour as the review badge - see .attention-badge.running.
 * "Something is working" and "you are needed" must not look alike.
 */
function paintAutopilotBadge() {
  const badge = document.getElementById("autopilotBadge");
  if (!badge) {
    return;
  }
  let n = 0;
  try {
    n = [...goalRuns.values()].map(crewLiveRun).filter(crewRunning).length;
  } catch {
    return; // leave the last known number rather than blanking it on a hiccup
  }
  badge.textContent = n > 0 ? String(n) : "";
  badge.classList.toggle("hidden", n === 0);
  badge.title = n === 1 ? "1 autopilot run working" : `${n} autopilot runs working`;
}

// carries goalRunId; events from a stale run (a previous run, or after a new
// one started) are ignored so late events can't clobber current state.
window.helm.onGoalEvent((evt) => {
  let run = goalRuns.get(evt.goalRunId);
  if (!run) {
    // A DISPATCHED run (launched by the app's dispatch watcher, not the Goal
    // page) - the renderer never called goalRuns.set for it. Create the entry
    // on its "started" event so it shows in the running indicator + fleet/tree
    // view; ignore later events for a run we somehow still don't know. Gated to
    // dispatched runs (evt.dispatchedBy): a Goal-page run creates its OWN entry
    // via goalRuns.set, so creating one here too would race + overwrite it
    // (review finding M4).
    if (evt.kind === "started" && evt.dispatchedBy) {
      run = {
        goalRunId: evt.goalRunId,
        ordinal: ++goalRunSeq,
        goal: evt.goal || "(dispatched run)",
        projectPath: evt.projectPath || null,
        dispatchedBy: evt.dispatchedBy || null,
        tier: evt.tier || null,
        status: "running",
        iterations: [],
        result: null,
        error: null,
        escalation: null,
        latestPlan: null,
        latestModel: null,
      };
      goalRuns.set(evt.goalRunId, run);
    } else {
      return;
    }
  }
  if (evt.kind === "iteration") {
    run.iterations.push(evt.record);
    // Track the latest plan.md content as it arrives (see goalOrchestrator.js
    // record.plan), so the Goal page can show the plan live instead of only
    // once the run finishes and its final `result.plan` is available.
    if (evt.record.plan) {
      run.latestPlan = evt.record.plan;
    }
    // Same live-mirror treatment for the resolved model (see
    // goalOrchestrator.js record.resolvedModel) - lets the Goal page and
    // Fleet crew row show which model actually ran before the run finishes.
    if (evt.record.resolvedModel) {
      run.latestModel = evt.record.resolvedModel;
    }
  } else if (evt.kind === "done") {
    run.status = "done";
    run.result = evt.result;
    // WHEN it finished, so a report-back nudge can tell "landed since you last looked"
    // from "has been sitting here for days" - see pendingSecondMateReviewNudge.
    run.finishedAt = Date.now();
  } else if (evt.kind === "error") {
    run.status = "error";
    run.error = evt.error;
    run.finishedAt = Date.now();
    // Failures must be visible even off-page (see unseenGoalAttention above) -
    // a run erroring while the user is on Chat/Plan would otherwise sit
    // silently until they happen to check the Goal page.
    unseenGoalAttention.add(run.goalRunId);
    // A notice, not a toast: this is an event, it can arrive while he is on another page,
    // and a run that failed leaves a worktree behind that someone has to look at.
    showNotice(`Autopilot run "${run.goal}" failed: ${run.error}`, {
      actions: [{ label: "Open Autopilot", onClick: () => navigateToPage("goal") }],
    });
    updateGoalAttentionBadge();
    window.helm.notifyAttention({ title: "Helm - a goal run failed", body: run.goal });
  } else if (evt.kind === "escalation") {
    // Point 12 Phase-0 escalation (opt-in) - arrives BEFORE "done" (see
    // main.js's goal:run handler), so the escalation card can show up the
    // moment the run actually pauses rather than waiting for the run's
    // promise to resolve and send "done" with the same info.
    run.escalation = evt.escalation;
    unseenGoalAttention.add(run.goalRunId);
    showNotice(`Autopilot run "${run.goal}" paused - it needs you before it can go on.`, {
      actions: [{ label: "Open Autopilot", onClick: () => navigateToPage("goal") }],
    });
    updateGoalAttentionBadge();
    window.helm.notifyAttention({ title: "Helm - a run needs you", body: run.goal });
  }
  // Ambient running indicator is app-wide, so update it on every event
  // regardless of which page is visible.
  updateRunningIndicator();
  // Same footing, and for the same reason: the Autopilot tab count must be right
  // whichever page you happen to be on, not only once you open Autopilot.
  paintAutopilotBadge();
  // Only re-render if the Goal page is actually visible, to avoid
  // clobbering another page the user may have switched to mid-run.
  if (!document.getElementById("goalPage").classList.contains("hidden")) {
    renderGoalPage();
  }
  // Keep the Dashboard in-motion list live when a run starts/finishes/changes
  // while the Dashboard is the visible page (section-scoped - only the queue
  // section repaints, and only if its fingerprint actually changed).
  refreshDashboardIfVisible();
});

// A dispatched run just reported back. FORCE a dashboard rebuild (not the
// fingerprint-gated refresh) so the crew report surfaces under its first-mate
// card and the "collect & continue" triage cue (pendingTriageNudge) appears the
// moment the report lands - the fleet fingerprint doesn't track every facet, so
// a plain refresh could otherwise skip the rebuild (see the 2026-07-11 note in
// acknowledgeGoalRun). The poll-tick refresh still backstops this.
window.helm.onDispatchReport?.(() => {
  refreshDashboardIfVisible({ force: true });
});

// Reflects unseenGoalAttention.size as a small dot + count on the primary
// Dashboard tab, so a run that errored/escalated while the user was on
// another page stays discoverable after the toast fades. Subtle by design
// (the captain's UI rule: color only for genuine attention states) - reuses
// --waiting, the same amber already used for the escalation card and other
// "needs you" states.
function updateGoalAttentionBadge() {
  const badge = document.getElementById("dashboardAttentionBadge");
  if (badge) {
    const count = unseenGoalAttention.size;
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  updateAttentionTaskbarCount();
}

// Away-from-desk attention delivery: keeps the OS taskbar badge in sync with
// the same "needs you" total the Dashboard attention spotlight uses - an
// unseen goal-run error/escalation, or a session sitting in "waiting".
function updateAttentionTaskbarCount() {
  const waitingSessions = state.sessions.filter(
    // Exclude a first mate that's only waiting on its own dispatched crew, so
    // the taskbar badge stays consistent with the queue's "N need a click".
    (s) => !s.isArchived && !isHiddenFromHelm(s) && s.status === "waiting" && !mateHasLiveCrew(firstMateForSession(s))
  ).length;
  window.helm.setAttentionCount(unseenGoalAttention.size + waitingSessions);
}

// Ambient "N Autopilot runs in progress" indicator on the Dashboard tab -
// visible from ANY page, so you can tell something is running without being on
// the Autopilot page (the model is dispatch-and-step-away). Distinct from the
// amber attention badge: a calm pulsing --active dot + count. Called on every
// goal event, on launch, on rehydrate, and at startup - anywhere goalRuns
// gains or changes a "running" entry.
function updateRunningIndicator() {
  const el = document.getElementById("dashboardRunningIndicator");
  if (!el) {
    return;
  }
  const n = [...goalRuns.values()].filter((r) => r.status === "running" && !r.escalation).length;
  el.classList.toggle("hidden", n === 0);
  el.innerHTML = "";
  if (n > 0) {
    const dot = document.createElement("span");
    dot.className = "run-dot";
    const count = document.createElement("span");
    count.className = "run-count";
    count.textContent = String(n);
    el.append(dot, count);
    el.title = `${n} Autopilot run${n > 1 ? "s" : ""} in progress`;
  }
}

// ============================== Lavish (interactive plan) ==============================
// v1 of the "Lavish"-style interactive-plan feature (PLAN Phase 4). The
// distinctive value over a plain text plan is the ANNOTATE-FEEDBACK LOOP: an
// HTML mockup is shown in a sandboxed iframe with the annotation SDK injected
// (see lib/lavishSdk.js, lifted from lavish-axi), the user clicks an element
// and types feedback ON it, and each annotation comes back as a structured
// record. "Copy feedback" / "Send to composer" turn the collected annotations
// into one agent-ready text block. Explicitly a FIRST-PASS draft.
//
// The SDK runs inside the sandboxed, null-origin iframe, so it can only reach
// the host via window.parent.postMessage — collected here (no Express, no
// long-poll, unlike lavish-axi). The message-type strings mirror LAVISH_MSG in
// lib/lavishSdk.js.

let lavishState = {
  srcdoc: null, // current iframe srcdoc (SDK-injected), or null before load
  annotateMode: true,
  annotations: [], // [{ uid, selector, tag, text, prompt, lavishId? }]
  domSnapshot: "", // indented uid/tag/text tree from the SDK
  loadError: "",
  pastedHtml: "", // persists the "Artifact HTML" textarea across re-renders so
  // loading a mockup doesn't wipe what you pasted (tweak + reload without re-paste)
};

// Recently-loaded mockups, most-recent-first, capped at 5. Renderer-only
// persistence (localStorage) - no main.js IPC needed. Each entry is either a
// file load { kind: "file", path } or a pasted-HTML load { kind: "paste",
// html, label } - so a pasted mockup (which has no path to remember) can still
// be reloaded in one click, not just file-path loads.
const LAVISH_RECENT_KEY = "helm.lavish.recentMockups";
const LAVISH_RECENT_MAX = 5;

function loadLavishRecents() {
  try {
    const raw = localStorage.getItem(LAVISH_RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      // Migrate the old string[] format (bare file paths) to the object shape.
      .map((e) => (typeof e === "string" ? { kind: "file", path: e } : e))
      .filter((e) =>
        e && (e.kind === "file" ? typeof e.path === "string" && e.path : e.kind === "paste" ? typeof e.html === "string" && e.html : false)
      );
  } catch {
    return [];
  }
}

function persistLavishRecents() {
  try {
    localStorage.setItem(LAVISH_RECENT_KEY, JSON.stringify(lavishRecents));
  } catch {
    // localStorage unavailable/full - recents just won't persist this run.
  }
}

function addLavishFileRecent(path) {
  if (!path) {
    return;
  }
  lavishRecents = [{ kind: "file", path }, ...lavishRecents.filter((e) => !(e.kind === "file" && e.path === path))].slice(0, LAVISH_RECENT_MAX);
  persistLavishRecents();
}

function addLavishPasteRecent(html) {
  if (!html) {
    return;
  }
  // Re-pasting identical HTML reuses its existing label and just moves it to
  // the front; a new paste gets the next "Pasted mockup N" number.
  const existing = lavishRecents.find((e) => e.kind === "paste" && e.html === html);
  let label;
  if (existing) {
    label = existing.label;
  } else {
    const maxN = lavishRecents.reduce((m, e) => {
      const match = e.kind === "paste" && /(\d+)\s*$/.exec(e.label || "");
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    label = `Pasted mockup ${maxN + 1}`;
  }
  lavishRecents = [{ kind: "paste", html, label }, ...lavishRecents.filter((e) => !(e.kind === "paste" && e.html === html))].slice(0, LAVISH_RECENT_MAX);
  persistLavishRecents();
}

let lavishRecents = loadLavishRecents();

// Build a mockup's sandboxed srcdoc, load it into the Plan (Lavish) review
// surface, switch to the Plan view, and render it ready for annotation. Shared
// by the manual "Load mockup" button and openMockupFileInPlan (the hook a
// generated-mockup flow calls), so "generate a mockup -> annotate it in Plan"
// is one action rather than a copy-paste round-trip. Returns { ok } or
// { ok: false, error }.
async function openMockupInPlan(html) {
  const built = await window.helm.buildArtifactSrcdoc(html);
  if (!built || !built.ok) {
    return { ok: false, error: built?.error || "unknown error" };
  }
  lavishState.srcdoc = built.srcdoc;
  lavishState.annotations = [];
  lavishState.domSnapshot = "";
  lavishState.annotateMode = true;
  lavishState.loadError = "";
  // Mirror the loaded mockup's HTML back into the textarea - whether it came
  // from a paste, a file, or a Recent click - so it's visible and editable for
  // a tweak-and-reload, not just rendered in the iframe below.
  lavishState.pastedHtml = html;
  // navigateToPage("lavish") re-renders the Plan page itself, so the mockup
  // shows even if the caller was on another view (the IPC hook below).
  navigateToPage("lavish");
  return { ok: true };
}

// Open a mockup that already exists as an HTML file (by absolute path) straight
// in the Plan view - the entry point for a generated artifact. Reads the file,
// then hands off to openMockupInPlan. Returns { ok } / { ok: false, error }.
async function openMockupFileInPlan(filePath) {
  const res = await window.helm.readArtifactFile(filePath);
  if (!res || !res.ok) {
    return { ok: false, error: res?.error || "unknown error" };
  }
  const built = await openMockupInPlan(res.html);
  if (built.ok) {
    addLavishFileRecent(filePath);
  }
  return built;
}

// Hook for opening a generated mockup straight in the Plan view: main sends
// "plan:openMockup" with { filePath } (a mockup written to disk) or { html }.
// This is the connection point the artifact-generation-during-planning flow
// will call so a generated vision-mockup lands in the annotator in one step;
// nothing sends it yet, so it's inert until that flow is wired.
if (window.helm.onOpenMockup) {
  window.helm.onOpenMockup(async (payload = {}) => {
    const { filePath, html } = payload;
    let res;
    if (html) {
      res = await openMockupInPlan(html);
    } else if (filePath) {
      res = await openMockupFileInPlan(filePath);
    } else {
      res = { ok: false, error: "no filePath or html in plan:openMockup" };
    }
    if (!res.ok) {
      lavishState.loadError = "Failed to open mockup: " + res.error;
      navigateToPage("lavish");
    }
  });
}

function renderLavishPage() {
  const page = document.getElementById("lavishPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Plan";
  page.append(header);

  const intro = document.createElement("div");
  intro.className = "analysis-totals";
  intro.textContent =
    "Draft / first pass. Load an HTML mockup, toggle annotate mode, click any element and type feedback on it. Each annotation is captured as structured data; 'Send to composer' / 'Copy feedback' turn them into one agent-ready text block.";
  page.append(intro);

  // ---- Load form: paste HTML, or point at a file path ----
  const form = document.createElement("div");
  form.className = "goal-form lavish-form";

  const htmlLabel = document.createElement("label");
  htmlLabel.className = "goal-field-label";
  htmlLabel.textContent = "Artifact HTML (paste a mockup)";
  const htmlInput = document.createElement("textarea");
  htmlInput.className = "goal-textarea lavish-html-input";
  htmlInput.placeholder = "Paste the HTML of a plan mockup here…";
  htmlInput.rows = 5;
  // Persist across re-renders (loading a mockup re-renders this page) so the
  // pasted HTML isn't wiped the moment you click Load - you can tweak + reload.
  htmlInput.value = lavishState.pastedHtml || "";
  htmlInput.addEventListener("input", () => {
    lavishState.pastedHtml = htmlInput.value;
  });

  const pathLabel = document.createElement("label");
  pathLabel.className = "goal-field-label";
  pathLabel.textContent = "…or load from a file path";
  const pathRow = document.createElement("div");
  pathRow.className = "goal-cwd-row";
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.className = "cwd-input";
  pathInput.placeholder = "Absolute path to an .html file";
  const pickBtn = document.createElement("button");
  pickBtn.className = "icon-btn";
  pickBtn.textContent = "…";
  pickBtn.title = "Pick an HTML file";
  pickBtn.addEventListener("click", async () => {
    const files = await window.helm.pickFiles();
    if (files && files.length) {
      pathInput.value = files[0];
    }
  });
  pathRow.append(pathInput, pickBtn);

  // ---- Recent mockups: last few loads (file or pasted), one click to reload ----
  let recentSection = null;
  if (lavishRecents.length > 0) {
    recentSection = document.createElement("div");
    recentSection.className = "lavish-recent";
    const recentLabel = document.createElement("div");
    recentLabel.className = "goal-field-hint lavish-recent-label";
    recentLabel.textContent = "Recent";
    recentSection.append(recentLabel);
    lavishRecents.forEach((entry) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "text-btn lavish-recent-row";
      if (entry.kind === "file") {
        row.title = entry.path;
        row.textContent = entry.path.split(/[\\/]/).pop();
      } else {
        row.title = "Pasted HTML mockup";
        row.textContent = entry.label || "Pasted mockup";
      }
      row.addEventListener("click", async () => {
        lavishState.loadError = "";
        const res = entry.kind === "file" ? await openMockupFileInPlan(entry.path) : await openMockupInPlan(entry.html);
        if (!res.ok) {
          lavishState.loadError = "Failed to build mockup: " + res.error;
          renderLavishPage();
        }
      });
      recentSection.append(row);
    });
  }

  const err = document.createElement("div");
  err.className = "goal-error";
  err.textContent = lavishState.loadError || "";

  const actionRow = document.createElement("div");
  actionRow.className = "goal-action-row";
  const loadBtn = document.createElement("button");
  loadBtn.className = "goal-start-btn";
  loadBtn.textContent = "Load mockup";
  loadBtn.addEventListener("click", async () => {
    lavishState.loadError = "";
    const html = htmlInput.value.trim();
    const filePath = pathInput.value.trim();
    let res;
    if (html) {
      res = await openMockupInPlan(html);
      // A pasted mockup has no path to remember, but keep the HTML itself as a
      // recent so it's still one click to reload (see addLavishPasteRecent).
      if (res.ok) {
        addLavishPasteRecent(html);
      }
    } else if (filePath) {
      res = await openMockupFileInPlan(filePath);
    } else {
      lavishState.loadError = "Paste HTML or pick a file first.";
      renderLavishPage();
      return;
    }
    if (!res.ok) {
      lavishState.loadError = "Failed to build mockup: " + res.error;
      renderLavishPage();
    }
  });
  actionRow.append(loadBtn);
  form.append(htmlLabel, htmlInput, pathLabel, pathRow);
  if (recentSection) {
    form.append(recentSection);
  }
  form.append(err, actionRow);
  page.append(form);

  if (!lavishState.srcdoc) {
    return;
  }

  // ---- Review surface: sandboxed iframe + annotate toggle ----
  const reviewBar = document.createElement("div");
  reviewBar.className = "lavish-review-bar";

  const modeToggle = document.createElement("button");
  modeToggle.className = "text-btn lavish-mode-toggle";
  const setToggleLabel = () => {
    modeToggle.textContent = lavishState.annotateMode ? "Annotate mode: ON" : "Annotate mode: OFF";
    modeToggle.classList.toggle("active", lavishState.annotateMode);
  };
  setToggleLabel();
  modeToggle.addEventListener("click", () => {
    lavishState.annotateMode = !lavishState.annotateMode;
    setToggleLabel();
    postToLavishFrame({ type: "lavish:setAnnotationMode", enabled: lavishState.annotateMode });
  });
  reviewBar.append(modeToggle);

  const hint = document.createElement("span");
  hint.className = "lavish-review-hint";
  hint.textContent = "Click an element in the mockup below and type feedback on it.";
  reviewBar.append(hint);
  page.append(reviewBar);

  const frame = document.createElement("iframe");
  frame.id = "lavishFrame";
  frame.className = "lavish-frame";
  // Sandboxed: scripts run (needed for the SDK) but no same-origin, no
  // top-navigation, no popups — the mockup can't reach app internals.
  frame.setAttribute("sandbox", "allow-scripts");
  // Load as a data: URL, NOT srcdoc: a srcdoc document inherits the app's own
  // strict CSP (default-src 'self'), which blocks the inline annotation SDK. A
  // framed data: URL is a separate browsing context governed only by the CSP
  // embedded in the document itself (see buildArtifactSrcdoc), so the SDK runs.
  frame.src = "data:text/html;charset=utf-8," + encodeURIComponent(lavishState.srcdoc);
  page.append(frame);

  // Stable wrapper for the collected annotations + actions. Rendered by
  // renderLavishCollected() so a NEW annotation (or Clear) refreshes only this
  // region — crucially NOT the iframe above, which would otherwise reload the
  // mockup and reset the SDK on every click.
  const collectedWrap = document.createElement("div");
  collectedWrap.id = "lavishCollectedWrap";
  page.append(collectedWrap);
  renderLavishCollected();
}

// Render just the collected-annotations list + feedback actions into the
// stable #lavishCollectedWrap, leaving the iframe intact.
function renderLavishCollected() {
  const wrap = document.getElementById("lavishCollectedWrap");
  if (!wrap) {
    return;
  }
  wrap.innerHTML = "";

  // ---- Collected annotations ----
  const collected = document.createElement("div");
  collected.className = "lavish-collected";
  const collHead = document.createElement("div");
  collHead.className = "goal-status-line";
  collHead.textContent = `Collected annotations (${lavishState.annotations.length})`;
  collected.append(collHead);

  if (lavishState.annotations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "goal-iter-summary";
    empty.textContent = "No annotations yet.";
    collected.append(empty);
  } else {
    lavishState.annotations.forEach((a, i) => {
      collected.append(lavishAnnotationCard(a, i));
    });
  }
  wrap.append(collected);

  // ---- Actions on the collected feedback ----
  const feedbackActions = document.createElement("div");
  feedbackActions.className = "goal-action-row lavish-feedback-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "goal-start-btn";
  copyBtn.textContent = "Copy feedback";
  copyBtn.disabled = lavishState.annotations.length === 0;
  copyBtn.addEventListener("click", async () => {
    const text = await lavishFormatText();
    if (text) {
      await window.helm.copyToClipboard(text);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy feedback"), 1500);
    }
  });

  const sendBtn = document.createElement("button");
  sendBtn.className = "goal-start-btn";
  sendBtn.textContent = "Send to composer";
  sendBtn.title = "Drop the formatted feedback into the focused chat composer";
  sendBtn.disabled = lavishState.annotations.length === 0;
  sendBtn.addEventListener("click", async () => {
    const text = await lavishFormatText();
    if (!text) {
      return;
    }
    // Drop into the focused pane's composer on the Chat page. NEXT-PASS: start
    // a fresh rooted session directly with this as the prompt (noted deferred).
    const paneEl = document.querySelector(`.pane[data-pane="${focusedPaneIndex}"]`);
    const promptEl = paneEl?.querySelector(".pane-composer textarea");
    if (promptEl) {
      promptEl.value = promptEl.value ? promptEl.value + "\n\n" + text : text;
      promptEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // Also copy, so it's usable even if the user isn't looking at the composer.
    await window.helm.copyToClipboard(text);
    // Jump to the Chat page so the composer is visible with the feedback in it.
    navigateToPage("chat");
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "goal-cancel-btn";
  clearBtn.textContent = "Clear";
  clearBtn.disabled = lavishState.annotations.length === 0;
  clearBtn.addEventListener("click", () => {
    lavishState.annotations = [];
    renderLavishCollected();
  });

  feedbackActions.append(sendBtn, copyBtn, clearBtn);
  wrap.append(feedbackActions);
}

function lavishAnnotationCard(a, index) {
  const card = document.createElement("div");
  card.className = "goal-iter-card lavish-annotation-card-row";

  const head = document.createElement("div");
  head.className = "goal-iter-head";
  const num = document.createElement("span");
  num.className = "goal-iter-num";
  num.textContent = `#${index + 1}`;
  const badge = document.createElement("span");
  badge.className = "goal-iter-badge";
  badge.textContent = a.lavishId ? `data-lavish-id=${a.lavishId}` : a.selector || a.tag || "(element)";
  head.append(num, badge);
  card.append(head);

  if (a.text) {
    const ctx = document.createElement("div");
    ctx.className = "goal-iter-sublabel";
    ctx.textContent = `"${a.text}"`;
    card.append(ctx);
  }

  const prompt = document.createElement("div");
  prompt.className = "goal-iter-summary";
  prompt.textContent = a.prompt || "";
  card.append(prompt);

  const removeBtn = document.createElement("button");
  removeBtn.className = "text-btn lavish-remove-btn";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    lavishState.annotations.splice(index, 1);
    renderLavishCollected();
  });
  card.append(removeBtn);

  return card;
}

// Format the collected annotations + DOM snapshot into an agent-ready block.
// Delegates to main (single source of truth in lib/lavishSdk.js).
async function lavishFormatText() {
  const res = await window.helm.formatAnnotations(lavishState.annotations, lavishState.domSnapshot);
  return res && res.ok ? res.text : "";
}

function postToLavishFrame(msg) {
  const frame = document.getElementById("lavishFrame");
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(msg, "*");
  }
}

// The SDK inside the sandboxed iframe posts annotation records + snapshots to
// window.parent. Collect them into lavishState. Only react to messages from
// our own artifact frame (payload shape check — the iframe is null-origin, so
// event.source identity is the reliable filter).
window.addEventListener("message", (event) => {
  const msg = event.data || {};
  const frame = document.getElementById("lavishFrame");
  if (!frame || event.source !== frame.contentWindow) {
    return;
  }
  if (msg.type === "lavish:ready") {
    if (typeof msg.snapshot === "string") {
      lavishState.domSnapshot = msg.snapshot;
    }
    return;
  }
  if (msg.type === "lavish:queuePrompt" && msg.prompt && msg.prompt.prompt) {
    lavishState.annotations.push(msg.prompt);
    // Refresh ONLY the collected list — never the whole page — so the iframe
    // (and the mockup/SDK state inside it) is left untouched between clicks.
    if (!document.getElementById("lavishPage").classList.contains("hidden")) {
      renderLavishCollected();
    }
    return;
  }
  if (msg.type === "lavish:snapshot" && typeof msg.snapshot === "string") {
    lavishState.domSnapshot = msg.snapshot;
  }
});

// ============================== Routines page ==============================
// Read-only view over Claude Code's OWN scheduled tasks (files under
// ~/.claude/scheduled-tasks/, one folder per task with a SKILL.md). Helm
// does NOT run a scheduler of its own here - this page only lists what
// already exists on disk, via routines:list (see lib/routines.js). A
// Helm-native routine type is a real idea (PLAN.md) but is not built in
// this pass; it is shown below as a clearly-marked "(coming)" placeholder
// rather than faked with invented schedule data.

async function renderRoutinesPage() {
  const page = document.getElementById("routinesPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Routines";
  page.append(header);

  const intro = document.createElement("div");
  intro.className = "analysis-totals";
  intro.textContent =
    "Recurring claude -p launches Helm schedules and fires itself. They run while Helm is open; any missed while it was closed fire once on the next startup.";
  page.append(intro);

  const board = document.createElement("section");
  board.className = "dash-board";
  board.append(dashBoardHead("Scheduled routines", null, "Helm-owned · stored in routines.json"));

  const body = document.createElement("div");
  body.className = "dash-board-body";
  board.append(body);
  page.append(board);

  const res = await window.helm.listRoutines();
  // The page may have been navigated away from while the read was in flight;
  // avoid clobbering whatever the user is looking at now.
  if (page.classList.contains("hidden")) {
    return;
  }
  const routines = res && res.ok ? res.routines : [];
  if (!routines.length) {
    body.append(dashEmpty("No routines yet - add one below."));
  } else {
    const list = document.createElement("div");
    list.className = "dash-queue-list";
    routines.forEach((r) => list.append(routineRowEl(r)));
    body.append(list);
  }

  // Always-present "add a routine" form below the list.
  page.append(routineFormEl(null));
}

function routineNextLabel(ts) {
  if (!ts) {
    return "not scheduled";
  }
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function routineRowEl(routine) {
  const row = document.createElement("div");
  row.className = "dash-queue-row" + (routine.enabled ? "" : " routine-disabled");

  const ic = document.createElement("div");
  ic.className = "dash-state-ic";
  ic.textContent = "⏰";
  row.append(ic);

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = routine.name;
  const tag = document.createElement("span");
  tag.className = "dash-goal-tag";
  tag.textContent = routine.cron;
  // Which model this routine runs under (f76ebb76): explicit, so an unset one
  // reads as "Default model" rather than looking like nothing was chosen.
  const modelChip = document.createElement("span");
  modelChip.className = "dash-goal-tag routine-model-tag";
  const mopt = flattenModelOptions(ROUTINE_MODEL_OPTIONS).find((o) => o.value === (routine.model || ""));
  modelChip.textContent = routine.model ? (mopt ? mopt.label : routine.model) : "Default model";
  top.append(title, tag, modelChip);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  why.textContent = routine.enabled
    ? `next ${routineNextLabel(routine.nextRunAt)}${routine.lastRunAt ? ` · last ${relTime(routine.lastRunAt)}` : ""}`
    : "disabled";
  qbody.append(why);
  row.append(qbody);

  const actions = document.createElement("div");
  actions.className = "dash-queue-actions";

  const toggle = document.createElement("button");
  toggle.className = "text-btn";
  toggle.textContent = routine.enabled ? "Disable" : "Enable";
  toggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    await window.helm.updateRoutine(routine.id, { enabled: !routine.enabled });
    renderRoutinesPage();
  });

  const runBtn = document.createElement("button");
  runBtn.className = "text-btn";
  runBtn.textContent = "Run now";
  runBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await window.helm.runRoutineNow(routine.id);
    showToast(`Running "${routine.name}"…`);
  });

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    row.replaceWith(routineFormEl(routine));
  });

  const delBtn = document.createElement("button");
  delBtn.className = "text-btn danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    customConfirm(`Delete routine "${routine.name}"?`, "Delete", async () => {
      await window.helm.removeRoutine(routine.id);
      renderRoutinesPage();
    });
  });

  actions.append(toggle, runBtn, editBtn, delBtn);
  row.append(actions);
  return row;
}

// Add/edit form for a routine. `routine` null -> create; else edit in place.
// Model / effort choices for a routine. "" = Default, i.e. Helm passes no
// --model/--effort and the Claude CLI uses whatever it's configured to (f76ebb76
// "vad är default?"). Reuses the shared model menu (submenu and all) so a routine
// can pick the same set of models as the composer, with "Default" on top.
const ROUTINE_MODEL_OPTIONS = [{ value: "", label: "Default (CLI model)" }, ...MODEL_MENU_OPTIONS];
/** Flatten a possibly-submenu'd option list to its leaves, for a label lookup. */
function flattenModelOptions(options) {
  return options.flatMap((o) => (o.submenu ? o.submenu : [o]));
}
const ROUTINE_EFFORT_OPTIONS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
// Friendly presets so a routine doesn't need raw cron (e7968b37). Each fills the
// cron field; the raw input stays for anything custom. Numeric 5-field cron to
// match cron.js (min hour day-of-month month day-of-week).
const CRON_PRESETS = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 08:00", cron: "0 8 * * *" },
  { label: "Weekdays 08:00", cron: "0 8 * * 1-5" },
  { label: "Weekly (Mon 08:00)", cron: "0 8 * * 1" },
  { label: "Monthly (1st 08:00)", cron: "0 8 1 * *" },
];

function routineFormEl(routine) {
  const isEdit = !!routine;
  const form = document.createElement("div");
  form.className = "routine-form";

  const heading = document.createElement("div");
  heading.className = "routine-form-title";
  heading.textContent = isEdit ? `Edit "${routine.name}"` : "Add a routine";
  form.append(heading);

  const field = (label, el) => {
    const wrap = document.createElement("label");
    wrap.className = "routine-field";
    const lab = document.createElement("span");
    lab.textContent = label;
    wrap.append(lab, el);
    return wrap;
  };
  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.value = routine?.name || "";
  nameIn.placeholder = "Weekly health check";
  const cronIn = document.createElement("input");
  cronIn.type = "text";
  cronIn.value = routine?.cron || "";
  cronIn.placeholder = "0 8 * * 1   (min hour day-of-month month day-of-week)";
  const cwdIn = document.createElement("input");
  cwdIn.type = "text";
  cwdIn.value = routine?.cwd || "";
  cwdIn.placeholder = "Repo folder (optional; defaults to your first mate's home base)";
  const promptIn = document.createElement("textarea");
  promptIn.rows = 3;
  promptIn.value = routine?.prompt || "";
  promptIn.placeholder = "What to run, e.g. /health-coach";

  // Quick cron presets (e7968b37): click to fill the cron field; raw input stays.
  const presetRow = document.createElement("div");
  presetRow.className = "routine-cron-presets";
  CRON_PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cron-preset-btn";
    b.textContent = p.label;
    b.title = p.cron;
    b.addEventListener("click", () => {
      cronIn.value = p.cron;
    });
    presetRow.append(b);
  });

  // Model / effort (f76ebb76). Default = leave unset -> CLI's own model.
  const modelPill = dropdownPill(routine?.model || "", ROUTINE_MODEL_OPTIONS, () => {});
  const effortPill = dropdownPill(routine?.effort || "", ROUTINE_EFFORT_OPTIONS, () => {});

  form.append(
    field("Name", nameIn),
    field("Schedule (cron)", cronIn),
    presetRow,
    field("Model", modelPill.el),
    field("Effort", effortPill.el),
    field("Folder", cwdIn),
    field("Prompt", promptIn)
  );

  const err = document.createElement("div");
  err.className = "routine-form-err";
  form.append(err);

  const actions = document.createElement("div");
  actions.className = "routine-form-actions";
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = isEdit ? "Save" : "Add routine";
  save.addEventListener("click", async () => {
    err.textContent = "";
    const spec = {
      name: nameIn.value.trim(),
      cron: cronIn.value.trim(),
      cwd: cwdIn.value.trim(),
      prompt: promptIn.value.trim(),
      model: modelPill.value,
      effort: effortPill.value,
    };
    if (!spec.name || !spec.cron || !spec.prompt) {
      err.textContent = "Name, schedule and prompt are all required.";
      return;
    }
    const res = isEdit ? await window.helm.updateRoutine(routine.id, spec) : await window.helm.createRoutine(spec);
    if (!res || !res.ok) {
      err.textContent = res?.error || "Could not save (check the cron format).";
      return;
    }
    renderRoutinesPage();
  });
  actions.append(save);
  if (isEdit) {
    const cancel = document.createElement("button");
    cancel.className = "text-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => renderRoutinesPage());
    actions.append(cancel);
  }
  form.append(actions);
  return form;
}

// ============================== Analysis page ==============================
// Replaces the earlier popup versions of Skills/Usage — those rendered via
// submenus that could overflow off-screen near the window edge, and the captain
// asked for a real page he can switch to rather than staying on the prompt
// page. Combines both into one page with simple hand-rolled bar charts (no
// charting dependency needed for this).

// Gear glyph for the header Settings button — currentColor stroke so it
// inherits .icon-btn's normal/hover/.active text color, sized to sit inside
// the .icon-btn box, matching the MIC/GLOBE/DOCUMENT icon conventions above.
const GEAR_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="3"/>' +
  '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
  "</svg>";
document.getElementById("settingsGear").innerHTML = GEAR_ICON;

// Which pages belong to the Dashboard primary tab (the "work" facets). The
// primary Dashboard button is shown/activated as a group across all of these,
// not by exact page match. "focus" now has its own #dashboardSubnav button (so
// the captain can't get stranded there after a goal-card click-through) and
// counts toward the group so the primary tab stays lit while viewing it. Skills
// (analysis) and Archive are reached from their own #headerUtilityNav, not
// the Settings/gear group.
const DASHBOARD_FACET_PAGES = ["dashboard", "goal", "routines", "review"];

// Single source of truth for page navigation. Everything (the primary bar,
// the gear, the sub-nav, and every programmatic jump) routes through here, so
// navigation no longer depends on a button physically existing in #pageToggle.
// Walk the app-level view history (dir -1 back, +1 forward). No-op at an end.
function appNavigateView(dir) {
  const next = viewNavIndex + dir;
  if (next < 0 || next >= viewNavStack.length) {
    return;
  }
  viewNavIndex = next;
  navigateToPage(viewNavStack[next], { fromHistory: true });
}

// Embedded Jot tab (one Jot, two mounts): mount Jot's BUILT renderer in a webview
// backed by @jot/core in Helm's main. Created once and kept alive across tab
// switches (so its scroll/state persist); main-side host store + IPC bridge are
// wired before the webview loads, so window.jot resolves immediately.
let jotWebviewCreated = false;
async function renderJotPage() {
  const container = document.getElementById("jotPage");
  if (jotWebviewCreated) {
    return;
  }
  container.innerHTML = "";
  let mount;
  let paths;
  try {
    mount = await window.helm.jotMount();
    paths = await window.helm.jotPaths();
  } catch (err) {
    mount = { ok: false, error: err.message };
    paths = { ok: false };
  }
  if (!mount?.ok || !paths?.ok) {
    const msg = document.createElement("div");
    msg.className = "pane-empty";
    msg.style.padding = "28px";
    msg.textContent = paths?.error || mount?.error || "Couldn't load Jot.";
    container.append(msg);
    return;
  }
  const wv = document.createElement("webview");
  wv.setAttribute("src", paths.src);
  wv.setAttribute("preload", paths.preload);
  wv.setAttribute("partition", "persist:jot");
  wv.style.width = "100%";
  wv.style.height = "100%";
  wv.style.border = "0";
  container.style.height = "calc(100vh - 60px)";
  container.append(wv);
  jotWebviewCreated = true;
}

// Has the user chosen a page yet? Startup finishes with a navigate to the
// dashboard, but it does that AFTER awaiting the first session refresh, which on a
// real board takes seconds. Anything you clicked during that window - the settings
// gear especially - was silently undone as the app snapped back to the dashboard,
// with nothing on screen to explain it. Startup now yields to a choice you already
// made. (Found on 2026-08-02: it made test-settings-groups fail two runs in three,
// which is the same thing happening to a person who clicks quickly.)
let userChosePage = false;

function navigateToPage(page, opts = {}) {
  if (opts.startup && userChosePage) {
    return;
  }
  if (!opts.startup && !opts.fromHistory) {
    userChosePage = true;
  }
  // Local, content-free usage analytics: record the view visit so the Analysis
  // page can show which views + navigation paths you actually use. Fire-and-
  // forget; never let analytics affect navigation.
  try {
    window.helm.trackUsage({ type: "nav", page });
  } catch {
    // best-effort
  }
  // App-level view history for the mouse back/forward buttons (see the mouseup
  // handler). Skip when THIS call is itself a history nav, and collapse repeats.
  if (!opts.fromHistory && viewNavStack[viewNavIndex] !== page) {
    viewNavStack = viewNavStack.slice(0, viewNavIndex + 1);
    viewNavStack.push(page);
    viewNavIndex = viewNavStack.length - 1;
  }
  document.getElementById("chatPage").classList.toggle("hidden", page !== "chat");
  document.getElementById("dashboardPage").classList.toggle("hidden", page !== "dashboard");
  document.getElementById("jotPage").classList.toggle("hidden", page !== "jot");
  document.getElementById("goalPage").classList.toggle("hidden", page !== "goal");
  document.getElementById("lavishPage").classList.toggle("hidden", page !== "lavish");
  document.getElementById("routinesPage").classList.toggle("hidden", page !== "routines");
  document.getElementById("reviewPage").classList.toggle("hidden", page !== "review");
  document.getElementById("analysisPage").classList.toggle("hidden", page !== "analysis");
  document.getElementById("archivePage").classList.toggle("hidden", page !== "archive");
  document.getElementById("settingsPage").classList.toggle("hidden", page !== "settings");

  // Chat-specific controls (Simple/Advanced view mode, split-view, background
  // tasks) live in the primary pane's header (see paneHeaderEl), inside
  // #chatPage - so they're hidden with the whole chat view off-Chat and need no
  // explicit toggle here. Keeping them out of the top header means the primary
  // tabs never shift when switching views.

  // Primary bar active state is group-aware: clicking a sub-nav facet (e.g.
  // Goal) must keep the Dashboard primary tab lit, not deactivate it.
  const inDashboardGroup = DASHBOARD_FACET_PAGES.includes(page);
  document.querySelectorAll("#pageToggle button").forEach((b) => {
    const bp = b.dataset.page;
    b.classList.toggle("active", bp === "dashboard" ? inDashboardGroup : bp === page);
  });

  // Gear = active only for Settings itself; Skills/Archive now live in their
  // own header utility nav (below) rather than the gear's group.
  document.getElementById("settingsGear").classList.toggle("active", page === "settings");

  // Header utility nav (Skills/Archive): its own buttons match exactly.
  document
    .querySelectorAll("#headerUtilityNav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));

  // Sub-nav: visible only within the Dashboard group; its buttons match exactly
  // (including "focus" now, so it highlights while viewing a goal's focus page).
  const subnav = document.getElementById("dashboardSubnav");
  subnav.classList.toggle("hidden", !inDashboardGroup);
  subnav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));

  // Landing on the facet that actually shows the failed/paused run is what
  // counts as "seen" - clears the attention dot from updateGoalAttentionBadge.
  if (page === "goal") {
    unseenGoalAttention.clear();
    updateGoalAttentionBadge();
  }

  if (page === "dashboard") {
    renderDashboardPage();
  } else if (page === "jot") {
    renderJotPage();
    } else if (page === "goal") {
    renderGoalPage();
  } else if (page === "lavish") {
    renderLavishPage();
  } else if (page === "routines") {
    renderRoutinesPage();
  } else if (page === "review") {
    renderReviewPage();
  } else if (page === "analysis") {
    renderAnalysisPage();
  } else if (page === "archive") {
    renderArchivePage();
  } else if (page === "settings") {
    renderSettingsPage();
  }
}

// Delegate all nav surfaces (primary bar + dashboard sub-nav) to
// navigateToPage — they all carry data-page buttons.
function wirePageNav(containerId) {
  document.getElementById(containerId).addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-page]");
    if (!btn) {
      return;
    }
    navigateToPage(btn.dataset.page);
  });
}
wirePageNav("pageToggle");
wirePageNav("dashboardSubnav");
wirePageNav("headerUtilityNav");
document.getElementById("settingsGear").addEventListener("click", () => navigateToPage("settings"));

// The window is frameless, so the header's three buttons are the title bar.
document.querySelectorAll("[data-window]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const which = btn.dataset.window;
    if (which === "minimize") {
      window.helm.minimizeWindow();
    } else if (which === "maximize") {
      window.helm.toggleMaximizeWindow();
    } else {
      window.helm.closeWindow();
    }
  });
});

// ============================== Settings page ==============================

function settingsGroupHeading(text) {
  const h = document.createElement("h3");
  h.className = "settings-group-heading";
  h.textContent = text;
  return h;
}

function settingsToggleRow(title, desc, checked, onChange) {
  const row = document.createElement("label");
  row.className = "settings-toggle-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => onChange(checkbox.checked));
  const labelText = document.createElement("div");
  labelText.className = "settings-toggle-text";
  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  titleEl.className = "settings-toggle-title";
  const descEl = document.createElement("div");
  descEl.className = "settings-toggle-desc";
  descEl.textContent = desc;
  labelText.append(titleEl, descEl);
  row.append(checkbox, labelText);
  return row;
}

// A place to actually get sessions back — "Remove from Helm" and
// "Archive" both used to be one-way (restorable only by hand-editing
// config.json / knowing to look). Reads the same state.sessions/state.config
// refresh() already keeps current; no separate IPC needed.
function renderArchivePage() {
  const page = document.getElementById("archivePage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Archive";
  page.append(header);

  // Search box (with a clear button) — the archive can accumulate a lot of
  // sessions and there was no way to find one. Mirrors the sidebar search.
  const searchWrap = document.createElement("div");
  searchWrap.className = "archive-search";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "search";
  searchInput.placeholder = "Search archived sessions…";
  searchInput.value = archiveSearchTerm;
  searchInput.addEventListener("input", (e) => {
    archiveSearchTerm = e.target.value.trim().toLowerCase();
    renderArchivePage();
    // Re-focus + restore caret to end after the re-render replaced the node.
    const fresh = document.querySelector(".archive-search input");
    if (fresh) {
      fresh.focus();
      fresh.setSelectionRange(fresh.value.length, fresh.value.length);
    }
  });
  searchWrap.append(searchInput);
  const clearBtn = document.createElement("button");
  clearBtn.className = "icon-btn";
  clearBtn.textContent = "✕";
  clearBtn.title = "Clear search";
  clearBtn.disabled = archiveSearchTerm === "";
  clearBtn.addEventListener("click", () => {
    archiveSearchTerm = "";
    renderArchivePage();
    const fresh = document.querySelector(".archive-search input");
    if (fresh) {
      fresh.focus();
    }
  });
  searchWrap.append(clearBtn);
  page.append(searchWrap);

  const matchesArchiveSearch = (s) => {
    if (!archiveSearchTerm) {
      return true;
    }
    return (
      (s.title || "").toLowerCase().includes(archiveSearchTerm) ||
      (s.cwd || "").toLowerCase().includes(archiveSearchTerm)
    );
  };

  const archived = state.sessions.filter((s) => s.isArchived).filter(matchesArchiveSearch);
  const hiddenIds = state.config.hiddenSessions || [];
  // Excludes anything also archived — the two flags are independent, so a
  // session could be both, and listing it (with two unrelated "get it back"
  // actions) in both sections at once would just be confusing. Archived is
  // the more definitive state; unarchiving it is enough to see it again here
  // even if it's still separately hidden from Helm's own sidebar view.
  const hidden = hiddenIds
    .map(sessionById)
    .filter(Boolean)
    .filter((s) => !s.isArchived)
    .filter(matchesArchiveSearch);

  const grid = document.createElement("div");
  grid.className = "analysis-grid";
  grid.append(
    archiveSectionEl("Archived sessions", archived, "No archived sessions.", (session) =>
      archiveRowEl(session, "Unarchive", () => unarchiveSession(session))
    ),
    archiveSectionEl("Removed from Helm", hidden, "Nothing hidden.", (session) =>
      archiveRowEl(session, "Restore", () => restoreToHelm(session))
    )
  );
  page.append(grid);
}

function archiveSectionEl(title, sessions, emptyText, rowFactory) {
  const block = document.createElement("div");
  block.className = "analysis-block";
  const h = document.createElement("h3");
  h.textContent = `${title} · ${sessions.length}`;
  block.append(h);
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = emptyText;
    block.append(empty);
  } else {
    sortByAttention(sessions).forEach((s) => block.append(rowFactory(s)));
  }
  return block;
}

function archiveRowEl(session, actionLabel, onAction) {
  const row = document.createElement("div");
  row.className = "archive-row";
  const info = document.createElement("div");
  info.className = "archive-row-info";
  const title = document.createElement("div");
  title.className = "archive-row-title";
  title.textContent = sessionDisplayName(session);
  const meta = document.createElement("div");
  meta.className = "archive-row-meta";
  meta.textContent = `${session.cwd || "no folder"} · last active ${relTime(session.lastActivityAt)}`;
  info.append(title, meta);
  const action = document.createElement("button");
  action.className = "text-btn";
  action.textContent = actionLabel;
  action.addEventListener("click", onAction);
  row.append(info, action);
  return row;
}

// Runs the CLI's real browser sign-in via main, shared by the Settings button
// and the shortcut that appears on an auth failure in chat (task 3218cdd4). One
// implementation so both surfaces behave identically. `onResolved` lets a caller
// refresh whatever status readout it owns once the flow ends.
let signInInFlight = false;
async function runSignInFlow(onResolved) {
  if (signInInFlight) {
    showNotice("A sign-in is already in progress - finish it in the browser window that opened.");
    return;
  }
  signInInFlight = true;
  // Capture the OAuth URL as the CLI prints it, so a browser that didn't open on
  // its own still leaves the user a way in.
  let capturedUrl = null;
  const unsubscribe = window.helm.onAuthLoginOutput((payload) => {
    if (payload?.url && !capturedUrl) {
      capturedUrl = payload.url;
      showNotice("Sign-in opened in your browser. If it didn't open, use the link.", {
        tone: "info",
        actions: [{ label: "Copy sign-in link", onClick: () => window.helm.copyToClipboard(capturedUrl).then(() => showToast("Copied the sign-in link.")) }],
      });
    }
  });
  showNotice("Opening Claude sign-in in your browser…", { tone: "info" });
  try {
    const res = await window.helm.startAuthLogin();
    if (res?.ok) {
      const who = res.status?.email ? ` as ${res.status.email}` : "";
      showToast(`Signed in${who}. New sessions will authenticate again.`);
    } else {
      showNotice(`Sign-in did not complete: ${res?.error || "unknown reason"}`, { tone: "warn" });
    }
    onResolved?.(res);
  } catch (err) {
    showNotice(`Sign-in failed: ${err?.message || String(err)}`, { tone: "warn" });
    onResolved?.({ ok: false, error: String(err) });
  } finally {
    unsubscribe?.();
    signInInFlight = false;
  }
}

// A session that failed because the CLI's login expired is the ONE error a
// captain can fix in one click, so it gets a shortcut rather than just a red
// turn they have to decode (task 3218cdd4). Matches the CLI's own wording
// ("Failed to authenticate", "OAuth session expired") loosely enough to catch
// the variants without firing on unrelated errors that merely contain "auth".
const AUTH_NOTICE_TEXT =
  "A session failed to authenticate - the Claude sign-in has expired. Sign in once and every session works again.";
function maybeSurfaceAuthError(message) {
  const text = String(message || "");
  // Anchor on the CLI's actual auth-FAILURE phrasings, not any co-occurrence of
  // auth words. The success-branch call site feeds ordinary assistant replies
  // through here, so a broad "oauth AND refresh/login/expired" test fired on a
  // session that had merely BUILT an auth feature ("added OAuth login, tokens
  // refresh automatically") - a false "your sign-in expired" alarm, on the very
  // codebase that is used to build Helm (independent review, 2026-08-09). These
  // patterns match the failure the CLI emits, not prose about authentication.
  const isAuthFailure =
    /failed to authenticate/i.test(text) ||
    /authentication failed/i.test(text) ||
    /oauth session (has )?expired/i.test(text) ||
    /session expired and could not be refreshed/i.test(text) ||
    /token (has )?expired and could not be refreshed/i.test(text) ||
    /\b(un|not[- ])authenticated\b/i.test(text) ||
    /\bclaude (auth )?login\b/i.test(text) || // the CLI's own remediation hint
    /please (sign|log) ?-? ?in (again|to continue)/i.test(text);
  if (!isAuthFailure) {
    return;
  }
  // Don't stack duplicates: across several failing turns in one session this
  // fired once per turn. If the same notice is already up (or queued), leave it.
  const already = [...document.querySelectorAll(".notice .notice-text")].some((n) => n.textContent === AUTH_NOTICE_TEXT);
  if (already) {
    return;
  }
  showNotice(AUTH_NOTICE_TEXT, {
    tone: "warn",
    actions: [{ label: "Sign in", onClick: () => runSignInFlow() }],
  });
}

/** A human sentence for an auth status object from `claude auth status --json`. */
function authStatusLine(status) {
  if (!status || status.ok === false) {
    return `Couldn't read sign-in status${status?.error ? `: ${status.error}` : ""}.`;
  }
  if (!status.loggedIn) {
    return "Signed out - sessions will fail to authenticate until you sign in.";
  }
  const parts = [];
  if (status.email) {
    parts.push(status.email);
  }
  if (status.orgName) {
    parts.push(status.orgName);
  }
  if (status.subscriptionType) {
    parts.push(`${status.subscriptionType} plan`);
  }
  return `Signed in${parts.length ? ` — ${parts.join(" · ")}` : ""}.`;
}

// A single full-width horizontal bar at the top of Settings, NOT one of the
// masonry columns. As a .settings-group it took a whole 240px column for one
// row - "extremt fult ... borde inte ta en kolumn" (the captain, task 3218cdd4) - and
// the status line squeezed the button into a three-line "Re- / sign / in". Here
// the status takes the width it needs and the button sits at the end, on one line.
function settingsAccountBar() {
  const bar = document.createElement("div");
  bar.className = "settings-account-bar";

  const info = document.createElement("div");
  info.className = "settings-account-info";
  const label = document.createElement("span");
  label.className = "settings-account-label";
  label.textContent = "Claude sign-in";
  const status = document.createElement("span");
  status.className = "settings-account-status";
  status.textContent = "Checking sign-in status…";
  info.append(label, status);

  const dot = document.createElement("span");
  dot.className = "settings-account-dot";

  const btn = document.createElement("button");
  btn.className = "text-btn settings-account-btn";
  btn.textContent = "Sign in";
  btn.title = "Runs Claude's own browser sign-in (claude auth login). Fixes 'OAuth session expired' for every session at once.";
  const refresh = () => {
    status.textContent = "Checking sign-in status…";
    dot.className = "settings-account-dot";
    window.helm.getAuthStatus().then((s) => {
      status.textContent = authStatusLine(s);
      // Re-label so the affordance matches the state: re-authenticating when
      // already signed in reads as "Re-sign in", not a no-op "Sign in".
      btn.textContent = s?.loggedIn ? "Re-sign in" : "Sign in";
      // A single status dot: green signed-in, amber signed-out, neutral if the
      // status couldn't be read - the state at a glance without reading the line.
      dot.className =
        "settings-account-dot " + (s && s.ok !== false ? (s.loggedIn ? "is-in" : "is-out") : "is-unknown");
    });
  };
  btn.addEventListener("click", () => runSignInFlow(refresh));

  bar.append(dot, info, btn);
  refresh();
  return bar;
}

function renderSettingsPage() {
  const page = document.getElementById("settingsPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Settings";
  page.append(header);

  // Account is a full-width bar directly under the header, not one of the
  // masonry columns below (task 3218cdd4).
  page.append(settingsAccountBar());

  // Skills (analysis) and Archive moved to their own #headerUtilityNav next
  // to the gear (2026-07-06) - reachable in one click, no longer buried here.

  const block = document.createElement("div");
  block.className = "analysis-block settings-block";

  // Passive/observational group: these only read and surface a suggestion or
  // note — they never touch a session on their own.
  const passiveGroup = document.createElement("div");
  passiveGroup.className = "settings-group";
  passiveGroup.append(settingsGroupHeading("Passive — suggests, never acts"));

  passiveGroup.append(
    settingsToggleRow(
      "Notify when a prompt finishes",
      "Shows a native Windows notification (with its default sound) when a session completes a run, so you can switch away while it works.",
      state.config.notifyOnComplete !== false,
      async (checked) => {
        state.config = await window.helm.setConfig({ notifyOnComplete: checked });
      }
    )
  );

  passiveGroup.append(
    settingsToggleRow(
      "Notify when something needs you",
      "Fires an OS notification (and taskbar badge) when a run fails/pauses or a session needs input, only while Helm isn't the focused window - so you can step away.",
      state.config.notifyAttention !== false,
      async (checked) => {
        state.config = await window.helm.setConfig({ notifyAttention: checked });
      }
    )
  );

  passiveGroup.append(
    settingsToggleRow(
      "Suggest archiving idle sessions",
      "Shows an \"Archive?\" pill on idle sessions with no open Jot review/in-progress/open work. Archiving still needs your click — this only surfaces the suggestion, it never archives on its own.",
      state.config.archiveSuggestions?.enabled === true,
      async (checked) => {
        state.config = await window.helm.setConfig({
          archiveSuggestions: { ...(state.config.archiveSuggestions || {}), enabled: checked },
        });
        refresh();
      }
    )
  );

  passiveGroup.append(
    settingsToggleRow(
      "Orchestrator helper",
      "Periodically reads recent messages in idle/waiting sessions (a cheap Haiku call, ~15 min intervals) to tell apart a real open question from a finished answer, or genuinely stuck from genuinely idle. Sharpens the archive suggestion above and shows its read as a small note on the session row. A proposal only — never archives or acts on its own.",
      state.config.orchestratorHelper?.enabled === true,
      async (checked) => {
        state.config = await window.helm.setConfig({
          orchestratorHelper: { ...(state.config.orchestratorHelper || {}), enabled: checked },
        });
        refresh();
      }
    )
  );

  // Liveness readout for the background sweep (runOrchestratorSweep in
  // main.js) driving the two toggles above and auto-compact below — its only
  // visible symptom if it silently stalls would otherwise be "sessions
  // stopped getting tagged", easy to miss. Read once here, no live polling.
  const sweepStatusEl = document.createElement("div");
  sweepStatusEl.className = "settings-toggle-desc settings-sweep-status";
  sweepStatusEl.textContent = "Background sweep: checking…";
  passiveGroup.append(sweepStatusEl);
  window.helm.getSweepStatus().then((status) => {
    if (!status || !status.lastRunAt) {
      sweepStatusEl.textContent = "Background sweep: never run yet";
      return;
    }
    if (status.ok === false) {
      sweepStatusEl.textContent = `Background sweep: last run errored (${relTime(status.lastRunAt)})`;
      return;
    }
    const countNote = status.classifiedCount ? `, classified ${status.classifiedCount}` : "";
    sweepStatusEl.textContent = `Background sweep: last ran ${relTime(status.lastRunAt)}${countNote}`;
  });

  
  // (appended into the two-column layout at the end)

  // Active group: these mutate a session's state on their own, unattended.
  const activeGroup = document.createElement("div");
  activeGroup.className = "settings-group";
  activeGroup.append(settingsGroupHeading("Acts on your data automatically"));

  activeGroup.append(
    settingsToggleRow(
      "Auto-compact large idle sessions",
      `Automatically runs /compact on a session left idle for ~${state.config.autoCompact?.idleMinutes || 10} min whose context has grown past ~${Math.round((state.config.autoCompact?.thresholdTokens || 150000) / 1000)}k tokens (checked on the ~15 min sweep). Time-based, so it won't fire mid-work — only after you've stepped away. Unlike everything else here this ACTS on its own — it summarizes the session's context (lossy, but the full history stays in the transcript on disk). A small note appears on the row after it happens.`,
      state.config.autoCompact?.enabled === true,
      async (checked) => {
        state.config = await window.helm.setConfig({
          autoCompact: { ...(state.config.autoCompact || {}), enabled: checked },
        });
        refresh();
      }
    )
  );

  // (appended into the two-column layout at the end)

  // Config values that exist under the hood but had no UI — surfacing the
  // one with real per-machine variability (voiceEngine: whisper.cpp needs a
  // local CUDA binary+model, not present on every machine, see config.js)
  // so it can be seen/forced without hand-editing config.json. voiceLanguage
  // already has a picker in the composer's mic button, but it's easy to miss
  // there — mirrored here as a durable, discoverable settings entry too.
  const voiceGroup = document.createElement("div");
  voiceGroup.className = "settings-group";
  voiceGroup.append(settingsGroupHeading("Voice transcription"));

  const engineRow = document.createElement("div");
  engineRow.className = "settings-select-row";
  const engineLabel = document.createElement("div");
  engineLabel.className = "settings-toggle-text";
  const engineTitle = document.createElement("div");
  engineTitle.textContent = "Transcription engine";
  engineTitle.className = "settings-toggle-title";
  const engineDesc = document.createElement("div");
  engineDesc.className = "settings-toggle-desc";
  engineDesc.textContent = "\"whisper.cpp\" is faster (needs the local CUDA binary+model, see docs/transcription-research.md) but not every machine has it installed; \"transformers.js\" always works as a fallback.";
  engineLabel.append(engineTitle, engineDesc);
  const engineDD = dropdownPill(
    state.config?.voiceEngine || "whispercpp",
    [
      { value: "whispercpp", label: "whisper.cpp" },
      { value: "transformers", label: "transformers.js" },
    ],
    async (value) => {
      state.config = await window.helm.setConfig({ voiceEngine: value });
    }
  );
  engineRow.append(engineLabel, engineDD.el);
  voiceGroup.append(engineRow);

  const languageRow = document.createElement("div");
  languageRow.className = "settings-select-row";
  const languageLabel = document.createElement("div");
  languageLabel.className = "settings-toggle-text";
  const languageTitle = document.createElement("div");
  languageTitle.textContent = "Default transcription language";
  languageTitle.className = "settings-toggle-title";
  const languageDesc = document.createElement("div");
  languageDesc.className = "settings-toggle-desc";
  languageDesc.textContent = "Same global setting as the mic button's language picker in the composer - changing either one changes both.";
  languageLabel.append(languageTitle, languageDesc);
  const settingsLanguageDD = dropdownPill(
    state.config?.voiceLanguage || "swedish",
    [
      { value: "auto", label: "Auto-detect" },
      { value: "swedish", label: "Svenska" },
      { value: "english", label: "English" },
    ],
    async (value) => {
      state.config = await window.helm.setConfig({ voiceLanguage: value });
    }
  );
  languageRow.append(languageLabel, settingsLanguageDD.el);
  voiceGroup.append(languageRow);

  // Appearance: the app theme (a full CSS var-map swap, applied instantly).
  const appearanceGroup = document.createElement("div");
  appearanceGroup.className = "settings-group";
  appearanceGroup.append(settingsGroupHeading("Appearance"));
  const themeRow = document.createElement("div");
  themeRow.className = "settings-select-row";
  const themeLabel = document.createElement("div");
  themeLabel.className = "settings-toggle-text";
  const themeTitle = document.createElement("div");
  themeTitle.textContent = "Theme";
  themeTitle.className = "settings-toggle-title";
  const themeDesc = document.createElement("div");
  themeDesc.className = "settings-toggle-desc";
  themeDesc.textContent = "The app's color theme. Applies instantly and is remembered. \"Brass\" is a warm light theme; \"Default\" is the dark one.";
  themeLabel.append(themeTitle, themeDesc);
  const themeDD = dropdownPill(
    state.config?.theme || "dark",
    THEMES.map((t) => ({ value: t.id, label: t.label })),
    async (value) => {
      const prev = state.config?.theme || "dark";
      applyTheme(value); // instant, before the round-trip
      state.config = await window.helm.setConfig({ theme: value });
      // Re-theme the mates' identity (names) if the theme family changed
      // (nautical <-> space); no-op within a family. Then repaint the fleet so
      // the new names + icons show.
      await window.helm.rethemeMates(prev, value);
      fillDashboardSections({ force: true });
    }
  );
  themeRow.append(themeLabel, themeDD.el);
  appearanceGroup.append(themeRow);

  // Guardrails: the fleet spend ceiling (Phase-2 orchestration guardrail,
  // orchestrationBudget.js) is Helm's own estimate of what dispatched runs
  // WOULD cost at API rates, used only to stop new dispatch once it's
  // crossed — not a real bill. On a subscription there's nothing to cap by
  // default (the captain, 2026-08-12: "den behövs inte så länge jag har en
  // subscription"), so it's off by default and fully optional; the manual
  // Stop button on the Dashboard (the `killed` flag) is a separate mechanism
  // and keeps working regardless of this toggle.
  const guardrailsGroup = document.createElement("div");
  guardrailsGroup.className = "settings-group";
  guardrailsGroup.append(settingsGroupHeading("Fleet guardrail"));

  const ceilingToggleRow = document.createElement("label");
  ceilingToggleRow.className = "settings-toggle-row";
  const ceilingCheckbox = document.createElement("input");
  ceilingCheckbox.type = "checkbox";
  const ceilingText = document.createElement("div");
  ceilingText.className = "settings-toggle-text";
  const ceilingTitle = document.createElement("div");
  ceilingTitle.className = "settings-toggle-title";
  ceilingTitle.textContent = "Cap the fleet's estimated spend";
  const ceilingDesc = document.createElement("div");
  ceilingDesc.className = "settings-toggle-desc";
  ceilingDesc.textContent =
    "Helm sums what each dispatched run's tokens WOULD cost at API rates and blocks new dispatch once that estimate crosses the cap below - a guardrail against a runaway fleet, not a real charge. On a Claude subscription nothing is billed per use, so leave this off if you don't need a cap; the manual Stop button on the Dashboard still works either way.";
  ceilingText.append(ceilingTitle, ceilingDesc);
  ceilingToggleRow.append(ceilingCheckbox, ceilingText);
  guardrailsGroup.append(ceilingToggleRow);

  const ceilingInputRow = document.createElement("div");
  ceilingInputRow.className = "settings-select-row";
  const ceilingInputLabel = document.createElement("div");
  ceilingInputLabel.className = "settings-toggle-text";
  const ceilingInputTitle = document.createElement("div");
  ceilingInputTitle.className = "settings-toggle-title";
  ceilingInputTitle.textContent = "Cap ($)";
  ceilingInputLabel.append(ceilingInputTitle);
  const ceilingInput = document.createElement("input");
  ceilingInput.type = "number";
  ceilingInput.min = "1";
  ceilingInput.step = "1";
  ceilingInput.className = "settings-budget-input";
  ceilingInputRow.append(ceilingInputLabel, ceilingInput);
  guardrailsGroup.append(ceilingInputRow);

  const spendNoteEl = document.createElement("div");
  spendNoteEl.className = "settings-toggle-desc settings-sweep-status";
  spendNoteEl.textContent = "Fleet guardrail: checking…";
  guardrailsGroup.append(spendNoteEl);

  let lastKnownCeiling = 25; // fallback shown only until the real value loads
  ceilingCheckbox.addEventListener("change", async () => {
    if (ceilingCheckbox.checked) {
      ceilingInput.disabled = false;
      const n = Number(ceilingInput.value) || lastKnownCeiling;
      ceilingInput.value = n;
      const res = await window.helm.setOrchestrationCeiling(n);
      if (res?.ok) {
        lastKnownCeiling = n;
      }
    } else {
      ceilingInput.disabled = true;
      await window.helm.setOrchestrationCeiling(null);
    }
  });
  ceilingInput.addEventListener("change", async () => {
    if (!ceilingCheckbox.checked) {
      return;
    }
    const n = Number(ceilingInput.value);
    if (!Number.isFinite(n) || n <= 0) {
      return;
    }
    const res = await window.helm.setOrchestrationCeiling(n);
    if (res?.ok) {
      lastKnownCeiling = n;
    }
  });

  window.helm.getOrchestrationBudget().then((res) => {
    const budget = res && res.ok ? res.budget : null;
    const ceiling = budget && typeof budget.ceilingUsd === "number" ? budget.ceilingUsd : null;
    if (ceiling != null) {
      lastKnownCeiling = ceiling;
    }
    ceilingCheckbox.checked = ceiling != null;
    ceilingInput.disabled = ceiling == null;
    ceilingInput.value = ceiling != null ? ceiling : lastKnownCeiling;
    const spent = budget ? Number(budget.spentUsd) || 0 : 0;
    spendNoteEl.textContent =
      `Estimated fleet spend so far: ~$${spent.toFixed(2)}` + (budget?.killed ? " · fleet currently stopped (Dashboard Resume clears this)" : "");
  });

  // Each group gets its OWN column (auto-fit grid) so every heading tops its
  // own column, instead of the shorter groups being stacked awkwardly under
  // one another. Auto-fit collapses to fewer columns on a narrow window (see
  // .settings-columns CSS).
  const columns = document.createElement("div");
  columns.className = "settings-columns";
  columns.append(passiveGroup, activeGroup, guardrailsGroup, voiceGroup, appearanceGroup);
  block.append(columns);

  page.append(block);
}

function barRow(label, count, max) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const name = document.createElement("span");
  name.className = "bar-label";
  name.textContent = label;
  const track = document.createElement("span");
  track.className = "bar-track";
  const fill = document.createElement("span");
  fill.className = "bar-fill";
  fill.style.width = `${max ? Math.max(4, (count / max) * 100) : 0}%`;
  track.append(fill);
  const value = document.createElement("span");
  value.className = "bar-value";
  value.textContent = count;
  row.append(name, track, value);
  return row;
}

/**
 * One skills source (global / this project / a plugin), grouped the way it is
 * grouped on disk.
 *
 * Two of the captain's tasks meet here:
 *  - 3d0fe057, the categorisation: a subfolder of the skills root renders as its
 *    own labelled row instead of every skill running together in one list.
 *  - 07658c1a, "vad är tänkt att visas här?" - asked about an empty "This pane's
 *    project skills · 0 / None found.", which said neither what it looks for nor
 *    where it looked. An empty state that cannot answer that is the bug; the
 *    heading now carries the folder and the empty line says what would fill it.
 */
function skillListEl(title, source, origin, cwd, opts = {}) {
  const section = document.createElement("div");
  section.className = "analysis-block";
  const h = document.createElement("h3");
  const count = source?.count || 0;
  h.textContent = `${title} · ${count}`;
  if (source?.dir) {
    h.title = source.dir;
  }
  section.append(h);
  // A folder NAME is ambiguous - two repos share a basename often enough - so a
  // per-project block says which folder it means, on screen rather than in a tooltip.
  if (opts.subtitle) {
    const sub = document.createElement("div");
    sub.className = "suggest-hint";
    sub.textContent = opts.subtitle;
    section.append(sub);
  }
  if (count === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = opts.emptyHint || (source?.dir ? `Nothing in ${source.dir} - a skill is a folder there with a SKILL.md in it.` : "None found.");
    section.append(empty);
    return section;
  }
  // Where the groups come from, when they do not come from this folder's own
  // subfolders. The captain's skills root is FLAT and its entries link into
  // skills-catalog, so eleven labelled groups off a flat folder would otherwise be
  // unexplainable from anything on screen.
  if (source.groupedBy) {
    const note = document.createElement("div");
    note.className = "suggest-hint";
    note.textContent = `Grouped by ${source.groupedBy.split(/[\\/]/).filter(Boolean).pop()}`;
    note.title = `The folder above is flat; these skills point into ${source.groupedBy}, and the groups are that tree's own categories.`;
    section.append(note);
  }
  for (const group of source.groups || []) {
    if (group.category) {
      const label = document.createElement("div");
      label.className = "suggest-hint";
      label.textContent = `${group.category} · ${group.skills.length}`;
      section.append(label);
    }
    const list = document.createElement("div");
    list.className = "skill-chip-list";
    for (const skill of group.skills) {
      const chip = document.createElement("button");
      chip.className = "skill-chip";
      chip.textContent = skill.label;
      chip.title = "Open SKILL.md (right-click to open the file)";
      // `ref` carries the category, so a grouped skill still resolves; `plugin`
      // is re-resolved in main against the enumerated plugin list.
      const skillRef = { name: skill.ref, origin, cwd, plugin: opts.plugin };
      chip.addEventListener("click", () =>
        openDocViewer({
          label: `${skill.ref} · SKILL.md`,
          read: () => window.helm.readSkill(skillRef),
          reveal: () => window.helm.openSkill(skillRef),
          revealLabel: "Open file",
        })
      );
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        window.helm.openSkill(skillRef);
      });
      list.append(chip);
    }
    section.append(list);
  }
  return section;
}


// Two overlapping renders used to BOTH append their grid: this function clears the
// page, then awaits four IPC calls, and only appends at the end - so a second call
// starting while the first was still waiting produced every block twice (found while
// testing the skill grouping; a navigate plus a refresh is enough to trigger it). The
// token makes the last caller the only one that draws, which is the same fix the
// dashboard's own refresh race needed.
let analysisRenderToken = 0;

/**
 * Which project's skills the Analysis block is showing. Kept in memory rather than in
 * config: it is a way of LOOKING at the page, not a setting - the same distinction the
 * review badge turns on (it honours the standing repo filter and ignores the page's
 * chip). Falls back to the first project when the remembered one has no skills any more.
 */
let analysisSkillProject = null;

/**
 * One "Project skills" block for every project, with a pill per project.
 *
 * A block per project is what this replaces: three of his projects carry their own skills
 * already, and the row grew the moment a fourth would (the captain, 2026-08-05). The pills are
 * .dash-chip, the Dashboard's own project chips, so this looks like the app rather than
 * like a new thing.
 */
function projectSkillsEl(projects) {
  const selected = projects.find((p) => p.root === analysisSkillProject) || projects[0];
  const section = skillListEl(`Project skills · ${selected.name}`, selected, "project", selected.root, {
    subtitle: selected.root,
  });
  // Pills go directly under the heading, above the skills they switch between.
  const picker = document.createElement("div");
  picker.className = "dash-chip-grid analysis-project-picker";
  for (const p of projects) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dash-chip" + (p.root === selected.root ? " dash-chip-selected" : "");
    chip.textContent = `${p.name} · ${p.count}`;
    chip.title = p.root;
    chip.addEventListener("click", () => {
      if (p.root === analysisSkillProject) {
        return;
      }
      analysisSkillProject = p.root;
      // Repaint just this block, in place - re-rendering the whole page would refetch
      // four stores and scroll the reader back to the top for a pill click.
      section.replaceWith(projectSkillsEl(projects));
    });
    picker.append(chip);
  }
  // After the heading (and its subtitle line), before the chips.
  const firstList = section.querySelector(".skill-chip-list, .pane-empty");
  if (firstList) {
    section.insertBefore(picker, firstList);
  } else {
    section.append(picker);
  }
  return section;
}

async function renderAnalysisPage() {
  const page = document.getElementById("analysisPage");
  page.innerHTML = "";
  const myToken = ++analysisRenderToken;

  const cwd = panes[focusedPaneIndex]?.cwd || "";
  // Project skills are asked for PER PROJECT, from the folders Helm knows sessions in.
  // Sessions are re-fetched rather than read out of renderer memory: this page can be
  // the first thing opened after a launch, and a panel that says "0 projects" because
  // nobody had refreshed yet is the same class of bug as the pane-scoped panel it
  // replaces - a true-looking number about the wrong thing.
  const sessionData = await window.helm.getSessions();
  const projectRoots = [...new Set((sessionData?.sessions || []).map((s) => s.cwd).filter(Boolean))];
  const [{ global, projects, projectsChecked, plugins }, summary, context, helmUsage, reviewActions] = await Promise.all([
    window.helm.listSkills(projectRoots),
    window.helm.getUsageSummary(),
    window.helm.listContext(cwd),
    window.helm.getHelmUsage(),
    window.helm.getReviewActionSummary(),
  ]);
  if (myToken !== analysisRenderToken) {
    return; // a newer render already owns the page
  }

  const header = document.createElement("h2");
  header.textContent = "Analysis";
  page.append(header);

  const totals = document.createElement("div");
  totals.className = "analysis-totals";
  totals.textContent =
    `${summary.totalRuns} runs · $${summary.totalCostUsd.toFixed(2)} total` +
    (summary.judgeCostUsd ? ` · $${summary.judgeCostUsd.toFixed(2)} spent on model-fit judging before it was removed` : "");
  page.append(totals);

  // The suggestion-accuracy notice was removed on 2026-08-30. It was written by a periodic
  // check that joined runs against the model-fit judge's verdicts; with the judge gone,
  // nothing can ever produce one again, so rendering it was a banner waiting for a sender
  // that no longer exists.

  const grid = document.createElement("div");
  grid.className = "analysis-grid";

  const modelBlock = document.createElement("div");
  modelBlock.className = "analysis-block";
  const modelH = document.createElement("h3");
  modelH.textContent = "By model";
  modelBlock.append(modelH);
  const modelEntries = Object.entries(summary.byModel).sort((a, b) => b[1] - a[1]);
  const modelMax = modelEntries.length ? modelEntries[0][1] : 0;
  if (modelEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet - usage logs as you use Helm.";
    modelBlock.append(empty);
  } else {
    modelEntries.forEach(([m, c]) => modelBlock.append(barRow(m.replace("claude-", ""), c, modelMax)));
  }

  const toolBlock = document.createElement("div");
  toolBlock.className = "analysis-block";
  const toolH = document.createElement("h3");
  toolH.textContent = "Top tools used";
  toolBlock.append(toolH);
  const toolEntries = Object.entries(summary.byTool).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const toolMax = toolEntries.length ? toolEntries[0][1] : 0;
  if (toolEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet.";
    toolBlock.append(empty);
  } else {
    toolEntries.forEach(([t, c]) => toolBlock.append(barRow(t, c, toolMax)));
  }

  const skillUsageBlock = document.createElement("div");
  skillUsageBlock.className = "analysis-block";
  const skillUsageH = document.createElement("h3");
  skillUsageH.textContent = "Skill usage (best-effort)";
  skillUsageH.title =
    'Counts skills a leading "/skill-name" prompt invoked AND skills the model invoked itself via the Skill tool (task aa9f5238), once per run each. Only runs Helm launched are observed - skills used in sessions started outside Helm aren\'t counted.';
  skillUsageBlock.append(skillUsageH);
  const skillEntries = Object.entries(summary.bySkill).sort((a, b) => b[1] - a[1]);
  const skillMax = skillEntries.length ? skillEntries[0][1] : 0;
  if (skillEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet - counts /skill-name prompts and skills the model invokes itself, across runs Helm launched.";
    skillUsageBlock.append(empty);
  } else {
    skillEntries.forEach(([s, c]) => skillUsageBlock.append(barRow(s, c, skillMax)));
  }

  // The "Model fit" and "Suggestion accuracy" blocks were removed on 2026-08-30 with the
  // judge that produced them. Keeping them relabelled as historical was the first instinct
  // and the wrong one: the raw verdicts are still in usage-log.jsonl and the conclusion is
  // in DECISIONS.md, so two frozen panels added nothing except something to scroll past
  // that would get staler every day. (the captain, 2026-08-30: "da borde kanske motsvarande del
  // i analysis ocksa rensas".)

  // Pure analytics on how the captain handles review, not the board's current state
  // (the captain, task 76790f23, round 2: "Jag vill bara ha analytics datan, inte
  // nuvarande state" - the first version's tally/criticality bars described
  // the LIVE queue, which is already the Review page's own job; this block
  // now only reports what he actually DID, joined against each decision by
  // taskId so "opened diff 3/5" means what it says: 3 of his 5 decisions were
  // preceded by actually opening that item's diff, not two unrelated counts
  // divided by each other. reviews:setStatus/openDiffViewer/reviews:runChecks/
  // the independent-reviewer dispatch each log one content-free event
  // (helmUsage.js - the same local log "Your Helm views" already uses);
  // summarizeReviewActions (main process) does the join.
  //
  // Counts start at zero from whenever each event type shipped - there is no
  // way to reconstruct an action that was never logged, so a low number here
  // means "recently added," not "rarely done."
  const reviewBlock = document.createElement("div");
  reviewBlock.className = "analysis-block";
  const reviewH = document.createElement("h3");
  reviewH.textContent = "Review analytics";
  reviewH.title = "What you actually did across your review decisions - opened the diff, ran the checks, sent an independent reviewer - not the board's current state (see the Review page for that).";
  reviewBlock.append(reviewH);
  const ra = reviewActions || { totalDecisions: 0, stamped: 0, sentBack: 0, diffOpenedCount: 0, checksRunCount: 0, independentCount: 0, independentTotal: 0, independentByModel: [] };
  if (ra.totalDecisions === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No review decisions logged yet - stamp or send back an item from the Review page to start building this up.";
    reviewBlock.append(empty);
  } else {
    const fractionRow = (label, n, total) => {
      const row = document.createElement("div");
      row.className = "fit-row";
      const l = document.createElement("span");
      l.className = "fit-model-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "fit-pill fit-pill-appropriate";
      v.textContent = `${n}/${total}`;
      row.append(l, v);
      return row;
    };
    reviewBlock.append(fractionRow("Stamped it done", ra.stamped, ra.totalDecisions));
    reviewBlock.append(fractionRow("Sent it back with feedback", ra.sentBack, ra.totalDecisions));
    reviewBlock.append(fractionRow("Opened the diff first", ra.diffOpenedCount, ra.totalDecisions));
    reviewBlock.append(fractionRow("Ran the checks first", ra.checksRunCount, ra.totalDecisions));
    reviewBlock.append(fractionRow("Sent an independent reviewer first", ra.independentCount, ra.totalDecisions));

    if (ra.independentByModel.length > 0) {
      const modelH = document.createElement("h4");
      modelH.className = "analysis-subhead";
      modelH.textContent = `Independent reviewer, by model chosen (${ra.independentTotal} dispatched)`;
      reviewBlock.append(modelH);
      const modelMax = ra.independentByModel[0].count;
      for (const m of ra.independentByModel) {
        reviewBlock.append(barRow(m.label, m.count, modelMax));
      }
    }
  }

  // Helm's OWN usage (distinct from the model/cost blocks above): which views
  // you visit and your common navigation paths - local + content-free.
  const usageBlock = document.createElement("div");
  usageBlock.className = "analysis-block";
  const usageH = document.createElement("h3");
  usageH.textContent = "Your Helm views";
  usageH.title = "Which app views you navigate to. Local and content-free - only view names + timestamps.";
  usageBlock.append(usageH);
  const viewMax = helmUsage.views.length ? helmUsage.views[0].count : 0;
  if (!helmUsage.views.length) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet - navigation logs as you move around Helm.";
    usageBlock.append(empty);
  } else {
    helmUsage.views.forEach((v) => usageBlock.append(barRow(v.page, v.count, viewMax)));
  }

  const pathsBlock = document.createElement("div");
  pathsBlock.className = "analysis-block";
  const pathsH = document.createElement("h3");
  pathsH.textContent = "Top navigation paths";
  pathsH.title = "Most common view-to-view moves within a sitting (A → B).";
  pathsBlock.append(pathsH);
  const pathList = helmUsage.transitions.slice(0, 10);
  const pathMax = pathList.length ? pathList[0].count : 0;
  if (!pathList.length) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No paths yet.";
    pathsBlock.append(empty);
  } else {
    pathList.forEach((t) => pathsBlock.append(barRow(t.path, t.count, pathMax)));
  }

  grid.append(modelBlock, toolBlock, skillUsageBlock, reviewBlock, usageBlock, pathsBlock);
  grid.append(skillListEl("Global skills (~/.claude/skills)", global, "global", cwd));
  // Project skills, PER PROJECT. This used to be "this pane's project skills", which
  // could not be read: Analysis is a page you reach by leaving the pane, so the panel
  // described a folder you were not looking at and had no way to name (the captain,
  // 2026-08-05: "man kan inte ens vara i ett projekt OCH analysis samtidigt"). The
  // question a global page CAN answer is which of your projects carry their own skills,
  // so only projects that have any get a block, and the empty state says how many were
  // looked at.
  // ONE block with a project picker, not a block per project: three projects carry their
  // own skills already and the row of blocks grew immediately (the captain, 2026-08-05: "Gör
  // inte en widget per projekt, kommer växa och ser dåligt ut. Kanske istället en pill
  // eller dropdown i en widget för att välja projekt man vill visa för"). The pills are
  // the Dashboard's own project chips, same class and same selected state.
  if ((projects || []).length === 0) {
    grid.append(
      skillListEl("Project skills", { dir: null, groups: [], count: 0 }, "project", "", {
        emptyHint: projectsChecked
          ? `None of the ${projectsChecked} project folders Helm has sessions in carry their own skills. A project's skills live in <project>\\.claude\\skills, committed to that repo so a teammate inherits them - everything reachable everywhere is in the global list above.`
          : "No project folders known yet - start a session in a repo and it shows up here.",
      })
    );
  } else {
    grid.append(projectSkillsEl(projects));
  }
  // Skills from ENABLED plugins - one block per plugin, because the plugin IS the
  // category. They were reachable by every session and shown nowhere (task 3d0fe057).
  for (const p of plugins || []) {
    grid.append(
      skillListEl(`Plugin skills (${p.plugin}@${p.marketplace})`, p, "plugin", cwd, { plugin: p.plugin })
    );
  }
  grid.append(contextFilesEl(context, cwd));
  page.append(grid);
}

// ---- Minimal, safe Markdown → HTML for the context doc viewer. ------------
// These files are the user's own (CLAUDE.md/DECISIONS.md/memory), but we still
// escape ALL text first and only ever emit our own tags, so nothing inside a
// file can inject markup. No external dependency (the CSP would block a CDN
// markdown lib anyway). Covers the constructs these docs actually use:
// headings, lists, fenced + inline code, blockquotes, tables, hr, links,
// bold/italic, and [[wiki]] memory cross-refs.
function mdEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline formatting on an already-escaped string.
function mdInline(escaped) {
  let s = escaped;
  // Inline code first so its content isn't further formatted.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return "\u0001C" + (codes.length - 1) + "\u0001";
  });
  // Links [text](url) - only safe schemes; anything else renders as plain text.
  // (url is already escaped, so &amp; etc. are valid inside the attribute.)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    if (/^(https?:\/\/|mailto:|#)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text;
  });
  // [[wiki]] memory cross-links have no navigable target - subtle emphasis.
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, t) => `<em>${t}</em>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/\u0001C(\d+)\u0001/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function renderMarkdown(md) {
  const raw = String(md || "")
    .replace(/\r\n/g, "\n")
    // The code-span/fence placeholders below are \u0001-delimited; strip both
    // control characters from the input so rendered text can never forge one.
    .replace(/[\u0000\u0001]/g, "");
  // Pull fenced code blocks out first so their bodies escape the block parser.
  const fences = [];
  const withoutFences = raw.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
    fences.push(code.replace(/\n$/, ""));
    return "\n\u0001F" + (fences.length - 1) + "\u0001\n";
  });
  const lines = withoutFences.split("\n");
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${mdInline(mdEscape(para.join(" ")))}</p>`);
      para = [];
    }
  };
  const isTableSep = (l) => /^\s*\|?[\s:]*-{2,}[\s:|-]*$/.test(l) && l.includes("-");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\u0001F(\d+)\u0001$/);
    if (fence) {
      flushPara();
      out.push(`<pre><code>${mdEscape(fences[Number(fence[1])])}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${mdInline(mdEscape(heading[2].trim()))}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      continue;
    }
    // Blockquote: consume consecutive `>` lines.
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      i--;
      out.push(`<blockquote>${mdInline(mdEscape(quote.join(" ")))}</blockquote>`);
      continue;
    }
    // Table: header row of `|` cells followed by a `---` separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const cells = (l) =>
        l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => mdInline(mdEscape(c.trim())));
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(cells(lines[i]));
        i++;
      }
      i--;
      const thead = `<thead><tr>${header.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // Lists: consume consecutive items of the same kind.
    const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
    const olItem = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulItem || olItem) {
      flushPara();
      const ordered = !!olItem;
      const items = [];
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) {
          break;
        }
        items.push(`<li>${mdInline(mdEscape(m[1]))}</li>`);
        i++;
      }
      i--;
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return out.join("\n");
}

// Open the doc viewer for any markdown file. `read` returns a Promise for the
// file's raw text ({ ok, text, truncated }); `reveal` opens/reveals it in the
// OS. Kept source-agnostic so both context files and skill SKILL.md files
// share the exact same readable-HTML rendering.
function openDocViewer({ label, read, reveal, revealLabel = "Reveal" }) {
  const overlay = document.getElementById("docViewer");
  const body = document.getElementById("docvBody");
  // A plain .md file has no changed-files column - clear whatever a previous
  // diff view left in it, rather than showing a stale file list beside an
  // unrelated document.
  const fileList = document.getElementById("docvFileList");
  fileList.classList.add("hidden");
  fileList.innerHTML = "";
  document.getElementById("docvTitle").textContent = label || "Document";
  const revealBtn = document.getElementById("docvReveal");
  revealBtn.textContent = revealLabel;
  revealBtn.onclick = () => reveal && reveal();
  body.innerHTML = '<div class="cmdk-empty">Loading…</div>';
  overlay.classList.remove("hidden");
  read().then((res) => {
    if (!res || !res.ok) {
      body.innerHTML = "";
      const e = document.createElement("div");
      e.className = "cmdk-empty";
      e.textContent = (res && res.error) || "Could not read file";
      body.append(e);
      return;
    }
    body.innerHTML = renderMarkdown(res.text);
    if (res.truncated) {
      const t = document.createElement("div");
      t.className = "md-truncated";
      t.textContent = `File truncated for display (over 1 MB) - use ${revealLabel} to open the full file.`;
      body.append(t);
    }
    body.scrollTop = 0;
  });
}

function closeDocViewer() {
  document.getElementById("docViewer").classList.add("hidden");
}

document.getElementById("docvClose").addEventListener("click", closeDocViewer);
document.getElementById("docvBackdrop").addEventListener("click", closeDocViewer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("docViewer").classList.contains("hidden")) {
    e.stopPropagation();
    closeDocViewer();
  }
});

// The context files that actually shape a session: the CLAUDE.md(s) that
// auto-load and the auto-memory files for the focused pane's cwd. Surfacing
// them here makes "what's in the room" visible - the point the 2026-07-08
// session-renewal work turns on (load-bearing knowledge belongs on the
// always-loaded surface). Click renders the file as readable HTML;
// right-click reveals it in Explorer.
function contextFilesEl(context, cwd) {
  const section = document.createElement("div");
  section.className = "analysis-block";
  const h = document.createElement("h3");
  h.textContent = "Context files (what auto-loads into a session)";
  section.append(h);

  const list = document.createElement("div");
  list.className = "skill-chip-list";
  for (const c of context?.claudeMd || []) {
    const chip = document.createElement("button");
    chip.className = "skill-chip";
    chip.textContent = c.label + (c.exists ? "" : " (none)");
    chip.disabled = !c.exists;
    chip.title = c.exists ? "Open (right-click to reveal in Explorer)" : "Not present";
    const ref = { cwd, kind: c.kind };
    chip.addEventListener("click", () =>
      openDocViewer({ label: c.label, read: () => window.helm.readContext(ref), reveal: () => window.helm.openContext(ref) })
    );
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.helm.openContext(ref);
    });
    list.append(chip);
  }
  // Durable project docs (DECISIONS.md/PLAN.md) - the "etc": they do NOT
  // auto-load like CLAUDE.md, so they're exactly what a fresh/carried-over
  // session has to be pointed at.
  //
  // main sends TWO kinds in this one array: the project docs above, and - for a
  // session with no repo of its own - the topic handoffs from Helm's own store.
  // The chip must ask for the kind it IS. Hardcoding "projectDoc" here made every
  // topic-handoff chip ask main for a project doc by a name the resolver refuses,
  // so it answered "Invalid project doc" (task 2ba0d277). They also get their own
  // row below, because they are not files in the project and reading them as such
  // is what made the section confusing in the first place.
  const docs = (context?.projectDocs || []).filter((d) => d.kind !== "handoffTopic");
  const topics = (context?.projectDocs || []).filter((d) => d.kind === "handoffTopic");
  const docChip = (d, title) => {
    const chip = document.createElement("button");
    chip.className = "skill-chip";
    chip.textContent = d.name + (d.exists ? "" : " (none)");
    chip.disabled = !d.exists;
    chip.title = d.exists ? title : "Not present";
    const ref = { cwd, kind: d.kind || "projectDoc", name: d.name };
    chip.addEventListener("click", () =>
      openDocViewer({ label: d.name, read: () => window.helm.readContext(ref), reveal: () => window.helm.openContext(ref) })
    );
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.helm.openContext(ref);
    });
    return chip;
  };
  for (const d of docs) {
    list.append(docChip(d, "Open (does not auto-load · right-click to reveal in Explorer)"));
  }
  section.append(list);

  if (topics.length) {
    const topicH = document.createElement("div");
    topicH.className = "suggest-hint";
    topicH.textContent = `Topic handoffs · ${topics.length} (continuity for sessions with no repo of their own)`;
    topicH.title = "Written by \"summarize & carry over\" when there is no project folder to save a HANDOFF.md into. A fresh session on the same subject reads these.";
    section.append(topicH);
    const topicList = document.createElement("div");
    topicList.className = "skill-chip-list";
    for (const t of topics) {
      topicList.append(docChip(t, "Open this topic's handoff (right-click to reveal in Explorer)"));
    }
    section.append(topicList);
  }

  const memH = document.createElement("div");
  memH.className = "suggest-hint";
  const memDir = context?.memory?.dir;
  memH.textContent = context?.memory?.exists
    ? `Memory · ${context.memory.files.length} file${context.memory.files.length === 1 ? "" : "s"}`
    : cwd
      ? "Memory · none for this folder yet"
      : "Memory · set a folder on the focused pane to see its memory";
  if (memDir) {
    memH.title = memDir;
  }
  section.append(memH);

  if (context?.memory?.files?.length) {
    const memList = document.createElement("div");
    memList.className = "skill-chip-list";
    for (const f of context.memory.files) {
      const chip = document.createElement("button");
      chip.className = "skill-chip";
      chip.textContent = f.name;
      chip.title = "Open (right-click to reveal in Explorer)";
      const ref = { cwd, kind: "memory", name: f.name };
      chip.addEventListener("click", () =>
        openDocViewer({ label: f.name, read: () => window.helm.readContext(ref), reveal: () => window.helm.openContext(ref) })
      );
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        window.helm.openContext(ref);
      });
      memList.append(chip);
    }
    section.append(memList);
  }
  return section;
}

document.getElementById("viewToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.helm.setConfig({ viewMode: btn.dataset.mode });
  applyViewMode();
});



// ============================== Background tasks (subagents) ==============================
// Matches the desktop app's "Background tasks" drawer, backed by real
// task_started/task_progress/task_updated/task_notification events (verified
// schema via spike/test-task-events-shape.mjs) rather than a hollow copy.

// task_progress/task_updated/task_done can arrive for a taskId this map
// hasn't seen yet — the underlying IPC/stream-json event stream has no
// delivery-order guarantee, so a dropped or reordered task_started is a
// real possibility, not just a theoretical one. Backfills a minimal
// placeholder rather than silently discarding the event.
function getOrCreateBackgroundTask(taskId) {
  let t = backgroundTasks.get(taskId);
  if (!t) {
    t = { description: "Background task", status: "running", lastToolName: null, startedAt: Date.now() };
    backgroundTasks.set(taskId, t);
  }
  return t;
}

function renderBackgroundTasksBadge() {
  // #backgroundTasksBtn is relocated between pane headers (see the chat-toolbar
  // note in index.html), so it can be momentarily absent from the DOM (e.g. a
  // refresh tick landing mid pane-rebuild). Guard rather than throw.
  const btn = document.getElementById("backgroundTasksBtn");
  if (!btn) {
    return;
  }
  const running = [...backgroundTasks.values()].filter((t) => t.status === "running").length;
  btn.textContent = running > 0 ? `Background tasks (${running})` : "Background tasks";
  btn.classList.toggle("has-running", running > 0);
}

document.getElementById("backgroundTasksBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const tasks = [...backgroundTasks.entries()];
  if (tasks.length === 0) {
    showContextMenu(e.clientX, e.clientY, [{ label: "No background tasks yet" }]);
    return;
  }
  const items = tasks
    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0))
    .map(([taskId, t]) => {
      const statusIcon = t.status === "running" ? "◔" : t.status === "failed" ? "✗" : "✓";
      const detail = t.status === "running" && t.lastToolName ? ` · ${t.lastToolName}` : "";
      return { label: `${statusIcon} ${t.summary || t.description}${detail}` };
    });
  items.push(
    { sep: true },
    {
      label: "Clear finished",
      onClick: () => {
        for (const [taskId, t] of backgroundTasks) {
          if (t.status !== "running") {
            backgroundTasks.delete(taskId);
          }
        }
        renderBackgroundTasksBadge();
      },
    }
  );
  showContextMenu(e.clientX, e.clientY, items);
});

window.helm.onSessionEvent((evt) => {
  // Ad-hoc one-off launch (e.g. a summarization call) not tied to any pane's
  // normal display — captured entirely here instead of routing further down.
  if (pendingLaunchCallbacks.has(evt.launchId)) {
    const cb = pendingLaunchCallbacks.get(evt.launchId);
    if (evt.kind === "assistant") {
      cb.assistantText += evt.text;
    } else if (evt.kind === "session") {
      cb.cliSessionId = evt.sessionId; // not used by summarizeSession today, but kept for future extension
    } else if (evt.kind === "done" || evt.kind === "error") {
      pendingLaunchCallbacks.delete(evt.launchId);
      cb.onDone(cb.assistantText, evt.kind === "error" ? evt.message : null);
    }
    return;
  }

  // The "modelFit" event was removed with the model-fit judge on 2026-08-30. It used to be
  // handled here because it was the ONE event kind that fully retired a launchPaneHistory
  // entry - the judge resolved well after "done" and was the last thing that ever needed
  // the launchId.
  //
  // Nothing retires an entry eagerly any more, and that is fine rather than a leak:
  // pruneStaleLaunchHistory already removes any entry whose pane is no longer busy once it
  // is ten minutes old, and it was written precisely as the backstop for the judge being
  // switched off. So entries now live a few minutes longer than they did and are still
  // bounded. Checked before removing this, not assumed.

  // Background Task-tool subagents — app-wide, not tied to a single pane.
  if (evt.kind === "task_started") {
    const existing = backgroundTasks.get(evt.taskId);
    // An out-of-order task_done/task_updated can arrive BEFORE task_started
    // and already backfill a terminal placeholder via getOrCreateBackgroundTask
    // below — unconditionally overwriting it here would un-finish an already-
    // completed task back to "running" with nothing left to ever fix it again.
    if (existing && TERMINAL_TASK_STATUSES.has(existing.status)) {
      return;
    }
    backgroundTasks.set(evt.taskId, {
      description: evt.description || evt.subagentType || "Background task",
      status: "running",
      lastToolName: null,
      startedAt: Date.now(),
    });
    renderBackgroundTasksBadge();
    return;
  }
  if (evt.kind === "task_progress") {
    // progress/updated/done for a taskId with no prior task_started (a
    // dropped or reordered IPC message — this stream has no delivery
    // guarantee) used to be silently ignored, making that task permanently
    // invisible even though it's genuinely running. getOrCreateBackgroundTask
    // backfills a minimal placeholder instead, so it still shows up.
    const t = getOrCreateBackgroundTask(evt.taskId);
    t.lastToolName = evt.lastToolName || t.lastToolName;
    renderBackgroundTasksBadge();
    return;
  }
  if (evt.kind === "task_updated") {
    const t = getOrCreateBackgroundTask(evt.taskId);
    // Ignore an out-of-order/delayed update trying to un-finish a task that
    // already reached a terminal state (e.g. via task_done) — a duplicate or
    // reordered IPC message shouldn't make a completed task look running again.
    if (!TERMINAL_TASK_STATUSES.has(t.status)) {
      t.status = evt.status || t.status;
      renderBackgroundTasksBadge();
    }
    return;
  }
  if (evt.kind === "task_done") {
    const t = getOrCreateBackgroundTask(evt.taskId);
    t.status = evt.status || "completed";
    t.summary = evt.summary || t.description;
    renderBackgroundTasksBadge();
    return;
  }

  // App-wide, not tied to any one pane — must never be gated behind a pane
  // lookup (a stale/missing launch entry shouldn't also swallow quota news).
  if (evt.kind === "quota") {
    if (evt.quota) {
      state.quota = evt.quota;
    }
    renderQuota(evt.quota);
    renderDashQuota(); // keep the dashboard chip live as quota news streams in
    return;
  }

  // Running-session tracking (a39286b7): kept independent of the pane-identity
  // gate below, so it stays correct even after navigating away and back. A
  // session is "running" from its "session" event until the process "closed".
  if (evt.kind === "session" && evt.sessionId) {
    runningSessions.add(evt.sessionId);
  } else if (evt.kind === "closed" && evt.sessionId) {
    runningSessions.delete(evt.sessionId);
    // Backstop against a stuck spinner: a process that exits emitting only "closed"
    // (no "done"/"error" ever routed - e.g. a launchId with no history entry, or a
    // crash before the result event) would otherwise leave the pane on "Working…"
    // forever, so the session looks hung and needs an app restart (bug b608c99b).
    // done/error already clear busy; this idempotently clears any pane still marked
    // busy for this session so the spinner can never outlive the process.
    const stuckIdx = panes.findIndex((p) => p && p.busy && p.cliSessionId === evt.sessionId);
    if (stuckIdx >= 0) {
      panes[stuckIdx].busy = false;
      panes[stuckIdx].currentLaunchId = null;
      stopLiveStatsTicker(stuckIdx);
      setPaneBusyUI(stuckIdx, "");
    }
  }

  // Routes purely via launchPaneHistory + an identity check, the same
  // pattern already used by the modelFit handler above. A separate
  // launchId->index map (paneLaunchMap) used to do this lookup WITHOUT the
  // identity check, which meant: send in a pane, hit "+" for a new chat
  // before the reply lands, and the orphaned launch's assistant text/done
  // would land in the unrelated NEW session now sitting at that index. That
  // map's own cleanup was also inconsistent (deleted on "done" but not on
  // "error", a genuine unbounded leak on every failed launch). Consolidating
  // on launchPaneHistory removes both problems: one map, one identity check,
  // used everywhere a launchId needs to find its way back to a pane.
  const entry = launchPaneHistory.get(evt.launchId);
  if (!entry) {
    return;
  }
  let { index, pane, startedAt } = entry;
  if (panes[index] !== pane) {
    // The original pane was reassigned (e.g. navigated to the dashboard and back,
    // which rebuilds the pane). If a pane is CURRENTLY showing the same session,
    // redirect this live event to it - so a reopened pane keeps ticking and gets
    // the completion, instead of the turn running invisibly and looking hung
    // (a39286b7). If the session isn't open anywhere, drop the event as before.
    const liveIdx = pane.cliSessionId ? panes.findIndex((p) => p && p.cliSessionId === pane.cliSessionId) : -1;
    if (liveIdx < 0) {
      return;
    }
    index = liveIdx;
    pane = panes[liveIdx];
  }
  switch (evt.kind) {
    case "session":
      pane.cliSessionId = evt.sessionId;
      // Named mates: bind this now-identified session to the mate/second mate it
      // embodies, so the Fleet's "jump in" resumes it next time.
      if (pane.mateId) {
        window.helm.bindMateSession(pane.mateId, evt.sessionId);
      }
      if (pane.secondMateId) {
        window.helm.bindSecondMateSession(pane.secondMateId, evt.sessionId, pane.cwd);
      }
      break;
    case "tool_use":
      setPaneBusyUI(index, `Working — ${evt.toolName}`);
      pulsePaneStatusIcon(index);
      break;
    case "tool_written":
      // Fires once the file-writing tool's tool_result confirms the write
      // actually completed (see launcher.js's "user" message handling) —
      // not on the earlier tool_use request, which can race the real write
      // if "Open in Plan" is clicked immediately. If this was a mockup HTML
      // file, offer to open it in the Plan view for annotation (option A:
      // generate -> annotate in one step).
      if (isMockupPath(evt.filePath)) {
        showMockupBanner(index, evt.filePath);
      }
      break;
    case "usage":
      // Incremental per-message usage (launcher.js reads it straight off each
      // "assistant" stream-json event's own evt.message.usage) — summed here
      // into a running total so the live ticker's "Nk tokens" actually counts
      // UP during the run instead of sitting blank until the final "result"
      // event (the captain's exact complaint: "den räknar inte upp ... tokens").
      // Sum OUTPUT tokens for the display, not the all-inclusive total: the
      // total is ~99% cache_read (the cached context re-fed each turn), which made
      // the "Nk tokens" readout look like a token explosion (~1.2M) next to
      // Desktop's leaner output count, while the real generation is tiny
      // (a39286b7 follow-up). Falls back to totalTokens for older event shapes.
      pane.liveTokens += evt.outputTokens ?? evt.totalTokens ?? 0;
      renderLiveStats(index, pane);
      pulsePaneStatusIcon(index);
      break;
    case "assistant":
      {
        const streamed = { role: "assistant", kind: "text", text: evt.text, pending: true };
        pane.turns.push(streamed);
        rememberPendingTurn(pane.sessionId, streamed);
      }
      bumpSessionActivity(pane.sessionId);
      // Coalesced onto a frame so a burst of streaming blocks doesn't drive
      // several synchronous full rebuilds and starve typing (f41a7f4e).
      scheduleRenderPane(index);
      pulsePaneStatusIcon(index);
      break;
    case "error":
      // A genuine terminal event for this launch — the Stop-button watchdog's
      // fallback (see handleSendOrStop) exists only for the case where NOTHING
      // terminal ever arrives, so cancel it the moment one does.
      clearTimeout(pane.stopWatchdogTimer);
      pane.busy = false;
      pane.currentLaunchId = null;
      stopLiveStatsTicker(index);
      setPaneBusyUI(index, "");
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ " + evt.message, pending: true });
      maybeSurfaceAuthError(evt.message);
      bumpSessionActivity(pane.sessionId);
      renderPane(index);
      break;
    case "done":
      clearTimeout(pane.stopWatchdogTimer);
      pane.busy = false;
      pane.currentLaunchId = null;
      stopLiveStatsTicker(index);
      setPaneBusyUI(index, "");
      // stopRequested alone isn't reliable: the process can finish naturally
      // in the small window between clicking Stop and that IPC call actually
      // landing, in which case it's not actually stopped, just a real
      // completion that happened to race a Stop click. evt.summary.sawResult
      // reflects whether the CLI itself produced a genuine result — only
      // treat this as a stop if it did NOT.
      if (pane.stopRequested && !evt.summary?.sawResult) {
        // Reconcile against the file with a plain (non-authoritative) reload first -
        // that merge is additive-only (mergeReloadedTurns), so it can only ADD
        // whatever the killed process DID manage to flush; it can never drop a
        // just-streamed chunk the file hasn't caught up with yet, which is what
        // reloading here used to risk before this merge existed. Once the process
        // has actually exited, though, nothing more is EVER going to land in the
        // file for this run - so the per-session pending buffer (rememberPendingTurn,
        // fed by every streamed chunk of this run) is cleared right after. Leaving
        // it live past this point is exactly what let old streamed turns resurrect on
        // every future reopen of this session whenever the reload's tail-match window
        // missed them (the captain: "output ibland dupliceras och återkommer längst ner").
        pane.stopRequested = false;
        loadTranscriptInto(index).then(() => {
          if (panes[index] !== pane) {
            return; // pane was reused for a different session while this awaited
          }
          pendingTurnsBySession.delete(pane.sessionId);
          pane.turns.push({ role: "assistant", kind: "text", text: "⏹ Stopped." });
          bumpSessionActivity(pane.sessionId);
          renderPane(index);
        });
        // A queued prompt is deliberately NOT fired after an explicit stop —
        // you stopped this run for a reason, most likely to intervene, not
        // to have something else auto-fire right after.
      } else if (!evt.summary?.sawResult && evt.summary?.code !== 0) {
        // A genuine CLI failure (non-zero exit, no result ever produced) —
        // e.g. "No conversation found with session ID" when resuming from a
        // folder the session wasn't created in. Previously this vanished
        // completely: stderr was captured but nothing consumed it, so the
        // prompt just silently disappeared with the pane going back to idle
        // (caught via the captain's "vad innebär pick repo folder på en befintlig
        // session" question). Surface it as a visible error turn instead of
        // reloading a transcript that never got the failed turn appended. The run is
        // still fully over, though - drop any leftover per-session pending buffer so a
        // stray streamed turn from an EARLIER run in this same session can't keep
        // resurrecting on future reopens (see the "stopped" branch above for the
        // mechanism this closes).
        pane.stopRequested = false;
        pendingTurnsBySession.delete(pane.sessionId);
        const cleaned = (evt.summary?.stderrText || "")
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("Warning: no stdin data received"))
          .join(" ")
          .trim();
        // A spawn-level failure (e.g. the claude binary couldn't be found)
        // resolves with {code:-1, error: err.message} and no stderrText at
        // all (launcher.js's separate child.on("error") path) — fall back to
        // that message rather than dropping it for the generic exit-code
        // text (caught in review).
        const message = cleaned || evt.summary?.error || `Run failed (exit code ${evt.summary?.code}).`;
        pane.turns.push({
          role: "assistant",
          kind: "text",
          text: "⚠ " + truncateText(message, 400),
        });
        maybeSurfaceAuthError(message);
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
      } else if (!evt.summary?.sawResult) {
        // The turn ended cleanly (exit 0) but WITHOUT a genuine CLI result event -
        // e.g. it stopped after a tool call without concluding. This used to fall
        // through to the normal-completion branch and go SILENTLY idle: send icon,
        // no spinner, no completion text, no error - so it looked hung (the captain:
        // "har den hängt sig?" - a39286b7). Keep whatever streamed and surface the
        // state so it's legible and the captain can continue to resume. A queued
        // prompt is deliberately NOT fired - the turn didn't complete.
        pane.stopRequested = false;
        pane.lastTurnStats = {
          durationMs: typeof evt.summary?.durationMs === "number" ? evt.summary.durationMs : Date.now() - startedAt,
          totalTokens: evt.summary?.outputTokens ?? evt.summary?.totalTokens ?? null,
          costUsd: evt.summary?.costUsd ?? null,
        };
        // Same reconcile-then-drop-the-buffer treatment as the "stopped" branch above:
        // a plain reload can only ADD whatever this run did manage to flush before
        // ending without a result, never drop the not-yet-flushed tail - and since the
        // process has already exited, nothing more is coming, so the per-session
        // pending buffer is cleared right after instead of resurrecting stale streamed
        // turns on every future reopen.
        loadTranscriptInto(index).then(() => {
          if (panes[index] !== pane) {
            return; // pane was reused for a different session while this awaited
          }
          pendingTurnsBySession.delete(pane.sessionId);
          pane.turns.push({
            role: "assistant",
            kind: "text",
            text: "⚠ The run ended without finishing (no result was produced) - it may have hit a limit or been interrupted. Press ⏎ to continue and resume it.",
          });
          bumpSessionActivity(pane.sessionId);
          renderPane(index);
        });
      } else {
        pane.stopRequested = false;
        // Feeds wireTurnStatsOnLastReply's "12.3s · 1.2k tokens" readout on
        // the reply that just landed. durationMs/totalTokens come straight
        // from the CLI's own result event (launcher.js) — the authoritative
        // per-turn numbers, already collected for the usage log, just not
        // previously surfaced in the UI. durationMs falls back to a
        // wall-clock measurement (startedAt was stamped at send time in
        // launchPaneHistory) for the rare case the CLI didn't report one
        // (e.g. sawResult false) but the run still produced a reply.
        pane.lastTurnStats = {
          durationMs: typeof evt.summary?.durationMs === "number" ? evt.summary.durationMs : Date.now() - startedAt,
          totalTokens: evt.summary?.outputTokens ?? evt.summary?.totalTokens ?? null,
          costUsd: evt.summary?.costUsd ?? null,
        };
        // An auth failure can arrive as the CLI's RESULT text - a "successful"
        // turn (sawResult true, ~0 tokens) whose content is just "Failed to
        // authenticate: OAuth session expired ..." - not as an error event. Seen
        // exactly this way (task 3218cdd4: "failed to authenticate hela tiden", a
        // plain 0-token turn with no shortcut). The error branches above already
        // call maybeSurfaceAuthError; this covers the result-text path, or the one
        // error a captain can fix in a click renders as an ordinary reply.
        const lastReplyText = [...pane.turns].reverse().find((t) => t.role === "assistant" && t.kind === "text")?.text || "";
        maybeSurfaceAuthError(lastReplyText);
        // Authoritative: the turn finished with a genuine result, so the file now holds
        // the whole conversation. Replacing (not merging) drops the streamed pending
        // blocks so the completed reply can't render twice - once as live bubbles and
        // again as the file's "Used N tools" grouped copy (bug b608c99b).
        loadTranscriptInto(index, { authoritative: true }).then(refresh);
        fireQueuedPromptIfAny(index, pane);
      }
      break;
    default:
      break;
  }
  // launchPaneHistory is intentionally NOT deleted here (unlike the old
  // paneLaunchMap on "done") — the model-fit judge fires well after "done"
  // and still needs this same entry; it does the one-shot delete itself.
  // Backstop: pruneStaleLaunchHistory() reclaims anything the judge never
  // consumes (disabled, errored launch, etc).
});

// ============================== Command palette (Cmd/Ctrl+K) ==============================
// A keyboard-first fuzzy launcher over EXISTING affordances - it never
// reimplements navigation or session logic, it just calls the same functions
// the buttons do (navigateToPage, openSessionInPane, openFreshDraftInPane) or
// clicks the real button (#backgroundTasksBtn). The command
// registry is rebuilt every open because entities (sessions, projects) are
// live. State is renderer-local; nothing persists.
let cmdkSelectedIndex = 0;
let cmdkCommands = []; // filtered list currently shown (in render order)

// Case-insensitive subsequence fuzzy match: every char of the query must
// appear in order somewhere in the label. Substring naturally satisfies this,
// so "gda"/"dash"/"go dash" all match "Go to Dashboard". No scoring beyond
// registry order - kept deliberately lean.
function cmdkFuzzyMatch(query, label) {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  let li = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    li = l.indexOf(ch, li);
    if (li === -1) {
      return false;
    }
    li++;
  }
  return true;
}

// Rebuilds the full command registry from current app state. Order is
// nav-first, then actions, then live session/project entities - so an empty
// query shows navigation at the top.
function cmdkBuildCommands() {
  const cmds = [];

  // NAVIGATION - one per router page (see navigateToPage's valid pages).
  const navPages = [
    ["Go to Dashboard / Overview", "dashboard"],
    ["Go to Autopilot", "goal"],
    ["Go to Routines", "routines"],
    ["Go to Chat", "chat"],
    ["Go to Plan", "lavish"],
    ["Go to Analysis", "analysis"],
    ["Go to Archive", "archive"],
    ["Go to Settings", "settings"],
  ];
  for (const [label, page] of navPages) {
    cmds.push({ label, tag: "Nav", run: () => navigateToPage(page) });
  }

  // AUTO-CAPTAIN. Its switch and its "run one pass" live in the Auto widget, which
  // only exists on the widget dashboard - and that is off for the captain, so without
  // these two entries the feature would be unreachable for him entirely. Kept out
  // of the classic dashboard on purpose: a permanent panel for something that is
  // switched off is the same noise the docs-drift nudge just had removed from it.
  {
    const on = state.config?.autoCaptain?.enabled === true;
    cmds.push({
      label: on ? "Auto-captain: turn OFF" : "Auto-captain: turn on (starts tasks tagged \"auto\")",
      tag: "Auto",
      run: async () => {
        if (!on) {
          customConfirm(
            "Turn on the auto-captain? Tasks tagged \"auto\" in Jot will start real sessions by themselves, up to 3 at a time. Work always lands in review - it never marks anything done.",
            "Turn on",
            async () => {
              const res = await window.helm.setAutoCaptainEnabled(true);
              if (!res?.ok) {
                showToast(`Couldn't turn it on: ${res.error}`);
                return;
              }
              state.config = { ...state.config, autoCaptain: { ...(state.config?.autoCaptain || {}), enabled: true } };
              showToast("Auto-captain is on.");
            },
            { deliberate: true }
          );
          return;
        }
        const res = await window.helm.setAutoCaptainEnabled(false);
        if (res?.ok) {
          state.config = { ...state.config, autoCaptain: { ...(state.config?.autoCaptain || {}), enabled: false } };
          showToast("Auto-captain is off.");
        }
      },
    });
    cmds.push({
      label: "Auto-captain: run one pass now",
      tag: "Auto",
      run: async () => {
        showToast("Auto-captain: checking the board…");
        const res = await window.helm.runAutoCaptainNow({ force: true });
        if (!res?.ok) {
          showToast(`Auto-captain: ${res?.error || "that didn't work"}`);
          return;
        }
        if (res.skipped) {
          showToast(`Auto-captain did nothing: ${res.skipped}.`);
          return;
        }
        const bits = [];
        if (res.acted) {
          bits.push(`started ${res.acted}`);
        }
        if (res.held) {
          bits.push(`held back ${res.held} for clarification`);
        }
        if (res.waiting) {
          bits.push(`${res.waiting} waiting`);
        }
        showToast(bits.length ? `Auto-captain: ${bits.join(", ")}.` : "Auto-captain: nothing tagged \"auto\" is queued.");
      },
    });
  }

  // ACTIONS - only when the underlying affordance exists in the DOM.
  //
  // "New chat" used to CLICK the sidebar's own button, so removing that panel (task 22f85eda)
  // silently deleted this entry too: the guard below it was `if (newChatBtn)`, and there was no
  // button left to find. Caught by review, which also caught the comment I left behind claiming
  // the palette still offered it. It now opens a fresh draft directly, the same call the pane's
  // own "+" makes - so the entry exists whatever the chat page happens to contain.
  cmds.push({
    label: "New chat",
    tag: "Action",
    run: () => {
      navigateToPage("chat");
      openFreshDraftInPane("", "");
    },
  });
  const bgBtn = document.getElementById("backgroundTasksBtn");
  if (bgBtn) {
    cmds.push({ label: "Background tasks", tag: "Action", run: () => bgBtn.click() });
  }

  // SESSION ENTITIES - non-archived sessions open in the focused pane (same as
  // clicking one in the sidebar), switching to Chat first.
  for (const session of state.sessions) {
    if (session.isArchived || isHiddenFromHelm(session)) {
      continue;
    }
    const statusLabel = STATUS_LABEL[session.status] || session.status || "";
    cmds.push({
      label: `Open session: ${session.title || "Untitled"}`,
      tag: statusLabel ? `Session · ${statusLabel}` : "Session",
      run: () => {
        navigateToPage("chat");
        openSessionInPane(session, focusedPaneIndex);
      },
    });
  }

  // PROJECT ENTITIES - repo projects derived from cwd's Helm has seen among
  // its sessions (the same repo-chip source as the dashboard launcher; kept
  // synchronous, so no async listDomains here - domains are omitted to keep
  // the palette instant). Starting one reuses the chip's Start-fresh flow.
  const knownRepos = [...new Set(state.sessions.filter((s) => s.cwd).map((s) => s.cwd))];
  for (const cwd of knownRepos) {
    const label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
    cmds.push({
      label: `New session in ${label}`,
      tag: "Project",
      run: () => {
        navigateToPage("chat");
        openFreshDraftInPane(cwd, "");
      },
    });
  }

  return cmds;
}

function cmdkIsOpen() {
  return !document.getElementById("commandPalette").classList.contains("hidden");
}

function cmdkRenderList() {
  const listEl = document.getElementById("cmdkList");
  listEl.innerHTML = "";
  if (cmdkCommands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cmdk-empty";
    empty.textContent = "No matches";
    listEl.append(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  cmdkCommands.forEach((cmd, i) => {
    const row = document.createElement("div");
    row.className = "cmdk-row" + (i === cmdkSelectedIndex ? " is-selected" : "");
    row.dataset.index = String(i);
    const label = document.createElement("span");
    label.className = "cmdk-row-label";
    label.textContent = cmd.label;
    const tag = document.createElement("span");
    tag.className = "cmdk-row-tag";
    tag.textContent = cmd.tag;
    row.append(label, tag);
    // Mouse hover selects (keeps parity with keyboard selection); click runs.
    row.addEventListener("mouseenter", () => cmdkSetSelected(i));
    row.addEventListener("click", () => cmdkRun(i));
    frag.append(row);
  });
  listEl.append(frag);
}

function cmdkSetSelected(i) {
  if (i === cmdkSelectedIndex) {
    return;
  }
  cmdkSelectedIndex = i;
  const rows = document.querySelectorAll("#cmdkList .cmdk-row");
  rows.forEach((r, idx) => r.classList.toggle("is-selected", idx === cmdkSelectedIndex));
}

function cmdkFilter() {
  const query = document.getElementById("cmdkInput").value.trim();
  const all = cmdkBuildCommands();
  cmdkCommands = query ? all.filter((c) => cmdkFuzzyMatch(query, c.label)) : all;
  cmdkSelectedIndex = 0;
  cmdkRenderList();
}

function cmdkOpen() {
  const palette = document.getElementById("commandPalette");
  palette.classList.remove("hidden");
  const input = document.getElementById("cmdkInput");
  input.value = "";
  cmdkFilter();
  input.focus();
}

function cmdkClose() {
  const palette = document.getElementById("commandPalette");
  palette.classList.add("hidden");
  document.getElementById("cmdkInput").value = "";
  cmdkCommands = [];
  cmdkSelectedIndex = 0;
}

document.getElementById("cmdkHint")?.addEventListener("click", () => cmdkOpen());

function cmdkRun(i) {
  const cmd = cmdkCommands[i];
  cmdkClose();
  if (cmd) {
    cmd.run();
  }
}

function cmdkMoveSelection(delta) {
  if (cmdkCommands.length === 0) {
    return;
  }
  const next = (cmdkSelectedIndex + delta + cmdkCommands.length) % cmdkCommands.length;
  cmdkSetSelected(next);
  const row = document.querySelector(`#cmdkList .cmdk-row[data-index="${next}"]`);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
  }
}

// Global toggle: Cmd/Ctrl+K opens/closes. Registered on document so it works
// from anywhere; guarded so it doesn't fight existing shortcuts (it only
// claims the Ctrl/Cmd+K combo, which nothing else uses).
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (cmdkIsOpen()) {
      cmdkClose();
    } else {
      cmdkOpen();
    }
    return;
  }
  if (!cmdkIsOpen()) {
    return;
  }
  // Palette-local keys, handled only while open.
  if (e.key === "Escape") {
    e.preventDefault();
    cmdkClose();
  } else if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "J"))) {
    e.preventDefault();
    cmdkMoveSelection(1);
  } else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "P"))) {
    // Up-alias is Ctrl+p (not Ctrl+k): Ctrl+k is the open/close toggle above,
    // so it can't double as "move up" without the toggle swallowing it first.
    e.preventDefault();
    cmdkMoveSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    cmdkRun(cmdkSelectedIndex);
  }
});

document.getElementById("cmdkInput").addEventListener("input", cmdkFilter);
document.getElementById("cmdkBackdrop").addEventListener("click", cmdkClose);

renderWorkspace();
renderBackgroundTasksBadge();
startup();
setInterval(refresh, 30000);

window.helm.getVersion().then((v) => {
  document.getElementById("appVersion").textContent = v;
});

// Dev-build marker: dev (npm start) and the installed app read different data
// dirs (repo root vs ~/.helm), so their fleet/sessions differ by design. Badge
// the dev window unmistakably (a filled DEV pill + a header accent stripe via
// body.dev-build) so the two windows are never confused (the captain 2026-07-11).
window.helm.isDevBuild().then((dev) => {
  if (dev) {
    document.getElementById("devBadge").classList.remove("hidden");
    document.body.classList.add("dev-build");
  }
});

// Stale-build indicator: shows the pill when main.js's periodic on-disk
// check (see runStaleBuildCheck) finds the git HEAD has moved past what this
// running instance booted with — i.e. the source on disk changed (a pull, an
// edit) since Helm started, so the currently running window no longer
// matches what's on disk. Purely informational (there is no in-app restart
// action here — the captain restarts via his own script, which this must not try
// to replace or second-guess).
function applyBuildStatus(status) {
  const pill = document.getElementById("staleBuildPill");
  if (!pill) {
    return;
  }
  if (status && status.stale) {
    pill.textContent = "Newer build available - restart";
    pill.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
  }
}

window.helm.getBuildStatus().then(applyBuildStatus);
window.helm.onBuildStaleUpdate(applyBuildStatus);

// Model-freshness indicator: main.js (checkModelFreshness, run once a day)
// scans the installed `claude` binary for model ids newer than anything in
// src/lib/models.js's KNOWN_MODEL_IDS. Purely informational, same as the
// stale-build pill - the fix is a one-line edit to that file (add the id),
// not something this button does for you.
function applyModelFreshness(status) {
  const pill = document.getElementById("modelFreshnessPill");
  if (!pill) {
    return;
  }
  const ids = status?.newModelIds || [];
  if (ids.length) {
    pill.textContent = ids.length === 1 ? `New model: ${ids[0]}` : `${ids.length} new models`;
    pill.title = `The installed claude CLI recognizes ${ids.join(", ")}, which src/lib/models.js doesn't list yet. Add ${ids.length === 1 ? "it" : "them"} there (and to the model picker/reviewer tiers if it should be selectable).`;
    pill.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
  }
}

window.helm.getModelFreshness().then(applyModelFreshness);
window.helm.onModelFreshnessUpdate(applyModelFreshness);

// A setting that could not be saved has to SAY so. setConfig returns the config
// object itself (assigned straight into state.config all over this file), so it has
// no room to report a failure - without this the setting would appear to apply and
// then quietly be gone after a restart.
window.helm.onConfigWriteFailed(({ message } = {}) => {
  // Sticky: the setting LOOKS applied and will be gone after a restart. This is the
  // exact case a four-second message was worst at - it arrives from the main process
  // while the eye is on the control that just moved.
  showNotice(`That setting didn't save: ${message || "unknown reason"}. It will be back to its old value after a restart.`);
});
