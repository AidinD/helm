const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };

let state = { sessions: [], config: { groups: [], viewMode: "simple" }, quota: null };
let searchTerm = "";
let archiveSearchTerm = ""; // filters the Archive page's two lists by title/folder
let selectedGoalId = null; // Focus page: which goal's breakdown is expanded
// Goal page (Fas 3 Point 11) — all autonomous runs this session, keyed by
// goalRunId. The backend (main.js liveGoalRuns + goal:event carrying
// goalRunId) already supports several concurrent runs, each in its own
// isolated worktree; the renderer tracks each as its own entry so the Goal
// page can launch and watch more than one at a time. Each entry:
// { goalRunId, ordinal, goal, projectPath, maxIterations, model, effort,
//   verifyCommand, escalationConfig, status, iterations: [...], result, error,
//   escalation, latestPlan }. `escalation` (Point 12 Phase-0, opt-in) is set
// when a run pauses on a signal instead of finishing - see goalOrchestrator.js.
let goalRuns = new Map();
// Monotonic label counter so concurrent runs are tellable apart ("Run 1", …).
let goalRunSeq = 0;
// goalRunIds whose error/escalation hasn't been seen yet - drives the small
// attention dot on the primary Dashboard tab so a failed/paused run started
// off-page (e.g. while on Chat) isn't silently missed. Cleared whenever the
// user navigates into the Goal or Agents facet (see navigateToPage).
let unseenGoalAttention = new Set();
// Persists the "Escalate on trouble" checkbox across re-renders of the launcher
// form (renderGoalPage rebuilds the whole page's DOM each time). A plain module
// var since it must survive before any run exists.
let goalEscalateOnTrouble = false;
let selectedSessionId = null;
let focusedPaneIndex = 0;
let dragSessionId = null;
// The single source of truth for a drag-reorder: set on every dragover and
// read verbatim by drop, so the drop lands exactly where the indicator was
// shown (the old code recomputed position from a live rect at drop time,
// which disagreed with the shown indicator once layout had shifted).
// { row: HTMLElement, before: boolean } | null.
let dropTarget = null;
// Same pattern, separate state — reordering CATEGORIES (dragging a section's
// header) is a distinct drag payload type ("text/category-label", never
// "text/session-id") from reordering sessions, so it needs its own drop
// target rather than sharing/overloading `dropTarget` above.
// { wrap: HTMLElement, label: string, before: boolean } | null.
let categoryDropTarget = null;
// Timestamp a category drag started (null when not dragging). The 30s
// refresh() timer — or any session event — otherwise rebuilds the sidebar
// mid-drag, visibly undoing the drag-collapse and destroying the dragged
// header. refresh() skips the sidebar rebuild while this is set. A timestamp
// (not a bool) so a drag that somehow never ends self-heals after 30s rather
// than freezing the sidebar forever — dragend clears it in every normal case.
let categoryDragStartedAt = null;
const CATEGORY_DRAG_STALE_MS = 30000;

function categoryDragInProgress() {
  return categoryDragStartedAt !== null && Date.now() - categoryDragStartedAt < CATEGORY_DRAG_STALE_MS;
}
// launchId -> { index, pane, startedAt }. The ONE map every launch-scoped
// event (session/tool_use/assistant/error/done/modelFit) is routed through,
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

// Browser-style back/forward between chats opened in a given pane SLOT.
// Keyed by pane index, not stored on the pane object itself — openSessionInPane
// replaces the whole pane object on every navigation, which would wipe
// history stored there. { stack: [sessionId, ...], position: number }.
const paneNavHistory = new Map();

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

// Live "Ns · Nk tokens" ticker while a pane is busy — Aidin's feedback on the
// first version of this readout ("den räknar inte upp varken tokens eller
// tid," i.e. it doesn't count up): a plain per-second interval reading
// pane.runStartedAt/pane.liveTokens (already updated live by the "usage"
// event case below) is the simplest thing that reads as "ticking," no need
// for anything fancier. Keyed by pane INDEX (mirrors paneNavHistory) since
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
// Hold-to-record, not click-to-toggle (Aidin's v1 feedback: "Jag vill ha en
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

// CONTINUOUS ("live") transcription — Aidin's ask: show what's being heard
// progressively WHILE holding, like Claude Desktop, instead of only on
// release. Whisper is NOT a streaming model, so this is deliberately built as
// ROLLING RE-TRANSCRIPTION, not real token streaming: while held, on this
// interval we take ALL audio captured so far, transcribe the whole
// accumulated clip, and replace the live partial in the composer with the
// latest fuller result. On release, one last full transcription produces the
// authoritative text. See DECISIONS.md ("continuous voice input").
//
// Tunable. Bumped from 2000 to 4000ms after Aidin's live-test feedback that
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
  window.maestro.onVoiceStreamEvent((payload) => {
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
        console.error("[maestro] voice stream error:", payload.message);
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
  const res = await window.maestro.startVoiceStream(language);
  if (!heldRecordings.has(index)) {
    // Hold released while the spawn round-trip was pending — if it did
    // start, stop it immediately rather than leaving it running unheld.
    if (res.ok) {
      window.maestro.stopVoiceStream(res.streamId);
    }
    return true; // claim the hold either way so the caller doesn't also fall back to the rolling path
  }
  if (!res.ok) {
    console.warn("[maestro] real-time voice streaming unavailable, falling back to rolling re-transcription:", res.error);
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
  micBtn.title = "Recording — release to stop (live streaming transcription)";
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
  await window.maestro.stopVoiceStream(entry.streamId);
  // Whatever text is already in the composer's voice span (committed +
  // last live partial) IS the final result — unlike the rolling path, there
  // is no separate "final transcription" pass to run, since whisper-stream
  // has already been continuously transcribing in real time.
  entry.micBtn.classList.remove("recording");
  entry.micBtn.innerHTML = MIC_ICON_IDLE;
  entry.micBtn.title = "Hold to record voice input (transcribed locally, offline) — or hold Alt in the composer";
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
      const res = await window.maestro.transcribeVoice(Array.from(samples), currentLanguage());
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
      const res = await window.maestro.transcribeVoice(Array.from(samples), currentLanguage());
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
      micBtn.title = "Hold to record voice input (transcribed locally, offline) — or hold Alt in the composer";
    }
  });

  activeRecordings.set(index, entry);
  // Timeslice so dataavailable fires ~every second, giving the rolling loop a
  // growing set of chunks to re-transcribe instead of one blob only at stop.
  mediaRecorder.start(1000);
  entry.rollingTimer = setInterval(rollingTick, VOICE_ROLLING_INTERVAL_MS);
  micBtn.classList.add("recording");
  micBtn.innerHTML = MIC_ICON_RECORDING;
  micBtn.title = "Recording — release to stop (transcribing live)";
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
// other special characters e.g. in "D:\Dropbox\Mina Dokument\..."). The
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

function matchesSearch(session) {
  if (!searchTerm) {
    return true;
  }
  return session.title.toLowerCase().includes(searchTerm);
}

function sessionById(id) {
  return state.sessions.find((s) => s.sessionId === id);
}

// Context-window size for a pane's session: prefer the real window Maestro
// learned for that session's model (from the CLI's result events, stored in
// config.modelContextWindows), fall back to the configurable default for a
// model not yet seen. Used to turn the token estimate into the gauge's %.
function contextWindowForPane(pane) {
  const model = sessionById(pane.sessionId)?.model;
  const learned = state.config.modelContextWindows || {};
  return (model && learned[model]) || state.config.contextWindowTokens || 1000000;
}

// state.sessions is only refreshed by the 30s poll / explicit refresh() —
// it does NOT update live as a run streams. Without this, a reply that
// streams in mid-conversation renders against the SESSION's stale
// lastActivityAt, which can still exactly equal an earlier
// acknowledgedSessions timestamp — making wireDoneButtonOnLastReply's
// isAcked check wrongly true and the Done checkmark "follow along" onto a
// brand new reply it was never actually placed on (caught by Aidin: "om jag
// sen fortsätter prompta tillkommer nya saker och då ska inte checkmarken
// följa med"). Bumping this the moment new content actually streams in
// invalidates the stale match immediately, without waiting for a poll.
function bumpSessionActivity(sessionId) {
  const session = sessionById(sessionId);
  if (session) {
    session.lastActivityAt = Date.now();
  }
}

// Sessions matched to the "Orchestrator" Jot list are Maestro-building work
// itself — tagged distinctly so it's never confused with regular project
// chats. The Jot-name match is fragile (breaks if that list is renamed), so
// it can also be set manually via right-click, independent of Jot.
function isOrchestratorSession(session) {
  const manual = state.config.manualMaestroSessions || [];
  return session.jot?.category === "Orchestrator" || manual.includes(session.sessionId);
}

// "Delete" a session from Maestro's own view — never touches the desktop
// app's real session files (that would risk destroying real conversation
// history). Purely hides it from the sidebar via config; restorable from
// the Archive page.
async function removeFromMaestro(session) {
  const hidden = [...(state.config.hiddenSessions || []), session.sessionId];
  state.config = await window.maestro.setConfig({ hiddenSessions: hidden });
  refresh();
}

async function restoreToMaestro(session) {
  const hidden = (state.config.hiddenSessions || []).filter((id) => id !== session.sessionId);
  state.config = await window.maestro.setConfig({ hiddenSessions: hidden });
  await refresh();
  refreshArchivePageIfVisible();
}

// refresh() only ever re-renders the sidebar — Analysis/Settings/Archive are
// pull-based (re-rendered on tab switch), which would otherwise leave a
// just-restored/unarchived row stale on screen if you're currently ON the
// Archive page when you click its own action button.
function refreshArchivePageIfVisible() {
  if (!document.getElementById("archivePage").classList.contains("hidden")) {
    renderArchivePage();
  }
}

// Real archiving: flips isArchived in the desktop app's OWN local_*.json
// file (unlike removeFromMaestro, which only ever touches Maestro's config).
// Always a direct response to an explicit click — either the manual context
// menu action, or the user clicking a suggested-archive pill — never fired
// on a timer or any other unattended trigger.
async function archiveSession(session) {
  const res = await window.maestro.archiveSession(session.sessionId, true);
  if (!res.ok) {
    console.error("[maestro] archive failed:", res.error);
    showToast(`Couldn't archive "${session.title}": ${res.error}`);
    return;
  }
  refresh();
}

// From the Archive page — flips isArchived back to false so the session
// reappears both in Maestro's sidebar and in the real desktop app.
async function unarchiveSession(session) {
  const res = await window.maestro.archiveSession(session.sessionId, false);
  if (!res.ok) {
    console.error("[maestro] unarchive failed:", res.error);
    showToast(`Couldn't unarchive "${session.title}": ${res.error}`);
    return;
  }
  await refresh();
  refreshArchivePageIfVisible();
}

// Small transient message for failures with no natural home (e.g. no pane to
// write into) — not for routine feedback, just so a failure is never silent.
function showToast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

// Exclusive (radio-button, not checkbox) — per "shouldn't there just be ONE
// Maestro chat?" Marking a new one replaces any previous manual pick. The
// Jot-category auto-match can still independently tag more than one session
// (that reflects real list membership, not a manual choice), so this only
// governs the manual override.
async function toggleManualMaestroTag(session) {
  const current = state.config.manualMaestroSessions || [];
  const next = current.includes(session.sessionId) ? [] : [session.sessionId];
  state.config = await window.maestro.setConfig({ manualMaestroSessions: next });
  refresh();
}

// ============================== Context menu ==============================

function closeContextMenu() {
  document.getElementById("contextMenu").classList.add("hidden");
}

// Context-size + quota popover, opened from the composer's context gauge —
// the combined readout Aidin wanted (like Claude Code: click the context
// meter, see both context and quota). Only one is ever open; a second click
// or an outside click closes it (closeContextPopover is wired into the
// document click handler alongside closeContextMenu).
function closeContextPopover() {
  document.querySelectorAll(".context-popover").forEach((el) => el.remove());
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

  const q = state.quota;
  if (q) {
    const qpct = Math.round((q.utilization || 0) * 100);
    pop.append(cpopBarRow(`Quota · ${q.rateLimitType || "limit"}`, `${qpct}% used`, qpct, qpct >= 80));
  } else {
    const none = document.createElement("div");
    none.className = "cpop-empty";
    none.textContent = "Quota: — (no data yet)";
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
function dropdownPill(initialValue, options, onSelect) {
  const btn = document.createElement("button");
  btn.className = "meta-pill";
  btn.dataset.hasMenu = "1";
  btn.type = "button";

  const setValue = (value) => {
    btn.dataset.value = value;
    const opt = options.find((o) => o.value === value);
    btn.textContent = opt ? opt.label : value;
  };
  setValue(initialValue);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom + 4,
      options.map((o) => ({
        label: o.label,
        onClick: () => {
          setValue(o.value);
          onSelect(o.value);
        },
      }))
    );
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

// Mouse side buttons (back = button 3, forward = button 4) drive the focused
// pane's chat history the same as the ←/→ header buttons — Aidin asked for
// the physical back/forward buttons to work too. Uses mouseup (fires for
// these buttons in Chromium) and guards focusedPaneIndex being a live pane.
document.addEventListener("mouseup", (e) => {
  if (e.button !== 3 && e.button !== 4) {
    return;
  }
  e.preventDefault();
  if (!panes[focusedPaneIndex]) {
    return;
  }
  navigateHistory(focusedPaneIndex, e.button === 3 ? -1 : 1);
});

// ============================== Category CRUD ==============================
//
// window.prompt()/confirm() turned out to be unreliable in this Electron
// build (renaming silently failed, and the OS cursor got stuck once). Rename
// is now inline double-click editing everywhere, and delete is a two-step
// context-menu confirm — no native synchronous dialogs anywhere.

function nextCategoryLabel() {
  const existing = new Set((state.config.groups || []).map((g) => g.label));
  if (!existing.has("New category")) {
    return "New category";
  }
  let n = 2;
  while (existing.has(`New category ${n}`)) {
    n++;
  }
  return `New category ${n}`;
}

async function createCategory() {
  const groups = [...(state.config.groups || []), { label: nextCategoryLabel(), sessionIds: [], collapsed: false }];
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

async function renameCategoryTo(oldLabel, newLabel) {
  if (!newLabel || !newLabel.trim() || newLabel === oldLabel) {
    return;
  }
  const groups = (state.config.groups || []).map((g) => (g.label === oldLabel ? { ...g, label: newLabel.trim() } : g));
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

async function deleteCategory(label) {
  const groups = (state.config.groups || []).filter((g) => g.label !== label);
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

// Display-only rename — never writes to the desktop app's own session files,
// so it can't corrupt live state there; it just overrides what Maestro shows.
async function renameSessionTo(session, newTitle) {
  if (!newTitle || !newTitle.trim() || newTitle === session.title) {
    return;
  }
  const titleOverrides = { ...(state.config.titleOverrides || {}), [session.sessionId]: newTitle.trim() };
  state.config = await window.maestro.setConfig({ titleOverrides });
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

// ============================== Drag and drop (VS Code style) ==============================

async function moveSessionToGroup(sessionId, targetLabel, insertBeforeId) {
  const groups = (state.config.groups || []).map((g) => ({
    ...g,
    sessionIds: (g.sessionIds || []).filter((id) => id !== sessionId),
  }));
  if (targetLabel) {
    const target = groups.find((g) => g.label === targetLabel);
    if (target) {
      const idx = insertBeforeId ? target.sessionIds.indexOf(insertBeforeId) : -1;
      if (idx === -1) {
        target.sessionIds.push(sessionId);
      } else {
        target.sessionIds.splice(idx, 0, sessionId);
      }
    }
  }
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

// Clears the drop indicator everywhere so only one row is ever marked. The
// indicator is a CSS class drawing an absolutely-positioned pseudo-element
// line — NOT a real element in the list flow — so toggling it never shifts
// layout and never moves the rects the position math depends on.
function clearDropIndicators() {
  document
    .querySelectorAll(".row.drop-before, .row.drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

function clearCategoryDropIndicators() {
  document
    .querySelectorAll(".section.drop-before, .section.drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

// Reorders state.config.groups by moving draggedLabel to just before/after
// targetLabel. Splice-based, same shape as moveSessionToGroup's reorder.
async function reorderCategory(draggedLabel, targetLabel, before) {
  const groups = [...(state.config.groups || [])];
  const draggedIdx = groups.findIndex((g) => g.label === draggedLabel);
  if (draggedIdx === -1) {
    return;
  }
  const [dragged] = groups.splice(draggedIdx, 1);
  const targetIdx = groups.findIndex((g) => g.label === targetLabel);
  if (targetIdx === -1) {
    groups.push(dragged);
  } else {
    groups.splice(before ? targetIdx : targetIdx + 1, 0, dragged);
  }
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

// ============================== Row + section rendering ==============================

function rowEl(session) {
  const row = document.createElement("div");
  row.className = "row" + (session.sessionId === selectedSessionId ? " selected" : "");
  row.draggable = true;
  row.dataset.sessionId = session.sessionId;
  row.dataset.hasMenu = "1";

  const titleLine = document.createElement("div");
  titleLine.className = "row-title-line";
  const dot = document.createElement("span");
  dot.className = `status-dot ${session.status}`;
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = session.title;
  title.title = session.title;
  titleLine.append(dot, title);
  if (isOrchestratorSession(session)) {
    const tag = document.createElement("span");
    tag.className = "maestro-tag";
    tag.textContent = "◆";
    tag.title = "Maestro orchestrator work";
    titleLine.append(tag);
  }
  row.append(titleLine);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.append(spanEl(STATUS_LABEL[session.status] || session.status), spanEl(relTime(session.lastActivityAt)));
  if (session.model) {
    meta.append(spanEl(session.model.replace("claude-", "")));
  }
  row.append(meta);

  if (session.jot) {
    const j = document.createElement("div");
    j.className = "row-jot" + (session.jot.review > 0 ? " review" : "");
    const parts = [];
    if (session.jot.review > 0) {
      parts.push(`${session.jot.review} review`);
    }
    if (session.jot.inProgress > 0) {
      parts.push(`${session.jot.inProgress} wip`);
    }
    if (session.jot.open > 0) {
      parts.push(`${session.jot.open} open`);
    }
    j.textContent = parts.length ? `${session.jot.category} · ${parts.join(" · ")}` : session.jot.category;
    row.append(j);

    // Deadline chip — only when close enough to actually matter for sorting
    // (within a week or overdue), matching the deadlineBoost tiers in
    // sessions.js. Makes the deadline-aware ordering legible: it explains
    // why a session with little other activity is sitting near the top.
    const deadlineText = deadlineChipText(session.jot.nearestDeadline);
    if (deadlineText) {
      const d = document.createElement("div");
      d.className = "row-deadline" + (session.jot.nearestDeadline < Date.now() ? " overdue" : "");
      d.textContent = "⏰ " + deadlineText;
      row.append(d);
    }
  }

  // "Orchestrator proposes, you approve" — only ever a suggestion. Clicking
  // this pill IS the approval step; nothing archives without it. Only shown
  // for genuinely idle sessions with no open Jot work, and never for a
  // Maestro-building session (idle between long autonomous stretches doesn't
  // mean done).
  const hasOpenJotWork =
    session.jot && (session.jot.review > 0 || session.jot.inProgress > 0 || session.jot.open > 0);
  // Fas 3 orchestrator-helper tag — a periodic Haiku classifier's read of
  // the actual conversation content (see main.js's runOrchestratorSweep,
  // PLAN.md Phase 3). Shown whenever present so its judgment is auditable,
  // not a black box (the full visualizer is deliberately deferred until
  // there's real behavior to design around — this is the minimal version:
  // just show what it concluded and why, right on the row it's about).
  if (session.orchestratorTag) {
    const tag = document.createElement("div");
    tag.className = "row-orchestrator-tag";
    tag.title = "Orchestrator helper's read of this session's content (a proposal, never acts on its own).";
    tag.textContent = `◎ ${session.orchestratorTag.reason}`;
    row.append(tag);
  }
  // Auto-compact note — the helper compacted this session automatically (per
  // Aidin's choice of automatic-not-propose for compaction). Shown so a
  // silent background compaction is at least visible after the fact, until
  // the next real activity clears it (main.js gates that on transcript size).
  if (session.autoCompacted) {
    const c = document.createElement("div");
    c.className = "row-orchestrator-tag";
    c.title = "The orchestrator helper auto-compacted this session's context (the full history is still on disk).";
    const pre = session.autoCompacted.preTokens;
    const post = session.autoCompacted.postTokens;
    const fmt = (n) => (typeof n === "number" ? `${Math.round(n / 1000)}k` : "?");
    c.textContent = post !== null ? `⊟ Auto-compacted (${fmt(pre)} → ${fmt(post)} tokens)` : "⊟ Auto-compacted";
    row.append(c);
  }
  // "Orchestrator proposes, you approve" — only ever a suggestion. Clicking
  // this pill IS the approval step; nothing archives without it. Sessions
  // still sitting in "waiting" (inside the attention window) but that the
  // helper has actually READ and concluded are genuinely done skip the wait
  // for the window to expire into "idle" — this is what "replaces the idle
  // proxy with something that's actually read the content" (PLAN.md) means
  // in practice. Never shown for a Maestro-building session (idle between
  // long autonomous stretches doesn't mean done).
  const classifierSaysDone = session.orchestratorTag?.statusTag === "done_not_archived";
  if (
    state.config.archiveSuggestions?.enabled === true &&
    (session.status === "idle" || classifierSaysDone) &&
    !hasOpenJotWork &&
    !isOrchestratorSession(session)
  ) {
    const suggest = document.createElement("button");
    suggest.type = "button";
    suggest.className = "archive-suggest-pill";
    suggest.textContent = "Archive?";
    suggest.title = classifierSaysDone
      ? "Suggested: the orchestrator helper read this conversation and concluded it's done. Click to archive."
      : "Suggested: this session looks idle with no open Jot work. Click to archive.";
    suggest.addEventListener("click", (e) => {
      e.stopPropagation();
      archiveSession(session);
    });
    row.append(suggest);
  }

  // Single click opens the session, but only after a short delay so a second
  // click (making this a double-click) can cancel it in favor of renaming.
  row.addEventListener("click", () => {
    clearTimeout(row._openTimer);
    row._openTimer = setTimeout(() => openSessionInPane(session, focusedPaneIndex), 250);
  });
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    clearTimeout(row._openTimer);
    makeInlineEditable(title, session.title, (v) => renameSessionTo(session, v));
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX;
    const y = e.clientY;
    const groupLabels = (state.config.groups || []).map((g) => g.label);
    showContextMenu(x, y, [
      { label: "Open here", onClick: () => openSessionInPane(session, focusedPaneIndex) },
      { label: "Open in split pane", onClick: () => openSessionInPane(session, focusedPaneIndex === 0 ? 1 : 0, true) },
      { label: "Rename chat (or double-click it)", onClick: () => makeInlineEditable(title, session.title, (v) => renameSessionTo(session, v)) },
      {
        label: isOrchestratorSession(session) ? "Unmark as Maestro chat" : "Mark as Maestro chat",
        onClick: () => toggleManualMaestroTag(session),
      },
      {
        label: "Summarize & carry over to new chat",
        onClick: () => summarizeAndCarryOver(session),
      },
      { sep: true },
      {
        label: "Move to category",
        submenu: [
          ...groupLabels.map((label) => ({ label, onClick: () => moveSessionToGroup(session.sessionId, label) })),
          { label: "Unsorted", onClick: () => moveSessionToGroup(session.sessionId, null) },
        ],
      },
      { sep: true },
      {
        label: "Archive session",
        danger: true,
        onClick: () => {
          // Re-opens with an explicit confirm step (no native window.confirm()
          // — unreliable in this build) since this writes to the desktop
          // app's OWN session file, not just Maestro's local config.
          showContextMenu(x, y, [
            { label: `Confirm archive "${session.title}"`, danger: true, onClick: () => archiveSession(session) },
          ]);
        },
      },
      {
        label: "Remove from Maestro",
        danger: true,
        onClick: () => removeFromMaestro(session),
      },
    ]);
  });

  row.addEventListener("dragstart", (e) => {
    dragSessionId = session.sessionId;
    row.classList.add("dragging");
    e.dataTransfer.setData("text/session-id", session.sessionId);
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    clearDropIndicators();
    dropTarget = null;
  });

  // VS Code-style: hovering the top/bottom half of a row marks that edge.
  // The marker is a pure CSS class (absolutely-positioned pseudo-element,
  // zero layout impact), and the exact {row, before} shown here is stashed
  // in dropTarget so the drop handler acts on the SAME decision — no second,
  // independently-recomputed measurement that could disagree with it.
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    // A category being dragged (reordering the lists themselves) has no
    // business showing a session-row drop indicator — this row would never
    // actually receive that drop (its own drop handler below no-ops on a
    // missing "text/session-id"), so without this guard it falsely promised
    // a valid target. Found in review, alongside the same drag also being
    // able to leave a stale .section indicator AND a stale .row indicator
    // visible at once, since neither handler cleared the other's markers.
    if (e.dataTransfer.types.includes("text/category-label")) {
      return;
    }
    e.stopPropagation();
    // No indicator on the row being dragged — dropping onto yourself is a
    // no-op, and marking it would just be visual noise.
    if (row.classList.contains("dragging")) {
      clearDropIndicators();
      dropTarget = null;
      return;
    }
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    if (dropTarget && dropTarget.row === row && dropTarget.before === before) {
      return; // unchanged since last event — nothing to redraw
    }
    dropTarget = { row, before };
    clearDropIndicators();
    row.classList.add(before ? "drop-before" : "drop-after");
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    // Same reasoning as the dragover guard above — a category drop landing
    // here isn't for this row at all.
    if (e.dataTransfer.types.includes("text/category-label")) {
      return;
    }
    e.stopPropagation();
    // Dropping onto the row being dragged is a no-op (dragover cleared
    // dropTarget for it) — bail before it degenerates into an append.
    if (row.classList.contains("dragging")) {
      clearDropIndicators();
      dropTarget = null;
      return;
    }
    const list = row.parentElement;
    const groupLabel = list.dataset.groupLabel;
    // Read the position from the indicator that was actually shown, not a
    // fresh rect measurement — guarantees the drop lands where you saw it.
    const insertBeforeId = groupLabel ? insertBeforeIdFromDropTarget() : null;
    clearDropIndicators();
    dropTarget = null;
    const sid = e.dataTransfer.getData("text/session-id");
    if (sid) {
      moveSessionToGroup(sid, groupLabel || null, insertBeforeId);
    }
  });

  return row;
}

// Translates the shown {row, before} indicator into the sessionId to insert
// in front of (null = append to end). "After row X" means "before whatever
// follows X" — and a following .dragging row is skipped so dropping just
// below the item you're dragging isn't a confusing no-op-that-looks-like-move.
function insertBeforeIdFromDropTarget() {
  if (!dropTarget) {
    return null;
  }
  const { row, before } = dropTarget;
  if (before) {
    return row.dataset.sessionId;
  }
  let next = row.nextElementSibling;
  while (next && next.classList.contains("dragging")) {
    next = next.nextElementSibling;
  }
  return next && next.dataset.sessionId ? next.dataset.sessionId : null;
}

function spanEl(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

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
  "not as a message to me.";

// If a summarize launch's "done"/"error" event never arrives (a crashed main
// process, a dropped IPC message), the callback registered below would
// otherwise wait forever — the caller's `await summarizeSession(...)` never
// resolves and the pane's status line stays stuck on "Summarizing…"
// indefinitely. This bounds the wait; a real Sonnet summarization of even a
// very long conversation should finish well under this.
const SUMMARIZE_TIMEOUT_MS = 5 * 60 * 1000;

function summarizeSession(session) {
  return new Promise(async (resolve) => {
    const res = await window.maestro.startSession({
      cwd: session.cwd,
      prompt: CARRY_OVER_PROMPT,
      model: "claude-sonnet-5",
      effort: "medium",
      resumeSessionId: session.cliSessionId || session.sessionId,
      // Maestro-internal launch (the hidden carry-over summary), not a real
      // user turn — keeps it out of the usage log, the "prompt finished"
      // notification, and the model-fit judge, which would otherwise spend a
      // real judge call on it AND contaminate the By-model / Model-fit /
      // Suggestion-accuracy analytics with a synthetic run the user never
      // initiated (model forced to sonnet-5, a hidden prompt).
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
        resolve(error ? { error } : { text });
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
function pickDraftTargetPane(avoidIndex) {
  const emptyIndex = panes.findIndex((p) => !p.sessionId && p.turns.length === 0 && !p.busy);
  if (emptyIndex !== -1) {
    return { index: emptyIndex, addedPane: false };
  }
  if (panes.length < 2) {
    panes.push(freshPane());
    return { index: panes.length - 1, addedPane: true };
  }
  // Both panes full: use the one that ISN'T the source, so the pane the
  // action came from stays intact. Only fall back to avoidIndex if there's
  // genuinely no other pane (avoidIndex undefined, or a future 1-pane edge).
  const alternative = panes.findIndex((_, i) => i !== avoidIndex);
  return { index: alternative !== -1 ? alternative : focusedPaneIndex, addedPane: false };
}

// opts.forceIndex — drop the draft into THIS exact pane, replacing whatever's
// there (used by rewind: Aidin wants it in the SAME pane, feeling like going
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
    // Non-empty draft landed silently in a textarea otherwise reads as
    // "nothing happened" (esp. the long orchestrator instruction block) -
    // a brief self-removing flash on the composer shell (mirrors
    // .pane-status-icon-ping) makes it obvious a draft is loaded and
    // waiting for Enter. Skipped for "" drafts (e.g. plain "Start fresh
    // session"), which have nothing to draw attention to.
    if (draftText) {
      const shellEl = paneEl.querySelector(".composer-shell");
      if (shellEl) {
        shellEl.classList.remove("composer-shell-draft-flash");
        void shellEl.offsetWidth; // restart animation if triggered again quickly
        shellEl.classList.add("composer-shell-draft-flash");
      }
    }
  }
  return index;
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
  const draft = `Continuing from "${session.title}". Summary of prior context:\n\n${result.text.trim()}\n\nPlease continue from here.`;
  openFreshDraftInPane(session.cwd, draft);
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

// fromHistoryNav is true only when THIS call originated from clicking the
// back/forward buttons — it skips the history push below so navigating
// backward doesn't itself get recorded as a new forward step.
function openSessionInPane(session, paneIndex, forceSplit, fromHistoryNav) {
  focusedPaneIndex = paneIndex;
  selectedSessionId = session.sessionId;
  const addedPane = forceSplit && panes.length < 2;
  if (addedPane) {
    panes.push(freshPane());
  }
  // Re-opening the session ALREADY showing in this exact pane (e.g.
  // navigating to a different session and back) is a no-op for the pane's
  // own in-memory state — rebuilding from scratch silently discarded any
  // in-progress edit. Real bug this fixed: picking a new root folder via
  // "…", navigating away and back, then sending reverted to the OLD folder
  // with zero warning (see DECISIONS.md — Aidin caught this live). Skipping
  // the reset here also happens to preserve any unsent draft prompt text for
  // the same scenario.
  const alreadyOpenHere = !addedPane && panes[paneIndex]?.sessionId === session.sessionId;
  if (!alreadyOpenHere) {
    stopLiveStatsTicker(paneIndex);
    panes[paneIndex] = {
      ...freshPane(),
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId || session.sessionId,
      cwd: session.cwd || "",
      title: session.title,
      loading: true,
      isOrchestrator: isOrchestratorSession(session),
    };
  }
  if (!fromHistoryNav) {
    pushNavHistory(paneIndex, session.sessionId);
  }
  if (addedPane) {
    renderWorkspace(); // pane count changed — full rebuild is unavoidable here
  } else {
    renderSinglePane(paneIndex); // leaves any typing in the other pane intact
  }
  renderSidebar();
  loadTranscriptInto(paneIndex);
}

function pushNavHistory(paneIndex, sessionId) {
  let entry = paneNavHistory.get(paneIndex);
  if (!entry) {
    entry = { stack: [], position: -1 };
    paneNavHistory.set(paneIndex, entry);
  }
  // Same as a browser tab: navigating to something new after having gone
  // back drops whatever forward history existed past this point.
  entry.stack = entry.stack.slice(0, entry.position + 1);
  entry.stack.push(sessionId);
  entry.position = entry.stack.length - 1;
}

function canNavigateHistory(paneIndex, delta) {
  const entry = paneNavHistory.get(paneIndex);
  if (!entry) {
    return false;
  }
  const target = entry.position + delta;
  return target >= 0 && target < entry.stack.length;
}

function navigateHistory(paneIndex, delta) {
  const entry = paneNavHistory.get(paneIndex);
  if (!entry) {
    return;
  }
  // Walk in the requested direction until a still-existing session is
  // found, rather than committing to the first entry regardless — a
  // session in history can have been archived/removed since. Committing
  // `position` on a dead entry before confirming it exists left the
  // pointer silently advanced with nothing opened, desyncing the ←/→
  // buttons' disabled state from what was actually still navigable.
  let candidate = entry.position + delta;
  while (candidate >= 0 && candidate < entry.stack.length) {
    const session = sessionById(entry.stack[candidate]);
    if (session) {
      entry.position = candidate;
      openSessionInPane(session, paneIndex, false, true);
      return;
    }
    candidate += delta;
  }
  // Nothing valid in that direction — re-render so the buttons reflect
  // reality even though nothing changed.
  renderSinglePane(paneIndex);
}

async function loadTranscriptInto(paneIndex) {
  const pane = panes[paneIndex];
  if (!pane || !pane.cliSessionId) {
    return;
  }
  const { turns, hiddenCount, truncated, contextTokens } = await window.maestro.getTranscript({
    cliSessionId: pane.cliSessionId,
    sessionId: pane.sessionId,
  });
  if (panes[paneIndex] !== pane) {
    return; // pane was reassigned while loading
  }
  pane.turns = turns;
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

// ============================== Sidebar sections ==============================

function sectionEl({ label, sessions, collapsed, pinned, droppable, emptyHint, isCategory }) {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const hasActiveSession = sessions.some((s) => s.sessionId === selectedSessionId);
  const head = document.createElement("div");
  head.className =
    "section-head" +
    (pinned ? " attention-head" : "") +
    (collapsed ? " collapsed" : "") +
    (isCategory && hasActiveSession ? " active-category" : "");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  const name = document.createElement("span");
  name.textContent = label;
  const count = document.createElement("span");
  count.className = "section-count";
  count.textContent = sessions.length;
  head.append(caret, name, count);

  const list = document.createElement("div");
  list.className = "section-list" + (collapsed ? " hidden" : "");
  if (droppable && droppable !== "unsorted") {
    list.dataset.groupLabel = label;
  }

  if (sessions.length === 0 && emptyHint) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = emptyHint;
    list.append(hint);
  } else {
    // Categories keep whatever order the user dragged them into (the actual
    // bug: this used to always re-sort by attention, so a manual reorder
    // changed the underlying data but the display silently overrode it every
    // render). Only the computed spotlight/list views sort by attention.
    const ordered = isCategory ? sessions : sortByAttention(sessions);
    ordered.forEach((s) => list.append(rowEl(s)));
  }

  // Same click-then-dblclick-cancels debounce as session rows, so a double
  // click on the label renames instead of just toggling collapse twice.
  head.addEventListener("click", () => {
    clearTimeout(head._toggleTimer);
    head._toggleTimer = setTimeout(() => {
      head.classList.toggle("collapsed");
      list.classList.toggle("hidden");
      if (isCategory) {
        persistCollapsed(label, head.classList.contains("collapsed"));
      }
    }, 250);
  });

  if (isCategory) {
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      clearTimeout(head._toggleTimer);
      makeInlineEditable(name, label, (v) => renameCategoryTo(label, v));
    });
    head.dataset.hasMenu = "1";
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x = e.clientX;
      const y = e.clientY;
      showContextMenu(x, y, [
        { label: "Rename category (or double-click it)", onClick: () => makeInlineEditable(name, label, (v) => renameCategoryTo(label, v)) },
        {
          label: "Delete category",
          danger: true,
          onClick: () => {
            // Re-opens the menu with an explicit confirm step instead of a
            // native window.confirm() dialog (unreliable in this build).
            showContextMenu(x, y, [
              { label: `Confirm delete "${label}"`, danger: true, onClick: () => deleteCategory(label) },
            ]);
          },
        },
      ]);
    });
    // Reordering categories themselves — only sessions could be dragged
    // before (found in review: category order had no drag handle at all).
    // A distinct dataTransfer type ("text/category-label", never
    // "text/session-id") keeps this from ever being confused with a
    // session drag — the existing session handlers already guard on
    // getData(...) being non-empty, so a category-type drag landing on a
    // session row's handlers is a harmless no-op. Only the header itself is
    // draggable, not the whole (often much taller, session-count-dependent)
    // section — a small fixed-size handle is far easier to aim than
    // splitting a tall section into "top half vs bottom half."
    head.draggable = true;
    head.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      // dataTransfer is only writable synchronously inside dragstart, so
      // these two MUST stay here.
      e.dataTransfer.setData("text/category-label", label);
      e.dataTransfer.effectAllowed = "move";
      categoryDragStartedAt = Date.now();
      // Collapse every session list to just its header for the duration of a
      // category drag (Aidin's ask) — with sessions expanded, reordering
      // categories means dragging past long lists and losing sight of the
      // order; header-only makes the target position obvious.
      //
      // Deferred to the next tick, NOT done synchronously here: hiding the
      // .section-list elements mid-dragstart reflows the drag SOURCE, which
      // Chromium/Electron treats as grounds to cancel the drag outright —
      // that's the "can't drag a list anymore" regression this feature
      // introduced. Letting dragstart finish first, then collapsing, keeps
      // the drag alive. requestAnimationFrame over setTimeout(0) so the
      // collapse paints on the very next frame with no visible flicker.
      requestAnimationFrame(() => {
        // Guard: the drag may have already ended (a very fast click-release)
        // by the time this fires — don't collapse if we're no longer dragging.
        if (categoryDragStartedAt !== null) {
          wrap.classList.add("dragging");
          document.getElementById("sidebarBody").classList.add("dragging-category");
        }
      });
    });
    head.addEventListener("dragend", () => {
      wrap.classList.remove("dragging");
      document.getElementById("sidebarBody").classList.remove("dragging-category");
      categoryDragStartedAt = null;
      clearCategoryDropIndicators();
      categoryDropTarget = null;
    });

    // Dropping a SESSION directly on the header appends it to the end of
    // that category (existing behavior). Dropping a CATEGORY shows a
    // before/after indicator on the whole section instead — same header,
    // branched on drag type via dataTransfer.types (readable during
    // dragover; getData itself is only reliably readable at drop in some
    // browsers).
    head.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes("text/category-label")) {
        clearDropIndicators(); // no leftover session-row marker while reordering categories
        dropTarget = null;
        if (wrap.classList.contains("dragging")) {
          clearCategoryDropIndicators();
          categoryDropTarget = null;
          return; // dropping a category onto itself is a no-op, mirroring the row pattern
        }
        const rect = head.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        if (categoryDropTarget && categoryDropTarget.wrap === wrap && categoryDropTarget.before === before) {
          return;
        }
        categoryDropTarget = { wrap, label, before };
        clearCategoryDropIndicators();
        wrap.classList.add(before ? "drop-before" : "drop-after");
        return;
      }
      head.classList.add("drag-over");
      // Hovering the header means "append here", not "between two rows" —
      // clear any row edge-marker left over from passing over rows.
      clearDropIndicators();
      dropTarget = null;
    });
    head.addEventListener("dragleave", () => head.classList.remove("drag-over"));
    head.addEventListener("drop", (e) => {
      e.preventDefault();
      head.classList.remove("drag-over");
      const draggedLabel = e.dataTransfer.getData("text/category-label");
      if (draggedLabel) {
        const target = categoryDropTarget;
        clearCategoryDropIndicators();
        categoryDropTarget = null;
        if (draggedLabel !== label) {
          reorderCategory(draggedLabel, label, target ? target.before : true);
        }
        return;
      }
      const sid = e.dataTransfer.getData("text/session-id");
      if (sid) {
        moveSessionToGroup(sid, label, null);
      }
    });
  }

  if (droppable) {
    wireListDropZone(list, droppable === "unsorted" ? null : label);
  }

  wrap.append(head, list);
  return wrap;
}

function wireListDropZone(el, targetLabel) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    // Same reasoning as the row/header guards: a category-reorder drag has
    // no business highlighting a session list's empty space as a drop
    // target it will never actually use.
    if (e.dataTransfer.types.includes("text/category-label")) {
      return;
    }
    if (e.target === el) {
      el.classList.add("drag-over");
      // Over the list's own empty space (not a row) = append; drop any
      // leftover row edge-marker so the two indicators don't both show.
      clearDropIndicators();
      dropTarget = null;
    }
  });
  el.addEventListener("dragleave", (e) => {
    if (e.target === el) {
      el.classList.remove("drag-over");
    }
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (e.target !== el) {
      return; // a row's own drop handler already dealt with it
    }
    const sid = e.dataTransfer.getData("text/session-id");
    if (sid) {
      moveSessionToGroup(sid, targetLabel, null);
    }
  });
}

async function persistCollapsed(groupLabel, collapsed) {
  const groups = (state.config.groups || []).map((g) => (g.label === groupLabel ? { ...g, collapsed } : g));
  state.config = await window.maestro.setConfig({ groups });
}

function renderSidebar() {
  const body = document.getElementById("sidebarBody");
  const pinned = document.getElementById("sidebarPinned");
  body.innerHTML = "";
  pinned.innerHTML = "";
  // Defensive: the category-drag "collapse lists to headers" class lives on
  // this persistent element, cleared on dragend. If dragend ever fails to
  // fire (odd HTML5-drag cancel path), a full re-render must not leave every
  // session list stuck hidden.
  body.classList.remove("dragging-category");

  const hiddenIds = new Set(state.config.hiddenSessions || []);
  const visible = state.sessions
    .filter((s) => !s.isArchived)
    .filter((s) => !hiddenIds.has(s.sessionId))
    .filter(matchesSearch);

  if ((state.config.sidebarMode || "smart") === "list") {
    body.append(
      sectionEl({ label: "All sessions", sessions: visible, collapsed: false, droppable: false })
    );
    return;
  }

  // No privileged "orchestrator session" pinned above everything else
  // anymore (PLAN.md's orchestrator-lifespan redesign) — a session tagged as
  // Maestro-building work (isOrchestratorSession) still gets its "◆" marker
  // inline (see rowEl) but otherwise flows into Needs-attention/its
  // group/Unsorted exactly like any other session. #sidebarPinned is left
  // unused here (still cleared above) rather than removed outright, in case
  // a future slice pins something else there.
  const attention = visible.filter((s) => s.needsAttention);
  if (attention.length > 0) {
    body.append(
      sectionEl({ label: "Needs your attention", sessions: attention, collapsed: false, pinned: true, droppable: false })
    );
  }

  const groups = state.config.groups || [];
  const grouped = new Set();
  for (const group of groups) {
    const members = (group.sessionIds || [])
      .map(sessionById)
      .filter(Boolean)
      .filter((s) => !s.isArchived)
      .filter(matchesSearch);
    (group.sessionIds || []).forEach((id) => grouped.add(id));
    body.append(
      sectionEl({
        label: group.label,
        sessions: members,
        collapsed: !!group.collapsed,
        droppable: true,
        isCategory: true,
        emptyHint: "Drag or move sessions here",
      })
    );
  }

  const unsorted = visible.filter((s) => !grouped.has(s.sessionId));
  body.append(sectionEl({ label: "Unsorted", sessions: unsorted, collapsed: false, droppable: "unsorted" }));
}

// ============================== Workspace (panes) ==============================

// Minimal, safe markdown: bold, inline code, fenced code blocks, "- " lists.
// Never uses innerHTML with model text — everything goes through
// createElement/textContent so there is no injection surface.
function renderMarkdownInto(container, text) {
  const segments = text.split(/```([\s\S]*?)```/);
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      pre.className = "md-code-block";
      pre.textContent = segment.replace(/^[ \t]*\S*\n/, "");
      container.append(pre);
    } else if (segment) {
      renderTextBlock(container, segment);
    }
  });
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

const isListLine = (line) => /^\s*[-*]\s+/.test(line);

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

function renderInlineLines(container, text) {
  const lines = text.split("\n");
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
    if (isBlank && (isListLine(nearestContentLine(lines, idx, -1)) || isListLine(nearestContentLine(lines, idx, 1)))) {
      return;
    }

    if (isList) {
      const listMatch = /^\s*[-*]\s+(.*)$/.exec(line);
      const li = document.createElement("div");
      li.className = "md-li";
      li.append(document.createTextNode("• "), ...inlineFormat(listMatch[1]));
      container.append(li);
    } else {
      const lineSpan = document.createElement("span");
      // The transition INTO a list gets a deliberate gap (.md-li's own
      // margin-top). The transition OUT of one got nothing — a plain <span>
      // has no margin rule at all, so the line right after the last bullet
      // sat flush against it with only incidental line-height between them,
      // reading as "tight"/inconsistent next to every other spaced
      // transition. This class gives it the matching gap.
      if (isListLine(nearestContentLine(lines, idx, -1))) {
        lineSpan.className = "md-after-list";
      }
      lineSpan.append(...inlineFormat(line));
      container.append(lineSpan);
    }

    // A list item is already display:block and self-breaks onto its own
    // line — a <br> touching one on either side is exactly what broke
    // .md-li adjacency above. Only insert one between two plain lines.
    if (idx < lines.length - 1 && !isList && !isListLine(nextLine || "")) {
      container.append(document.createElement("br"));
    }
  });
}

function inlineFormat(text) {
  const nodes = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text))) {
    if (m.index > lastIndex) {
      nodes.push(document.createTextNode(text.slice(lastIndex, m.index)));
    }
    const token = m[0];
    if (token.startsWith("**")) {
      const b = document.createElement("strong");
      b.textContent = token.slice(2, -2);
      nodes.push(b);
    } else {
      const c = document.createElement("code");
      c.textContent = token.slice(1, -1);
      nodes.push(c);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(document.createTextNode(text.slice(lastIndex)));
  }
  return nodes;
}

const MODEL_FIT_ICON = { too_weak: "⬆", appropriate: "⚖", too_strong: "⬇" };
const MODEL_FIT_LABEL = { too_weak: "Underpowered", appropriate: "Good fit", too_strong: "Overkill" };

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
  const wrap = document.createElement("div");
  wrap.className = "turn " + turn.role;
  const bubble = document.createElement("div");
  bubble.className = "turn-bubble";
  if (turn.role === "assistant") {
    renderMarkdownInto(bubble, turn.text);
  } else {
    bubble.textContent = turn.text;
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
      window.maestro.copyToClipboard(turn.text);
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
// normal chat bubble, since Aidin didn't actually type this.
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
// when the window fills (trigger "auto"), Maestro's Fas 3 auto-compact, or a
// manual /compact (both "manual"). Mirrors the desktop app showing where
// context was summarized. Aidin's ask: "skriv även ut i chatten med en pill
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

function toolGroupEl(pairs) {
  const details = document.createElement("details");
  details.className = "tool-group";
  const summary = document.createElement("summary");
  const names = pairs.map((p) => p.useTurn.toolName);
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
  summary.textContent =
    (pairs.length === 1 ? "Used 1 tool" : `Used ${pairs.length} tools`) + `: ${shown}${extra}`;
  details.append(summary);

  const list = document.createElement("div");
  list.className = "tool-group-list";
  pairs.forEach(({ useTurn, resultTurn }) => {
    const item = document.createElement("details");
    item.className = "tool-call-item";
    const itemSummary = document.createElement("summary");
    itemSummary.textContent = `${useTurn.toolName}${useTurn.toolInput ? " · " + useTurn.toolInput : ""}`;
    item.append(itemSummary);
    if (resultTurn) {
      const pre = document.createElement("pre");
      pre.className = "tool-call-output";
      pre.textContent = resultTurn.text;
      item.append(pre);
    }
    list.append(item);
  });
  details.append(list);
  return details;
}

function appendTurns(scroll, turns) {
  let i = 0;
  while (i < turns.length) {
    if (turns[i].kind === "tool_use") {
      const pairs = [];
      while (i < turns.length && turns[i].kind === "tool_use") {
        const useTurn = turns[i];
        const next = turns[i + 1];
        const resultTurn = next && next.kind === "tool_result" ? next : null;
        pairs.push({ useTurn, resultTurn });
        i += resultTurn ? 2 : 1;
      }
      scroll.append(toolGroupEl(pairs));
    } else {
      scroll.append(turnEl(turns[i]));
      i++;
    }
  }
}

function renderPane(index) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  const pane = panes[index];
  const scroll = paneEl.querySelector(".pane-scroll");
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
      const { turns, hiddenCount, truncated } = await window.maestro.getTranscript({
        cliSessionId: pane.cliSessionId,
        sessionId: pane.sessionId,
      });
      pane.turns = turns;
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
    empty.textContent = "No history yet — start typing below.";
    scroll.append(empty);
  } else {
    appendTurns(scroll, pane.turns);
    wireEditableUserTurns(index, scroll);
    wireDoneButtonOnLastReply(index, scroll);
    wireTurnStatsOnLastReply(index, scroll);
    wireQuestionFlagOnLastReply(index, scroll);
  }
  wireScrollToBottomButton(scroll);
  scroll.scrollTop = scroll.scrollHeight;
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
// message, then the message itself. Per Aidin's review it stays in the same
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
    // wrong message.
    if (pane.cliSessionId && !pane.transcriptTruncated) {
      const rewindBtn = document.createElement("button");
      rewindBtn.className = "copy-btn rewind-btn";
      rewindBtn.title = "Rewind to here — go back to this point, dropping everything after it";
      rewindBtn.textContent = "⤺";
      rewindBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        rewindToTurn(index, i, turn.text);
      });
      wrap.append(rewindBtn);
    }
  });
}

// Manual "I'm done with this" — Aidin's ask: a session can end with a real
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
  // it (Aidin's ask: "en check ikon bredvid copy ikonen som endast dyker upp
  // på hover"). ".acked" overrides that to always-visible + accent-colored —
  // a persistent checkmark on the reply itself ("när den är checkad dyker en
  // checkmark upp på svaret"), not just a transient hover flash. Toggleable
  // (Aidin: "checkmarken bör gå att ta bort också, eller?") — a checkbox you
  // can't uncheck would be an odd affordance, and un-acking is exactly
  // "actually, this does need attention again," the same real state
  // acknowledgedSessions already models.
  let acked = isAcked;
  const applyAckedVisual = () => {
    done.classList.toggle("acked", acked);
    done.title = acked ? "Marked done — click to undo" : "Nothing left to do here — mark done (comes back automatically if new activity happens).";
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
    state.config = await window.maestro.setConfig({ acknowledgedSessions });
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
// Aidin's ask, modeled on Claude Desktop's small per-reply stats line. Reuses
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
  const res = await window.maestro.forkSession(pane.cliSessionId, userMsgIndex);
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
// updated the visible path (caught via Aidin's "path bredvid titeln
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

// Small clickable affordances to open Aidin's global personal CLAUDE.md and
// the current session's own project CLAUDE.md — his ask for easy navigation
// to both from inside the app, matching the existing header icon-button
// pattern (same "icon-btn" class/size as the ←/→ nav and "+"/"✕" buttons
// beside it). Rebuilt whenever the header's own cwd changes (picking a
// folder, typing one, a root-folder switch), same trigger points
// updatePaneSubText already reacts to — a stale project link pointing at the
// PREVIOUS folder would be worse than not showing one.
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
    const res = await window.maestro.openGlobalClaudeMd();
    if (!res.ok) {
      showToast(res.error || "Couldn't open global CLAUDE.md");
    }
  });
  links.append(globalBtn);

  if (cwd) {
    // Existence is checked before showing the button at all, rather than
    // showing one that errors on click — per the ask, a project without a
    // CLAUDE.md just shouldn't get this affordance.
    window.maestro.projectClaudeMdExists(cwd).then((exists) => {
      if (!exists || !links.isConnected) {
        return;
      }
      const projectBtn = document.createElement("button");
      projectBtn.className = "icon-btn";
      projectBtn.innerHTML = DOCUMENT_ICON;
      projectBtn.title = "Open this project's folder";
      projectBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await window.maestro.openProjectClaudeMd(cwd);
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

  const navBack = document.createElement("button");
  navBack.className = "icon-btn";
  navBack.textContent = "←";
  navBack.title = "Previous chat in this pane";
  navBack.disabled = !canNavigateHistory(index, -1);
  navBack.addEventListener("click", () => navigateHistory(index, -1));

  const navForward = document.createElement("button");
  navForward.className = "icon-btn";
  navForward.textContent = "→";
  navForward.title = "Next chat in this pane";
  navForward.disabled = !canNavigateHistory(index, 1);
  navForward.addEventListener("click", () => navigateHistory(index, 1));

  header.append(navBack, navForward);

  const title = document.createElement("span");
  title.textContent = pane.title || "New session";
  header.append(title);
  if (pane.isOrchestrator) {
    const tag = document.createElement("span");
    tag.className = "maestro-tag";
    tag.textContent = "◆ Maestro";
    tag.title = "This is Maestro-building work, not a regular project chat";
    header.append(tag);
  }
  if (pane.cwd) {
    const sub = document.createElement("span");
    sub.className = "pane-sub";
    sub.textContent = pane.cwd;
    header.append(sub);
  }
  updateClaudeMdLinks(header, pane.cwd);
  const actions = document.createElement("span");
  actions.className = "pane-actions";
  if (pane.sessionId) {
    const resetBtn = document.createElement("button");
    resetBtn.className = "icon-btn";
    resetBtn.textContent = "+";
    resetBtn.title = "Start a new chat in this pane";
    resetBtn.addEventListener("click", () => {
      panes[index] = freshPane();
      // Same reasoning as the sidebar's "+ New chat" button — a fresh chat
      // is a new browsing context for this slot.
      paneNavHistory.delete(index);
      stopLiveStatsTicker(index);
      if (selectedSessionId === pane.sessionId) {
        selectedSessionId = null;
      }
      renderSinglePane(index);
      renderSidebar();
    });
    actions.append(resetBtn);
  }
  if (index === 1) {
    const close = document.createElement("button");
    close.className = "pane-close icon-btn";
    close.textContent = "✕";
    close.title = "Close split";
    close.addEventListener("click", () => {
      // If this pane has a live launch, stop it before discarding the pane
      // — otherwise the process keeps running with no UI left able to show
      // its completion or stop it. No map entry to clean up here: once
      // `panes = [panes[0]]` below drops this slot, launchPaneHistory's own
      // identity check (`panes[index] === pane`) naturally rejects any of
      // this launch's late events on its own.
      const closingPane = panes[1];
      if (closingPane?.busy && closingPane.currentLaunchId) {
        window.maestro.stopSession(closingPane.currentLaunchId);
      }
      // A future split reusing slot 1 is a new browsing context — don't let
      // it inherit back/forward history from whatever used to live there.
      paneNavHistory.delete(1);
      stopLiveStatsTicker(1);
      panes = [panes[0]];
      document.getElementById("workspace").classList.remove("split");
      renderWorkspace();
    });
    actions.append(close);
  }
  // The chat-global controls (Simple/Advanced, split, background tasks) ride on
  // the PRIMARY pane's header row rather than a dedicated bar - so no extra row,
  // and the top header stays just the primary tabs + gear (Aidin design note
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

  const promptEl = document.createElement("textarea");
  promptEl.rows = 2;
  promptEl.placeholder = pane.sessionId ? `Continue "${pane.title}"…` : "What should this session do?";
  shell.append(promptEl);

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
      const res = await window.maestro.saveImage(base64, ext);
      // Pane may have been reset/reused while the save round-tripped through
      // main — don't attach a stale paste to whatever now occupies this slot.
      if (res.ok && panes[index] === pane) {
        pane.pendingAttachments.push({ path: res.path, name: file.name || `pasted.${ext}`, isImage: true });
        renderAttachments();
      }
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
    const folder = await window.maestro.pickFolder();
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

  // "Auto" lets Maestro pick per-prompt (resolved at send time from the
  // current text); picking a specific value locks it in and stops the
  // suggestion from silently overriding your choice.
  const modelDD = dropdownPill(
    "auto",
    [
      { value: "auto", label: "Auto" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ],
    () => {}
  );
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
  // Plan mode / Auto mode / Bypass permissions). Maestro's -p invocation has
  // no live channel to answer an interactive approval prompt, so a mode that
  // genuinely needs to ask mid-run could still stall — tested "default" in
  // this environment and it did not (Aidin's existing broad allowlists let
  // tools through), but that is not a general guarantee for every setup.
  // Note: this "auto" is a literal CLI permission mode name, unrelated to the
  // model/effort "Auto" above (let Maestro pick) — they just share the word.
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
  // handles whatever it can from there; Maestro doesn't need to know the type.
  const attachBtn = document.createElement("button");
  attachBtn.className = "icon-btn";
  attachBtn.innerHTML = PAPERCLIP_ICON;
  attachBtn.title = "Attach a file";
  attachBtn.addEventListener("click", async () => {
    const filePaths = await window.maestro.pickFiles();
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
  // Hold-to-record (Aidin's feedback on v1's click-to-toggle: "Jag vill ha en
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
  micBtn.title = "Hold to record voice input (transcribed locally, offline) — or hold Alt in the composer";
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
  // Swedish behavior (Aidin's primary language).
  const languageDD = dropdownPill(
    state.config?.voiceLanguage || "swedish",
    [
      { value: "auto", label: "Auto-detect" },
      { value: "swedish", label: "Svenska" },
      { value: "english", label: "English" },
    ],
    async (value) => {
      // Persist globally via the same setConfig IPC every other setting uses.
      state.config = await window.maestro.setConfig({ voiceLanguage: value });
    }
  );
  languageDD.el.title = "Voice transcription language";

  const sendBtn = document.createElement("button");
  sendBtn.className = "send-btn";
  sendBtn.textContent = "➤";
  sendBtn.title = pane.sessionId ? "Continue (Enter)" : "Start session (Enter)";

  controls.append(pickBtn, cwdInput, attachBtn, permissionDD.el, modelDD.el, effortDD.el, languageDD.el, micBtn, sendBtn);
  shell.append(controls);

  // Context-size gauge — a bar + %, under the model/effort row (Aidin's
  // placement). Clicking it opens a popover with the context detail AND the
  // quota, mirroring Claude Code's combined readout. Its own render closure
  // because the composer is built once but pane.contextTokens arrives later,
  // async, from loadTranscriptInto (which calls this to fill it in).
  const contextGauge = document.createElement("button");
  contextGauge.type = "button";
  contextGauge.className = "composer-context";
  const renderContextGauge = () => {
    if (typeof pane.contextTokens !== "number") {
      contextGauge.style.display = "none";
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
    contextGauge.title = "Context in use for this session — click for detail + quota";
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

  // Aidin's ask: put the suggestion hint and the context gauge on the SAME
  // row instead of stacking them (they were two separate full-width lines).
  const metaRow = document.createElement("div");
  metaRow.className = "composer-meta-row";
  metaRow.append(suggestHint, contextGauge);
  shell.append(metaRow);
  wrap.append(shell);

  // Model-fit judge verdict lives here, under the composer — not in the chat
  // scrollback — per Aidin's ask, and to keep the conversation itself
  // uncluttered. Cleared on each new send, filled in once the judge resolves.
  const modelFitLine = document.createElement("div");
  modelFitLine.className = "model-fit-line";
  wrap.append(modelFitLine);

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
        const res = await window.maestro.stopSession(pane.currentLaunchId);
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
      const suggestion = await window.maestro.suggestModelEffort(promptEl.value);
      const modelLabel = suggestion.model.replace("claude-", "");
      const usingAuto = modelDD.value === "auto" && effortDD.value === "auto";
      suggestHint.textContent = usingAuto
        ? `→ Auto-picking ${modelLabel} · ${suggestion.effort} — ${suggestion.reason}`
        : `Heuristic guess: ${modelLabel} · ${suggestion.effort} — ${suggestion.reason} (using your manual pick instead)`;
    }, 300);
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
// fixed generic CSS pulse forever — Aidin's ask for the indicator to "feel
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

function setModelFitLine(index, text, verdict) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const line = paneEl?.querySelector(".model-fit-line");
  if (!line) {
    return;
  }
  line.textContent = text || "";
  line.className = "model-fit-line" + (verdict ? ` model-fit-${verdict}` : "");
}

// Surfaces what "Auto" actually resolved to, at the moment it's resolved for
// THIS send - replacing the as-you-type guess (which can go stale between
// typing and hitting Send) so the last thing shown before the run starts is
// the real pick, not a debounced heuristic. Per PLAN.md 9/10: suggest AND let
// the user choose, which requires seeing the resolved choice before paying
// for the run, not only in setModelFitLine's post-hoc verdict.
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
  pane.turns.push({ role: "user", kind: "text", text: prompt });
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
  setModelFitLine(index, "");
  renderPane(index);

  // Resolved fresh from the FINAL prompt text at send time (not the debounced
  // background suggestion, which could be stale) — used to fill in any "Auto"
  // picks, and always logged as the suggestion regardless of whether you
  // followed it, so usage-log's followedSuggestion stays meaningful.
  const suggestion = await window.maestro.suggestModelEffort(prompt);
  const model = els.modelDD.value === "auto" ? suggestion.model : els.modelDD.value;
  const effort = els.effortDD.value === "auto" ? suggestion.effort : els.effortDD.value;
  if (els.modelDD.value === "auto" || els.effortDD.value === "auto") {
    // Shown just before startSession fires below - the resolved pick, not the
    // debounced as-you-type guess, so there's a real moment to notice/override
    // before the run (and its cost) actually begins.
    setResolvedAutoHint(index, model.replace("claude-", ""), effort);
  }

  // "Switch root folder" (Aidin's question about the "…" picker on an
  // EXISTING session — it silently broke the next send with "No conversation
  // found," since --resume scopes lookup by cwd; see DECISIONS.md). If this
  // is a resumed session and the folder was changed since it was opened,
  // copy the transcript into the new folder's project dir FIRST so --resume
  // can actually find it there.
  if (pane.cliSessionId && sessionById(pane.sessionId)?.cwd && sessionById(pane.sessionId).cwd !== cwd) {
    const switchRes = await window.maestro.switchSessionRootFolder(pane.cliSessionId, pane.sessionId, cwd);
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

  const res = await window.maestro.startSession({
    cwd,
    prompt,
    model,
    effort,
    permissionMode: els.permissionDD.value,
    resumeSessionId: pane.cliSessionId,
    suggestedModel: suggestion.model,
    suggestedEffort: suggestion.effort,
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
  // (session/tool_use/assistant/error/done/modelFit) is routed through this
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
  pane.els.renderQueuedPrompt();
  pane.els.promptEl.value = queued;
  sendFromPane(index, pane.els);
}

// Left pane's share of the split, 0..1. Module-level (not per-pane, not
// persisted) so it survives split toggles within a session but resets on
// restart — a reasonable v1; persisting to config is a possible follow-up.
let splitRatio = 0.5;
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

function applySplitRatio() {
  const workspace = document.getElementById("workspace");
  workspace.style.setProperty("--left-fr", `${splitRatio}fr`);
  workspace.style.setProperty("--right-fr", `${1 - splitRatio}fr`);
}

// Rebuilds every pane's DOM. Only call this when the NUMBER of panes changes
// (split on/off) — it discards any in-progress typing in every pane.
function renderWorkspace() {
  const workspace = document.getElementById("workspace");
  const split = panes.length > 1;
  workspace.classList.toggle("split", split);
  workspace.innerHTML = "";
  const makePane = (index) => {
    const paneEl = document.createElement("section");
    paneEl.className = "pane";
    paneEl.dataset.pane = String(index);
    paneEl.addEventListener("click", () => {
      focusedPaneIndex = index;
    });
    workspace.append(paneEl);
    renderSinglePane(index);
  };
  makePane(0);
  if (split) {
    workspace.append(paneDividerEl());
    applySplitRatio();
    makePane(1);
  } else {
    // Clear any leftover split sizing so a future single-pane layout isn't
    // constrained by stale fr variables.
    workspace.style.removeProperty("--left-fr");
    workspace.style.removeProperty("--right-fr");
  }
}

// Draggable divider between the two split panes — adjusts their relative
// width. Pointer events (not mouse) so a capture keeps tracking even if the
// cursor briefly leaves the thin divider mid-drag.
function paneDividerEl() {
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  divider.title = "Drag to resize";
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const workspace = document.getElementById("workspace");
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    const onMove = (ev) => {
      const rect = workspace.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const raw = (ev.clientX - rect.left) / rect.width;
      splitRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, raw));
      applySplitRatio();
    };
    const onUp = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  });
  return divider;
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

// Quota moved out of the header into the context-gauge popover (Aidin's ask:
// "flytta ner quota menyn dit också"). state.quota still flows via refresh();
// the popover reads it directly on open. This is now just a defensive no-op
// kept so the existing refresh() call site doesn't need touching / can't
// throw if the header element is gone.
function renderQuota() {
  // intentionally empty — see comment above
}

// A cheap summary of exactly the fields renderSidebar()'s output depends on
// (session identity/status/model/archived + the Jot badge fields it reads,
// plus the config knobs that affect grouping/visibility). Comparing this
// string is far cheaper than the full innerHTML="" + rebuild it guards —
// found in a performance audit: the 30s poll below was rebuilding the whole
// sidebar every tick even when nothing had changed (audit: "performance +
// token usage granskning"). Deliberately NOT a full JSON.stringify of the
// whole sessions/config payload — most fields on a session (turns, cwd,
// etc.) don't affect the sidebar row at all, so including them would cause
// false-positive "changed" on unrelated backend churn.
function computeSidebarFingerprint(sessions, config) {
  const sessionsPart = sessions
    .map((s) =>
      [
        s.sessionId,
        s.title,
        s.status,
        s.lastActivityAt,
        s.model,
        s.isArchived,
        s.jot?.review,
        s.jot?.inProgress,
        s.jot?.open,
        s.jot?.category,
        s.jot?.nearestDeadline,
        s.orchestratorTag?.statusTag,
        s.orchestratorTag?.reason,
        s.autoCompacted?.preTokens,
        s.autoCompacted?.postTokens,
      ].join(":")
    )
    .join("|");
  const configPart = JSON.stringify(config.groups) + "|" + config.sidebarMode + "|" + config.archiveSuggestions?.enabled + "|" + config.hideArchived;
  return sessionsPart + "##" + configPart;
}
let lastSidebarFingerprint = null;

async function refresh() {
  const data = await window.maestro.getSessions();
  state.sessions = data.sessions;
  state.config = data.config;
  state.quota = data.quota;
  applyViewMode();
  applySidebarMode();
  // Don't rebuild the sidebar out from under an in-progress category drag —
  // innerHTML="" would destroy the dragged header and the drag-collapse
  // mid-gesture (jarring layout jump). State above is still refreshed; the
  // sidebar re-renders on the next tick once the drag ends (dragend clears
  // the flag; reorderCategory/openSessionInPane also re-render on their own).
  //
  // Also skip the rebuild entirely when nothing the sidebar actually
  // displays has changed since the last poll — every OTHER call site that
  // renders in response to a real user action (search, category CRUD,
  // opening a session, ...) calls renderSidebar() directly and is
  // unaffected by this cache; this only guards the unconditional 30s timer
  // tick from redoing identical work.
  const fingerprint = computeSidebarFingerprint(state.sessions, state.config);
  if (!categoryDragInProgress() && fingerprint !== lastSidebarFingerprint) {
    renderSidebar();
    lastSidebarFingerprint = fingerprint;
  }
  renderQuota(state.quota);
  pruneStaleLaunchHistory();
  pruneStaleBackgroundTasks();
  renderBackgroundTasksBadge();
  refreshDashboardIfVisible();
}

// First-load: land on the Dashboard, not on any specific chat. PLAN.md's
// orchestrator-lifespan redesign retired the old behavior here (auto-opening
// the most-recently-active "orchestrator" session in pane 0) — there is no
// privileged session to land on anymore. The Dashboard (overview + attention
// spotlight) is the home now; Chat is one destination among the page tabs,
// reached the same way any other page is.
async function startup() {
  await rehydrateGoalRuns();
  await refresh();
  navigateToPage("dashboard");
}

// Seeds goalRuns from the persisted index (src/lib/goalRunHistory.js) so past
// runs still show on the Goal page after a restart, instead of the in-memory
// Map silently starting empty every time. Only the compact fields main.js
// wrote are available (no iteration list/plan — those live in the worktree's
// own .maestro-goal/notes.md), so each rehydrated entry renders as a plain
// finished/interrupted summary rather than the richer live-run view. Runs
// left "running" have already been downgraded to "interrupted" by the
// goal:history handler if no live process backs them.
async function rehydrateGoalRuns() {
  let records = [];
  try {
    records = await window.maestro.getGoalRunHistory();
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
            }
          : null,
      error: record.error || null,
      escalation: record.escalation || null,
      latestPlan: null,
      persisted: true,
    });
  }
}

// The modelFit event is the normal way launchPaneHistory entries get cleaned
// up, but if the judge is disabled (config.modelFitJudge.enabled: false) or
// errors before emitting one, that never happens — this is the backstop so
// the map doesn't grow forever over a long-running session.
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

function applyViewMode() {
  document.body.classList.toggle("advanced", state.config.viewMode === "advanced");
  // Scoped to #viewToggle specifically — a bare ".view-toggle button" also
  // matches the page tabs and sidebar mode toggle (same shared class), which
  // was wiping their active state every time this ran.
  document.querySelectorAll("#viewToggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.config.viewMode || "simple"));
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  renderSidebar();
});

document.getElementById("newCategory").addEventListener("click", createCategory);

// Collapse/expand ALL categories at once — the lightweight "list-sorting
// view" Aidin asked for: collapse everything to headers to see the whole
// category order at a glance (and reorder), then expand back. Toggles based
// on current state: if every category is already collapsed, expand all;
// otherwise collapse all. Persists via each group's `collapsed` flag, same
// as the per-header toggle.
document.getElementById("collapseAll").addEventListener("click", async () => {
  const groups = state.config.groups || [];
  if (groups.length === 0) {
    return;
  }
  const allCollapsed = groups.every((g) => g.collapsed);
  const next = groups.map((g) => ({ ...g, collapsed: !allCollapsed }));
  state.config = await window.maestro.setConfig({ groups: next });
  renderSidebar();
});

document.getElementById("newChat").addEventListener("click", () => {
  panes[focusedPaneIndex] = freshPane();
  // A brand-new chat is a new browsing context for this slot — without
  // this, ← immediately after "New chat" navigated back into whatever
  // session used to be here, which is exactly the inconsistency the
  // split-close handler already guards against for slot 1 (found in
  // review, was previously missing here and on the pane-header reset).
  paneNavHistory.delete(focusedPaneIndex);
  stopLiveStatsTicker(focusedPaneIndex);
  selectedSessionId = null;
  renderSinglePane(focusedPaneIndex);
  renderSidebar();
});

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
// - the same IPC renderFocusPage uses). Anything without existing plumbing
// (background worktree telemetry, a real work/private domain tag on Jot
// goals, actual session-start-from-dashboard) is rendered as a clearly
// labeled placeholder rather than invented data - see the individual section
// comments below.
let dashboardFocusMode = "all"; // "all" | "work" | "private" - local UI state (the Focus filter), resets on reload. "all" = no filtering/dimming.
let dashboardSelectedChip = null; // which "New session" project chip is selected (a cwd string)

function isDashboardVisible() {
  return !document.getElementById("dashboardPage").classList.contains("hidden");
}

// Re-renders the Dashboard if it's the currently visible page — called from
// the same 30s refresh() tick that already re-polls state.sessions, so the
// "In motion" / "Orchestrator proposes" sections stay live without a second
// polling loop. A no-op (and cheap to call) when the page isn't open.
function refreshDashboardIfVisible() {
  if (isDashboardVisible()) {
    renderDashboardPage();
  }
  // Agents page's session nodes are also derived from state.sessions - keep
  // them live on the same poll tick, same no-op-when-hidden guard.
  if (!document.getElementById("agentsPage").classList.contains("hidden")) {
    renderAgentsPage();
  }
}

async function renderDashboardPage() {
  const page = document.getElementById("dashboardPage");
  page.innerHTML = "";
  page.className = "analysis-page dashboard-page";

  const topbar = document.createElement("div");
  topbar.className = "dash-topbar";
  const heading = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "Dashboard";
  const sub = document.createElement("div");
  sub.className = "analysis-totals";
  sub.style.marginBottom = "0";
  sub.textContent = "No orchestrator session is open right now — it's a faculty, not a room. Start one fresh whenever you need it.";
  heading.append(h2, sub);
  const topbarActions = document.createElement("div");
  topbarActions.className = "dash-topbar-actions";
  topbarActions.append(focusModeToggleEl(), startOrchestratorSessionBtnEl());
  topbar.append(heading, topbarActions);
  page.append(topbar);

  const goalsResult = await window.maestro.getJotGoals();
  const isColdStart = dashboardInMotionRows().length === 0 && (!goalsResult.ok || goalsResult.goals.length === 0);
  if (isColdStart) {
    page.append(dashboardOnboardingBlock());
  }

  page.append(dashboardQueueSection());
  page.append(await dashboardGoalsSection(goalsResult));
  page.append(await dashboardNewSessionSection());
}

// First-run orientation. Shown only in the cold/low-data state (no active or
// waiting sessions, and no Jot goals) so it reads as calm guidance rather
// than a permanent fixture - it naturally disappears once real data exists,
// no dismiss control needed. Reuses the same .dash-board/.dash-hint tokens as
// the rest of the dashboard rather than inventing new structure.
function dashboardOnboardingBlock() {
  const section = document.createElement("section");
  section.className = "dash-board dash-onboarding";

  const title = document.createElement("div");
  title.className = "dash-onboarding-title";
  title.textContent = "Welcome to your dashboard";
  section.append(title);

  const list = document.createElement("ul");
  list.className = "dash-onboarding-list";
  [
    '"Needs you & in motion" surfaces sessions waiting on your input or currently working - it stays empty until something is running.',
    "Work is organized by goal below, pulled straight from your Jot board.",
    'Pick a project under "New session" and start fresh whenever you\'re ready.',
  ].forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    list.append(li);
  });
  section.append(list);

  return section;
}

// --- Focus work/private toggle -----------------------------------------
// Real, functional UI logic: flips dashboardFocusMode and dims goal cards
// whose domain doesn't match. The domain itself comes straight from Jot's
// Category.domain field (set via Jot's own W/P chip, 1.5.14+) and is threaded
// through loadGoals in src/lib/jot.js onto each goal - no heuristic here.
// A goal whose category has no domain set is neutral: it matches BOTH Focus
// modes and is never dimmed, same as before a domain is ever assigned.
function domainForGoal(goal) {
  return goal.domain === "work" || goal.domain === "private" ? goal.domain : null;
}

// Shared Focus-filter toggle (All / Work / Private) used by BOTH the dashboard
// (dims non-matching goal cards; "All" = no dimming) and the Focus page
// (filters the list; "All" = show everything). `rerender` is the page's own
// re-render fn so the toggle refreshes the right view.
function focusModeToggleEl(rerender = renderDashboardPage) {
  const wrap = document.createElement("div");
  wrap.className = "dash-focus-toggle";

  const label = document.createElement("span");
  label.className = "dash-focus-label";
  label.textContent = "Focus";
  wrap.append(label);

  const seg = document.createElement("div");
  seg.className = "view-toggle";
  const LABELS = { all: "All", work: "Work", private: "Private" };
  for (const mode of ["all", "work", "private"]) {
    const btn = document.createElement("button");
    btn.textContent = LABELS[mode];
    btn.classList.toggle("active", dashboardFocusMode === mode);
    btn.addEventListener("click", () => {
      dashboardFocusMode = mode;
      rerender();
    });
    seg.append(btn);
  }
  wrap.append(seg);
  return wrap;
}

// Replaces the old "open the orchestrator" affordance (which resumed one
// privileged, ever-growing session) per PLAN.md's orchestrator-lifespan
// redesign: this always starts a brand-new session, pre-pointed at
// orchestrator-instructions.md, never resumed history. Rooted in the Claude
// "meta home" (orchestrator:info's cwd) - the dir with the canonical CLAUDE.md
// AND the cwd-keyed auto-memory, so the orchestrator actually starts with the
// accumulated rules/memory in context. It's above every code project (not
// Maestro, not a work repo), so it dispatches into whatever it names rather
// than doing hands-on work in its own cwd (see orchestrator-instructions.md).
function startOrchestratorSessionBtnEl() {
  const btn = document.createElement("button");
  btn.className = "text-btn";
  btn.textContent = "+ New orchestrator session";
  btn.title = "Starts a fresh session pointed at orchestrator-instructions.md - never resumes a prior one";
  btn.addEventListener("click", async () => {
    const info = await window.maestro.getOrchestratorInfo();
    if (!info.ok) {
      showToast("Couldn't resolve the orchestrator working dir - see console.");
      console.error("[maestro] orchestrator:info failed:", info.error);
      return;
    }
    navigateToPage("chat");
    const draft = `Read ${info.instructionsPath} and act as an orchestrator for this session. You're rooted in the Claude meta-home (above any one code project), so your CLAUDE.md rules and accumulated memory are in context - survey the current state (your Jot board and the projects you're working on) and tell me what needs attention and what to dispatch. Do coordination and dispatch from here; do hands-on code work in the project it belongs to (a dispatched agent or a project-rooted session), not in this cwd.`;
    openFreshDraftInPane(info.cwd, draft, { paneOverrides: { isOrchestrator: true } });
  });
  return btn;
}

// --- Needs you & in motion (merged attention queue) ------------------------
// Variant A's key structural change: ONE prioritized list instead of two
// separate sections. Two row kinds share the list:
//   - "proposal" rows: archive suggestions, reusing the exact same
//     archive-suggestion + orchestratorTag signals the sidebar already
//     surfaces (see rowEl in this file and runOrchestratorSweep in main.js).
//     Approve/Dismiss call the same archiveSession path used elsewhere -
//     nothing here acts without a click.
//   - "session" rows: real state.sessions in "waiting" (needs your input) or
//     "active" (currently working) status - the same status field the
//     sidebar's status-dot already reads.
// Ordering is by urgency, not chronology or section: proposals and waiting
// sessions (both need a click) sort above active sessions (no action needed,
// just visibility), and attentionScore breaks ties within each group so the
// most pressing item within a tier still floats up.
//
// Archive-proposal grouping: with archiveSuggestions on, a long-idle inbox
// can produce dozens of individual "Archive finished session" rows that bury
// genuine needs-you items (observed: ~38 rows on a real board). All archive
// proposals collapse into ONE row ("N sessions ready to archive") with
// "Archive all" / "Review" - individual running/waiting SESSIONS never
// collapse, only the archive-cleanup proposal kind. "Review" expands the
// group inline into its normal per-session Archive/Dismiss rows (same
// dashProposeRowEl used before this change) rather than hiding that control
// behind a second page.
// NOT wired up: the mock's per-row context-budget bar and worktree path
// (PLAN.md's worker/isolated-worktree model isn't built yet - Maestro today
// runs sessions directly, not via dispatched worktree workers) - labeled as a
// placeholder rather than faked. Proposal KINDS beyond archive suggestions
// (stale Jot task, "merge this worker branch") have no backing signal yet in
// Maestro and are NOT fabricated here.
let dashboardArchiveGroupExpanded = false; // local UI state, resets on reload

function dashboardProposalSessions() {
  const hasOpenJotWork = (s) => s.jot && (s.jot.review > 0 || s.jot.inProgress > 0 || s.jot.open > 0);
  const classifierSaysDone = (s) => s.orchestratorTag?.statusTag === "done_not_archived";
  const suggestionsEnabled = state.config.archiveSuggestions?.enabled === true;
  if (!suggestionsEnabled) {
    return [];
  }
  const proposalSessions = state.sessions.filter(
    (s) => !s.isArchived && (s.status === "idle" || classifierSaysDone(s)) && !hasOpenJotWork(s) && !isOrchestratorSession(s)
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
  return [...goalRuns.values()].filter((r) => r.status === "error" || r.escalation);
}

function dashboardInMotionRows() {
  const inMotionSessions = state.sessions.filter((s) => !s.isArchived && (s.status === "active" || s.status === "waiting"));
  const sessionRows = sortByAttention(inMotionSessions).map((s) => ({
    kind: "session",
    session: s,
    needsAction: s.status === "waiting",
  }));
  // Goal-run rows always read as top-priority needs-you (same as a "waiting"
  // session), so they lead the list rather than being sorted in by a made-up
  // attention score.
  const goalRunRows = dashboardGoalAttentionRuns().map((run) => ({
    kind: "goalRun",
    run,
    needsAction: true,
  }));
  return [...goalRunRows, ...sessionRows];
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
    dashBoardHeadWithLabel(
      "Needs you & in motion",
      countLabel,
      needsActionCount > 0,
      "One list, ordered by how much you need to act - nothing here happens without you"
    )
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
    const list = document.createElement("div");
    list.className = "dash-queue-list";
    if (proposalSessions.length > 0) {
      list.append(dashArchiveGroupEl(proposalSessions));
    }
    inMotion.forEach((row) => list.append(row.kind === "goalRun" ? dashGoalRunRowEl(row.run) : dashSessionRowEl(row.session)));
    body.append(list);
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
  archiveAll.addEventListener("click", async (e) => {
    e.stopPropagation();
    archiveAll.disabled = true;
    for (const session of proposalSessions) {
      await archiveSession(session);
    }
    refreshDashboardIfVisible();
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

function dashBoardHeadWithLabel(title, countLabel, urgent, hint) {
  const head = document.createElement("div");
  head.className = "dash-board-head";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  if (countLabel) {
    const c = document.createElement("span");
    c.className = "dash-count" + (urgent ? " dash-count-urgent" : "");
    c.textContent = countLabel;
    h3.append(c);
  }
  const hintEl = document.createElement("span");
  hintEl.className = "dash-hint";
  hintEl.textContent = hint;
  head.append(h3, hintEl);
  return head;
}

function dashQueueStateIcon(kind, session) {
  const ic = document.createElement("div");
  if (kind === "proposal") {
    ic.className = "dash-state-ic dash-state-needs";
    ic.textContent = "\u{1F4C1}"; // folder - archive proposal
    return ic;
  }
  if (kind === "goalRun") {
    ic.className = "dash-state-ic dash-state-needs";
    ic.textContent = "⚠"; // warning - same as a waiting session, goal run needs you too
    return ic;
  }
  if (session.status === "waiting") {
    ic.className = "dash-state-ic dash-state-needs";
    ic.textContent = "⚠"; // warning - needs your input
    return ic;
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
  title.textContent = `Archive finished session: "${session.title}"`;
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  why.textContent = session.orchestratorTag?.reason || "No activity, no open Jot work — looks wrapped up.";
  qbody.append(why);
  row.append(qbody);

  const actions = document.createElement("div");
  actions.className = "dash-queue-actions";
  const approve = document.createElement("button");
  approve.className = "text-btn";
  approve.textContent = "Archive";
  approve.addEventListener("click", async (e) => {
    e.stopPropagation();
    await archiveSession(session);
    refreshDashboardIfVisible();
  });
  const dismiss = document.createElement("button");
  dismiss.className = "text-btn";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", (e) => {
    e.stopPropagation();
    row.classList.add("dash-resolved");
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
  if (session.jot?.category) {
    const tag = document.createElement("span");
    tag.className = "dash-goal-tag";
    tag.textContent = session.jot.category;
    top.append(tag);
  }
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = session.title;
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  const bits = [session.model ? session.model.replace("claude-", "") : "model unknown", relTime(session.lastActivityAt)];
  // Note: context-budget + worktree path are intentionally omitted until that
  // telemetry is actually wired - a placeholder suffix here read as clutter.
  why.textContent = (session.status === "waiting" ? "Waiting on you · " : "") + bits.join(" · ");
  qbody.append(why);
  row.append(qbody);

  if (session.status === "waiting") {
    const meta = document.createElement("div");
    meta.className = "dash-q-meta";
    meta.textContent = "needs input";
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
  row.append(dashQueueStateIcon("goalRun", null));

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  const goalSnippet = run.goal.length > 60 ? run.goal.slice(0, 60) + "…" : run.goal;
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = run.status === "error" ? `Goal run "${goalSnippet}" — failed` : `Goal run "${goalSnippet}" — paused, needs you`;
  top.append(title);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  why.textContent = run.status === "error" ? run.error || "Run ended with an error." : "Escalated - waiting on your input.";
  qbody.append(why);
  row.append(qbody);

  const meta = document.createElement("div");
  meta.className = "dash-q-meta";
  meta.textContent = "needs input";
  row.append(meta);

  return row;
}

// --- Goals -----------------------------------------------------------------
// Real data: the same jot:goals IPC / loadGoals() as the Focus page. Cards
// dim when their domain doesn't match the Focus toggle's mode, per
// domainForGoal (see comment above the toggle). A neutral goal (no domain set
// on its Jot category) is shown in both modes and never dimmed.
async function dashboardGoalsSection(preloadedResult) {
  const result = preloadedResult ?? (await window.maestro.getJotGoals());

  const section = document.createElement("section");
  section.className = "dash-board";
  section.append(dashBoardHead("Goals", result.ok ? result.goals.length : 0, "Work organized by goal, not a flat session list"));

  const body = document.createElement("div");
  body.className = "dash-board-body";
  if (!result.ok) {
    body.append(dashEmpty("Jot data unavailable — check Settings."));
  } else if (result.goals.length === 0) {
    body.append(dashEmpty("No active goals in Jot right now."));
  } else {
    const grid = document.createElement("div");
    grid.className = "dash-goals-grid";
    // When a Work/Private focus is active, float the matching (+ neutral) goals
    // to the top and let the dimmed non-matching ones sink below - dimming alone
    // wasn't enough to get an overview with ~29 goals (Aidin note 2026-07-05).
    // Stable sort keeps each group's original order. "All" leaves order intact.
    const isDimmed = (g) => {
      const d = domainForGoal(g);
      return dashboardFocusMode !== "all" && d !== null && d !== dashboardFocusMode;
    };
    const ordered =
      dashboardFocusMode === "all"
        ? result.goals
        : [...result.goals].sort((a, b) => (isDimmed(a) ? 1 : 0) - (isDimmed(b) ? 1 : 0));
    ordered.forEach((goal) => grid.append(dashGoalCardEl(goal)));
    body.append(grid);
  }
  section.append(body);
  return section;
}

function dashGoalCardEl(goal) {
  const domain = domainForGoal(goal);
  const card = document.createElement("div");
  card.className =
    "dash-goal-card" +
    (dashboardFocusMode !== "all" && domain !== null && domain !== dashboardFocusMode ? " dash-dimmed" : "");

  const head = document.createElement("div");
  head.className = "dash-goal-head";
  const name = document.createElement("span");
  name.className = "dash-goal-name";
  name.textContent = goal.text || "(untitled goal)";
  head.append(name);
  if (domain !== null) {
    const badge = document.createElement("span");
    badge.className = "dash-domain-badge dash-domain-" + domain;
    badge.textContent = domain === "work" ? "Work" : "Private";
    head.append(badge);
  }
  card.append(head);

  const meta = document.createElement("div");
  meta.className = "dash-goal-meta";
  const bits = [];
  if (goal.category) {
    bits.push(goal.category);
  }
  if (goal.subtaskTotal > 0) {
    bits.push(`${goal.subtaskDone}/${goal.subtaskTotal} subtasks`);
  }
  const dl = goalDeadlineText(goal.deadline);
  if (dl) {
    bits.push(dl);
  }
  meta.textContent = bits.join(" · ") || "no subtasks yet";
  card.append(meta);

  if (goal.subtaskTotal > 0) {
    const bar = document.createElement("div");
    bar.className = "dash-goal-progress-bar";
    const fill = document.createElement("div");
    fill.style.width = `${Math.round((goal.subtaskDone / goal.subtaskTotal) * 100)}%`;
    bar.append(fill);
    card.append(bar);
  }

  card.addEventListener("click", () => {
    navigateToPage("focus");
    selectedGoalId = goal.id;
  });

  return card;
}

// --- New session -------------------------------------------------------
// Project chips come from two sources:
//   - repo projects: derived from actual repo cwd's seen among state.sessions
//     (so the chip list reflects real projects Maestro has touched).
//   - domain projects: PLAN.md's non-repo "life-domain" project type (gym,
//     diabetes, kombucha, ...) — a small persisted registry (domains.js),
//     surfaced here with a distinct icon per the approved dashboard mock
//     (repo chips get a folder icon, domain chips get their own icon).
// Both chip kinds behave identically once selected: a session rooted in
// either folder auto-loads its CLAUDE.md + memory the moment it starts (see
// dashAutoContextStripEl) — there is no separate "domain session" mode.
// Variant A change: the old manual "load context" checklist (checkboxes for
// CLAUDE.md/PLAN.md/DECISIONS.md/memory) is gone. There was never anything to
// decide there - a session rooted in a project already auto-loads that
// project's CLAUDE.md + memory the moment it starts, so the checklist only
// implied a choice that doesn't exist. It's replaced by a passive one-line
// strip stating what already happens.
const REPO_CHIP_ICON = "\u{1F4C1}"; // folder

async function dashboardNewSessionSection() {
  const section = document.createElement("section");
  section.className = "dash-board";
  section.append(dashBoardHead("New session", null, "Starts fresh every time - never resumed history"));

  const body = document.createElement("div");
  body.className = "dash-board-body";
  const panel = document.createElement("div");
  panel.className = "dash-new-session-panel";

  const projectTitle = document.createElement("div");
  projectTitle.className = "dash-ns-col-title";
  projectTitle.textContent = "Pick a project";
  panel.append(projectTitle);

  const chipGrid = document.createElement("div");
  chipGrid.className = "dash-chip-grid";

  const knownRepos = [...new Set(state.sessions.filter((s) => s.cwd).map((s) => s.cwd))];
  const domains = await window.maestro.listDomains();

  // { cwd, label, icon } for every selectable chip, repos first then domains,
  // so dashAutoContextStripEl can look up the selected chip's label/icon by
  // cwd regardless of which kind it is.
  const chips = [
    ...knownRepos.map((cwd) => ({
      cwd,
      label: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
      icon: REPO_CHIP_ICON,
    })),
    ...domains.map((d) => ({ cwd: d.path, label: d.name, icon: d.icon })),
  ];

  chips.forEach((chip) => chipGrid.append(dashChipEl(chip.label, chip.cwd, chip.icon)));
  chipGrid.append(dashChipEl("+ other…", "__other__", null));
  chipGrid.append(dashChipEl("+ new domain…", "__new_domain__", null));
  panel.append(chipGrid);

  panel.append(dashAutoContextStripEl(dashboardSelectedChip, chips));

  const launchRow = document.createElement("div");
  launchRow.className = "dash-launch-row";
  const startBtn = document.createElement("button");
  startBtn.className = "text-btn";
  startBtn.textContent = "Start fresh session";
  startBtn.addEventListener("click", async () => {
    if (!dashboardSelectedChip || dashboardSelectedChip === "__other__" || dashboardSelectedChip === "__new_domain__") {
      showToast("Pick a project chip first.");
      return;
    }
    navigateToPage("chat");
    openFreshDraftInPane(dashboardSelectedChip, "");
  });
  launchRow.append(startBtn);

  body.append(panel, launchRow);
  section.append(body);
  return section;
}

function dashChipEl(label, cwd, icon) {
  const chip = document.createElement("div");
  chip.className = "dash-chip" + (dashboardSelectedChip === cwd ? " dash-chip-selected" : "");
  if (icon) {
    const ic = document.createElement("span");
    ic.className = "dash-chip-ic";
    ic.textContent = icon;
    chip.append(ic);
  }
  chip.append(document.createTextNode(label));
  chip.addEventListener("click", async () => {
    if (cwd === "__other__") {
      const folder = await window.maestro.pickFolder();
      if (folder) {
        dashboardSelectedChip = folder;
        renderDashboardPage();
      }
      return;
    }
    if (cwd === "__new_domain__") {
      await promptRegisterDomain();
      return;
    }
    dashboardSelectedChip = cwd;
    renderDashboardPage();
  });
  return chip;
}

// Minimal "register a new domain" flow. Folder comes from the native picker
// (which can also create a new folder); the name defaults to the folder's
// basename and is confirmed/renamed via the same inline-editable text input
// used everywhere else in the sidebar (makeInlineEditable) rather than
// window.prompt() - a documented-unreliable native dialog in this Electron
// build (see the Category CRUD comment above). Kept intentionally simple per
// the task's "keep it simple" - no dedicated modal/form. A domain's
// CLAUDE.md is optional, so nothing here requires or creates one.
async function promptRegisterDomain() {
  const folder = await window.maestro.pickDomainFolder();
  if (!folder) {
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
    const result = await window.maestro.registerDomain({ name: finalName, path: folder });
    if (!result.ok) {
      showToast(result.error || "Couldn't register domain.");
      return;
    }
    dashboardSelectedChip = result.domain.path;
    renderDashboardPage();
  });
}

// Passive confirmation strip - nothing to check, nothing to decide. Names the
// selected project (falling back to the first chip, or a generic label when
// none are known yet) so the sentence reads correctly either way. `chips` is
// the same { cwd, label, icon } list dashboardNewSessionSection built, so
// this works identically for a repo chip or a non-repo domain chip - the
// only difference is a domain's file list doesn't assume PLAN.md/
// DECISIONS.md exist (those are repo conventions; a domain's CLAUDE.md is
// even optional).
function dashAutoContextStripEl(selectedCwd, chips) {
  const selected = chips.find((c) => c.cwd === selectedCwd) || chips[0] || null;
  const projectLabel = selected ? selected.label : "the project";
  const isDomain = selected ? selected.icon !== REPO_CHIP_ICON : false;

  const strip = document.createElement("div");
  strip.className = "dash-auto-context";

  const icon = document.createElement("div");
  icon.className = "dash-auto-context-ic";
  icon.textContent = "⚡"; // lightning bolt
  strip.append(icon);

  const ctxBody = document.createElement("div");
  ctxBody.className = "dash-auto-context-body";
  const title = document.createElement("div");
  title.className = "dash-auto-context-title";
  const projectStrong = document.createElement("b");
  projectStrong.textContent = projectLabel;
  title.append("Starts fresh - auto-loads ", projectStrong, "'s CLAUDE.md + memory automatically");
  ctxBody.append(title);

  const files = document.createElement("div");
  files.className = "dash-auto-context-files";
  const fileNames = isDomain ? ["CLAUDE.md (optional)", "memory/*.md"] : ["CLAUDE.md", "PLAN.md", "DECISIONS.md", "memory/*.md"];
  fileNames.forEach((name) => {
    const code = document.createElement("code");
    code.textContent = name;
    files.append(code);
  });
  const rest = document.createElement("span");
  rest.textContent = "· no history resumed, no files to pick";
  files.append(rest);
  ctxBody.append(files);

  strip.append(ctxBody);
  return strip;
}

// --- Shared small pieces ----------------------------------------------

function dashBoardHead(title, count, hint) {
  const head = document.createElement("div");
  head.className = "dash-board-head";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  if (typeof count === "number") {
    const c = document.createElement("span");
    c.className = "dash-count";
    c.textContent = String(count);
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

async function renderFocusPage() {
  const page = document.getElementById("focusPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Focus";
  page.append(header);

  const result = await window.maestro.getJotGoals();

  if (!result.ok) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "Jot data unavailable — check that Jot is enabled and its file exists (Settings).";
    page.append(empty);
    return;
  }

  // Focus filter (All / Work / Private). Unlike the dashboard toggle (which
  // dims non-matching cards), on the Focus page it actually NARROWS the list so
  // you don't see everything. Neutral goals (no domain set) always show.
  page.append(focusModeToggleEl(renderFocusPage));
  const goals =
    dashboardFocusMode === "all"
      ? result.goals
      : result.goals.filter((g) => {
          const d = domainForGoal(g);
          return d === null || d === dashboardFocusMode;
        });

  const intro = document.createElement("div");
  intro.className = "analysis-totals";
  const filterNote = dashboardFocusMode === "all" ? "" : ` (${dashboardFocusMode} + unset)`;
  intro.textContent =
    `${goals.length} active goal${goals.length === 1 ? "" : "s"}${filterNote} (open or in progress), ranked by what deserves your focus now. Backed by Jot.`;
  page.append(intro);

  if (goals.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent =
      dashboardFocusMode === "all"
        ? "No active goals in Jot right now."
        : `No ${dashboardFocusMode} goals active right now.`;
    page.append(empty);
    return;
  }

  // The top few are the actual "work on this now" recommendation; the rest are
  // shown below a divider so the ranking's point (focus) isn't lost in a long
  // list. Keeping all of them visible (read-only) still lets the breakdown be
  // opened for any goal.
  const list = document.createElement("div");
  list.className = "focus-list";
  const TOP_N = 3;
  goals.forEach((goal, i) => {
    if (i === TOP_N && goals.length > TOP_N) {
      const divider = document.createElement("div");
      divider.className = "focus-divider";
      divider.textContent = "Also active";
      list.append(divider);
    }
    list.append(focusGoalCard(goal, i < TOP_N));
  });
  page.append(list);
}

function focusGoalCard(goal, isTop) {
  const card = document.createElement("div");
  card.className = "focus-card" + (isTop ? " focus-card-top" : "");

  const head = document.createElement("div");
  head.className = "focus-card-head";
  head.addEventListener("click", () => {
    selectedGoalId = selectedGoalId === goal.id ? null : goal.id;
    renderFocusPage();
  });

  const caret = document.createElement("span");
  caret.className = "focus-caret";
  caret.textContent = selectedGoalId === goal.id ? "▾" : "▸";
  head.append(caret);

  const titleWrap = document.createElement("div");
  titleWrap.className = "focus-title-wrap";
  const title = document.createElement("div");
  title.className = "focus-title";
  title.textContent = goal.text || "(untitled goal)";
  titleWrap.append(title);

  const meta = document.createElement("div");
  meta.className = "focus-meta";
  if (goal.category) {
    const catChip = document.createElement("span");
    catChip.className = "focus-chip focus-chip-cat";
    if (goal.color) {
      catChip.style.borderColor = goal.color;
    }
    catChip.textContent = goal.category;
    meta.append(catChip);
  }
  const statusChip = document.createElement("span");
  statusChip.className = "focus-chip";
  statusChip.textContent = goal.status === "in-progress" ? "in progress" : goal.status;
  meta.append(statusChip);
  if (typeof goal.priority === "number") {
    const prChip = document.createElement("span");
    prChip.className = "focus-chip";
    prChip.title = "Jot priority (lower = more urgent)";
    prChip.textContent = `p${goal.priority}`;
    meta.append(prChip);
  }
  const dl = goalDeadlineText(goal.deadline);
  if (dl) {
    const dlChip = document.createElement("span");
    dlChip.className = "focus-chip focus-chip-deadline" + (dl === "overdue" ? " focus-chip-overdue" : "");
    dlChip.textContent = dl;
    meta.append(dlChip);
  }
  if (goal.subtaskTotal > 0) {
    const progChip = document.createElement("span");
    progChip.className = "focus-chip";
    progChip.textContent = `${goal.subtaskDone}/${goal.subtaskTotal} subtasks`;
    meta.append(progChip);
  }
  if (goal.subtaskReview > 0) {
    const revChip = document.createElement("span");
    revChip.className = "focus-chip focus-chip-review";
    revChip.title = "Subtasks awaiting your review";
    revChip.textContent = `${goal.subtaskReview} to review`;
    meta.append(revChip);
  }
  titleWrap.append(meta);
  head.append(titleWrap);

  const score = document.createElement("span");
  score.className = "focus-score";
  score.title = "Attention score — higher means it deserves your focus sooner";
  score.textContent = String(goal.attentionScore);
  head.append(score);

  card.append(head);

  if (selectedGoalId === goal.id) {
    card.append(focusGoalBreakdown(goal));
  }
  return card;
}

function focusGoalBreakdown(goal) {
  const body = document.createElement("div");
  body.className = "focus-breakdown";

  if (goal.description) {
    const desc = document.createElement("div");
    desc.className = "focus-desc";
    desc.textContent = goal.description;
    body.append(desc);
  }

  const subHead = document.createElement("div");
  subHead.className = "focus-sub-head";
  subHead.textContent = goal.subtaskTotal > 0 ? "Subtasks" : "No subtasks yet — break this goal down below.";
  body.append(subHead);

  if (goal.subtaskTotal > 0) {
    const ul = document.createElement("ul");
    ul.className = "focus-subtasks";
    goal.subtasks.forEach((s) => {
      const li = document.createElement("li");
      li.className = "focus-subtask focus-subtask-" + (s.status || "open");
      const st = document.createElement("span");
      st.className = "focus-subtask-status";
      st.textContent = SUBTASK_STATUS_LABEL[s.status] || s.status || "open";
      const txt = document.createElement("span");
      txt.className = "focus-subtask-text";
      txt.textContent = s.text;
      li.append(st, txt);
      ul.append(li);
    });
    body.append(ul);
  }

  // Add-a-subtask row: the "break it down further" write. A single click to
  // add (Enter or the button) — the actual atomic write to todos.json happens
  // in jot.js. On success the page re-renders from the freshly-read file, so
  // what shows always reflects the real Jot state, never an optimistic guess.
  const addRow = document.createElement("div");
  addRow.className = "focus-add-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "focus-add-input";
  input.placeholder = "Add a subtask to break this goal down…";
  const btn = document.createElement("button");
  btn.className = "focus-add-btn";
  btn.textContent = "Add";
  const err = document.createElement("div");
  err.className = "focus-add-err";
  err.style.display = "none";

  async function submit() {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    btn.disabled = true;
    input.disabled = true;
    const res = await window.maestro.addJotSubtask(goal.id, text);
    if (res.ok) {
      // Keep this goal expanded so the new subtask is visible after re-render.
      selectedGoalId = goal.id;
      renderFocusPage();
    } else {
      err.textContent = res.error || "Failed to add subtask.";
      err.style.display = "";
      btn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  btn.addEventListener("click", submit);
  addRow.append(input, btn);
  body.append(addRow, err);

  return body;
}

// ============================== Goal page (Fas 3 Point 11) ==============================
// A MINIMAL first-pass UI to trigger and watch an autonomous goal run against
// the already-built src/lib/goalOrchestrator.js. This is explicitly a draft
// for Aidin to react to, not a finalized interface — the point is to make the
// orchestrator testable, not to design its permanent UX.
//
// GUARDRAIL: starting a run spawns REAL autonomous claude subprocesses that
// make real commits in an isolated worktree. It is USER-TRIGGERED ONLY (the
// Start button below) — nothing here runs on a timer or any automatic event.
// The orchestrator never pushes/merges, and there is deliberately no push
// affordance in this pass.

function renderGoalPage() {
  const page = document.getElementById("goalPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Autonomous goal";
  page.append(header);

  const intro = document.createElement("div");
  intro.className = "analysis-totals";
  intro.textContent =
    "Draft / first pass. Runs a goal to partial completion via fresh autonomous claude iterations in an isolated git worktree. Each successful iteration is committed. It never pushes or merges — the work is left in a worktree for you to review. Several runs can go at once; each launches in its own worktree and shows below.";
  page.append(intro);

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
    const folder = await window.maestro.pickFolder();
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
  const modelDD = dropdownPill(
    "auto",
    [
      { value: "auto", label: "Auto" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ],
    () => {}
  );
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
    const res = await window.maestro.suggestVerifyCommand(folder);
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
  startBtn.textContent = "Start goal run";
  startBtn.addEventListener("click", async () => {
    const goal = goalInput.value.trim();
    const projectPath = cwdInput.value.trim();
    const maxIterations = parseInt(iterInput.value, 10) || 5;
    const verifyCommand = verifyInput.value.trim();
    const model = modelDD.value === "auto" ? undefined : modelDD.value;
    const effort = effortDD.value === "auto" ? undefined : effortDD.value;
    // `{}` (not `true`) enables escalation with goalOrchestrator.js's own
    // Phase-0 defaults; unchecked sends `undefined`, keeping the pre-existing
    // no-escalation behavior exactly (mirrors verifyCommand's opt-in shape).
    const escalationConfig = escalateCheckbox.checked ? {} : undefined;
    err.textContent = "";
    if (!goal) {
      err.textContent = "Enter a goal first.";
      return;
    }
    if (!projectPath) {
      err.textContent = "Pick a project folder first.";
      return;
    }
    const res = await window.maestro.runGoal({ projectPath, goal, maxIterations, model, effort, verifyCommand, escalationConfig });
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
    });
    // Clear only the goal field so the launcher is ready for the next run;
    // folder / verify / model picks usually carry over between runs.
    goalInput.value = "";
    renderGoalPage();
  });
  actionRow.append(startBtn);

  form.append(
    goalLabel,
    goalInput,
    cwdLabel,
    cwdRow,
    iterLabel,
    iterInput,
    modelEffortLabel,
    modelEffortRow,
    verifyLabel,
    verifyInput,
    verifyHint,
    escalateRow,
    err,
    actionRow
  );
  page.append(form);

  // ---- Runs (newest first) ----
  const runs = [...goalRuns.values()];
  if (runs.length) {
    const runsWrap = document.createElement("div");
    runsWrap.className = "goal-runs";
    for (const run of runs.reverse()) {
      runsWrap.append(goalRunDetailEl(run));
    }
    page.append(runsWrap);
  }
}

// One run's live block: heading (ordinal + goal, so concurrent runs are
// tellable apart) + per-run cancel, then status line, plan, iteration cards,
// escalation, and final summary/error. Extracted from the old single-run
// rendering so the Goal page can show several runs at once.
function goalRunDetailEl(run) {
  const wrap = document.createElement("div");
  // Subtle amber accent (see .goal-run-detail-attention in style.css) so a
  // run needing attention is visible at a glance among several run blocks,
  // not just discoverable by reading each status line.
  wrap.className = "goal-run-detail" + (run.status === "error" || run.escalation ? " goal-run-detail-attention" : "");

  const head = document.createElement("div");
  head.className = "goal-run-head";
  const title = document.createElement("span");
  title.className = "goal-run-title";
  const goalSnippet = run.goal.length > 80 ? run.goal.slice(0, 80) + "…" : run.goal;
  title.textContent = `Run ${run.ordinal}: ${goalSnippet}`;
  head.append(title);
  if (run.status === "running") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "goal-cancel-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling after current iteration…";
      await window.maestro.cancelGoal(run.goalRunId);
    });
    head.append(cancelBtn);
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
      head.append(goalWorktreeActionsEl(run, worktreePath));
    }
  }
  wrap.append(head);

  const progress = document.createElement("div");
  progress.className = "goal-progress";

  const statusLine = document.createElement("div");
  statusLine.className = "goal-status-line";
  if (run.status === "running") {
    statusLine.textContent = run.escalation
      ? `Paused · ${run.iterations.length} iteration(s) so far…`
      : `Running · ${run.iterations.length} iteration(s) so far…`;
  } else if (run.status === "done") {
    statusLine.textContent = run.escalation ? "Run paused for you." : "Run finished.";
  } else if (run.status === "error") {
    statusLine.textContent = "Run ended with an error.";
  } else if (run.status === "interrupted") {
    // Rehydrated from disk (see goalRunHistory.js/goal:history): the run was
    // still "running" when Maestro last shut down, so there is no live
    // process behind it anymore - its actual outcome is unknown, not "done".
    statusLine.textContent = "Interrupted by an app restart - check the worktree/branch on disk for what it left behind.";
  }
  progress.append(statusLine);

  // RPI phase (research -> plan -> implement, see goalOrchestrator.js): the
  // plan itself is the plan-phase's one durable artifact, so surface it as soon
  // as any iteration has reached/passed the plan phase - a plain expandable
  // block (the app's existing `.tool-group` <details> pattern), not its own
  // card, since it is reference material for the run rather than an event.
  const planContent = run.result?.plan ?? run.latestPlan ?? null;
  if (planContent) {
    progress.append(goalPlanBlock(planContent));
  }

  run.iterations.forEach((rec) => {
    progress.append(goalIterationCard(rec));
  });
  wrap.append(progress);

  // Escalation (Point 12 Phase-0, opt-in) - shown as soon as the escalation
  // event arrives (it precedes "done"), so a human-gated pause is visible
  // immediately rather than only once the run winds down.
  if (run.escalation) {
    wrap.append(goalEscalationCard(run.escalation));
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
    const res = await window.maestro.openGoalWorktree(worktreePath);
    if (res && !res.ok) {
      showToast(res.error || "Couldn't open the worktree.");
    }
  });
  wrap.append(openBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "text-btn";
  deleteBtn.textContent = "Delete worktree";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // removeWorktree only removes the worktree checkout itself, never the
    // branch ref (see lib/worktree.js doc comment) - the confirm copy must
    // stay accurate about that rather than imply the branch goes away too.
    const branchNote = run.result?.branchName
      ? ` (branch "${run.result.branchName}" is kept - delete it by hand if unwanted)`
      : "";
    showContextMenu(e.clientX, e.clientY, [
      {
        label: `Confirm delete worktree "${worktreePath}"${branchNote}`,
        danger: true,
        onClick: async () => {
          deleteBtn.disabled = true;
          openBtn.disabled = true;
          const res = await window.maestro.deleteGoalWorktree({
            goalRunId: run.goalRunId,
            projectPath: run.projectPath,
            worktreePath,
          });
          if (!res || !res.ok) {
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
        },
      },
    ]);
  });
  wrap.append(deleteBtn);

  return wrap;
}

// RPI phase (research/plan/implement) display labels - short and title-cased
// for the iteration card, matching the app's other compact-label conventions.
const GOAL_PHASE_LABELS = { research: "Research", plan: "Plan", implement: "Implement" };

// An expandable block showing the current `.maestro-goal/plan.md` content -
// reuses the same <details>/.tool-group pattern as tool-call output elsewhere
// in the app, rather than inventing a new expandable widget.
function goalPlanBlock(planContent) {
  const details = document.createElement("details");
  details.className = "tool-group goal-plan-block";
  const summary = document.createElement("summary");
  summary.textContent = "Plan (.maestro-goal/plan.md)";
  details.append(summary);
  const pre = document.createElement("pre");
  pre.className = "tool-call-output goal-plan-content";
  pre.textContent = planContent;
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

  return card;
}

function goalSummaryCard(result) {
  const card = document.createElement("div");
  card.className = "goal-summary-card";

  const title = document.createElement("div");
  title.className = "goal-summary-title";
  title.textContent = "Run complete — review the work in its isolated worktree";
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
// Resume: goalOrchestrator.js does NOT yet expose a "continue this exact run"
// entry point - `runGoal` always creates a brand-new worktree/branch. The
// worktree/branch/notes.md/phase.json ARE preserved on disk (the whole point
// of pausing rather than aborting), so a one-click resume is architecturally
// possible, but wiring a NEW runGoal call to an EXISTING worktree instead of
// creating a fresh one is real orchestrator work, not a renderer-only change.
// Rather than fake a resume button that silently starts an unrelated new run
// against the same project, this card surfaces the paused worktree/branch so
// the user can inspect or continue the work by hand today, and says plainly
// that one-click resume is a follow-up.
function goalEscalationCard(escalation) {
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
    "The run paused here rather than continuing blind - nothing was discarded. Its worktree, branch, notes.md and plan.md are all preserved above for you to inspect, and you can continue the work by hand in that worktree. One-click resume from this card is a planned follow-up, not wired up yet.";
  card.append(note);

  return card;
}

// Live goal-run events (own channel, parallel to session events). Each payload
// carries goalRunId; events from a stale run (a previous run, or after a new
// one started) are ignored so late events can't clobber current state.
window.maestro.onGoalEvent((evt) => {
  const run = goalRuns.get(evt.goalRunId);
  if (!run) {
    return;
  }
  if (evt.kind === "iteration") {
    run.iterations.push(evt.record);
    // Track the latest plan.md content as it arrives (see goalOrchestrator.js
    // record.plan), so the Goal page can show the plan live instead of only
    // once the run finishes and its final `result.plan` is available.
    if (evt.record.plan) {
      run.latestPlan = evt.record.plan;
    }
  } else if (evt.kind === "done") {
    run.status = "done";
    run.result = evt.result;
  } else if (evt.kind === "error") {
    run.status = "error";
    run.error = evt.error;
    // Failures must be visible even off-page (see unseenGoalAttention above) -
    // a run erroring while the user is on Chat/Plan would otherwise sit
    // silently until they happen to check the Goal page.
    unseenGoalAttention.add(run.goalRunId);
    showToast(`Goal run "${run.goal}" failed: ${run.error}`);
    updateGoalAttentionBadge();
  } else if (evt.kind === "escalation") {
    // Point 12 Phase-0 escalation (opt-in) - arrives BEFORE "done" (see
    // main.js's goal:run handler), so the escalation card can show up the
    // moment the run actually pauses rather than waiting for the run's
    // promise to resolve and send "done" with the same info.
    run.escalation = evt.escalation;
    unseenGoalAttention.add(run.goalRunId);
    showToast(`Goal run "${run.goal}" paused - needs you`);
    updateGoalAttentionBadge();
  }
  // Only re-render if the Goal/Agents page is actually visible, to avoid
  // clobbering another page the user may have switched to mid-run.
  if (!document.getElementById("goalPage").classList.contains("hidden")) {
    renderGoalPage();
  }
  if (!document.getElementById("agentsPage").classList.contains("hidden")) {
    renderAgentsPage();
  }
});

// Reflects unseenGoalAttention.size as a small dot + count on the primary
// Dashboard tab, so a run that errored/escalated while the user was on
// another page stays discoverable after the toast fades. Subtle by design
// (Aidin's UI rule: color only for genuine attention states) - reuses
// --waiting, the same amber already used for the escalation card and other
// "needs you" states.
function updateGoalAttentionBadge() {
  const badge = document.getElementById("dashboardAttentionBadge");
  if (!badge) {
    return;
  }
  const count = unseenGoalAttention.size;
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.classList.toggle("hidden", count === 0);
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
};

// Recently-loaded mockup FILE PATHS, most-recent-first, capped at 5.
// Renderer-only persistence (localStorage) - no main.js IPC needed. Read once
// at startup; every successful file-path load pushes/reorders and re-saves.
const LAVISH_RECENT_KEY = "maestro.lavish.recentMockups";
const LAVISH_RECENT_MAX = 5;

function loadLavishRecents() {
  try {
    const raw = localStorage.getItem(LAVISH_RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string" && p) : [];
  } catch {
    return [];
  }
}

function addLavishRecent(filePath) {
  if (!filePath) {
    return;
  }
  const deduped = lavishRecents.filter((p) => p !== filePath);
  deduped.unshift(filePath);
  lavishRecents = deduped.slice(0, LAVISH_RECENT_MAX);
  try {
    localStorage.setItem(LAVISH_RECENT_KEY, JSON.stringify(lavishRecents));
  } catch {
    // localStorage unavailable/full - recents just won't persist this run.
  }
}

let lavishRecents = loadLavishRecents();

// Build a mockup's sandboxed srcdoc, load it into the Plan (Lavish) review
// surface, switch to the Plan view, and render it ready for annotation. Shared
// by the manual "Load mockup" button and openMockupFileInPlan (the hook a
// generated-mockup flow calls), so "generate a mockup -> annotate it in Plan"
// is one action rather than a copy-paste round-trip. Returns { ok } or
// { ok: false, error }.
async function openMockupInPlan(html) {
  const built = await window.maestro.buildArtifactSrcdoc(html);
  if (!built || !built.ok) {
    return { ok: false, error: built?.error || "unknown error" };
  }
  lavishState.srcdoc = built.srcdoc;
  lavishState.annotations = [];
  lavishState.domSnapshot = "";
  lavishState.annotateMode = true;
  lavishState.loadError = "";
  // navigateToPage("lavish") re-renders the Plan page itself, so the mockup
  // shows even if the caller was on another view (the IPC hook below).
  navigateToPage("lavish");
  return { ok: true };
}

// Open a mockup that already exists as an HTML file (by absolute path) straight
// in the Plan view - the entry point for a generated artifact. Reads the file,
// then hands off to openMockupInPlan. Returns { ok } / { ok: false, error }.
async function openMockupFileInPlan(filePath) {
  const res = await window.maestro.readArtifactFile(filePath);
  if (!res || !res.ok) {
    return { ok: false, error: res?.error || "unknown error" };
  }
  const built = await openMockupInPlan(res.html);
  if (built.ok) {
    addLavishRecent(filePath);
  }
  return built;
}

// Hook for opening a generated mockup straight in the Plan view: main sends
// "plan:openMockup" with { filePath } (a mockup written to disk) or { html }.
// This is the connection point the artifact-generation-during-planning flow
// will call so a generated vision-mockup lands in the annotator in one step;
// nothing sends it yet, so it's inert until that flow is wired.
if (window.maestro.onOpenMockup) {
  window.maestro.onOpenMockup(async (payload = {}) => {
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
    const files = await window.maestro.pickFiles();
    if (files && files.length) {
      pathInput.value = files[0];
    }
  });
  pathRow.append(pathInput, pickBtn);

  // ---- Recent mockups: last few file-path loads, one click to reload ----
  let recentSection = null;
  if (lavishRecents.length > 0) {
    recentSection = document.createElement("div");
    recentSection.className = "lavish-recent";
    const recentLabel = document.createElement("div");
    recentLabel.className = "goal-field-hint lavish-recent-label";
    recentLabel.textContent = "Recent";
    recentSection.append(recentLabel);
    lavishRecents.forEach((recentPath) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "text-btn lavish-recent-row";
      row.title = recentPath;
      row.textContent = recentPath.split(/[\\/]/).pop();
      row.addEventListener("click", async () => {
        lavishState.loadError = "";
        const res = await openMockupFileInPlan(recentPath);
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
      await window.maestro.copyToClipboard(text);
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
    await window.maestro.copyToClipboard(text);
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
  const res = await window.maestro.formatAnnotations(lavishState.annotations, lavishState.domSnapshot);
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
// ~/.claude/scheduled-tasks/, one folder per task with a SKILL.md). Maestro
// does NOT run a scheduler of its own here - this page only lists what
// already exists on disk, via routines:list (see lib/routines.js). A
// Maestro-native routine type is a real idea (PLAN.md) but is not built in
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
    "Claude Code's own scheduled tasks (~/.claude/scheduled-tasks/) - read-only. Maestro doesn't run a scheduler of its own; this just shows what's already there.";
  page.append(intro);

  const board = document.createElement("section");
  board.className = "dash-board";
  board.append(dashBoardHeadWithLabel("Scheduled tasks", null, false, "Each one is a Claude Code SKILL.md task folder"));

  const body = document.createElement("div");
  body.className = "dash-board-body";
  board.append(body);
  page.append(board);

  const res = await window.maestro.listRoutines();
  // The page may have been navigated away from while the read was in flight;
  // avoid clobbering whatever the user is looking at now.
  if (page.classList.contains("hidden")) {
    return;
  }
  body.innerHTML = "";

  if (!res || !res.ok || !Array.isArray(res.tasks) || res.tasks.length === 0) {
    body.append(dashEmpty("No scheduled tasks found under ~/.claude/scheduled-tasks/."));
  } else {
    const list = document.createElement("div");
    list.className = "dash-queue-list";
    res.tasks.forEach((task) => list.append(routineRowEl(task)));
    body.append(list);
  }

  const later = document.createElement("div");
  later.className = "later-note";
  later.textContent =
    "(coming) A Maestro-native routine type - defined and run from inside Maestro itself, alongside these Claude-native ones - is not built in this pass.";
  page.append(later);
}

function routineRowEl(task) {
  const row = document.createElement("div");
  row.className = "dash-queue-row";

  // A scheduled task is a static definition, not running work - use a neutral
  // clock glyph, not the pulsing "working" dot (which implies live activity).
  const ic = document.createElement("div");
  ic.className = "dash-state-ic";
  ic.textContent = "🕒";
  row.append(ic);

  const qbody = document.createElement("div");
  qbody.className = "dash-q-body";
  const top = document.createElement("div");
  top.className = "dash-q-top";
  const title = document.createElement("span");
  title.className = "dash-q-title";
  title.textContent = task.name;
  const tag = document.createElement("span");
  tag.className = "dash-goal-tag";
  tag.textContent = "claude scheduled-task";
  top.append(title, tag);
  qbody.append(top);

  const why = document.createElement("div");
  why.className = "dash-q-why";
  why.textContent = task.schedule ? `${task.schedule} · ${task.description || ""}` : task.description || task.taskId;
  qbody.append(why);
  row.append(qbody);

  const openBtn = document.createElement("button");
  openBtn.className = "text-btn";
  openBtn.textContent = "Copy path";
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.maestro.copyToClipboard(task.skillPath);
  });
  const actions = document.createElement("div");
  actions.className = "dash-queue-actions";
  actions.append(openBtn);
  row.append(actions);

  return row;
}

// ============================== Agents page ==============================
// Maestro's OWN activity - not a rebuild of Claude Code's native Agent View.
// Two real sources, both already in renderer state:
//   - state.sessions: manual sessions Maestro is tracking (reuses the same
//     session.status the sidebar dot and dashboard queue already read).
//   - goalRuns: the in-flight goalOrchestrator runs (several can run at once,
//     each in its own worktree), with their iterations as children - the same
//     state renderGoalPage reads.
// Each run's iterations are sequential (one worker per run); a true multi-worker
// fan-out UNDER a single run (several parallel workers in one orchestrator node)
// does not exist yet - that is marked "(coming)" below rather than faked.

function renderAgentsPage() {
  const page = document.getElementById("agentsPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Agents";
  page.append(header);

  const intro = document.createElement("div");
  intro.className = "analysis-totals";
  intro.textContent = "What Maestro itself is running right now - active sessions and goal-orchestrator runs.";
  page.append(intro);

  const wrap = document.createElement("div");
  wrap.className = "tree-wrap";

  // All in-motion goal runs (running or paused-for-escalation - both keep
  // status "running" until they finish). Several can run at once.
  const activeGoalRuns = [...goalRuns.values()].filter((r) => r.status === "running");
  if (activeGoalRuns.length) {
    activeGoalRuns.forEach((r) => wrap.append(agentsGoalRunNode(r)));
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "tree-meta-row agents-placeholder";
    placeholder.textContent = "(goal runs appear here when running)";
    wrap.append(placeholder);
  }

  const activeSessions = sortByAttention(state.sessions.filter((s) => !s.isArchived && (s.status === "active" || s.status === "waiting")));
  activeSessions.forEach((session) => wrap.append(agentsSessionNode(session)));

  if (activeGoalRuns.length === 0 && activeSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-meta-row agents-placeholder";
    empty.textContent = "Nothing in motion right now.";
    wrap.append(empty);
  }

  page.append(wrap);

  const legend = document.createElement("div");
  legend.className = "legend";
  [
    ["running", "running"],
    ["waiting", "needs you"],
    ["done", "done / committed"],
    ["failed", "failed / rolled back"],
  ].forEach(([cls, label]) => {
    const span = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = `agents-state-dot ${cls}`;
    span.append(dot, document.createTextNode(label));
    legend.append(span);
  });
  page.append(legend);

  const later = document.createElement("div");
  later.className = "later-note";
  later.textContent =
    "(coming) Gated on the dispatch layer maturing: true multi-worker fan-out (several parallel workers UNDER a single run's node), a timeline scrubber over past runs, and per-node token/cost readout. Several goal runs can already run at once (each its own branch here); within a run, iterations are still sequential.";
  page.append(later);
}

function agentsGoalRunNode(run) {
  const node = document.createElement("div");
  node.className = "tree-node root";

  const line = document.createElement("div");
  line.className = "tree-line";
  const dot = document.createElement("span");
  dot.className = `agents-state-dot ${run.status === "running" ? "running" : run.status === "error" ? "failed" : "done"}`;
  const label = document.createElement("span");
  label.className = "tree-label";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = `Goal run - "${run.goal || "(no goal text)"}"`;
  const detail = document.createElement("span");
  detail.className = "detail";
  const projectName = (run.projectPath || "").split(/[\\/]/).filter(Boolean).pop() || run.projectPath || "";
  detail.textContent = `${projectName} · iteration ${run.iterations.length}/${run.maxIterations || "?"}`;
  label.append(name, detail);
  const badge = document.createElement("span");
  badge.className = "tree-badge";
  badge.textContent = "orchestrator";
  line.append(dot, label, badge);
  node.append(line);

  const meta = document.createElement("div");
  meta.className = "tree-meta-row";
  meta.textContent = `project: ${run.projectPath || "(unknown)"} · status: ${run.status}`;
  node.append(meta);

  if (run.iterations.length > 0) {
    const children = document.createElement("div");
    children.className = "tree-children";
    run.iterations.forEach((rec) => children.append(agentsIterationNode(rec)));
    node.append(children);
  }

  return node;
}

function agentsIterationNode(rec) {
  const node = document.createElement("div");
  node.className = "tree-node";

  const line = document.createElement("div");
  line.className = "tree-line";
  const ok = rec.ok && rec.result && rec.result.success;
  const dot = document.createElement("span");
  dot.className = `agents-state-dot ${rec.ok ? "done" : "failed"}`;
  const label = document.createElement("span");
  label.className = "tree-label";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = `Iteration ${rec.iteration}`;
  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent = rec.ok && rec.result ? rec.result.summary || "" : rec.error || "failed";
  label.append(name, detail);
  const badge = document.createElement("span");
  badge.className = "tree-badge";
  badge.textContent = rec.ok ? (ok ? "committed" : "discarded") : "error";
  line.append(dot, label, badge);
  node.append(line);

  return node;
}

function agentsSessionNode(session) {
  const node = document.createElement("div");
  node.className = "tree-node root";
  node.addEventListener("click", () => {
    navigateToPage("chat");
    openSessionInPane(session, focusedPaneIndex);
  });

  const line = document.createElement("div");
  line.className = "tree-line";
  const dot = document.createElement("span");
  dot.className = `agents-state-dot ${session.status === "waiting" ? "waiting" : "running"}`;
  const label = document.createElement("span");
  label.className = "tree-label";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = `Session - "${session.title}"`;
  const detail = document.createElement("span");
  detail.className = "detail";
  const projectName = (session.cwd || "").split(/[\\/]/).filter(Boolean).pop() || session.cwd || "";
  detail.textContent = `${projectName} · ${session.status === "waiting" ? "waiting for input" : "active"}`;
  label.append(name, detail);
  const badge = document.createElement("span");
  badge.className = "tree-badge";
  badge.textContent = "manual session";
  line.append(dot, label, badge);
  node.append(line);

  const meta = document.createElement("div");
  meta.className = "tree-meta-row";
  const modelLabel = session.model ? session.model.replace("claude-", "") : "model unknown";
  meta.textContent = `${modelLabel}${session.effort ? " / " + session.effort : ""} · ${relTime(session.lastActivityAt)}`;
  node.append(meta);

  return node;
}

// ============================== Analysis page ==============================
// Replaces the earlier popup versions of Skills/Usage — those rendered via
// submenus that could overflow off-screen near the window edge, and Aidin
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
// primary Dashboard button and the #dashboardSubnav are shown/activated as a
// group across all of these, not by exact page match. Settings owns the two
// utility pages (Skills=analysis, Archive) reached from the gear.
const DASHBOARD_FACET_PAGES = ["dashboard", "goal", "agents", "routines", "focus"];
const SETTINGS_GROUP_PAGES = ["settings", "analysis", "archive"];

// Single source of truth for page navigation. Everything (the primary bar,
// the gear, the sub-nav, and every programmatic jump) routes through here, so
// navigation no longer depends on a button physically existing in #pageToggle.
function navigateToPage(page) {
  document.getElementById("chatPage").classList.toggle("hidden", page !== "chat");
  document.getElementById("dashboardPage").classList.toggle("hidden", page !== "dashboard");
  document.getElementById("focusPage").classList.toggle("hidden", page !== "focus");
  document.getElementById("goalPage").classList.toggle("hidden", page !== "goal");
  document.getElementById("lavishPage").classList.toggle("hidden", page !== "lavish");
  document.getElementById("routinesPage").classList.toggle("hidden", page !== "routines");
  document.getElementById("agentsPage").classList.toggle("hidden", page !== "agents");
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

  // Gear = active whenever we're on Settings or one of its utility pages.
  document.getElementById("settingsGear").classList.toggle("active", SETTINGS_GROUP_PAGES.includes(page));

  // Sub-nav: visible only within the Dashboard group; its buttons match exactly.
  const subnav = document.getElementById("dashboardSubnav");
  subnav.classList.toggle("hidden", !inDashboardGroup);
  subnav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));

  // Landing on the facet that actually shows the failed/paused run is what
  // counts as "seen" - clears the attention dot from updateGoalAttentionBadge.
  if (page === "goal" || page === "agents") {
    unseenGoalAttention.clear();
    updateGoalAttentionBadge();
  }

  if (page === "dashboard") {
    renderDashboardPage();
  } else if (page === "focus") {
    renderFocusPage();
  } else if (page === "goal") {
    renderGoalPage();
  } else if (page === "lavish") {
    renderLavishPage();
  } else if (page === "routines") {
    renderRoutinesPage();
  } else if (page === "agents") {
    renderAgentsPage();
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
document.getElementById("settingsGear").addEventListener("click", () => navigateToPage("settings"));

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

// A place to actually get sessions back — "Remove from Maestro" and
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
  // even if it's still separately hidden from Maestro's own sidebar view.
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
    archiveSectionEl("Removed from Maestro", hidden, "Nothing hidden.", (session) =>
      archiveRowEl(session, "Restore", () => restoreToMaestro(session))
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
  title.textContent = session.title;
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

function renderSettingsPage() {
  const page = document.getElementById("settingsPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Settings";
  page.append(header);

  // Quiet secondary row reaching the two utility pages that no longer have a
  // primary tab of their own (Skills = the former "Analysis" page; Archive).
  const utilRow = document.createElement("div");
  utilRow.className = "view-toggle settings-utilities";
  const skillsBtn = document.createElement("button");
  skillsBtn.textContent = "Skills";
  skillsBtn.addEventListener("click", () => navigateToPage("analysis"));
  const archiveBtn = document.createElement("button");
  archiveBtn.textContent = "Archive";
  archiveBtn.addEventListener("click", () => navigateToPage("archive"));
  utilRow.append(skillsBtn, archiveBtn);
  page.append(utilRow);

  const block = document.createElement("div");
  block.className = "analysis-block settings-block";

  // Passive/observational group: these only read and surface a suggestion or
  // note — they never touch a session on their own.
  const passiveGroup = document.createElement("div");
  passiveGroup.className = "settings-group";
  passiveGroup.append(settingsGroupHeading("Passive — suggests, never acts"));

  passiveGroup.append(
    settingsToggleRow(
      "Model-fit judge",
      "Runs a cheap Haiku call after every completed prompt to flag whether the model/effort choice was too weak, too strong, or appropriate. Adds ~$0.015 per prompt. Shown under the composer, not in the chat history.",
      state.config.modelFitJudge?.enabled !== false,
      async (checked) => {
        state.config = await window.maestro.setConfig({
          modelFitJudge: { ...(state.config.modelFitJudge || {}), enabled: checked },
        });
      }
    )
  );

  passiveGroup.append(
    settingsToggleRow(
      "Notify when a prompt finishes",
      "Shows a native Windows notification (with its default sound) when a session completes a run, so you can switch away while it works.",
      state.config.notifyOnComplete !== false,
      async (checked) => {
        state.config = await window.maestro.setConfig({ notifyOnComplete: checked });
      }
    )
  );

  passiveGroup.append(
    settingsToggleRow(
      "Suggest archiving idle sessions",
      "Shows an \"Archive?\" pill on idle sessions with no open Jot review/in-progress/open work. Archiving still needs your click — this only surfaces the suggestion, it never archives on its own.",
      state.config.archiveSuggestions?.enabled === true,
      async (checked) => {
        state.config = await window.maestro.setConfig({
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
        state.config = await window.maestro.setConfig({
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
  window.maestro.getSweepStatus().then((status) => {
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

  passiveGroup.append(
    settingsToggleRow(
      "Proactively check suggestion accuracy",
      "Periodically re-checks the same \"Suggestion accuracy\" comparison shown on the Analysis page (no extra cost — it's the existing usage log, no model call) and surfaces a dismissible note there when overriding the model/effort suggestion has been judged \"appropriate\" meaningfully more often than following it. Checked on the same sweep as the items above, after enough new judged runs accumulate. Never changes the suggestion heuristic itself — only tells you it might be worth revisiting.",
      state.config.suggestionAccuracyCheck?.enabled === true,
      async (checked) => {
        state.config = await window.maestro.setConfig({
          suggestionAccuracyCheck: { ...(state.config.suggestionAccuracyCheck || {}), enabled: checked },
        });
      }
    )
  );

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
        state.config = await window.maestro.setConfig({
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
      state.config = await window.maestro.setConfig({ voiceEngine: value });
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
  languageDesc.textContent = "Same global setting as the mic button's language picker in the composer — changing either one changes both.";
  languageLabel.append(languageTitle, languageDesc);
  const settingsLanguageDD = dropdownPill(
    state.config?.voiceLanguage || "swedish",
    [
      { value: "auto", label: "Auto-detect" },
      { value: "swedish", label: "Svenska" },
      { value: "english", label: "English" },
    ],
    async (value) => {
      state.config = await window.maestro.setConfig({ voiceLanguage: value });
    }
  );
  languageRow.append(languageLabel, settingsLanguageDD.el);
  voiceGroup.append(languageRow);

  // Each group gets its OWN column (auto-fit grid) so every heading tops its
  // own column, instead of the shorter groups being stacked awkwardly under
  // one another. Auto-fit collapses to fewer columns on a narrow window (see
  // .settings-columns CSS).
  const columns = document.createElement("div");
  columns.className = "settings-columns";
  columns.append(passiveGroup, activeGroup, voiceGroup);
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

function skillListEl(title, names, origin, cwd) {
  const section = document.createElement("div");
  section.className = "analysis-block";
  const h = document.createElement("h3");
  h.textContent = `${title} · ${names.length}`;
  section.append(h);
  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "None found.";
    section.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "skill-chip-list";
    names.forEach((n) => {
      const chip = document.createElement("button");
      chip.className = "skill-chip";
      chip.textContent = n;
      chip.title = "Open SKILL.md";
      chip.addEventListener("click", () => window.maestro.openSkill({ name: n, origin, cwd }));
      list.append(chip);
    });
    section.append(list);
  }
  return section;
}

function fitPill(kind, count) {
  const pill = document.createElement("span");
  pill.className = `fit-pill fit-pill-${kind}`;
  const shortLabel = { too_weak: "weak", appropriate: "ok", too_strong: "strong" }[kind];
  pill.textContent = `${count} ${shortLabel}`;
  return pill;
}

async function renderAnalysisPage() {
  const page = document.getElementById("analysisPage");
  page.innerHTML = "";

  const cwd = panes[focusedPaneIndex]?.cwd || "";
  const [{ global, project }, summary] = await Promise.all([
    window.maestro.listSkills(cwd),
    window.maestro.getUsageSummary(),
  ]);

  const header = document.createElement("h2");
  header.textContent = "Skills";
  page.append(header);

  const totals = document.createElement("div");
  totals.className = "analysis-totals";
  totals.textContent =
    `${summary.totalRuns} runs · $${summary.totalCostUsd.toFixed(2)} total` +
    (summary.judgeCostUsd ? ` · $${summary.judgeCostUsd.toFixed(2)} spent on model-fit judging` : "");
  page.append(totals);

  // Fas 3's proactive suggestion-accuracy finding (main.js's periodic
  // runSuggestionAccuracyCheck, folded into the orchestrator sweep — see
  // PLAN.md Phase 3 / DECISIONS.md). Surfaced right above the "Suggestion
  // accuracy" block it's about, since that's where Aidin already looks to
  // check this manually — the proactive version just means he doesn't have
  // to remember to. Same "propose, never auto-act" posture as the archive
  // pill: dismissing only hides THIS finding; a new one (computed from
  // meaningfully more data) replaces it automatically.
  const notice = state.config.suggestionAccuracyNotice;
  if (notice && !notice.dismissed) {
    const banner = document.createElement("div");
    banner.className = "analysis-notice";
    const text = document.createElement("span");
    text.textContent = `◎ ${notice.message}`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "analysis-notice-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", async () => {
      state.config = await window.maestro.setConfig({
        suggestionAccuracyNotice: { ...notice, dismissed: true },
      });
      renderAnalysisPage();
    });
    banner.append(text, dismiss);
    page.append(banner);
  }

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
    empty.textContent = "No data yet — usage logs as you use Maestro.";
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
  skillUsageH.title = 'Guessed from a leading "/skill-name" in the prompt text — not a real event from the CLI, so this misses skills invoked any other way.';
  skillUsageBlock.append(skillUsageH);
  const skillEntries = Object.entries(summary.bySkill).sort((a, b) => b[1] - a[1]);
  const skillMax = skillEntries.length ? skillEntries[0][1] : 0;
  if (skillEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet — only counts prompts starting with /skill-name.";
    skillUsageBlock.append(empty);
  } else {
    skillEntries.forEach(([s, c]) => skillUsageBlock.append(barRow(s, c, skillMax)));
  }

  const fitBlock = document.createElement("div");
  fitBlock.className = "analysis-block";
  const fitH = document.createElement("h3");
  fitH.textContent = "Model fit (judged)";
  fitH.title = "A cheap Haiku judge reviews each completed prompt for whether the model/effort choice fit the task.";
  fitBlock.append(fitH);
  const fitModels = Object.keys(summary.modelFit || {});
  if (fitModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No verdicts yet.";
    fitBlock.append(empty);
  } else {
    fitModels.forEach((m) => {
      const counts = summary.modelFit[m];
      const row = document.createElement("div");
      row.className = "fit-row";
      const label = document.createElement("span");
      label.className = "fit-model-label";
      label.textContent = m.replace("claude-", "");
      row.append(label);
      row.append(fitPill("too_weak", counts.too_weak), fitPill("appropriate", counts.appropriate), fitPill("too_strong", counts.too_strong));
      fitBlock.append(row);
    });
  }

  const accuracyBlock = document.createElement("div");
  accuracyBlock.className = "analysis-block";
  const accuracyH = document.createElement("h3");
  accuracyH.textContent = "Suggestion accuracy";
  accuracyH.title =
    "Joins each run's followed-vs-overridden auto-suggestion with the judge's verdict for that SAME run (by launchId) — not just a same-model coincidence. Runs from before this tracking existed, or with no judge verdict, are excluded rather than estimated.";
  accuracyBlock.append(accuracyH);
  const acc = summary.suggestionAccuracy || { followed: {}, overridden: {} };
  const followedTotal = (acc.followed.too_weak || 0) + (acc.followed.appropriate || 0) + (acc.followed.too_strong || 0);
  const overriddenTotal = (acc.overridden.too_weak || 0) + (acc.overridden.appropriate || 0) + (acc.overridden.too_strong || 0);
  if (followedTotal + overriddenTotal === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No judged runs with a suggestion yet.";
    accuracyBlock.append(empty);
  } else {
    const followedRow = document.createElement("div");
    followedRow.className = "fit-row";
    const followedLabel = document.createElement("span");
    followedLabel.className = "fit-model-label";
    followedLabel.textContent = `Followed suggestion (${followedTotal})`;
    followedRow.append(followedLabel);
    followedRow.append(fitPill("too_weak", acc.followed.too_weak || 0), fitPill("appropriate", acc.followed.appropriate || 0), fitPill("too_strong", acc.followed.too_strong || 0));
    accuracyBlock.append(followedRow);

    const overriddenRow = document.createElement("div");
    overriddenRow.className = "fit-row";
    const overriddenLabel = document.createElement("span");
    overriddenLabel.className = "fit-model-label";
    overriddenLabel.textContent = `Overrode suggestion (${overriddenTotal})`;
    overriddenRow.append(overriddenLabel);
    overriddenRow.append(fitPill("too_weak", acc.overridden.too_weak || 0), fitPill("appropriate", acc.overridden.appropriate || 0), fitPill("too_strong", acc.overridden.too_strong || 0));
    accuracyBlock.append(overriddenRow);

    // A plain read of what the numbers say, not a persuasive spin — if
    // overriding does better, that's a real signal the heuristic in
    // suggest.js should change, not something to word around.
    const followedRate = followedTotal ? (acc.followed.appropriate || 0) / followedTotal : null;
    const overriddenRate = overriddenTotal ? (acc.overridden.appropriate || 0) / overriddenTotal : null;
    if (followedRate !== null && overriddenRate !== null) {
      const note = document.createElement("div");
      note.className = "suggest-hint";
      const diff = Math.round((followedRate - overriddenRate) * 100);
      note.textContent =
        diff >= 0
          ? `Following the suggestion was judged "appropriate" ${diff} points more often than overriding it.`
          : `Overriding the suggestion was judged "appropriate" ${Math.abs(diff)} points more often than following it — worth revisiting suggest.js's heuristic.`;
      accuracyBlock.append(note);
    }
  }

  grid.append(modelBlock, toolBlock, skillUsageBlock, fitBlock, accuracyBlock);
  grid.append(
    skillListEl("Global skills (~/.claude/skills)", global, "global", cwd),
    skillListEl(`This pane's project skills${cwd ? "" : " (no folder set on the focused pane)"}`, project, "project", cwd)
  );
  page.append(grid);
}

document.getElementById("viewToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.maestro.setConfig({ viewMode: btn.dataset.mode });
  applyViewMode();
});

document.getElementById("sidebarModeToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.maestro.setConfig({ sidebarMode: btn.dataset.mode });
  applySidebarMode();
  renderSidebar();
});

function applySidebarMode() {
  document.querySelectorAll("#sidebarModeToggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.config.sidebarMode || "smart"));
  });
}

document.getElementById("splitToggle").addEventListener("click", () => {
  const workspace = document.getElementById("workspace");
  if (panes.length > 1) {
    stopLiveStatsTicker(1);
    panes = [panes[0]];
  } else {
    panes.push(freshPane());
  }
  workspace.classList.toggle("split", panes.length > 1);
  document.getElementById("splitToggle").classList.toggle("active", panes.length > 1);
  renderWorkspace();
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
  const btn = document.getElementById("backgroundTasksBtn");
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

window.maestro.onSessionEvent((evt) => {
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

  // Handled separately from the main switch below because this is the ONE
  // event kind that fully retires an entry — the judge resolves well after
  // "done" and is the last thing that will ever need this launchId.
  if (evt.kind === "modelFit") {
    const entry = launchPaneHistory.get(evt.launchId);
    launchPaneHistory.delete(evt.launchId); // this is the only consumer; always one-shot
    if (!entry || panes[entry.index] !== entry.pane) {
      return; // pane was reused for a different session in the meantime
    }
    const text = `${MODEL_FIT_ICON[evt.verdict] || "⚖"} ${MODEL_FIT_LABEL[evt.verdict] || evt.verdict}: ${evt.reason}`;
    setModelFitLine(entry.index, text, evt.verdict);
    return;
  }

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
    renderQuota(evt.quota);
    return;
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
  if (!entry || panes[entry.index] !== entry.pane) {
    return;
  }
  const { index, pane, startedAt } = entry;
  switch (evt.kind) {
    case "session":
      pane.cliSessionId = evt.sessionId;
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
      // event (Aidin's exact complaint: "den räknar inte upp ... tokens").
      pane.liveTokens += evt.totalTokens || 0;
      renderLiveStats(index, pane);
      pulsePaneStatusIcon(index);
      break;
    case "assistant":
      pane.turns.push({ role: "assistant", kind: "text", text: evt.text });
      bumpSessionActivity(pane.sessionId);
      renderPane(index);
      pulsePaneStatusIcon(index);
      break;
    case "error":
      pane.busy = false;
      pane.currentLaunchId = null;
      stopLiveStatsTicker(index);
      setPaneBusyUI(index, "");
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ " + evt.message });
      bumpSessionActivity(pane.sessionId);
      renderPane(index);
      break;
    case "done":
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
        // A killed process may not have flushed its in-progress turn to disk
        // yet — reloading the transcript here would silently drop whatever
        // text already streamed live. Keep what's on screen instead.
        pane.stopRequested = false;
        pane.turns.push({ role: "assistant", kind: "text", text: "⏹ Stopped." });
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
        // A queued prompt is deliberately NOT fired after an explicit stop —
        // you stopped this run for a reason, most likely to intervene, not
        // to have something else auto-fire right after.
      } else if (!evt.summary?.sawResult && evt.summary?.code !== 0) {
        // A genuine CLI failure (non-zero exit, no result ever produced) —
        // e.g. "No conversation found with session ID" when resuming from a
        // folder the session wasn't created in. Previously this vanished
        // completely: stderr was captured but nothing consumed it, so the
        // prompt just silently disappeared with the pane going back to idle
        // (caught via Aidin's "vad innebär pick repo folder på en befintlig
        // session" question). Surface it as a visible error turn instead of
        // reloading a transcript that never got the failed turn appended.
        pane.stopRequested = false;
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
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
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
          totalTokens: evt.summary?.totalTokens ?? null,
          costUsd: evt.summary?.costUsd ?? null,
        };
        loadTranscriptInto(index).then(refresh);
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

renderWorkspace();
renderBackgroundTasksBadge();
startup();
setInterval(refresh, 30000);

window.maestro.getVersion().then((v) => {
  document.getElementById("appVersion").textContent = v;
});

// Stale-build indicator: shows the pill when main.js's periodic on-disk
// check (see runStaleBuildCheck) finds the git HEAD has moved past what this
// running instance booted with — i.e. the source on disk changed (a pull, an
// edit) since Maestro started, so the currently running window no longer
// matches what's on disk. Purely informational (there is no in-app restart
// action here — Aidin restarts via his own script, which this must not try
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

window.maestro.getBuildStatus().then(applyBuildStatus);
window.maestro.onBuildStaleUpdate(applyBuildStatus);
