import { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, utilityProcess } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAllSessions, enrichWithJot, setSessionArchived, forkTranscriptAtUserMessage, switchSessionRootFolder } from "./lib/sessions.js";
import { loadJot, loadGoals, addSubtask, formatJotSummaryForClassifier } from "./lib/jot.js";
import { loadConfig, writeConfig } from "./lib/config.js";
import { startSession } from "./lib/launcher.js";
import { suggestModelEffort } from "./lib/suggest.js";
import { readTranscript } from "./lib/transcript.js";
import { findTranscriptPath } from "./lib/paths.js";
import { listSkills, skillMdPath } from "./lib/skills.js";
import { appendUsageLog, readUsageSummary, computeSuggestionAccuracyVerdict } from "./lib/usage.js";
import { judgeModelFit } from "./lib/judge.js";
import { classifySessionStatus, estimateSessionContextTokens, compactSession, getTranscriptSize } from "./lib/orchestratorHelper.js";
import { savePastedImage, prunePastedImages } from "./lib/images.js";
import { computeVersionString, captureRunningBuildIdentity, checkForNewerBuild } from "./lib/version.js";
import { runGoal } from "./lib/goalOrchestrator.js";
import { buildArtifactSrcdoc, formatAnnotationsAsPrompt } from "./lib/lavishSdk.js";
import { isAvailable as whisperStreamAvailable, startStream as startWhisperStream, stopStream as stopWhisperStream } from "./lib/whisperStream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let latestQuota = null;
// Stale-build indicator: the identity (package.json version + git HEAD short
// hash) of the build THIS instance is actually running, captured exactly
// once here at module load (main.js is only evaluated once per app launch).
// This never changes for the lifetime of the process — it is the fixed
// baseline that runStaleBuildCheck() below compares the live on-disk state
// against, which is the whole point: an already-running instance has no
// other way to notice that the source on disk moved out from under it.
const runningBuildIdentity = captureRunningBuildIdentity();
// Latest stale-check result, read by the "build:status" IPC handler (renderer
// polls it once on startup) and pushed proactively over "build:staleUpdate"
// whenever the periodic check (see runStaleBuildCheck) flips it.
let latestBuildStatus = { stale: false, runningVersion: runningBuildIdentity.version, runningCommit: runningBuildIdentity.commit, currentVersion: runningBuildIdentity.version };
const liveChildren = new Map(); // launchId -> child process, for the Stop button
// Fas 3 Point 11 (goal orchestrator) — one entry per in-flight goal run,
// goalRunId -> { cancelToken }. The orchestrator itself checks
// cancelToken.cancelled BETWEEN iterations (never mid-iteration), so
// "goal:cancel" just flips the flag on the matching run and the loop stops
// at its next boundary. In-memory only: a goal run is inherently tied to the
// app being open, and a run's real durable output is the worktree/branch/
// commits it leaves on disk, not this transient handle.
const liveGoalRuns = new Map();
// Fas 3 orchestrator-helper classifier results, sessionId -> { statusTag,
// reason, classifiedAtActivity }. In-memory only (lost on restart — a fresh
// sweep re-populates it soon after; not worth persisting for a v1 ambient
// signal). classifiedAtActivity lets the sweep skip re-spending on a session
// that hasn't changed since its last classification.
const sessionClassifications = new Map();
// Fas 3 auto-compact results, sessionId -> { preTokens, postTokens,
// compactedTranscriptSize }. compactedTranscriptSize (the transcript's byte
// size sampled right after compaction) is the "has real activity happened
// since?" guard — see getTranscriptSize's rationale. Lets the sweep avoid
// re-compacting an already-compacted-and-untouched session, and lets the
// row surface a "was auto-compacted" note until the next real activity.
const sessionCompactions = new Map();

// child.kill() only signals the top-level claude.exe — it does NOT kill the
// process tree. claude.exe spawns its own children (the model runtime, any
// MCP servers, Task-tool subagents), and on Windows those are not
// automatically terminated when their parent dies. Left running, they keep
// executing (and consuming subscription usage) after a Stop click or even
// after Maestro itself quits. `taskkill /T` recurses through the whole tree.
// `sync: true` runs the kill synchronously — required from the "before-quit"
// sweep, where an async execFile would very likely lose the race against the
// process actually exiting (nothing awaits it, so the app tears down before
// the async taskkill has run, leaving exactly the orphaned tree this is
// meant to prevent). The Stop-button path uses the default async form since
// the app keeps running there and blocking the main thread is pointless.
function killChildTree(child, { sync = false } = {}) {
  if (!child || child.killed || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T", "/F"];
    if (sync) {
      try {
        execFileSync("taskkill", args, { stdio: "ignore" });
      } catch {
        // Process may have already exited on its own — taskkill then reports
        // an error, which is fine and nothing to act on.
      }
      return;
    }
    execFile("taskkill", args, (err) => {
      if (err) {
        // Best-effort: the process may have already exited on its own
        // between the check above and this call, which taskkill reports as
        // an error — nothing more useful to do with it here.
        console.error(`[maestro] taskkill failed for pid ${child.pid}:`, err.message);
      }
    });
    return;
  }
  child.kill();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: "#1a1a1a",
    title: "Maestro",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Electron denies media (mic/camera) permission requests by default unless
  // a handler explicitly grants them — needed for the composer's mic button
  // (renderer's navigator.mediaDevices.getUserMedia). Scoped to this window's
  // own session only, and to the "media" permission specifically — no blanket
  // grant of other permission types.
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  // Surface renderer console output (incl. errors) in the terminal — there is
  // no separate devtools console to watch when driving this headlessly.
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const tag = ["LOG", "WARN", "ERROR"][level] || "LOG";
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
  });
}

// --- Overview: read + enrich sessions (reuses the Session Radar read layer) ---
ipcMain.handle("sessions:get", () => {
  const config = loadConfig();
  const attentionWindowMs = (config.attentionWindowHours || 24) * 60 * 60 * 1000;
  const { error, sessions } = readAllSessions({ attentionWindowMs });
  // The manual-ack downgrade MUST happen BEFORE enrichWithJot: its scoring
  // (attentionScore/needsAttention) reads session.status, so applying this
  // after scoring would leave an acknowledged session's score/spotlight
  // stuck at full "waiting" weight even though it displays as idle (caught
  // in review — scoring silently used the pre-downgrade status).
  const acknowledged = config.acknowledgedSessions || {};
  for (const session of sessions) {
    // A "waiting" session the user manually marked done stays downgraded to
    // "idle" ONLY while the ack is still current — if lastActivityAt has
    // moved past the timestamp it was acknowledged at, new activity arrived
    // since, so the ack is stale and the session goes back to needing
    // attention on its own, with no extra bookkeeping required here.
    if (session.status === "waiting" && acknowledged[session.sessionId] >= session.lastActivityAt) {
      session.status = "idle";
    }
  }
  const jotIndex = loadJot(config.jot || {});
  enrichWithJot(sessions, jotIndex, config.jot?.weights || {});
  // Title overrides are applied AFTER Jot matching so a renamed display title
  // never breaks the category-name match, which relies on the real title.
  const overrides = config.titleOverrides || {};
  for (const session of sessions) {
    if (overrides[session.sessionId]) {
      session.title = overrides[session.sessionId];
    }
    // orchestratorTag is the Fas 3 helper's own read of the content — a
    // proposal the renderer can use to sharpen the archive-suggestion pill,
    // never something that mutates status here. null when never classified
    // (helper disabled, or hasn't reached this session yet).
    session.orchestratorTag = sessionClassifications.get(session.sessionId) || null;
    // autoCompacted: surfaced so an automatic (silent) compaction isn't a
    // total black box — the row shows a small note until the next real
    // activity grows the transcript past its post-compaction size.
    const compaction = sessionCompactions.get(session.sessionId);
    if (compaction) {
      const currentSize = getTranscriptSize(session.cliSessionId, session.sessionId);
      session.autoCompacted = currentSize !== null && currentSize <= compaction.compactedTranscriptSize ? compaction : null;
    } else {
      session.autoCompacted = null;
    }
  }
  return {
    error,
    sessions,
    config,
    jot: { ok: jotIndex.ok, categories: jotIndex.categories },
    quota: latestQuota,
    generatedAt: Date.now(),
  };
});

// --- Config: grouping, sorting, view mode, persisted to config.json ---
ipcMain.handle("config:set", (_event, patch) => {
  const current = loadConfig();
  const next = { ...current, ...patch };
  writeConfig(next);
  return next;
});

// --- Model/effort suggestion for a given prompt ---
ipcMain.handle("suggest:modelEffort", (_event, prompt) => suggestModelEffort(prompt));

// --- Focus (Point 8): the user's active GOALS ranked by attention/priority,
// read straight from Jot (the same todos.json the sidebar's category matching
// reads — no second task system). Read-only. ---
ipcMain.handle("jot:goals", () => {
  const config = loadConfig();
  return loadGoals(config.jot || {});
});

// --- Goal breakdown: add a subtask under an existing top-level goal, written
// back to todos.json via the safe atomic-write path (re-read fresh, append one
// todo, temp file + rename — see addSubtask in jot.js). The one Jot WRITE
// Maestro performs; only ever in response to an explicit user action. ---
ipcMain.handle("jot:addSubtask", (_event, { parentId, text }) => {
  const config = loadConfig();
  return addSubtask(config.jot || {}, parentId, text);
});

// --- Skills available to a pane, split global vs project-specific ---
ipcMain.handle("skills:list", (_event, cwd) => listSkills(cwd));

// --- Open a skill's SKILL.md in the OS default app (from an Analysis-page chip) ---
ipcMain.handle("skills:open", (_event, { name, origin, cwd }) => {
  const file = skillMdPath(name, origin, cwd);
  if (!file) {
    return { ok: false, error: "SKILL.md not found" };
  }
  shell.openPath(file);
  return { ok: true };
});

// --- Copy text to clipboard (Electron's own module, not navigator.clipboard,
// to avoid relying on an untested web-permission assumption) ---
ipcMain.handle("clipboard:write", (_event, text) => {
  clipboard.writeText(text || "");
  return { ok: true };
});

// --- Resolve ~/.claude/CLAUDE.md's own @import line to find the real,
// canonical Dropbox-synced file. Previous behavior deliberately opened the
// thin stub itself and made Aidin follow the @import line manually - he's
// since said directly he wants the real file, not the stub, so this now
// reads the stub just to find the canonical path and returns that instead. ---
function resolveCanonicalGlobalClaudeMd() {
  const stubFile = path.join(os.homedir(), ".claude", "CLAUDE.md");
  if (!fs.existsSync(stubFile)) {
    return { ok: false, error: "Global CLAUDE.md not found at " + stubFile };
  }
  const stubContent = fs.readFileSync(stubFile, "utf8");
  const importMatch = stubContent.match(/^@(.+\.md)\s*$/m);
  if (!importMatch) {
    return { ok: false, error: "No @import line found in " + stubFile };
  }
  const canonicalFile = path.normalize(importMatch[1].trim());
  if (!fs.existsSync(canonicalFile)) {
    return { ok: false, error: "Canonical CLAUDE.md not found at " + canonicalFile };
  }
  return { ok: true, file: canonicalFile };
}

// --- Open the FOLDER containing Aidin's real, canonical global CLAUDE.md
// (resolved via the stub's @import line - see resolveCanonicalGlobalClaudeMd)
// in Explorer, with the file itself selected. A folder rather than the bare
// file per Aidin's ask: that folder also holds DECISIONS.md/PLAN.md-shaped
// siblings (OPINIONS.md, VOICE.md, skills/) he wants to browse to from the
// same click. showItemInFolder (not openPath) so Explorer opens with
// CLAUDE.md highlighted rather than just landing on the folder view. ---
ipcMain.handle("claudeMd:openGlobal", () => {
  const resolved = resolveCanonicalGlobalClaudeMd();
  if (!resolved.ok) {
    return resolved;
  }
  shell.showItemInFolder(resolved.file);
  return { ok: true };
});

// --- Open the current session's own project ROOT folder (where that
// project's CLAUDE.md/DECISIONS.md/PLAN.md live) in Explorer, with
// CLAUDE.md selected, if a project CLAUDE.md exists. The renderer only shows
// this affordance when a lookup confirms the file is actually there (see
// claudeMd:projectExists) rather than surfacing a dead link that errors on
// click. Opens the folder (not just the file) per the same "browse to
// DECISIONS.md/PLAN.md from here" ask as the global link above. ---
ipcMain.handle("claudeMd:openProject", (_event, cwd) => {
  if (!cwd) {
    return { ok: false, error: "No project folder for this session" };
  }
  const file = path.join(cwd, "CLAUDE.md");
  if (!fs.existsSync(file)) {
    return { ok: false, error: "No CLAUDE.md in " + cwd };
  }
  shell.showItemInFolder(file);
  return { ok: true };
});

// --- Cheap existence check so the renderer can hide/disable the project
// CLAUDE.md link instead of showing one that errors on click. ---
ipcMain.handle("claudeMd:projectExists", (_event, cwd) => {
  if (!cwd) {
    return false;
  }
  return fs.existsSync(path.join(cwd, "CLAUDE.md"));
});

// --- Archive/unarchive a session in the desktop app's own state. Always a
// direct response to an explicit click in the renderer (manual "Archive", or
// approving an orchestrator-proposed suggestion) — never called on a timer or
// any other unattended trigger. ---
ipcMain.handle("session:archive", (_event, { sessionId, archived }) => {
  return setSessionArchived(sessionId, archived !== false);
});

// --- "Rewind to here": fork a session's transcript, truncated to just before
// the given user message, and return the new forked cliSessionId to --resume.
// Verified buildable in spike/test-rewind-fork.mjs. Never touches the
// original transcript — writes a new file beside it. ---
ipcMain.handle("session:fork", (_event, { cliSessionId, userMsgIndex }) => {
  return forkTranscriptAtUserMessage(cliSessionId, userMsgIndex);
});

// --- "Switch root folder": copy a session's transcript into a new folder's
// own project directory so --resume can find it there. `claude --resume`
// scopes lookup by cwd (verified in spike/test-cwd-switch.mjs — resuming
// from a different folder fails outright), and the copy trick is verified in
// spike/test-cwd-switch-copy.mjs. Never touches the original transcript. ---
ipcMain.handle("session:switchRootFolder", (_event, { cliSessionId, sessionId, newCwd }) => {
  return switchSessionRootFolder(cliSessionId, sessionId, newCwd);
});

// --- Save a pasted image to disk and hand back its path, so a prompt can
// reference it by file path — verified in spike/test-image-via-path.mjs that
// Claude Code's own Read tool picks it up from the path with no other
// architecture change. ---
ipcMain.handle("image:save", (_event, { base64Data, ext }) => {
  try {
    return { ok: true, path: savePastedImage(base64Data, ext) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Voice input: transcribe recorded mic audio locally (offline Whisper).
// Two backends behind config.voiceEngine (see config.js): "whispercpp"
// (default, src/lib/whisperCpp.js) spawns a whisper.cpp + CUDA subprocess,
// ~10-20x faster than the original path on Aidin's RTX 3070 (see
// docs/transcription-research.md); "transformers" (src/lib/voice.js) is the
// original @huggingface/transformers ONNX pipeline, kept as a fallback for
// machines without the .whisper/ binary+model installed. See voice.js for
// why transformers.js was originally picked over the OS speech API /
// whisper.cpp Node bindings / OpenSuperWhisper.
//
// Both backends' inference runs in a dedicated utility process (see
// src/lib/voiceWorker.js), NOT here on the main process. Aidin's feedback
// after the Swedish-quality model swap: "even the mic button feels laggy" -
// the CPU-bound Whisper inference used to run directly on this IPC handler,
// which is on the main process's event loop, so a multi-second
// transcription blocked EVERY other IPC round-trip (session polling, the
// mic button's own state, etc.) until it finished. utilityProcess.fork()
// gives inference its own OS process and event loop; this process only
// ever does a cheap postMessage + await reply (or, for whisper.cpp, an
// async child_process.spawn from within that worker process), so the UI
// stays responsive no matter how long a transcription takes.
//
// The worker is spawned lazily on first use (not at app startup) so apps
// that never touch voice input never pay the ~1s process-spawn cost or hold
// the model in memory. It is then kept alive and reused for every
// subsequent call in the app's lifetime - restarting it per call would
// re-load the (hundreds-of-MB) ONNX model from disk every time, which is
// exactly the per-call reload voice.js's own transcriberPromise caching was
// already written to avoid.
let voiceWorker = null;
let voiceRequestId = 0;
const pendingVoiceRequests = new Map(); // id -> { resolve, reject }

function getVoiceWorker() {
  if (voiceWorker) {
    return voiceWorker;
  }
  voiceWorker = utilityProcess.fork(path.join(__dirname, "lib", "voiceWorker.js"));
  voiceWorker.on("message", (message) => {
    const pending = pendingVoiceRequests.get(message.id);
    if (!pending) {
      return; // stale/unknown reply (worker restarted mid-flight, etc.) - ignore.
    }
    pendingVoiceRequests.delete(message.id);
    pending.resolve(message);
  });
  voiceWorker.on("exit", (code) => {
    console.error(`[maestro] voice worker exited unexpectedly (code ${code})`);
    // Fail every request still waiting on the dead worker instead of hanging
    // the mic button forever; the next transcribe call spawns a fresh worker.
    for (const pending of pendingVoiceRequests.values()) {
      pending.reject(new Error("Voice worker process exited unexpectedly"));
    }
    pendingVoiceRequests.clear();
    voiceWorker = null;
  });
  return voiceWorker;
}

function transcribeInWorker(samples, language, engine) {
  return new Promise((resolve, reject) => {
    const id = ++voiceRequestId;
    pendingVoiceRequests.set(id, { resolve, reject });
    getVoiceWorker().postMessage({ id, samples, language, engine });
  });
}

// samples arrives as a plain array of floats (structured-clone can't carry a
// Float32Array through contextBridge's IPC boundary as-is in every Electron
// version, so the renderer sends Array.from(float32Array); it is forwarded
// as-is to the worker, which rebuilds the typed array on its side). ---
ipcMain.handle("voice:transcribe", async (_event, { samples, language }) => {
  try {
    const engine = loadConfig().voiceEngine || "whispercpp";
    const message = await transcribeInWorker(samples, language, engine);
    if (!message.ok) {
      throw new Error(message.error);
    }
    return { ok: true, text: message.text };
  } catch (err) {
    console.error("[maestro] voice transcription failed:", err);
    return { ok: false, error: err.message };
  }
});

// --- True real-time streaming transcription (continuous voice input) ---
// See src/lib/whisperStream.js for the full design rationale. Unlike
// voice:transcribe (one-shot, routed through the dedicated utility process
// since ONNX/whisper-cli inference is CPU-bound and would otherwise block
// this process's event loop), whisper-stream.exe is a long-lived SUBPROCESS
// that owns the microphone directly via SDL2 — there is nothing CPU-bound
// happening on the main process's own event loop here, just an async spawn
// and incremental stdout reads, so no utility-process indirection is needed.
//
// One stream per pane/hold at a time in practice (only one mic can be held
// at once in the UI), but keyed by streamId so overlapping stop/start pairs
// (e.g. rapid re-holds) can never cross-wire a stale process's events into a
// fresh one.
const liveVoiceStreams = new Map(); // streamId -> child process

ipcMain.handle("voice:streamStart", (_event, { language }) => {
  if (!whisperStreamAvailable()) {
    return { ok: false, error: "whisper-stream.exe or the GGML model is not installed" };
  }
  const streamId = crypto.randomUUID();
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("voice:streamEvent", { streamId, ...payload });
    }
  };
  let child;
  try {
    child = startWhisperStream(language, send);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  liveVoiceStreams.set(streamId, child);
  child.on("exit", () => {
    liveVoiceStreams.delete(streamId);
  });
  return { ok: true, streamId };
});

ipcMain.handle("voice:streamStop", (_event, { streamId }) => {
  const child = liveVoiceStreams.get(streamId);
  if (!child) {
    return { ok: false, error: "no running stream for that streamId" };
  }
  stopWhisperStream(child);
  liveVoiceStreams.delete(streamId);
  return { ok: true };
});

// --- Aggregate usage summary (models + tools most used) ---
ipcMain.handle("usage:summary", () => readUsageSummary());

// --- App version, same scheme as Crewline/Jot: major.minor (hand-bumped in
// package.json) + a commit count since that bump, so the last number resets
// to 0 on every version bump instead of growing forever. ---
ipcMain.handle("app:version", () => computeVersionString());

// --- Stale-build indicator: hands back the running build's own identity plus
// the most recent periodic staleness check (see runStaleBuildCheck below).
// The renderer calls this once on startup to paint the initial state, then
// just listens on "build:staleUpdate" for changes — no polling from the
// renderer side. ---
ipcMain.handle("build:status", () => latestBuildStatus);

// --- Full chat history for a session (for the pane view) ---
ipcMain.handle("transcript:get", (_event, { cliSessionId, sessionId }) => {
  const transcriptPath = findTranscriptPath([cliSessionId, sessionId]);
  const result = readTranscript(transcriptPath);
  // Also hand back the context-size estimate so the pane header can show a
  // "how full is this session" marker (like Claude Desktop's context gauge).
  // One extra tail read, only on transcript load — not per poll.
  result.contextTokens = estimateSessionContextTokens(cliSessionId, sessionId);
  return result;
});

// --- Pick a repo folder to root a new session in ---
ipcMain.handle("dialog:pickFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Pick the repo folder to root the session in",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// --- Pick one or more files to attach to a prompt (same path-reference
// mechanism as a pasted image) ---
ipcMain.handle("dialog:pickFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Attach files",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) {
    return [];
  }
  return result.filePaths;
});

// --- Lavish (interactive-plan) v1: read an HTML artifact file from disk so the
// renderer (which has no fs access) can load a mockup by path. Read-only; the
// renderer also supports pasting HTML directly, which needs no IPC at all. ---
ipcMain.handle("lavish:readFile", (_event, filePath) => {
  try {
    if (!filePath) {
      return { ok: false, error: "No file path given" };
    }
    const resolved = path.normalize(String(filePath).trim());
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: "File not found: " + resolved };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, error: "Not a file: " + resolved };
    }
    // Cap the read: a mockup is tiny (KBs). Without this, pointing at a huge
    // or special file would read it fully into memory on the main thread via
    // the sync read below and freeze the whole app (review finding). 8MB is
    // far above any real mockup and still safe to load synchronously.
    const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
    if (stat.size > MAX_ARTIFACT_BYTES) {
      return { ok: false, error: `File too large (${Math.round(stat.size / 1024)} KB; max ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB). A mockup should be far smaller.` };
    }
    return { ok: true, html: fs.readFileSync(resolved, "utf8") };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// --- Lavish v1: wrap artifact HTML into a full srcdoc document with the
// annotation SDK injected. Kept in main (single source of truth in
// lib/lavishSdk.js, which is an ES module the non-module renderer can't import
// directly). Pure string transform — no fs, no side effects. ---
ipcMain.handle("lavish:buildSrcdoc", (_event, artifactHtml) => {
  return { ok: true, srcdoc: buildArtifactSrcdoc(artifactHtml) };
});

// --- Lavish v1: format collected annotations into a single agent-ready TEXT
// block. Pure; unit-tested standalone in spike/test-lavish.mjs. ---
ipcMain.handle("lavish:formatPrompt", (_event, { annotations, domSnapshot }) => {
  return { ok: true, text: formatAnnotationsAsPrompt(annotations, domSnapshot) };
});

// --- Start (or resume) a rooted session; stream events to the renderer ---
ipcMain.handle(
  "session:start",
  (_event, { cwd, prompt, model, effort, permissionMode, resumeSessionId, suggestedModel, suggestedEffort, internal }) => {
    if (!cwd || !prompt) {
      return { ok: false, error: "cwd and prompt are required" };
    }
    // A random id, not an incrementing counter — usage-log.jsonl persists
    // across app restarts but this counter wouldn't, so small reused integers
    // (1, 2, 3...) could join a verdict to the WRONG run from a different
    // Maestro session (found by review, see DECISIONS.md's suggestion-
    // accuracy entry). randomUUID makes cross-restart collision practically
    // impossible instead of merely unlikely.
    const launchId = crypto.randomUUID();
    const send = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("session:event", { launchId, ...payload });
      }
    };
    const meta = { toolsUsed: [], costUsd: 0, numTurns: 0, durationMs: null, totalTokens: null, actualModel: model || null, lastAssistantText: "", contextWindows: {} };
    const { child, done } = startSession({
      cwd,
      prompt,
      model,
      effort,
      permissionMode,
      resumeSessionId,
      onEvent: (evt) => {
        if (evt.kind === "quota" && evt.quota) {
          latestQuota = evt.quota;
        } else if (evt.kind === "tool_use" && evt.toolName) {
          meta.toolsUsed.push(evt.toolName);
        } else if (evt.kind === "assistant" && evt.text) {
          meta.lastAssistantText = evt.text;
        } else if (evt.kind === "result") {
          meta.costUsd = evt.costUsd || 0;
          meta.numTurns = evt.numTurns || 0;
          meta.durationMs = evt.durationMs ?? null;
          meta.totalTokens = evt.totalTokens ?? null;
          if (evt.contextWindows) {
            Object.assign(meta.contextWindows, evt.contextWindows);
          }
        } else if (evt.kind === "system" && evt.model) {
          meta.actualModel = evt.model;
        }
        send(evt);
      },
    });
    liveChildren.set(launchId, child);
    // Headless -p expands a leading "/skill-name" in the prompt text before
    // running it, so a leading slash-token is a reasonable (if not perfect —
    // it's a text-pattern guess, not a real event from the CLI) proxy for
    // "which skill was invoked," which the stream itself doesn't expose.
    const skillMatch = /^\/(\S+)/.exec(prompt.trim());
    done.then((summary) => {
      liveChildren.delete(launchId);
      // Send "done" FIRST, before any of the bookkeeping below that could
      // throw (a corrupt config.json, a disk-full usage-log write, etc).
      // Previously this came after appendUsageLog — if that threw, the
      // renderer never got its "done" event and the pane stayed "running"
      // forever with no way to recover short of restarting Maestro.
      // durationMs/totalTokens/costUsd ride along on the same summary object
      // so the renderer can show a "12.3s · 1.2k tokens" readout under the
      // reply that just completed, reusing the CLI's own result-event numbers
      // (already collected into `meta` for the usage log) instead of adding a
      // new plumbing path just for display.
      send({
        kind: "done",
        summary: { ...summary, durationMs: meta.durationMs, totalTokens: meta.totalTokens, costUsd: meta.costUsd },
      });

      // Learn model→context-window from what the CLI reported (done even for
      // internal launches — they run real models, so their reported windows
      // are just as valid). Persist only when something new/changed, so this
      // is a no-op write on the steady state.
      if (Object.keys(meta.contextWindows).length > 0) {
        const cfg = loadConfig();
        const known = cfg.modelContextWindows || {};
        let changed = false;
        for (const [m, w] of Object.entries(meta.contextWindows)) {
          if (known[m] !== w) {
            known[m] = w;
            changed = true;
          }
        }
        if (changed) {
          writeConfig({ ...cfg, modelContextWindows: known });
        }
      }

      // Maestro-internal launches (e.g. the hidden "summarize & carry over"
      // resume) are not real user turns: they must not be usage-logged,
      // notified, or judged. Doing so would spend a real judge call per
      // summarize AND inject a synthetic run into the very By-model /
      // Model-fit / Suggestion-accuracy analytics this app exists to surface.
      // The renderer still needs the "done" event above (its pendingLaunch
      // callback resolves on it), so that's sent unconditionally first.
      if (internal) {
        return;
      }

      try {
        appendUsageLog({
          type: "run",
          launchId,
          timestamp: Date.now(),
          cwd,
          model: meta.actualModel,
          effort: effort || null,
          permissionMode: permissionMode || null,
          suggestedModel: suggestedModel || null,
          suggestedEffort: suggestedEffort || null,
          followedSuggestion: !suggestedModel || suggestedModel === meta.actualModel,
          costUsd: meta.costUsd,
          numTurns: meta.numTurns,
          toolsUsed: meta.toolsUsed,
          skillInvoked: skillMatch ? skillMatch[1] : null,
        });

        // Native OS notification (Windows plays its default sound with it, no
        // separate audio file needed) when a prompt finishes — lets Aidin
        // switch away while a run is in progress.
        const notifyConfig = loadConfig().notifyOnComplete;
        if (notifyConfig !== false && summary.sawResult && Notification.isSupported()) {
          new Notification({
            title: "Maestro — prompt finished",
            body: truncateForNotification(prompt),
            silent: false,
          }).show();
        }

        // Model-fit judge: user-requested, cost-verified (~$0.015-0.02/call
        // after stripping MCP servers + tool defs the judge never needs).
        // Fire-and-forget so it never delays the real response; only runs on a
        // genuinely completed turn (skipped if the process was killed early —
        // sawResult false — since there is nothing meaningful to judge then).
        const config = loadConfig();
        if (summary.sawResult && config.modelFitJudge?.enabled !== false) {
          judgeModelFit({
            cwd,
            taskPrompt: prompt,
            model: meta.actualModel,
            effort,
            toolsUsed: meta.toolsUsed,
            numTurns: meta.numTurns,
            finalText: meta.lastAssistantText,
          })
            .then((result) => {
              if (!result) {
                return;
              }
              appendUsageLog({
                type: "modelFitVerdict",
                launchId,
                timestamp: Date.now(),
                model: meta.actualModel,
                verdict: result.verdict,
                reason: result.reason,
                judgeCostUsd: result.costUsd,
              });
              send({ kind: "modelFit", verdict: result.verdict, reason: result.reason });
            })
            .catch((err) => {
              console.error("[maestro] model-fit judge failed:", err);
            });
        }
      } catch (err) {
        // Purely post-run bookkeeping (usage log, notification, judge
        // kickoff) — the renderer already has its "done" event above and
        // the pane is no longer waiting on any of this, so a failure here
        // is logged, not surfaced as a broken run.
        console.error("[maestro] post-run bookkeeping failed:", err);
      }
    });
    return { ok: true, launchId };
  }
);

// --- Stop a running session ---
ipcMain.handle("session:stop", (_event, { launchId }) => {
  const child = liveChildren.get(launchId);
  if (!child) {
    return { ok: false, error: "no running process for that launch" };
  }
  killChildTree(child);
  liveChildren.delete(launchId);
  return { ok: true };
});

// --- Fas 3 Point 11: run an autonomous goal to (partial) completion in an
// isolated worktree, streaming each iteration's result to the renderer. This
// spawns REAL autonomous `claude -p` subprocesses that make real commits, so
// it is USER-TRIGGERED ONLY (invoked from a click in the Goal page) — never
// on a timer or any automatic event. It never pushes/merges/opens a PR (the
// orchestrator refuses to; there is deliberately no push affordance here).
//
// Events are sent on their own "goal:event" channel (parallel to
// "session:event"), so goal progress never collides with normal session
// streaming. Every payload carries the goalRunId so the renderer can ignore
// events from a stale/previous run.
ipcMain.handle("goal:run", async (_event, { projectPath, goal, maxIterations, model, effort, verifyCommand }) => {
  if (!projectPath || !goal) {
    return { ok: false, error: "projectPath and goal are required" };
  }
  // Hard-clamp iterations at the trust boundary, not just the UI. This spawns
  // real autonomous claude subprocesses that make real commits and spend real
  // tokens; the renderer's input max="20" is only an HTML hint (a user typing
  // 500, or any future non-UI caller, would otherwise get 500 real
  // iterations). Floor 1, ceiling 20 (review finding).
  const GOAL_ITERATION_CEILING = 20;
  const requestedMax = parseInt(maxIterations, 10);
  const clampedMax = Number.isFinite(requestedMax)
    ? Math.min(Math.max(1, requestedMax), GOAL_ITERATION_CEILING)
    : undefined; // undefined -> runGoal's own default
  const goalRunId = crypto.randomUUID();
  const cancelToken = { cancelled: false };
  liveGoalRuns.set(goalRunId, { cancelToken });

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("goal:event", { goalRunId, ...payload });
    }
  };

  send({ kind: "started", goal, maxIterations: clampedMax || null });

  // Fire-and-return: the handler resolves immediately with the goalRunId so
  // the renderer can wire up its Cancel button, while the run itself proceeds
  // and streams progress over goal:event. Errors are reported over the same
  // channel, never left to reject an already-resolved invoke.
  runGoal({
    projectPath,
    goal,
    maxIterations: clampedMax,
    model: model || undefined,
    effort: effort || undefined,
    // Optional independent build/test verification gate (Point 11
    // hardening) - a plain shell command string, e.g. "npm test". Passed
    // straight through; runGoal treats an empty/missing value as "no gate"
    // (unchanged pre-existing behavior).
    verifyCommand: verifyCommand || undefined,
    cancelToken,
    onIteration: (record) => send({ kind: "iteration", record }),
  })
    .then((result) => {
      send({ kind: "done", result });
    })
    .catch((err) => {
      send({ kind: "error", error: err?.message || String(err) });
    })
    .finally(() => {
      liveGoalRuns.delete(goalRunId);
    });

  return { ok: true, goalRunId };
});

// --- Cancel an in-flight goal run: flip its cancelToken so the orchestrator
// stops at the next iteration boundary (an in-flight iteration always runs to
// its own completion or timeout — there is no mid-iteration kill). ---
ipcMain.handle("goal:cancel", (_event, { goalRunId }) => {
  const run = liveGoalRuns.get(goalRunId);
  if (!run) {
    return { ok: false, error: "no running goal for that id" };
  }
  run.cancelToken.cancelled = true;
  return { ok: true };
});

function truncateForNotification(text) {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > 100 ? oneLine.slice(0, 100) + "…" : oneLine;
}

// Fas 3 orchestrator-helper: a periodic, stateless sweep that reads recent
// content to classify sessions today's purely time/role-based status
// heuristic can't tell apart (see PLAN.md Phase 3, DECISIONS.md 2026-07-03).
// Off by default (config.orchestratorHelper.enabled); extends this existing
// process rather than adding a new triggering mechanism, same reasoning as
// the model-fit judge.
const ORCHESTRATOR_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// Cost/time safety valve — with many eligible sessions, classifying all of
// them every sweep at ~$0.015 each would add up; caps a single sweep's
// spend and wall-clock time. The rest simply wait for the next sweep.
const MAX_CLASSIFICATIONS_PER_SWEEP = 15;
// Auto-compact is far more expensive per call than classification (~13s +
// real token cost each, and it MUTATES the session) — cap it much tighter.
// The rest wait for the next sweep; nothing is lost, a large session stays
// large one more cycle.
const MAX_COMPACTIONS_PER_SWEEP = 3;
// How many NEW judged+suggested runs must accumulate since the last check
// before the sweep re-computes the suggestion-accuracy verdict. This is a
// data-volume trigger, not a wall-clock one (e.g. "weekly") — Aidin's usage
// is bursty (some nights many runs, some days none), so a fixed calendar
// interval would either fire on stale/unchanged data or sit silent through
// a heavy stretch. The check itself is nearly free (readUsageSummary parses
// the local usage-log.jsonl already read for the on-demand report; no model
// call), so the real cost this trigger controls isn't compute — it's how
// often Aidin gets re-nagged about a finding he already saw. 10 new judged
// runs is enough to meaningfully move the followed/overridden appropriate-
// rate (each run is a full data point in a typically low-N comparison)
// without re-surfacing on every single prompt.
const SUGGESTION_ACCURACY_CHECK_EVERY_N_RUNS = 10;
// setInterval doesn't know whether the PREVIOUS sweep is still running — up
// to MAX_CLASSIFICATIONS_PER_SWEEP sequential calls, each with its own 30s
// timeout backstop, stay comfortably under one interval in the stated worst
// case (15 * 30s = 7.5min < 15min), but that's a coincidental margin, not an
// enforced one (a slow/hung `claude` spawn, slow disk I/O, etc. could push
// a sweep past 15min). Without this guard, a second sweep starting while
// the first is still in flight would double the concurrent `claude`
// spawns and spend with no lock (caught in review before shipping).
let sweepInFlight = false;

async function runOrchestratorSweep() {
  if (sweepInFlight) {
    return;
  }
  const config = loadConfig();
  const classifyOn = config.orchestratorHelper?.enabled === true;
  const compactOn = config.autoCompact?.enabled === true;
  const accuracyCheckOn = config.suggestionAccuracyCheck?.enabled === true;
  if (!classifyOn && !compactOn && !accuracyCheckOn) {
    return;
  }
  sweepInFlight = true;
  try {
    await runOrchestratorSweepBody(config, { classifyOn, compactOn, accuracyCheckOn });
  } finally {
    sweepInFlight = false;
  }
}

async function runOrchestratorSweepBody(config, { classifyOn, compactOn, accuracyCheckOn }) {
  const attentionWindowMs = (config.attentionWindowHours || 24) * 60 * 60 * 1000;
  const { sessions } = readAllSessions({ attentionWindowMs });
  // "active" sessions have work genuinely in flight — never touch them.
  // Archived sessions are done by definition. Classification looks at both
  // "waiting" and "idle"; compaction is restricted to "idle" ONLY (below) —
  // "waiting" means the assistant spoke recently (within the attention
  // window), which is the one status that could still be a session actively
  // streaming a turn run OUTSIDE Maestro, and compacting a live session
  // would be a real problem. "idle" (aged past the window) is safely parked,
  // and matches Aidin's "aktiv men idle" framing for what to auto-compact.
  const candidates = sessions.filter((s) => !s.isArchived && (s.status === "waiting" || s.status === "idle"));

  if (classifyOn) {
    // Jot data is only used by the classifier's per-session summary — enrich
    // only when actually classifying (the compaction pass never reads it).
    const jotIndex = loadJot(config.jot || {});
    enrichWithJot(candidates, jotIndex, config.jot?.weights || {});
    // Skip re-spending on a session that hasn't changed since it was last
    // classified — classifiedAtActivity mirrors the ack mechanism's own
    // staleness check (config.acknowledgedSessions), just for this map.
    const toClassify = candidates.filter((s) => {
      const prior = sessionClassifications.get(s.sessionId);
      return !prior || prior.classifiedAtActivity !== s.lastActivityAt;
    });
    for (const session of toClassify.slice(0, MAX_CLASSIFICATIONS_PER_SWEEP)) {
      // Minimal, explicit projection — see formatJotSummaryForClassifier's own
      // doc comment for why this is a category name + counts, never raw todo
      // text/descriptions.
      const jotSummary = formatJotSummaryForClassifier(session.jot);
      let result;
      try {
        result = await classifySessionStatus({
          cwd: session.cwd,
          cliSessionId: session.cliSessionId,
          sessionId: session.sessionId,
          title: session.title,
          jotSummary,
        });
      } catch (err) {
        console.error("[maestro] orchestrator helper classification failed:", err);
        continue;
      }
      if (!result) {
        continue;
      }
      sessionClassifications.set(session.sessionId, { ...result, classifiedAtActivity: session.lastActivityAt });
      appendUsageLog({
        type: "orchestratorClassification",
        sessionId: session.sessionId,
        timestamp: Date.now(),
        statusTag: result.statusTag,
        reason: result.reason,
        classifierCostUsd: result.costUsd,
      });
    }
  }

  if (compactOn) {
    const threshold = config.autoCompact?.thresholdTokens || 150000;
    const idleMs = (config.autoCompact?.idleMinutes || 30) * 60 * 1000;
    const now = Date.now();
    // Time-since-last-activity gate (Aidin's refinement) rather than the
    // coarse waiting/idle status: don't compact a session being actively
    // worked, but do tidy one left silent past idleMinutes (e.g. over
    // lunch) even if it's technically still "waiting". This also makes the
    // earlier "could it be mid-turn outside Maestro?" worry moot — 30+ min
    // of transcript silence means it definitely isn't. `candidates` already
    // excludes "active".
    const compactCandidates = candidates.filter((s) => now - s.lastActivityAt >= idleMs);
    // Only sessions not already compacted at this same activity level, and
    // whose estimated context is over the threshold. The estimate is cheap
    // (a transcript tail read, no model call), so it's fine to check every
    // candidate; the expensive /compact only fires for those over the line.
    const toCompact = [];
    for (const session of compactCandidates) {
      // Skip a session already compacted whose transcript hasn't grown since
      // (no real activity to warrant re-compacting). This — not the token
      // estimate — is the reliable guard, because a /compact-only run writes
      // no fresh low-token usage block, so the estimate would still read the
      // stale pre-compaction number and re-fire endlessly otherwise.
      const prior = sessionCompactions.get(session.sessionId);
      if (prior) {
        const currentSize = getTranscriptSize(session.cliSessionId, session.sessionId);
        if (currentSize !== null && currentSize <= prior.compactedTranscriptSize) {
          continue;
        }
      }
      const tokens = estimateSessionContextTokens(session.cliSessionId, session.sessionId);
      if (tokens !== null && tokens > threshold) {
        toCompact.push({ session, tokens });
      }
    }
    for (const { session, tokens } of toCompact.slice(0, MAX_COMPACTIONS_PER_SWEEP)) {
      let result;
      try {
        result = await compactSession({
          cwd: session.cwd,
          cliSessionId: session.cliSessionId,
          sessionId: session.sessionId,
        });
      } catch (err) {
        console.error("[maestro] auto-compact failed:", err);
        continue;
      }
      if (!result || !result.ok) {
        continue;
      }
      // Sample the transcript size AFTER compaction (its own append already
      // included) — any later growth is real new activity, which re-enables
      // compaction and clears the row note.
      sessionCompactions.set(session.sessionId, {
        preTokens: result.preTokens ?? tokens,
        postTokens: result.postTokens ?? null,
        compactedTranscriptSize: getTranscriptSize(session.cliSessionId, session.sessionId) ?? 0,
      });
      appendUsageLog({
        type: "orchestratorAutoCompact",
        sessionId: session.sessionId,
        timestamp: Date.now(),
        preTokens: result.preTokens ?? tokens,
        postTokens: result.postTokens ?? null,
      });
    }
  }

  if (accuracyCheckOn) {
    runSuggestionAccuracyCheck(config);
  }
}

// Fas 3's proactive model/effort suggestion-accuracy review (PLAN.md Phase
// 3 — "infogas i Fas 3:s orkestrator-helper istället för en egen separat
// loop", 2026-07-02). Deliberately reuses computeSuggestionAccuracyVerdict
// (usage.js) — the SAME metric the on-demand "Suggestion accuracy" report on
// the Analysis page already computes — rather than inventing a new one; this
// only changes WHEN the check happens (piggybacking on the existing sweep),
// never what's being measured. No model call, no network, just parsing the
// local usage-log.jsonl already read for the on-demand report — cheap enough
// to check every sweep, gated below on data volume rather than time so it
// doesn't re-nag on unchanged data.
function runSuggestionAccuracyCheck(config) {
  const summary = readUsageSummary();
  const verdict = computeSuggestionAccuracyVerdict(summary);
  if (!verdict) {
    return;
  }
  const totalNow = verdict.followedTotal + verdict.overriddenTotal;
  const checkState = config.suggestionAccuracyCheck || {};
  const totalAtLastCheck = (checkState.lastCheckedFollowedTotal || 0) + (checkState.lastCheckedOverriddenTotal || 0);
  if (totalNow - totalAtLastCheck < SUGGESTION_ACCURACY_CHECK_EVERY_N_RUNS) {
    return;
  }
  const next = { ...config };
  next.suggestionAccuracyCheck = {
    ...checkState,
    lastCheckedFollowedTotal: verdict.followedTotal,
    lastCheckedOverriddenTotal: verdict.overriddenTotal,
  };
  // Only surface a notice when the heuristic looks meaningfully OFF
  // (overriding did better than following — the "suggested Sonnet but Opus
  // was used successfully" style signal) — a positive/neutral diff just
  // confirms the heuristic is fine and isn't worth interrupting Aidin about.
  // A fresh finding always REPLACES a prior dismissed one (new data volume
  // means a genuinely new read, not the same stale nag), but only when the
  // verdict is actually still negative — this can also CLEAR a previously
  // surfaced notice if enough new data flipped the verdict positive.
  if (verdict.diffPoints < 0) {
    next.suggestionAccuracyNotice = {
      message: verdict.message,
      diffPoints: verdict.diffPoints,
      totalAtCheck: totalNow,
      dismissed: false,
    };
  } else {
    next.suggestionAccuracyNotice = null;
  }
  writeConfig(next);
}

// Stale-build indicator: how often to re-check the on-disk git HEAD against
// the identity captured at boot. Cheap (a single `git rev-parse`, no model
// call, no network) so a fairly tight interval is fine — 45s means a restart
// prompt shows up soon after a pull/edit without polling so often it shows
// up in any profiling. Runs off the hot path: it's its own timer, entirely
// decoupled from session polling / IPC traffic.
const STALE_BUILD_CHECK_INTERVAL_MS = 45 * 1000;

function runStaleBuildCheck() {
  // No .git to read (e.g. a packaged build) — checkForNewerBuild always
  // reports stale:false in that case, so this naturally becomes a no-op
  // that just keeps latestBuildStatus's version string current.
  const result = checkForNewerBuild(runningBuildIdentity);
  const next = {
    stale: result.stale,
    runningVersion: runningBuildIdentity.version,
    runningCommit: runningBuildIdentity.commit,
    currentVersion: result.current.version,
  };
  const changed = next.stale !== latestBuildStatus.stale || next.currentVersion !== latestBuildStatus.currentVersion;
  latestBuildStatus = next;
  // Only push when something actually changed — avoids spamming the
  // renderer with an identical payload every 45s for the entire session.
  if (changed && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("build:staleUpdate", latestBuildStatus);
  }
}

app.whenReady().then(() => {
  prunePastedImages();
  createWindow();
  setInterval(runOrchestratorSweep, ORCHESTRATOR_SWEEP_INTERVAL_MS);
  setInterval(runStaleBuildCheck, STALE_BUILD_CHECK_INTERVAL_MS);
});

// Without this, quitting Maestro while any prompt is still running leaves
// its claude.exe process tree orphaned — same underlying issue as Stop
// (see killChildTree above), just triggered by app exit instead of a click.
app.on("before-quit", () => {
  // Synchronous kills here: this handler does not (and cannot easily) await,
  // so an async taskkill would race the app's own teardown and often lose,
  // orphaning the very process tree this sweep exists to clean up.
  for (const child of liveChildren.values()) {
    killChildTree(child, { sync: true });
  }
  liveChildren.clear();
  // Same orphan-prevention concern as liveChildren above, but for any
  // whisper-stream.exe still holding the microphone (continuous voice mode
  // left active when the app quits). SDL2's audio capture does not get
  // released just because the parent Electron process exits.
  for (const child of liveVoiceStreams.values()) {
    stopWhisperStream(child, { sync: true });
  }
  liveVoiceStreams.clear();
  // Electron tears down utilityProcess children on quit regardless, but
  // killing it explicitly avoids depending on that ordering and matches the
  // liveChildren cleanup right above.
  if (voiceWorker) {
    voiceWorker.kill();
    voiceWorker = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
