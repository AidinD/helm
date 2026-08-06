// Must be the very first import: it redirects every store lib's HELM_*_PATH
// env-var seam to Electron's writable userData dir when packaged, and has to
// run before any of those libs (imported below, some transitively - e.g.
// sessions.js imports config.js) evaluate their own path constant. See
// lib/packagedPaths.js for the full rationale.
import "./lib/packagedPaths.js";
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, utilityProcess } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAllSessions, enrichWithJot, setSessionArchived, forkTranscriptAtUserMessage, switchSessionRootFolder } from "./lib/sessions.js";
import { loadJot, loadGoals, addSubtask, formatJotSummaryForClassifier, projectBoardSummary, reviewTasks, signedOffWithoutRecord, setTaskStatus, setTaskTags, readJotState, ensureTagsExist } from "./lib/jot.js";
import { loadConfig, writeConfig } from "./lib/config.js";
import { startSession } from "./lib/launcher.js";
import { createLiveSessionRegistry } from "./lib/liveSessions.js";
import { sessionLifecycleState, applyStatusOverrides, sessionStateSource } from "./lib/sessionState.js";
import { createJotHostStore } from "./lib/jotHostStore.js";
import { registerJotIpc } from "./lib/jotIpcBridge.js";
import { continueOnMobile } from "./lib/remoteControl.js";
import { suggestModelEffort } from "./lib/suggest.js";
import { readTranscript } from "./lib/transcript.js";
import { liveSubAgents } from "./lib/subAgents.js";
import { invalidateTranscriptIndex, findTranscriptPath, projectsRoot, encodeProjectDir } from "./lib/paths.js";
import { listSkills, skillMdPath } from "./lib/skills.js";
import { appendUsageLog, readUsageSummary, computeSuggestionAccuracyVerdict } from "./lib/usage.js";
import { judgeModelFit } from "./lib/judge.js";
import {
  listScheduledPrompts,
  pendingScheduledPrompts,
  scheduledPromptAdd,
  cancelScheduledPrompt,
  dueScheduledPrompts,
  pushScheduledPrompt,
  markScheduledPromptFired,
  markScheduledPromptOutcome,
  failedScheduledPrompts,
  acknowledgeScheduledPrompt,
  pruneScheduledPrompts,
  quotaResetFireAt,
} from "./lib/scheduledPrompts.js";
import { buildReviewQueue, listReviewRecords, reviewQueueTally, readReviewRecord, recordCheckRun, gauntletStatus, currentHead, codeChangedBetween } from "./lib/reviewRecords.js";
import { resolveTaskCommits, diffForCommits } from "./lib/reviewDiff.js";
import { recommendReviewer, diffStats, REVIEWER_MODELS } from "./lib/reviewerModel.js";
import { listHandoffCategories, writeHandoff, readHandoff, planHandoffFiling, handoffPath } from "./lib/handoffStore.js";
import { classifySessionStatus, classifyHandoffCategory, expectsUserInputHeuristic, estimateSessionContextTokens, compactSession, getTranscriptSize, triageAutoTask } from "./lib/orchestratorHelper.js";
import { savePastedImage, prunePastedImages } from "./lib/images.js";
import { computeVersionString, captureRunningBuildIdentity, checkForNewerBuild } from "./lib/version.js";
import { runGoal } from "./lib/goalOrchestrator.js";
import { loadGoalRunHistory, upsertGoalRunRecord, removeGoalRunRecord } from "./lib/goalRunHistory.js";
import {
  removeWorktree,
  isBranchMerged,
  deleteBranch,
  listWorktrees,
  listLocalBranches,
  hasUncommittedWork,
  pruneWorktrees,
  primaryBranch,
} from "./lib/worktree.js";
import { planSweep, describeSweep, reconcileSweepReport } from "./lib/worktreeSweep.js";
import { docsStaleness, staleProjectsAsync, docsNudgeCandidates, DOCS_NUDGE_ACTIVE_DAYS } from "./lib/docsStaleness.js";
import { loadDomains, registerDomain, removeDomain } from "./lib/domains.js";
import { ensureMates, activeMates, findMateById, loadMates, renameMate, retireAndRespawn, bindMateSession, consumeMateHandoff, setMatePersona, rethemeMateNames, retireMateSlot, clampMateSlots, MATE_SLOT_COUNT, MATE_SLOT_MAX } from "./lib/mates.js";

// How many first mates the captain wants. Two by default; configurable since
// 2026-08-02 (task 4bf2421c) because the fleet was hard-capped at two.
// The count must never be BELOW how many mates actually exist. ensureMates only
// ever adds, so mates.json can hold more than config says - and if config is reset
// or unparseable it falls back to the default of two while four mates are visibly
// on the board. Reading the floor from config alone then refused to dismiss any of
// them ("Helm keeps at least one first mate") with three still on screen.
const configuredMateSlots = () => {
  const wanted = clampMateSlots(loadConfig().firstMateSlots ?? MATE_SLOT_COUNT);
  return clampMateSlots(Math.max(wanted, activeMates().length));
};
import { personaOverlay, personaAgents, PERSONAS } from "./lib/personas.js";
import { listSlashItems } from "./lib/slashCommands.js";
import { trackHelmUsage, summarizeHelmUsage } from "./lib/helmUsage.js";
import { mcpAllowedToolsFromConfig } from "./lib/userMcp.js";
import { initAutoUpdate } from "./lib/autoUpdate.js";
import { deriveSecondMates, bindSecondMateSession, renameSecondMate, readBindings, proposeSecondMate, markSecondMateCreated, secondMateIdForSession, secondMateId, removeSecondMates } from "./lib/secondMates.js";
import {
  AUTO_WIDTH_CAP,
  AUTO_CAPTAIN_TAGS,
  AUTO_RUNNING_TAG,
  NEEDS_CLARIFICATION_TAG,
  TRIAGE_SYSTEM_PROMPT,
  TRIAGE_PROMPT_VERSION,
  buildTriageInput,
  clarificationNote,
  planAutoTick,
  resolveTaskProject,
  selectStrandedAutoCards,
  staleTriageEntries,
  taskFingerprint,
} from "./lib/autoCaptain.js";
import { secondMateAppendPrompt } from "./lib/secondMatePrompt.js";
import { addSpend, isOverBudget, isKilled, setKilled, resetBudget, readBudget, setCeiling } from "./lib/orchestrationBudget.js";
import { parseAnsi, newAnsiState, collapseCarriageReturns } from "./lib/ansi.js";
import {
  ensureDispatchDirs,
  requestsDir,
  readRequests,
  claimRequest,
  removeRequest,
  writeAck,
  writeReport,
  readReports,
  writeFleetState,
} from "./lib/dispatchQueue.js";
import { recordsNeedingReport, buildReportFromRecord } from "./lib/dispatchReconcile.js";
import { assembleFleetState } from "./lib/fleetState.js";
import { widthCapExceeded, depthCapExceeded, isForeignDispatch } from "./lib/dispatchCaps.js";
import { listRoutines, createRoutine, updateRoutine, removeRoutine, dueRoutines, markRoutineFired } from "./lib/helmRoutines.js";
import { buildArtifactSrcdoc, formatAnnotationsAsPrompt } from "./lib/lavishSdk.js";
import { isAvailable as whisperStreamAvailable, startStream as startWhisperStream, stopStream as stopWhisperStream } from "./lib/whisperStream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let latestQuota = null;
// When latestQuota actually arrived. Kept beside it because the refresh payload
// used to report `Date.now()` whenever a reading existed in memory, so the age of
// the newest reading was always "just now" from the first rate-limit event of the
// launch onwards - a timestamp that cannot say anything but "fresh". Every surface
// deciding how much to trust a number was reading that.
let latestQuotaAt = null;
// Accumulated last-known reading PER rate-limit window (bc6786c7 follow-up: show
// the quota like the Claude desktop app's usage panel - 5-hour, weekly-all,
// weekly-per-model all at once). The CLI's rate_limit_event only reports ONE
// binding window per event, so a single latestQuota can never show them side by
// side. We instead remember the most recent reading for each rateLimitType and
// let the renderer stack them, each carrying its own "as of" freshness (so a
// stale window greys out independently - the bc6786c7 rule, per window).
// Keyed by rateLimitType (e.g. "five_hour", "seven_day_opus"); value { info, at }.
const quotaWindows = new Map();
// Seed the accumulator from persisted state at startup so the panel is populated
// on a fresh launch before any turn has produced a live event. Migrates a
// pre-accumulation single reading (config.lastQuota) into the by-window map.
function seedQuotaWindows() {
  try {
    const cfg = loadConfig();
    if (cfg.quotaWindows && typeof cfg.quotaWindows === "object") {
      for (const [type, entry] of Object.entries(cfg.quotaWindows)) {
        if (entry && entry.info) {
          quotaWindows.set(type, { info: entry.info, at: typeof entry.at === "number" ? entry.at : null });
        }
      }
    } else if (cfg.lastQuota) {
      quotaWindows.set(cfg.lastQuota.rateLimitType || "unknown", { info: cfg.lastQuota, at: cfg.lastQuotaAt || null });
    }
    if (cfg.lastQuota && !latestQuota) {
      latestQuota = cfg.lastQuota;
    }
  } catch {
    // best-effort seeding - a live event will still populate the map
  }
}
// A plain array snapshot of the accumulated windows for the renderer.
function quotaWindowsSnapshot() {
  const out = [];
  for (const entry of quotaWindows.values()) {
    out.push({ info: entry.info, at: entry.at });
  }
  return out;
}
// Records the latest quota reading AND persists it, so the Dashboard quota chip
// (and the usage panel) can show a last-known value immediately - even on a fresh
// launch with no active turn yet, which is exactly when it was invisible before
// (6ed0b09e "kan inte se den": latestQuota was null until some turn produced a
// rate_limit_event). Also upserts the by-window accumulator (see quotaWindows).
// Best-effort persistence; never lets a write failure throw.
function recordQuota(q) {
  if (!q) {
    return;
  }
  latestQuota = q;
  const at = Date.now();
  latestQuotaAt = at;
  quotaWindows.set(q.rateLimitType || "unknown", { info: q, at });
  try {
    const cfg = loadConfig();
    const windows = {};
    for (const [type, entry] of quotaWindows.entries()) {
      windows[type] = { info: entry.info, at: entry.at };
    }
    writeConfig({ ...cfg, lastQuota: q, lastQuotaAt: at, quotaWindows: windows });
  } catch {
    // persistence is best-effort - the in-memory value still drives this session
  }
}
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
// goalRunId -> { cancelToken, currentChild }. The orchestrator checks
// cancelToken.cancelled BETWEEN iterations, so "goal:cancel" flips the flag
// (the loop stops at its next boundary) AND — via currentChild — kills the
// iteration/verify child process tree that is running RIGHT NOW, so an
// in-flight iteration (up to ITERATION_TIMEOUT_MS) doesn't keep going after
// cancel. currentChild is the single child the run currently has spawned
// (iterations/verify never overlap within one run); the orchestrator reports
// each freshly-spawned child via runGoal's onChild callback and this map
// entry always holds the latest. before-quit sweeps these too, so quitting
// mid-goal-run doesn't orphan the goal's claude.exe/verify trees the same way
// liveChildren covers normal sessions. In-memory only: a goal run is
// inherently tied to the app being open, and a run's real durable output is
// the worktree/branch/commits it leaves on disk, not this transient handle.
const liveGoalRuns = new Map();
// Per-session turn lock (Phase-2 Slice 4, review's #1 hazard): the set of
// session ids that currently have a turn in flight. Two `claude -p --resume
// <same id>` running at once interleave and corrupt the transcript, so a second
// turn on an already-busy session is REFUSED - this is what keeps a first-mate
// relay and a direct pane turn from driving one second-mate session at once.
// A fresh session (no resume id) is never locked (it has no prior transcript to
// race). Released when the turn's `done` resolves (close or error).
const sessionTurnLocks = new Set();
// Authoritative "a turn is running RIGHT NOW" registry (task 5939df: sessions
// showed "idle" while genuinely working). Unlike sessionTurnLocks (resume-only,
// for transcript-race prevention) this covers EVERY launch path, fresh included.
// See src/lib/liveSessions.js for why the file heuristic can't see a live turn.
const liveSessions = createLiveSessionRegistry();
const markSessionLive = (id) => liveSessions.markLive(id);
const markSessionDone = (id) => liveSessions.markDone(id);

// Embedded Jot tab (one Jot, two mounts): the @jot/core host store + the
// webview's webContents (set on did-attach-webview). Created lazily the first
// time the Jot tab mounts, then kept alive for the app's lifetime.
let jotHost = null;
let jotHostUnregister = null;
let jotWebviewWebContents = null;
// First-mate tier caps (docs/first-mate-tier-design.md sections 3 + 5),
// enforced at the app - the single dispatch authority - never trusting the
// caller. WIDTH: at most this many CONCURRENT dispatched runs per mate (design
// decision 3 = 3). DEPTH: 2 - a dispatched run (non-null dispatchedBy) may not
// itself dispatch, so the chain is mate -> second-mate run and no deeper. The
// depth cap is ALSO structural (only first mates get the dispatch MCP tools),
// this is the belt-and-suspenders app-side check.
const DISPATCH_WIDTH_CAP = 3;
const DISPATCH_DEPTH_CAP = 2;
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
// after Helm itself quits. `taskkill /T` recurses through the whole tree.
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
        console.error(`[helm] taskkill failed for pid ${child.pid}:`, err.message);
      }
    });
    return;
  }
  child.kill();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // Match Jot's startup size so the two apps open at the same footprint
    // (the captain's ask). Min sizes mirror Jot's too.
    width: 1960,
    height: 988,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#1a1a1a",
    title: "Helm",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the embedded Jot tab's <webview> (loads Jot's built renderer).
      webviewTag: true,
    },
  });
  // Track the embedded Jot webview's webContents so the Jot IPC bridge can push
  // state:changed to it (one Jot, two mounts - Epic f3d096fa / auto-captain design).
  mainWindow.webContents.on("did-attach-webview", (_e, wc) => {
    jotWebviewWebContents = wc;
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
    // One place applies the two status overrides (Epic f3d096fa): the manual-ack
    // downgrade (a "waiting" session the user marked done stays idle ONLY while
    // the ack is still current - newer lastActivityAt means new activity, so the
    // ack is stale and it needs attention again) and the authoritative live-turn
    // override (a session Helm is running a turn for RIGHT NOW is working, over a
    // decayed transcript heuristic - the "idle while working" fix, task 5939df).
    // Runs BEFORE enrichWithJot because its scoring reads session.status.
    applyStatusOverrides(session, {
      isLive: liveSessions.isLive(session.cliSessionId) || liveSessions.isLive(session.sessionId),
      isAcked: acknowledged[session.sessionId] >= session.lastActivityAt,
    });
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
    // lifecycleState (Epic f3d096fa): the single "what is this doing" field,
    // projected from status + orchestratorTag now that both are resolved. isAcked
    // is passed so a content-driven needs-you promotion (an age-decayed open
    // question, 4cd7d592) is still suppressed for a session the user acked.
    // isLaunching is only ever true for a Helm-OWNED session (it is the launch
    // itself that proves it), which is what makes `launching` a TRACKED state
    // rather than another guess layered on the heuristic.
    const launchingNow =
      session.helmOwned && (liveSessions.isLaunching(session.cliSessionId) || liveSessions.isLaunching(session.sessionId));
    session.lifecycleState = sessionLifecycleState(session, {
      isAcked: acknowledged[session.sessionId] >= session.lastActivityAt,
      isLaunching: launchingNow,
    });
    // Whether that state is tracked or merely derived - the design's hybrid
    // caveat, exposed instead of assumed (Epic f3d096fa).
    session.stateSource = sessionStateSource(session, {
      isLive: liveSessions.isLive(session.cliSessionId) || liveSessions.isLive(session.sessionId),
      isLaunching: launchingNow,
    });
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
    // Fall back to the persisted last-known quota so the Dashboard chip shows a
    // value even before this launch has run a turn (6ed0b09e).
    quota: latestQuota || config.lastQuota || null,
    quotaAt: latestQuota ? latestQuotaAt : config.lastQuotaAt || null,
    // Accumulated per-window readings for the usage panel (bc6786c7): each { info, at }.
    quotaWindows: quotaWindowsSnapshot(),
    generatedAt: Date.now(),
  };
});

// --- Config: grouping, sorting, view mode, persisted to config.json ---
// EVERY setting in the app goes through here, and the renderer does
// `state.config = await window.helm.setConfig(patch)` in ~40 places. So this one
// must never reject: a throw here would take out whichever click handler was
// mid-flight, silently, and none of those 40 call sites check for it.
//
// On failure the UNCHANGED config comes back, which is the truth - the setting did
// not persist - and a `config:writeFailed` event tells the user why. Returning the
// patched-but-unsaved config instead would show the setting as applied and then
// lose it on the next restart, which is the worse of the two lies.
ipcMain.handle("config:set", (_event, patch) => {
  const current = loadConfig();
  try {
    const next = { ...current, ...patch };
    writeConfig(next);
    return next;
  } catch (err) {
    const message = err?.message || String(err);
    console.error("[helm] could not persist a setting:", message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("config:writeFailed", { message });
    }
    return current;
  }
});

// --- Away-from-desk attention delivery: an OS notification (only while the
// window isn't focused, so it doesn't nag while the captain is already looking at
// it) plus a best-effort taskbar badge count. Renderer always calls; this is
// where the focus/config gate actually lives. ---
ipcMain.handle("attention:notify", (_event, { title, body } = {}) => {
  const notifyConfig = loadConfig().notifyAttention;
  if (notifyConfig === false) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) {
    return;
  }
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
});

ipcMain.handle("attention:setCount", (_event, n) => {
  // app.setBadgeCount has partial platform support (Windows in particular);
  // never let a badge-count failure take down the app.
  try {
    app.setBadgeCount(Number(n) || 0);
  } catch {
    // best-effort only
  }
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

// --- Fleet retire nudge, trigger layer 3: per-project Jot board summary so a
// mate's "work wrapped" nudge can strengthen (boards clear) or dampen (an
// urgent task still queued) based on the projects its second mates work. ---
ipcMain.handle("jot:boardSummary", (_event, { projectPaths }) => {
  const config = loadConfig();
  return { ok: true, summary: projectBoardSummary(projectPaths || [], config.jot || {}) };
});

// --- Goal breakdown: add a subtask under an existing top-level goal, written
// back to todos.json via the safe atomic-write path (re-read fresh, append one
// todo, temp file + rename — see addSubtask in jot.js). The one Jot WRITE
// Helm performs; only ever in response to an explicit user action. ---
ipcMain.handle("jot:addSubtask", (_event, { parentId, text }) => {
  const config = loadConfig();
  return addSubtask(config.jot || {}, parentId, text);
});

// --- Skills available to a pane, split global vs project-specific ---
// The organised tree the global skills link into. ~/.claude/skills is flat, but its
// entries point into <meta-home>/skills-catalog, which IS categorised - so Analysis
// groups them by where they point (the captain: "jag tänkte på hur de är strukturerade i
// skills-catalog"). Resolved here because the meta-home is main's to know; skills.js
// takes it as a parameter and works without one.
// `projectRoots` comes from the renderer because the renderer is what knows which
// projects have sessions. Project skills are reported per project rather than for the
// focused pane: Analysis is a page you reach by LEAVING the pane, so a pane-scoped
// panel there could not be read (the captain, 2026-08-05).
ipcMain.handle("skills:list", (_event, { projectRoots } = {}) =>
  listSkills({ catalogDir: path.join(resolveMetaHome(), "skills-catalog"), projectRoots })
);

// --- Slash-invokable items (skills + custom commands) for the composer menu.
// Both scopes; project overrides global. Excludes built-in TUI commands (they
// don't run through `claude -p`). ---
ipcMain.handle("slash:list", (_event, cwd) => {
  try {
    return { ok: true, items: listSlashItems(cwd) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), items: [] };
  }
});

// --- Open a skill's SKILL.md in the OS default app (from an Analysis-page chip) ---
ipcMain.handle("skills:open", (_event, { name, origin, cwd, plugin }) => {
  const file = skillMdPath(name, origin, cwd, plugin);
  if (!file) {
    return { ok: false, error: "SKILL.md not found" };
  }
  shell.openPath(file);
  return { ok: true };
});

// --- Read a skill's SKILL.md for the in-app rendered viewer (same readable-
// HTML treatment as context docs). Path is resolved server-side via the
// guarded skillMdPath; capped like context:read. ---
ipcMain.handle("skills:read", (_event, { name, origin, cwd, plugin } = {}) => {
  const file = skillMdPath(name, origin, cwd, plugin);
  if (!file) {
    return { ok: false, error: "SKILL.md not found" };
  }
  try {
    const stat = fs.statSync(file);
    const truncated = stat.size > CONTEXT_READ_MAX_BYTES;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(stat.size, CONTEXT_READ_MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { ok: true, text: buf.toString("utf8"), name, truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// --- Copy text to clipboard (Electron's own module, not navigator.clipboard,
// to avoid relying on an untested web-permission assumption) ---
ipcMain.handle("clipboard:write", (_event, text) => {
  clipboard.writeText(text || "");
  return { ok: true };
});

// --- Resolve ~/.claude/CLAUDE.md's own @import line to find the real,
// canonical Dropbox-synced file. Previous behavior deliberately opened the
// thin stub itself and made the captain follow the @import line manually - he's
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

// --- Open the FOLDER containing the captain's real, canonical global CLAUDE.md
// (resolved via the stub's @import line - see resolveCanonicalGlobalClaudeMd)
// in Explorer, with the file itself selected. A folder rather than the bare
// file per the captain's ask: that folder also holds DECISIONS.md/PLAN.md-shaped
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

// --- Context files that shape a session: the CLAUDE.md(s) that auto-load and
// the auto-memory files for this cwd. Surfaced in the Analysis view so "what
// context is actually in the room" is visible (directly serves the 2026-07-08
// session-renewal work: the always-loaded surface is where load-bearing
// knowledge belongs). Memory lives under ~/.claude/projects/<encoded-cwd>/memory
// - the same encoding the CLI uses (encodeProjectDir), so it's per-project. ---
function memoryDirFor(cwd) {
  return cwd ? path.join(projectsRoot, encodeProjectDir(cwd), "memory") : null;
}

ipcMain.handle("context:list", (_event, cwd) => {
  const out = { claudeMd: [], projectDocs: [], memory: { dir: null, exists: false, files: [] } };
  const g = resolveCanonicalGlobalClaudeMd();
  out.claudeMd.push({ kind: "globalClaude", label: "Global CLAUDE.md (canonical)", path: g.ok ? g.file : null, exists: g.ok });
  if (cwd) {
    const pj = path.join(cwd, "CLAUDE.md");
    out.claudeMd.push({ kind: "projectClaude", label: "Project CLAUDE.md", path: pj, exists: fs.existsSync(pj) });
    // The durable project docs that do NOT auto-load (unlike CLAUDE.md) - the
    // "etc" of the request, and what a carried-over session must be pointed at.
    // HANDOFF.md FIRST: it's the latest session's current-state summary (small,
    // overwritten each handoff - see context:saveHandoff), so a fresh session
    // reads it before diving into DECISIONS.md's full rationale history.
    // At the meta-home root a HANDOFF.md is not the continuity file - the topic
    // handoffs listed just below are (a session with no repo of its own writes
    // there instead). Listing "HANDOFF.md (none)" next to four real topic
    // handoffs claimed the opposite, which is half of task 2ba0d277.
    const docNames = isMetaHomeRoot(cwd) ? ["DECISIONS.md", "PLAN.md"] : ["HANDOFF.md", "DECISIONS.md", "PLAN.md"];
    for (const name of docNames) {
      const p = path.join(cwd, name);
      out.projectDocs.push({ kind: "projectDoc", name, path: p, exists: fs.existsSync(p) });
    }
  }
  // Non-rooted sessions (no repo, or rooted at the meta-home) have no project
  // docs; their continuity lives in the topic-keyed handoff store instead, so
  // surface those so a fresh session on the same subject can actually find the
  // last one (task 663ab4b6 - previously a non-rooted handoff had nowhere to go
  // and nothing to read back).
  if (!cwd || isMetaHomeRoot(cwd)) {
    const metaHome = resolveMetaHome();
    for (const slug of listHandoffCategories(metaHome)) {
      out.projectDocs.push({
        kind: "handoffTopic",
        name: `${slug}.md`,
        topic: slug,
        path: path.join(metaHome, ".helm", "handoffs", `${slug}.md`),
        exists: true,
      });
    }
  }
  const memDir = memoryDirFor(cwd);
  out.memory.dir = memDir;
  if (memDir && fs.existsSync(memDir)) {
    out.memory.exists = true;
    try {
      const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
      // MEMORY.md (the always-loaded index) first, then the rest alphabetically.
      files.sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)));
      out.memory.files = files.map((name) => ({ name }));
    } catch {
      // best-effort listing
    }
  }
  return out;
});

// --- Resolve a context-file reference to an absolute path, server-side. The
// path is recomputed from a (kind[, name]) reference rather than trusting a
// renderer-supplied absolute path; a memory `name` is guarded to a bare .md
// filename so it can't escape the memory dir. Shared by context:open (reveal)
// and context:read (render), so both enforce the exact same guards. ---
function resolveContextFile({ cwd, kind, name } = {}) {
  if (kind === "globalClaude") {
    const g = resolveCanonicalGlobalClaudeMd();
    return g.ok ? { ok: true, file: g.file } : g;
  }
  if (kind === "projectClaude") {
    if (!cwd) {
      return { ok: false, error: "No project folder for this session" };
    }
    const file = path.join(cwd, "CLAUDE.md");
    return fs.existsSync(file) ? { ok: true, file } : { ok: false, error: "No CLAUDE.md in " + cwd };
  }
  if (kind === "memory") {
    if (!cwd || !name || name.includes("/") || name.includes("\\") || !name.endsWith(".md")) {
      return { ok: false, error: "Invalid memory file" };
    }
    const file = path.join(memoryDirFor(cwd), name);
    return fs.existsSync(file) ? { ok: true, file } : { ok: false, error: "Memory file not found" };
  }
  if (kind === "handoffTopic") {
    // Topic handoffs live in Helm's own store, not in a session cwd. The slug is
    // re-derived by the store (slugifyCategory), so a crafted name can't escape
    // the handoffs directory.
    const metaHome = resolveMetaHome();
    const slug = String(name || "").replace(/\.md$/, "");
    // handoffPath re-slugs, so the path here can never diverge from the one the
    // store actually writes (an ad-hoc strip here would mismatch on case).
    const file = handoffPath(metaHome, slug);
    if (!file || readHandoff(metaHome, slug) === null) {
      return { ok: false, error: "Handoff topic not found" };
    }
    return { ok: true, file };
  }
  if (kind === "projectDoc") {
    // Guarded to the known durable-doc names in the session's own cwd.
    if (!cwd || (name !== "HANDOFF.md" && name !== "DECISIONS.md" && name !== "PLAN.md")) {
      return { ok: false, error: "Invalid project doc" };
    }
    const file = path.join(cwd, name);
    return fs.existsSync(file) ? { ok: true, file } : { ok: false, error: name + " not found" };
  }
  return { ok: false, error: "Unknown context kind" };
}

// --- Reveal a context file in Explorer. ---
ipcMain.handle("context:open", (_event, ref = {}) => {
  const r = resolveContextFile(ref);
  if (!r.ok) {
    return r;
  }
  shell.showItemInFolder(r.file);
  return { ok: true };
});

// --- Read a context file's raw markdown for the in-app rendered viewer (task
// "md filer presenterade som html-sidor för bättre readability"). Rendering to
// HTML happens in the renderer; main only hands back trusted text from a
// guarded path. Capped so a pathological file can't wedge the IPC/renderer. ---
const CONTEXT_READ_MAX_BYTES = 1024 * 1024;
ipcMain.handle("context:read", (_event, ref = {}) => {
  const r = resolveContextFile(ref);
  if (!r.ok) {
    return r;
  }
  try {
    const stat = fs.statSync(r.file);
    const truncated = stat.size > CONTEXT_READ_MAX_BYTES;
    const fd = fs.openSync(r.file, "r");
    try {
      const buf = Buffer.alloc(Math.min(stat.size, CONTEXT_READ_MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { ok: true, text: buf.toString("utf8"), name: path.basename(r.file), truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// --- One-click "capture on the go": append a dated note to the session's own
// project DECISIONS.md (where carry-over already points a fresh session). The
// producer side of faithful transfer - capture a decision/gotcha the MOMENT it
// happens instead of reconstructing at handoff (see DECISIONS.md
// "Session-renewal strategy"). Append-only + atomic (temp+rename); creates the
// file with a "# Decisions" header if absent; prepends after the existing H1
// (newest-first, matching this repo's DECISIONS.md) so it can't clobber curated
// content. Labeled "Capture:" so it's honestly a raw on-the-go note, promotable
// into a polished entry later. ---
ipcMain.handle("context:capture", (_event, { cwd, text } = {}) => {
  if (!cwd || !text || !text.trim()) {
    return { ok: false, error: "Nothing to capture" };
  }
  const note = text.trim();
  const file = path.join(cwd, "DECISIONS.md");
  const date = new Date().toISOString().slice(0, 10);
  const title = note.split("\n")[0].slice(0, 60);
  const entry = `## ${date} - Capture: ${title}\n\n${note}\n\n`;
  try {
    let existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    let updated;
    if (/^#\s+/.test(existing)) {
      // Insert after the existing top-level H1 (any title), keeping it first.
      const nl = existing.indexOf("\n");
      const head = nl === -1 ? existing + "\n" : existing.slice(0, nl + 1);
      const rest = (nl === -1 ? "" : existing.slice(nl + 1)).replace(/^\n+/, "");
      updated = head + "\n" + entry + rest;
    } else {
      updated = "# Decisions\n\n" + entry + existing;
    }
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(tmp, updated, "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Save a session HANDOFF to the project's HANDOFF.md - the "current state /
// where things stand + what's next" continuity note a fresh session reads first.
// Unlike context:capture (which APPENDS a durable decision to DECISIONS.md),
// this OVERWRITES: a handoff is latest-only, superseded by the next one, so it
// must never grow the file (the old DECISIONS-append pattern bloated DECISIONS.md
// with transient session narrative - the captain 2026-07-14). Git history keeps prior
// handoffs. Atomic temp+rename. Durable rationale still goes to DECISIONS.md; a
// handoff should distill any genuinely new decision INTO DECISIONS.md separately. ---
ipcMain.handle("context:saveHandoff", async (_event, { cwd, text, title, category } = {}) => {
  if (!text || !text.trim()) {
    return { ok: false, error: "Nothing to save" };
  }
  // A session with NO project folder (a non-rooted second mate - training,
  // kombucha, job hunting) has no HANDOFF.md to write, and meta-home-rooted
  // ones would all fight over ONE shared file. File those by TOPIC instead
  // (task 663ab4b6). Everything with a real repo keeps the repo-local file.
  if (!cwd || isMetaHomeRoot(cwd)) {
    const metaHome = resolveMetaHome();
    const existing = listHandoffCategories(metaHome);
    let proposed = category || null;
    let classifierError = null;
    if (!proposed) {
      // Classify against the topics already on file - match-first, so related
      // sessions keep landing in the same readable document.
      const verdict = await classifyHandoffCategory({ cwd: metaHome, title, text, existingCategories: existing });
      proposed = verdict?.category || null;
      classifierError = proposed ? null : verdict?.error || "The topic classifier did not answer.";
    }
    // No topic and topics already exist -> ASK, never invent (planHandoffFiling
    // holds the rule and the reasoning). The caller re-sends the same text with an
    // explicit `category`, so nothing is lost by refusing here.
    const resolved = planHandoffFiling({ proposed, existing, title });
    if (resolved.needsCategory) {
      return { ok: false, topicKeyed: true, ...resolved, error: classifierError };
    }
    const written = writeHandoff(metaHome, resolved.category, text, { title });
    if (!written.ok) {
      return written;
    }
    return { ...written, category: resolved.category, isNew: resolved.isNew, topicKeyed: true };
  }
  const file = path.join(cwd, "HANDOFF.md");
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  const body =
    `# Handoff - latest session state\n\n` +
    `_Overwritten on each handoff (latest-only); prior handoffs are in git history._\n` +
    `_Saved ${date}. For durable rationale see DECISIONS.md; for the roadmap, PLAN.md._\n\n` +
    text.trim() +
    "\n";
  try {
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(tmp, body, "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Archive/unarchive a session. Always a direct response to an explicit
// click in the renderer (manual "Archive", or approving an orchestrator-
// proposed suggestion) — never called on a timer or any other unattended
// trigger.
//
// Authoritative store is Helm's OWN `config.archivedSessions` on D:\, applied
// as an overlay in readAllSessions. This is the fix for "archive keeps coming
// back": a Desktop session's local_*.json is owned by the (MSIX-packaged)
// Claude app, which rewrites that file and drops the isArchived flag Helm had
// written into it - so writing there could never hold. The overlay can't be
// reverted by another app. We still mirror the flag into whichever store the
// session lives in (best-effort) so views stay consistent, but the overlay is
// what actually holds the line. ---
/**
 * Both id forms a session can be keyed under, given either one.
 *
 * A Desktop session carries a `local_<uuid>` sessionId AND a separate
 * cliSessionId, and different surfaces key on different ones - the Fleet node is
 * built from whichever the session object exposes. Anything that has to CLEAR a
 * stored id therefore has to clear both, or it silently misses.
 */
function sessionIdForms(sessionId) {
  const forms = new Set([sessionId]);
  try {
    for (const s of readAllSessions().sessions || []) {
      if (s.sessionId === sessionId || s.cliSessionId === sessionId) {
        if (s.sessionId) {
          forms.add(s.sessionId);
        }
        if (s.cliSessionId) {
          forms.add(s.cliSessionId);
        }
      }
    }
  } catch {
    // A failed scan must not stop the archive change itself.
  }
  return [...forms].filter(Boolean);
}

// Returns { ok } - and never throws. The session:archive handler is a one-line
// delegation to this, so a throw here crossed the channel as a rejected promise:
// `await window.helm.archiveSession(...)` threw inside an async click handler, the
// `if (!res.ok)` branch never ran, and archiving a session while config.json was
// locked did nothing at all with no message. Found by the pre-release review.
function applySessionArchive(sessionId, archived) {
  try {
    return applySessionArchiveInner(sessionId, archived);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function applySessionArchiveInner(sessionId, archived) {
  const shouldArchive = archived !== false;
  const cfg = loadConfig();
  const set = new Set(cfg.archivedSessions || []);
  if (shouldArchive) {
    set.add(sessionId);
  } else {
    set.delete(sessionId);
  }
  const nextCfg = { ...cfg, archivedSessions: [...set] };
  // Un-archiving must clear the FLEET's separate overlay too, or the session comes
  // back in the sidebar and stays invisible in Fleet/Captain (the captain, 2026-07-28:
  // "jag tog unarchive på träning och kost och den syns inte i captain ändå").
  //
  // There are two independent archive lists: `archivedSessions` for the session
  // itself, and `archivedSecondMates` for its node in the Fleet view, keyed
  // "sess_<id>" (renderer.js builds it from whichever id form the session carries).
  // Archiving from the Fleet button writes the second list; un-archiving the session
  // only ever cleared the first. A one-way overlay - the mirror image of the bug the
  // overlay was introduced to fix.
  //
  // Both id forms are removed because the node is built from cliSessionId OR
  // sessionId depending on the session, and guessing wrong leaves it hidden.
  if (!shouldArchive) {
    const smSet = new Set(cfg.archivedSecondMates || []);
    const before = smSet.size;
    for (const id of sessionIdForms(sessionId)) {
      smSet.delete(`sess_${id}`);
    }
    if (smSet.size !== before) {
      nextCfg.archivedSecondMates = [...smSet];
    }
  }
  // Mirror into the Helm-owned session index if this is a Helm-created session
  // (no Desktop file to patch), and persist the overlay in the same write.
  if (cfg.helmSessions && cfg.helmSessions[sessionId]) {
    const map = { ...cfg.helmSessions };
    map[sessionId] = { ...map[sessionId], isArchived: shouldArchive };
    nextCfg.helmSessions = map;
    writeConfig(nextCfg);
    return { ok: true };
  }
  writeConfig(nextCfg);
  // Best-effort mirror into the Desktop file too; if the Claude app later
  // reverts it, the overlay above still keeps the session archived in Helm.
  const mirror = setSessionArchived(sessionId, shouldArchive);
  return { ok: true, desktopMirror: mirror.ok };
}
ipcMain.handle("session:archive", (_event, { sessionId, archived }) => applySessionArchive(sessionId, archived));

// Archive second mates by id: hide them from the Fleet for good. Adds each id to
// a config overlay (archivedSecondMates) that the renderer excludes, AND drops the
// binding. The overlay is what makes it stick even for a CREW-derived node: the
// binding removal alone wouldn't, because deriveSecondMates re-derives the node
// from goal-run history every refresh - so "archive" appeared to do nothing
// (bug 05166d55). Crew runs themselves are untouched (they stay on the Autopilot
// page); this only removes the second-mate NODE from the fleet tree.
function archiveSecondMateIds(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) {
    return;
  }
  const cfg = loadConfig();
  const set = new Set(cfg.archivedSecondMates || []);
  for (const id of list) {
    set.add(id);
  }
  writeConfig({ ...cfg, archivedSecondMates: [...set] });
  removeSecondMates(list);
}

/**
 * Un-park a fleet node because new work is being sent to it.
 *
 * Archiving a node means "I am done looking at this". Dispatching work to it says
 * the opposite, and the two were never connected: the auto-captain re-proposes the
 * project's second mate on every dispatch, but the archive overlay outlived that, so
 * once a project's row had been archived EVERY later auto run for that project was
 * invisible. Permanently, and in silence - the run still happened, still cost money,
 * still edited the repo.
 *
 * That is what a full day of "the widget is empty" turned out to be (2026-08-03).
 * Helm's own project node had been archived while cleaning up after a test run, and
 * from then on nothing auto did in this repo could appear anywhere.
 */
function unarchiveSecondMateForNewWork(id) {
  if (!id) {
    return;
  }
  try {
    const cfg = loadConfig();
    const list = cfg.archivedSecondMates || [];
    if (!list.includes(id)) {
      return;
    }
    writeConfig({ ...cfg, archivedSecondMates: list.filter((x) => x !== id) });
    console.log(`[helm] un-archived fleet node ${id} - new work was dispatched to it`);
  } catch (err) {
    // Non-fatal: the work still runs. It would just be invisible, which is the
    // whole bug, so it is worth a loud line.
    console.error("[helm] could not un-archive a fleet node being dispatched to:", err?.message || err);
  }
}
/**
 * Drop fleet-node parkings that can no longer mean anything.
 *
 * The overlay `archivedSecondMates` hides a node from the Fleet. For a SESSION node
 * ("sess_<id>") its only purpose is to keep an archived session's node hidden - so a
 * parked node whose session is alive and NOT archived is a leftover, and a harmful
 * one: the session shows in the needs-you queue and is invisible in Captain, with no
 * control anywhere that can un-park it.
 *
 * the captain hit exactly that. His "Träning och kost (Hevy)" node was parked before
 * un-archive learned to clear it (fix 3fa55c2), so the fix helps future archives and
 * did nothing for the entry already on disk. It sat there for days while the session
 * was plainly live two panels away.
 *
 * The same shape as the docs-drift "parked with no un-park" bug: a state the UI can
 * create and cannot reverse. Rather than a repair button nobody would find, this runs
 * at startup and heals it. Real second mates ("sm_<id>") are left alone - they are
 * not session-backed and their parking is a deliberate, separate decision.
 */
function pruneStaleArchivedFleetNodes() {
  try {
    const cfg = loadConfig();
    const parked = cfg.archivedSecondMates || [];
    if (parked.length === 0) {
      return { ok: true, removed: [] };
    }
    const all = readAllSessions();
    // A session counts as "alive" only if we can see it AND it is not archived.
    // An id we cannot find at all is left parked: absence is not evidence that the
    // session is live, and un-parking on a failed read would resurrect nodes.
    const live = new Set();
    for (const s of all.sessions || []) {
      if (s.isArchived) {
        continue;
      }
      for (const id of sessionIdForms(s.sessionId)) {
        live.add(`sess_${id}`);
      }
      if (s.cliSessionId) {
        live.add(`sess_${s.cliSessionId}`);
      }
    }
    const removed = parked.filter((id) => typeof id === "string" && id.startsWith("sess_") && live.has(id));
    if (removed.length === 0) {
      return { ok: true, removed: [] };
    }
    writeConfig({ ...cfg, archivedSecondMates: parked.filter((id) => !removed.includes(id)) });
    console.log(`[helm] un-parked ${removed.length} fleet node(s) whose session is not archived:`, removed.join(", "));
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), removed: [] };
  }
}

ipcMain.handle("secondMates:pruneStaleArchived", () => pruneStaleArchivedFleetNodes());

ipcMain.handle("secondMates:archive", (_event, { id }) => {
  try {
    archiveSecondMateIds([id]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Retire teardown (task 58e9a433): when a first mate is retired, tear down its
// second-mate subtree so nothing lingers referencing a now-dead parent id.
// the captain's intent for retire = "I'm done with this whole track", so we archive
// each second mate's interactive session and drop its binding (proposed/created).
// Crew autopilot runs in goal-run history are intentionally NOT killed - they
// stay on the Autopilot page; force-stopping in-flight work would lose it.
// Returns { count, sessionIds } so the caller can reflect it locally.
function tearDownSecondMatesFor(mateId) {
  try {
    const subMates = deriveSecondMates(loadGoalRunHistory()).filter((s) => s.firstMateId === mateId);
    const sessionIds = [];
    for (const sm of subMates) {
      if (sm.sessionId) {
        try {
          applySessionArchive(sm.sessionId, true);
          sessionIds.push(sm.sessionId);
        } catch (err) {
          console.error("[helm] failed to archive second-mate session on retire:", err);
        }
      }
    }
    // Add to the archived-second-mates overlay (not just removeSecondMates): a
    // crew-derived child re-derives from goal-run history, so only the overlay
    // keeps it out of the Fleet after retire (same fix as the archive button).
    archiveSecondMateIds(subMates.map((s) => s.secondMateId));
    return { count: subMates.length, sessionIds };
  } catch (err) {
    console.error("[helm] tearDownSecondMatesFor failed:", err);
    return { count: 0, sessionIds: [] };
  }
}

// "Continue on mobile": open a real terminal running an interactive Remote
// Control session for this conversation, so it can be driven from the Claude
// mobile app / claude.ai/code. See lib/remoteControl.js for why this needs a
// terminal (RC requires a TTY; Helm's headless launcher can't host it).
ipcMain.handle("session:continueOnMobile", (_event, { cwd, cliSessionId, title }) => {
  try {
    return continueOnMobile({ cwd, cliSessionId, title });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
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
// ~10-20x faster than the original path on the captain's RTX 3070 (see
// docs/transcription-research.md); "transformers" (src/lib/voice.js) is the
// original @huggingface/transformers ONNX pipeline, kept as a fallback for
// machines without the .whisper/ binary+model installed. See voice.js for
// why transformers.js was originally picked over the OS speech API /
// whisper.cpp Node bindings / OpenSuperWhisper.
//
// Both backends' inference runs in a dedicated utility process (see
// src/lib/voiceWorker.js), NOT here on the main process. The captain's feedback
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
    console.error(`[helm] voice worker exited unexpectedly (code ${code})`);
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
    console.error("[helm] voice transcription failed:", err);
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

// --- Helm's OWN usage analytics (which views/paths the captain takes; distinct from
// the model/cost usage above). Content-free, local. track appends an event;
// helmSummary aggregates. ---
ipcMain.handle("usage:track", (_event, event) => {
  trackHelmUsage({ ...(event || {}), at: Date.now() });
  return { ok: true };
});
ipcMain.handle("usage:helmSummary", () => summarizeHelmUsage());

// --- App version, same scheme as Skiff/Jot: major.minor (hand-bumped in
// package.json) + a commit count since that bump, so the last number resets
// to 0 on every version bump instead of growing forever. ---
ipcMain.handle("app:version", () => computeVersionString());

// True for an unpackaged dev run (npm start), false for the installed build.
// The renderer uses this to badge the dev window UNMISTAKABLY - dev and the
// installed daily driver read different data dirs (repo root vs ~/.helm), so
// their fleet/sessions legitimately differ; the badge is what keeps you from
// mistaking one window for the other (the captain 2026-07-11: deliberately separate,
// clearly marked).
ipcMain.handle("app:isDev", () => !app.isPackaged);

// --- Orchestrator info: the paths needed to start a fresh orchestrator
// session from the Dashboard (PLAN.md's orchestrator-lifespan redesign).
// There is no privileged, always-present orchestrator session anymore — this
// just hands the renderer a cwd for a fresh orchestrator session plus the path
// to its operating manual. The cwd is the Claude "meta home" — the dir holding
// the canonical CLAUDE.md AND the auto-memory (feedback/project rules). This
// matters: auto-memory is cwd-KEYED, so an empty neutral dir (an earlier
// attempt used ~/.helm) would start the orchestrator with NO memory at all —
// none of the accumulated behavioral rules. The meta home is still above every
// code project (not Helm, not a work repo), so it stays a coordinator root,
// not a place code work lands. Derived from the ~/.claude/CLAUDE.md @import line
// so it tracks wherever the canonical rules live; falls back to the home dir if
// that can't be resolved. instructionsPath is absolute so the session reads the
// manual regardless. Read-only, no session-of-its-own state.
// Resolves the Claude "meta home" - the dir holding the canonical CLAUDE.md
// (and the auto-memory), derived from the ~/.claude/CLAUDE.md @import line, or
// the home dir if that can't be resolved. This is BOTH the cwd a fresh
// orchestrator (first-mate) session is rooted in AND the root under which the
// first-mate dispatch queue (.helm-dispatch/) lives. Extracted so
// orchestrator:info and the first-mate launch detection / dispatch watcher all
// agree on the exact same path (a first mate is, by definition, a session
// rooted here).
function resolveMetaHome() {
  // Test seam: HELM_META_HOME_OVERRIDE lets an E2E point the dispatch queue
  // (and first-mate detection) at an isolated temp dir, so a test dispatch is
  // never raced/consumed by a separately-running dev instance watching the real
  // meta-home. Honored ONLY in dev (never a packaged build), so a stray env var
  // can't silently relocate the queue in production (review finding L5).
  if (process.env.HELM_META_HOME_OVERRIDE && !app.isPackaged) {
    return process.env.HELM_META_HOME_OVERRIDE;
  }
  try {
    const stub = fs.readFileSync(path.join(os.homedir(), ".claude", "CLAUDE.md"), "utf8");
    const importMatch = stub.match(/^@(.+?CLAUDE\.md)\s*$/m);
    if (importMatch) {
      const metaHome = path.dirname(importMatch[1].trim());
      if (fs.existsSync(metaHome)) {
        return metaHome;
      }
    }
  } catch {
    // fall through to the home dir
  }
  return os.homedir();
}

// True when a session cwd is the meta home, i.e. this launch is a FIRST MATE
// (the one launch that gets the dispatch MCP tools; a dispatched second-mate
// run is rooted in a project worktree, not here, so it never matches - the
// structural depth cap, design section 5). Path compare is normalized the same
// way isOwnWorktreeRoot / mates.js do (resolve, strip trailing sep, lowercase
// for Windows case-insensitivity).
function isMetaHomeRoot(cwd) {
  if (!cwd) {
    return false;
  }
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(cwd) === norm(resolveMetaHome());
}

ipcMain.handle("orchestrator:info", () => {
  return {
    ok: true,
    cwd: resolveMetaHome(),
    instructionsPath: path.join(__dirname, "lib", "orchestrator-instructions.md"),
  };
});

// First-mate tier: the validated project enum a mate may dispatch to (design
// decision 5). Seeded from the registered life-domain folders PLUS the distinct
// git-repo cwds seen across recent sessions - the projects the captain actually works
// in. A mate may also dispatch to an explicit absolute repo path (the escape
// hatch), validated at accept time in the dispatch watcher, not listed here.
function knownProjects() {
  const byPath = new Map();
  for (const d of loadDomains()) {
    if (d?.path) {
      byPath.set(path.resolve(d.path).toLowerCase(), { name: d.name || path.basename(d.path), path: path.resolve(d.path) });
    }
  }
  try {
    const config = loadConfig();
    const attentionWindowMs = (config.attentionWindowHours || 24) * 60 * 60 * 1000;
    const { sessions } = readAllSessions({ attentionWindowMs });
    for (const s of sessions || []) {
      if (!s.cwd) {
        continue;
      }
      const key = path.resolve(s.cwd).toLowerCase();
      if (!byPath.has(key)) {
        byPath.set(key, { name: path.basename(s.cwd), path: path.resolve(s.cwd) });
      }
    }
  } catch {
    // sessions read is best-effort - domains alone still make a usable enum
  }
  return [...byPath.values()];
}

// Resolves a dispatch request's `project` (a known-project NAME or an explicit
// absolute PATH) to an absolute projectPath, or null if it neither matches a
// known project nor is an explicit existing absolute path. Name match is
// case-insensitive; the escape hatch requires an absolute path that exists on
// disk (runGoal itself then enforces it is a git work tree).
function resolveDispatchProject(project) {
  if (!project) {
    return null;
  }
  const projects = knownProjects();
  const byName = projects.find((p) => p.name.toLowerCase() === project.toLowerCase());
  if (byName) {
    return byName.path;
  }
  const byPath = projects.find((p) => p.path.toLowerCase() === path.resolve(project).toLowerCase());
  if (byPath) {
    return byPath.path;
  }
  // Escape hatch: an explicit absolute path that exists.
  if (path.isAbsolute(project) && fs.existsSync(project)) {
    return path.resolve(project);
  }
  return null;
}

// Builds the inline --mcp-config JSON string for a FIRST-MATE launch: names the
// stdio dispatch server (src/mcp/helmDispatchServer.js) and injects the
// meta home, the resolved mateId, the known-project enum, and the width cap via
// env. Generated per-launch (not a static helm-mcp.json on disk) precisely
// because these values are launch-specific - the design allows "or generate at
// launch". Returned as a string passed straight to startSession's mcpConfig,
// exactly the inline-JSON form judge.js already uses for --mcp-config.
// The MCP server name + the three dispatch tools, as one source of truth so
// the mcp-config key and the --allowedTools list can't drift. Claude Code names
// an MCP tool `mcp__<server>__<tool>`. A headless first-mate `-p` session is
// PRE-APPROVED for exactly these first-party tools via --allowedTools, because
// it has no live channel to answer a permission prompt (verified: without this,
// a real first-mate session replies "TOOL-BLOCKED" and never dispatches - review M3).
const FIRST_MATE_MCP_SERVER = "helm-dispatch";
const FIRST_MATE_ALLOWED_TOOLS = ["helm_dispatch", "helm_collect_reports", "helm_list_projects", "helm_fleet_state", "helm_report_up", "helm_create_second_mate", "helm_relay_to_second_mate", "helm_resume_fleet"].map(
  (t) => `mcp__${FIRST_MATE_MCP_SERVER}__${t}`
);

// First-mate tier guard (tier-discipline, task ad17e2e6): a first mate must not
// do hands-on project work or fan out its own workers - it dispatches via the
// helm_* tools above. Denying Edit/Write/NotebookEdit makes file mutation
// structurally impossible (the dinghy runaway did 23 Edits in the coordinator
// seat); denying Task removes the sub-agent fan-out multiplier. Read/Grep/Glob/
// Bash stay so it can still survey (git state, Jot, file reads). The rare
// legitimate write (a Jot status tick) can still go via Bash.
const FIRST_MATE_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit", "Task"];

// The user's OWN configured MCP servers, as `mcp__<key>` allowedTools entries,
// so a second-mate session can actually USE them in headless -p (see
// lib/userMcp.js for the full why - bug 1f8b54be). Read once + cached; a config
// change is picked up on the next Helm restart.
let _userMcpAllowedTools = null;
function userMcpAllowedTools() {
  if (!_userMcpAllowedTools) {
    _userMcpAllowedTools = mcpAllowedToolsFromConfig(path.join(os.homedir(), ".claude.json"));
  }
  return _userMcpAllowedTools;
}

// The first-mate operating manual, attached as system context on a fresh
// first-mate turn (see session:start). Read once and cached - it's a static doc.
let _firstMateInstructions = null;
function firstMateInstructions() {
  if (_firstMateInstructions === null) {
    try {
      _firstMateInstructions = fs.readFileSync(path.join(__dirname, "lib", "first-mate-instructions.md"), "utf8");
    } catch (err) {
      console.error("[helm] could not read first-mate-instructions.md:", err);
      _firstMateInstructions = "";
    }
  }
  return _firstMateInstructions || undefined;
}

// The second-mate operating manual, attached on a fresh second-mate turn (see
// session:start). The judgment tier: own a project, dispatch crew, validate +
// merge their work, report up, externalize before retire. Cached (static doc).
let _secondMateInstructions = null;
function secondMateInstructions() {
  if (_secondMateInstructions === null) {
    try {
      _secondMateInstructions = fs.readFileSync(path.join(__dirname, "lib", "second-mate-instructions.md"), "utf8");
    } catch (err) {
      console.error("[helm] could not read second-mate-instructions.md:", err);
      _secondMateInstructions = "";
    }
  }
  return _secondMateInstructions || undefined;
}

// The dispatch MCP config shared by both tiers that can dispatch: a first mate
// (callerTier "first-mate", callerId = its mateId) and, in Phase 2, a second
// mate (callerTier "second-mate", callerId = its secondMateId). The MCP server
// stamps every request it writes with this callerId (as dispatchedBy) + tier, so
// the watcher's ownership + depth caps route it correctly.
function buildDispatchMcpConfig(metaHome, callerId, callerTier, parentMateId = null) {
  const serverPath = path.join(__dirname, "mcp", "helmDispatchServer.js");
  const config = {
    mcpServers: {
      [FIRST_MATE_MCP_SERVER]: {
        command: process.execPath,
        args: [serverPath],
        env: {
          // Electron's own binary is process.execPath; ELECTRON_RUN_AS_NODE=1
          // makes it behave as a plain Node runtime for the spawned MCP server
          // (no BrowserWindow, no app bootstrap) so we don't depend on a
          // separate `node` being on PATH.
          ELECTRON_RUN_AS_NODE: "1",
          HELM_META_HOME: metaHome,
          HELM_MATE_ID: callerId,
          HELM_CALLER_TIER: callerTier,
          // A second mate's parent first mate, so helm_report_up can address its
          // roll-up to the first mate (dispatchedBy = this id). Empty for a first
          // mate (it's the top - it reports to the captain via the Dashboard).
          HELM_PARENT_MATE_ID: parentMateId || "",
          HELM_PROJECTS: JSON.stringify(knownProjects()),
          HELM_WIDTH_CAP: String(DISPATCH_WIDTH_CAP),
        },
      },
    },
  };
  return JSON.stringify(config);
}

function buildFirstMateMcpConfig(metaHome, mateId) {
  // Named mates: the session is bound to one of the two fixed mate slots by the
  // mateId the renderer passes. Fall back to the first active mate if none was
  // given (a direct meta-home launch that didn't pick a slot) so a first mate
  // always has a stable identity. ensureMates guarantees the two slots exist.
  const active = ensureMates(metaHome, configuredMateSlots());
  const mate = (mateId && findMateById(mateId)) || active[0];
  return buildDispatchMcpConfig(metaHome, mate.mateId, "first-mate");
}

// --- Stale-build indicator: hands back the running build's own identity plus
// the most recent periodic staleness check (see runStaleBuildCheck below).
// The renderer calls this once on startup to paint the initial state, then
// just listens on "build:staleUpdate" for changes — no polling from the
// renderer side. ---
ipcMain.handle("build:status", () => latestBuildStatus);

// --- Orchestrator sweep liveness: last-run timestamp/outcome for the
// Settings page readout (see lastSweepStatus above, updated at the end of
// every runOrchestratorSweep call). Read-only, no polling from the renderer
// side — it's fetched once when the Settings page renders. ---
ipcMain.handle("orchestrator:sweepStatus", () => lastSweepStatus);

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

// A session's live sub-agents (Claude Code Task tool calls not yet finished),
// so the Fleet can show them as crew under the session. Batched; the renderer
// only asks for sessions that are actively working (an idle session has none),
// so this stays cheap even though each call tail-reads a transcript.
ipcMain.handle("session:liveSubAgents", (_event, { sessions }) => {
  const out = {};
  for (const s of sessions || []) {
    try {
      const live = liveSubAgents(findTranscriptPath([s.cliSessionId, s.sessionId]));
      if (live.length) {
        out[s.sessionId] = live;
      }
    } catch {
      // tolerant - a missing/unreadable transcript just means no sub-agents
    }
  }
  return { ok: true, subAgents: out };
});

// Last-known context size per session, so the Fleet can show a context gauge for
// EVERY first mate, not just the one open in a pane (bug bf1ea538). Same batch
// shape as session:liveSubAgents; reuses estimateSessionContextTokens (a
// transcript tail-read), so keep the caller's list to mates that have a session.
ipcMain.handle("session:contextTokens", (_event, { sessions }) => {
  const out = {};
  for (const s of sessions || []) {
    try {
      const t = estimateSessionContextTokens(s.cliSessionId, s.sessionId);
      if (typeof t === "number") {
        out[s.sessionId] = t;
      }
    } catch {
      // tolerant - a missing/unreadable transcript just means no estimate
    }
  }
  return { ok: true, contextTokens: out };
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

// --- Non-repo "life-domain" projects (PLAN.md's non-repo project types) —
// plain folders (gym, cycling, kombucha, etc) that are first-class project
// types alongside git repos, backed by domains.js's small persisted
// registry. A session rooted in a domain's folder works exactly like a repo
// session (same session:start handler, same automatic CLAUDE.md + memory
// loading) - there is no separate "domain session" code path, only a
// different source for the cwd. ---
ipcMain.handle("domains:list", () => loadDomains());

ipcMain.handle("domains:register", (_event, { name, path: domainPath, icon }) =>
  registerDomain({ name, path: domainPath, icon })
);

ipcMain.handle("domains:remove", (_event, id) => removeDomain(id));

// --- Routines page (read-only): list Claude Code's OWN scheduled tasks from
// ~/.claude/scheduled-tasks/. Helm does not run a scheduler of its own -
// this just surfaces what already exists on disk. Async so a large or slow
// folder read never blocks the main event loop. ---
// --- Helm-owned routines: recurring claude -p launches Helm schedules + fires
// itself (helmRoutines.js). Replaces the old read-only mirror of Claude
// Desktop's private scheduler - Helm owns the format, so it can fully see +
// manage them. See fireRoutine + the scheduler in app.whenReady. ---
ipcMain.handle("routines:list", () => {
  return { ok: true, routines: listRoutines() };
});
ipcMain.handle("routines:create", (_event, spec) => {
  try {
    return { ok: true, routine: createRoutine(spec || {}) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("routines:update", (_event, { id, patch }) => {
  try {
    const r = updateRoutine(id, patch || {});
    return r ? { ok: true, routine: r } : { ok: false, error: "unknown routine" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("routines:remove", (_event, { id }) => {
  return { ok: removeRoutine(id) };
});
ipcMain.handle("routines:runNow", (_event, { id }) => {
  const routine = listRoutines().find((r) => r.id === id);
  if (!routine) {
    return { ok: false, error: "unknown routine" };
  }
  fireRoutine(routine); // does not advance the schedule - this is an ad-hoc extra run
  return { ok: true };
});

// --- Autopilot C2: a quick project-rooted claude pass that reads the repo + the
// goal and PROPOSES the crew config (a lightweight "second mate" translating
// the captain's intent), so verify/iterations aren't hand-set. Returns a config
// object; falls back to deterministic defaults if the model output can't be
// parsed. Best-effort - never throws into the renderer. ---
ipcMain.handle("autopilot:proposeConfig", async (_event, { projectPath, goal } = {}) => {
  const fallback = { verifyCommand: "", maxIterations: 5, model: "", effort: "", escalate: false, rationale: "" };
  if (!projectPath || !goal) {
    return { ok: true, config: fallback };
  }
  const prompt =
    "You are setting up an autonomous coding run (\"autopilot\") in THIS project for the goal below. " +
    "Read only as much of the repo as you need (package.json, obvious config) to decide - do NOT start doing the work. " +
    "Output ONLY a single JSON object, no prose, with keys: " +
    "verifyCommand (a shell command that verifies a change like \"npm test\" or \"npm run build\", or \"\" if none is obvious), " +
    "maxIterations (integer 1-15, sized to the goal), " +
    "model (\"claude-sonnet-5\" | \"claude-opus-4-8\" | \"\" for auto), " +
    "effort (\"low\"|\"medium\"|\"high\"|\"\"), " +
    "escalate (boolean - pause the run on repeated trouble), " +
    "rationale (one short sentence explaining the choices).\n\nGoal:\n" +
    goal;
  let text = "";
  try {
    const { done } = startSession({
      cwd: projectPath,
      prompt,
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "default",
      onEvent: (evt) => {
        if (evt.kind === "assistant" && evt.text) {
          text = evt.text;
        }
      },
    });
    await done;
  } catch (err) {
    return { ok: true, config: { ...fallback, rationale: "Proposal failed: " + (err?.message || String(err)) } };
  }
  const match = text && text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { ok: true, config: fallback };
  }
  try {
    const p = JSON.parse(match[0]);
    return {
      ok: true,
      config: {
        verifyCommand: typeof p.verifyCommand === "string" ? p.verifyCommand : "",
        maxIterations: Number.isInteger(p.maxIterations) ? Math.min(15, Math.max(1, p.maxIterations)) : 5,
        model: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"].includes(p.model) ? p.model : "",
        effort: ["low", "medium", "high", "xhigh", "max"].includes(p.effort) ? p.effort : "",
        escalate: p.escalate === true,
        rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 240) : "",
      },
    };
  } catch {
    return { ok: true, config: fallback };
  }
});

// --- Pick or create the folder for a new non-repo domain project ---
ipcMain.handle("dialog:pickDomainFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Pick (or create) the folder for this domain",
    properties: ["openDirectory", "createDirectory"],
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

// --- Named mates: the two fixed first-mate slots the Fleet shows and the
// captain jumps into. `list` returns the active pair (ordered by slot) plus all
// records (incl. retired, so a retired mate's historical runs stay named).
// `rename`/`retire` mutate; retire discards the mate and respawns a fresh one in
// the same slot with a new name. ---
ipcMain.handle("mates:list", () => {
  try {
    const metaHome = resolveMetaHome();
    return { ok: true, active: ensureMates(metaHome, configuredMateSlots()), all: loadMates() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), active: [], all: [] };
  }
});
// Add a first mate. The fleet was fixed at two slots; this raises the configured
// count by one and lets ensureMates fill it, so the new mate is a real coordinator
// with its own name, root and session - not a widget with nothing behind it.
ipcMain.handle("mates:add", () => {
  try {
    const cfg = loadConfig();
    // Count from reality, not just from config - see configuredMateSlots.
    const current = configuredMateSlots();
    if (current >= MATE_SLOT_MAX) {
      return { ok: false, error: `${MATE_SLOT_MAX} first mates is the most Helm will run at once.`, active: activeMates() };
    }
    writeConfig({ ...cfg, firstMateSlots: current + 1 });
    return { ok: true, active: ensureMates(resolveMetaHome(), current + 1) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), active: [] };
  }
});

// Remove a first mate for good (as opposed to retire, which respawns into the same
// slot). Lowers the configured count in the SAME step - retiring without lowering
// it would just have ensureMates recreate the mate on the next render, which would
// read as the app refusing to do what it was asked.
ipcMain.handle("mates:remove", (_event, { mateId } = {}) => {
  try {
    const cfg = loadConfig();
    const current = configuredMateSlots();
    if (current <= 1) {
      return { ok: false, error: "Helm keeps at least one first mate.", active: activeMates() };
    }
    const mate = mateId ? findMateById(mateId) : null;
    if (!mate || mate.status !== "active") {
      return { ok: false, error: "That first mate isn't on watch.", active: activeMates() };
    }
    // Tear down its second mates first, exactly as retiring does - otherwise their
    // nodes linger pointing at a mate id that no longer exists.
    try {
      tearDownSecondMatesFor(mate.mateId);
    } catch (err) {
      console.error("[helm] could not tear down second mates while removing a first mate:", err);
    }
    retireMateSlot(mate.slot);
    // RE-READ. `cfg` was loaded before the teardown, and tearDownSecondMatesFor
    // writes config.json twice on its way through (it archives each second mate's
    // session and adds their ids to the archived-second-mates overlay). Writing the
    // stale `cfg` back over the top erased both, so the dismissed mate's second
    // mates reappeared in the Fleet under a parent that no longer exists and their
    // sessions un-archived - exactly the orphan state the teardown exists to
    // prevent. Found by the pre-release review, reproduced with a probe.
    writeConfig({ ...loadConfig(), firstMateSlots: current - 1 });
    return { ok: true, active: ensureMates(resolveMetaHome(), current - 1) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), active: [] };
  }
});

ipcMain.handle("mates:rename", (_event, { mateId, name }) => {
  try {
    const mate = renameMate(mateId, name);
    return mate ? { ok: true, mate } : { ok: false, error: "unknown mateId" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("mates:retire", (_event, { mateId, handoff, persona, keepPersona }) => {
  try {
    // Tear down the retiring mate's second-mate subtree FIRST, while its mateId
    // is still the parent the second mates reference (task 58e9a433). Archives
    // their sessions + drops their bindings so they don't linger as hidden
    // orphans or stale proposals under a dead parent.
    const torndown = tearDownSecondMatesFor(mateId);
    // `persona` set = a deliberate persona switch: respawn into it. keepPersona = an
    // ordinary refresh, which now CARRIES the outgoing mate's persona rather than resetting
    // it - refreshing context is not a decision to change the mate's character.
    const mate = retireAndRespawn(mateId, handoff || null, persona || null, { keepPersona: !!keepPersona });
    return { ok: true, mate, tornDownSessionIds: torndown.sessionIds };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
// The persona catalog for the Fleet picker (key/label/blurb only - the overlay
// text stays server-side, injected at launch). Single source of truth is
// personas.js; the renderer can't import an ES module, so it fetches this.
ipcMain.handle("personas:list", () => PERSONAS.map(({ key, label, blurb }) => ({ key, label, blurb })));
// Re-theme active mates' names when the theme's identity family changes
// (nautical <-> space). No-op within a family (dark <-> brass).
ipcMain.handle("mates:retheme", (_event, { fromTheme, toTheme }) => {
  try {
    return { ok: true, active: rethemeMateNames(fromTheme, toTheme) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("mates:setPersona", (_event, { mateId, persona }) => {
  try {
    const mate = setMatePersona(mateId, persona || null);
    return mate ? { ok: true, mate } : { ok: false, error: "unknown mateId" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("mates:consumeHandoff", (_event, { mateId }) => {
  try {
    return { ok: true, handoff: consumeMateHandoff(mateId) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("mates:bindSession", (_event, { mateId, sessionId }) => {
  try {
    const mate = bindMateSession(mateId, sessionId);
    if (mate && sessionId) {
      // Defensive backstop for the same gap fixed on the server-side bind
      // (session:start's onEvent handler): this is the RENDERER's own bind-on-
      // session call, used when that server-side path was skipped (pane
      // reassigned before the event landed - see the comment there). Whichever
      // path runs first wins; createIfAbsent:true on BOTH means a mate-bound
      // session is never left undiscoverable just because neither path happened
      // to fire with the resume flag it needed.
      recordHelmSession(sessionId, { cwd: mate.root || "", createIfAbsent: true });
    }
    return mate ? { ok: true, mate } : { ok: false, error: "unknown mateId" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// --- Second mates: per-project sessions (the judgment tier) derived from the
// dispatched-run history - one per (first mate, project). Each owns its crew
// (the dispatched Autopilot runs). list derives them; bindSession/rename persist
// the small per-second-mate overrides. ---
ipcMain.handle("secondMates:list", () => {
  try {
    return { ok: true, secondMates: deriveSecondMates(loadGoalRunHistory()) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), secondMates: [] };
  }
});
ipcMain.handle("secondMates:bindSession", (_event, { secondMateId, sessionId }) => {
  try {
    return { ok: true, binding: bindSecondMateSession(secondMateId, sessionId) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("secondMates:rename", (_event, { secondMateId, name }) => {
  try {
    return { ok: true, binding: renameSecondMate(secondMateId, name) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
// Phase-2 Slice 1: propose a second mate for a project without spinning its
// session (lazy). The project is validated the same way a dispatch is, so a
// proposal always resolves to a real repo path.
ipcMain.handle("secondMates:propose", (_event, { firstMateId, project, brief, assignments, name }) => {
  try {
    const projectPath = resolveDispatchProject(project) || project;
    if (!projectPath) {
      return { ok: false, error: `Unknown project "${project}".` };
    }
    return { ok: true, secondMate: proposeSecondMate(firstMateId || "direct", projectPath, { brief, assignments, name }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Records a Helm-created session into config.helmSessions so readAllSessions
// can surface it (the headless `claude -p` launcher never writes a Desktop
// local_*.json - see config.js/DECISIONS). Upserts: immutable fields are set
// once (on create), lastActivityAt always bumps. `createIfAbsent:false` means
// "only bump an existing entry" - used on resume/completion so resuming a
// DESKTOP session (which Helm didn't create) never fabricates a stray entry.
function recordHelmSession(sessionId, { cwd, model, effort, permissionMode, title, startedBy, createIfAbsent } = {}) {
  // A brand-new session's transcript file has just appeared, and the transcript index is
  // cached (paths.js). Drop it here rather than relying on the TTL, so the session
  // resolves its own transcript on the very next lookup instead of looking empty for a
  // few seconds - the one case where a cache could be user-visible rather than just fast.
  invalidateTranscriptIndex();
  if (!sessionId) {
    return;
  }
  try {
    const cfg = loadConfig();
    const map = { ...(cfg.helmSessions || {}) };
    const existing = map[sessionId];
    if (!existing && !createIfAbsent) {
      return;
    }
    const now = Date.now();
    map[sessionId] = {
      sessionId,
      cliSessionId: sessionId,
      cwd: existing?.cwd ?? cwd ?? "",
      model: existing?.model ?? model ?? "",
      effort: existing?.effort ?? effort ?? "",
      permissionMode: existing?.permissionMode ?? permissionMode ?? "",
      title: existing?.title ?? title ?? "(untitled)",
      // Who started this session. "auto" marks an auto-captain run, which is what
      // puts it in the Auto column instead of among the captain's own work. Never
      // downgraded once set - a resumed auto run is still an auto run.
      startedBy: existing?.startedBy ?? startedBy ?? null,
      isArchived: existing?.isArchived ?? false,
      createdAt: existing?.createdAt ?? now,
      lastActivityAt: now,
    };
    writeConfig({ ...cfg, helmSessions: map });
  } catch (err) {
    console.error("[helm] failed to record helm session:", err);
  }
}

// --- Start (or resume) a rooted session; stream events to the renderer ---
ipcMain.handle(
  "session:start",
  (_event, { cwd, prompt, model, effort, permissionMode, resumeSessionId, suggestedModel, suggestedEffort, internal, mateId, secondMateId }) => {
    if (!cwd || !prompt) {
      return { ok: false, error: "cwd and prompt are required" };
    }
    // Per-session turn lock (Slice 4): refuse a concurrent turn on the SAME
    // resumed session (a relay vs a direct pane turn) - they'd corrupt the
    // transcript. Check + acquire atomically (this handler is sync up to spawn,
    // so two calls can't interleave here). Released in done.then below.
    if (resumeSessionId && sessionTurnLocks.has(resumeSessionId)) {
      return {
        ok: false,
        error: "That session already has a turn in flight - wait for it to finish (a relay and a direct turn can't run on one session at once).",
        busy: true,
      };
    }
    if (resumeSessionId) {
      sessionTurnLocks.add(resumeSessionId);
    }
    // A random id, not an incrementing counter — usage-log.jsonl persists
    // across app restarts but this counter wouldn't, so small reused integers
    // (1, 2, 3...) could join a verdict to the WRONG run from a different
    // Helm session (found by review, see DECISIONS.md's suggestion-
    // accuracy entry). randomUUID makes cross-restart collision practically
    // impossible instead of merely unlikely.
    const launchId = crypto.randomUUID();
    const send = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("session:event", { launchId, ...payload });
      }
    };
    const meta = { toolsUsed: [], skillsInvoked: [], costUsd: 0, numTurns: 0, durationMs: null, totalTokens: null, outputTokens: null, actualModel: model || null, lastAssistantText: "", contextWindows: {} };
    // First-mate tier (design section 5): attach the dispatch MCP tools ONLY
    // when this launch is a first mate (rooted in the meta home). A dispatched
    // second-mate run is a runGoal (never routed through here) rooted in a
    // project worktree, so it structurally never gets these tools. Best-effort:
    // a failure to build the config must not break launching a normal session.
    let mcpConfig;
    let allowedTools;
    let disallowedTools;
    let appendSystemPrompt;
    let strictMcpConfig;
    let agents;
    let effectiveSecondMateId = null;
    // A meta-home session is a FIRST MATE only when it is actually bound to one -
    // either the pane passed its mateId, or a resumed session resolves to a mate by
    // its binding. A meta-home session with NO mate (a personal chat the captain
    // keeps in /claude - training/Hevy, health/home-assistant, etc.) is NOT a first
    // mate: it must keep the user's full MCP set and get no first-mate framing.
    // Deciding by cwd ALONE stripped every meta-home chat of its MCP servers and
    // injected the first-mate manual into it (the captain: "Helm doesn't see my Hevy
    // connection" - a direct personal session rooted in /claude was classed as a
    // first mate).
    const firstMateId = mateId || (resumeSessionId ? activeMates().find((m) => m.sessionId === resumeSessionId)?.mateId || null : null);
    try {
      if (isMetaHomeRoot(cwd) && firstMateId) {
        const metaHome = resolveMetaHome();
        ensureDispatchDirs(metaHome);
        mcpConfig = buildFirstMateMcpConfig(metaHome, firstMateId);
        // Pre-approve exactly the dispatch tools so the headless first mate can
        // call them without a permission prompt it can't answer (review M3).
        allowedTools = FIRST_MATE_ALLOWED_TOOLS;
        // Tier-discipline guard (ad17e2e6): deny file mutation + sub-agent
        // fan-out so a first mate can't do hands-on project work in its own seat.
        disallowedTools = FIRST_MATE_DISALLOWED_TOOLS;
        // Load the first-mate operating manual as system context on the FRESH
        // turn only (no resume) so a newly-spun-up mate boots knowing its role,
        // with the composer left empty for the captain's first prompt. On resume
        // it's already in the session's context - don't re-append.
        if (!resumeSessionId) {
          appendSystemPrompt = firstMateInstructions();
          // Persona overlay (personas.js): a per-spawn temperament layer after
          // the base manual. Read from the mate record so it's fixed for this
          // session (a system prompt can't change mid-session). null persona =
          // plain coordinator = no overlay.
          const mate = findMateById(firstMateId);
          const overlay = personaOverlay(mate?.persona);
          if (overlay) {
            appendSystemPrompt = `${appendSystemPrompt || ""}\n\n${overlay}`;
          }
        }
        // First mates launch LEAN: only the helm_* dispatch tools above, not
        // the machine's other MCP servers (Roblox, hevy, home-assistant, Unity,
        // hibob, Atlassian, etc.) a normal chat session inherits from the
        // user's global config. A dispatched second-mate run is a separate
        // runGoal path (never this handler), so this only ever narrows a
        // first-mate launch.
        strictMcpConfig = true;
      } else if (secondMateId || (resumeSessionId && secondMateIdForSession(resumeSessionId))) {
        // Phase-2 Slice 2: a SECOND-MATE session (project-rooted) gets the crew-
        // dispatch tools too - one tier deeper than a first mate. Resolve the id
        // from the pane tag on a fresh engagement OR from the durable binding on
        // a RESUME (a resumed pane is rebuilt without the tag, so keying only on
        // the pane tag silently dropped the tools on re-entry - review CONFIRMED).
        // Unlike a first mate it is NOT strict: it keeps the user's full MCP set
        // for hands-on project work, and helm_* is ADDED on top (+ pre-approved).
        // Dispatches are stamped dispatchedBy=<this id>, callerTier "second-mate",
        // so the depth cap allows crew but crew can't re-dispatch.
        effectiveSecondMateId = secondMateId || secondMateIdForSession(resumeSessionId);
        const metaHome = resolveMetaHome();
        ensureDispatchDirs(metaHome);
        // Resolve the parent first mate from the DERIVED second mate, not the raw
        // binding: firstMateId is only ever written by proposeSecondMate (not
        // reachable in shipping UI yet), whereas deriveSecondMates derives it from
        // the run history (a crew run's dispatchedBy IS the first mate) - so this
        // is where the real parent lives (review CONFIRMED). A "direct" second mate
        // has no first mate above it (it reports to the captain via the Dashboard,
        // not up a chain), so it gets no parent -> helm_report_up stays disabled
        // for it (review PLAUSIBLE: "direct" is top-of-chain, don't dead-letter).
        const derivedSm = deriveSecondMates(loadGoalRunHistory()).find((s) => s.secondMateId === effectiveSecondMateId);
        const parentFirstMate = derivedSm?.firstMateId;
        const parentMateId = parentFirstMate && parentFirstMate !== "direct" ? parentFirstMate : null;
        mcpConfig = buildDispatchMcpConfig(metaHome, effectiveSecondMateId, "second-mate", parentMateId);
        // helm_* crew tools + the user's OWN MCP servers pre-approved, so the
        // "keeps the user's full MCP set" intent actually holds in headless -p
        // (passing --mcp-config otherwise de-auto-allows them -> they stall on an
        // unanswerable permission prompt; bug 1f8b54be). NOT strict, so the
        // servers still load; this just restores their auto-allow.
        allowedTools = [...FIRST_MATE_ALLOWED_TOOLS, ...userMcpAllowedTools()];
        // Fresh launch gets the full manual; a RESUMED turn (the dominant path for
        // jump-in/direct second mates) gets the condensed delegate-vs-do reminder,
        // so the guardrail is present on EVERY turn - not just the first (9c358433).
        appendSystemPrompt = secondMateAppendPrompt(resumeSessionId, secondMateInstructions());
        // Advisory seats (personas.js): the four persona temperaments published as
        // read-only sub-agents this second mate can consult mid-task - an Architect
        // to review a diff before reporting up, a Red team to attack a plan before
        // committing to it. Passed on EVERY turn, not just a fresh one: --agents is
        // a launch flag, so unlike the system prompt it is not carried by a resume.
        //
        // A second mate is the tier that can reach them: it has Task (a first mate
        // is denied it by the tier guard, so injecting seats there would advertise
        // something it structurally cannot call).
        agents = personaAgents();
        // NOT strict: additive to the project's full MCP set (see comment above).
      }
    } catch (err) {
      console.error("[helm] failed to build first-mate launch config:", err);
    }
    // Wrap the launch so a SYNCHRONOUS throw (e.g. the claude binary can't be
    // resolved) releases the per-session turn lock instead of wedging that
    // session as "busy" for the app's lifetime - mirrors runRelayTurn's guard
    // (ship-review: session:start was the asymmetric path that leaked the lock).
    let child;
    let done;
    // Track this launch's session id in the authoritative live-turn set so the
    // sidebar/fleet show "working", not "idle", while the turn runs (task 5939df).
    // Known upfront for a resume; learned from the session event for a fresh one.
    // Skip Helm-internal launches (e.g. the hidden retire-summarize turn) - they're
    // invisible to the captain, so they must not flash a session "active", matching
    // the other `!internal` bookkeeping below.
    let liveTurnId = null;
    if (!internal && resumeSessionId) {
      liveTurnId = resumeSessionId;
      markSessionLive(liveTurnId);
    }
    // launching (Epic f3d096fa): spawned, nothing back yet. A FRESH launch has no
    // session id in this window at all, which is exactly why the transcript
    // heuristic cannot see it - so track it by launchId and bind the id later.
    if (!internal) {
      liveSessions.markLaunching(launchId, liveTurnId);
    }
    try {
      ({ child, done } = startSession({
      cwd,
      prompt,
      model,
      effort,
      permissionMode,
      resumeSessionId,
      mcpConfig,
      allowedTools,
      disallowedTools,
      appendSystemPrompt,
      strictMcpConfig,
      agents,
      onEvent: (evt) => {
        if (evt.kind === "session" && evt.sessionId && !internal && !liveTurnId) {
          liveTurnId = evt.sessionId;
          markSessionLive(liveTurnId);
          liveSessions.bindLaunch(launchId, liveTurnId);
        }
        // First real output ends the launching window - it is working now. Without
        // this the window would last the whole turn, which is not what the state
        // means ("spawned, nothing back yet") and would make it co-extensive with
        // isLive - i.e. a pure relabel of a state already resolved correctly.
        if (!internal && (evt.kind === "assistant" || evt.kind === "tool_use" || evt.kind === "result")) {
          liveSessions.clearLaunching(launchId);
        }
        if (evt.kind === "session" && evt.sessionId && !internal) {
          // Record into Helm's own index the moment the session id appears, so
          // a session shows in Direct/Fleet while its first turn is still
          // running - not only once it completes. createIfAbsent only on a
          // FRESH launch (no resume) NORMALLY - a resumed Desktop session isn't
          // ours to index, since the Desktop app already tracks it.
          //
          // EXCEPT when this turn is bound to a first or second mate (even on
          // resume): that binding is Helm's own durable pointer to this session,
          // and the Desktop app's local_*.json index is a rolling window that can
          // age a session back out from under it - the session's transcript stays
          // on disk and the mate stays pointed at it, but Helm had no record of
          // its own and the mate silently opened blank on the next jump-in
          // ("historiken är borta", 2026-08-06 - a9e222f5 aged out of Desktop's
          // index weeks after its first turn, with nothing here to fall back on).
          // Forcing createIfAbsent here means every mate-bound session is always
          // findable through Helm's own store, independent of the Desktop app's
          // retention. Title defaults to the first prompt line (renamable via the
          // display-only titleOverrides overlay).
          const isMateBound = (isMetaHomeRoot(cwd) && !!firstMateId) || !!effectiveSecondMateId;
          recordHelmSession(evt.sessionId, {
            cwd,
            model,
            effort,
            permissionMode,
            title: prompt.trim().split("\n")[0].slice(0, 80) || "(untitled)",
            createIfAbsent: !resumeSessionId || isMateBound,
          });
          // Bind a second-mate session to its id SERVER-SIDE the moment it
          // appears, so this instance owns its crew dispatches (processDispatch's
          // ownedMateIds) immediately - not dependent on the renderer's bind-on-
          // session, which is skipped if the pane was reassigned before the event
          // (the orphaned-first-dispatch window flagged in review).
          if (effectiveSecondMateId) {
            try {
              bindSecondMateSession(effectiveSecondMateId, evt.sessionId);
            } catch (err) {
              console.error("[helm] failed to bind second-mate session:", err);
            }
          }
          // Bind a FIRST-mate session SERVER-SIDE too, for the SAME reason as the
          // second-mate bind above: the renderer's bind-on-session (renderer.js
          // "session" case) is skipped when the pane is reassigned before the
          // event lands - e.g. you type a prompt in a first mate then navigate to
          // the dashboard before it replies. The binding was then dropped, so the
          // session was never recognized as the mate's: it surfaced as a "direct"
          // 2nd mate under Captain, and a second first mate's dispatches
          // mis-attributed to the slot-0 mate (bugs 3c52cc0d + 2a5e6196 "samma fel
          // igen"). Only when this launch is a first mate (meta-home root) with an
          // explicit mateId - never a captain personal chat in the meta-home.
          if (isMetaHomeRoot(cwd) && firstMateId) {
            try {
              bindMateSession(firstMateId, evt.sessionId);
            } catch (err) {
              console.error("[helm] failed to bind first-mate session:", err);
            }
          }
        }
        if (evt.kind === "quota" && evt.quota) {
          recordQuota(evt.quota);
        } else if (evt.kind === "tool_use" && evt.toolName) {
          meta.toolsUsed.push(evt.toolName);
          // A skill the model invoked itself (Skill tool), so usage tracking
          // counts autonomous skill use, not just leading-"/skill" prompts (aa9f5238).
          if (evt.skillName) {
            meta.skillsInvoked.push(evt.skillName);
          }
        } else if (evt.kind === "assistant" && evt.text) {
          meta.lastAssistantText = evt.text;
        } else if (evt.kind === "result") {
          meta.costUsd = evt.costUsd || 0;
          meta.numTurns = evt.numTurns || 0;
          meta.durationMs = evt.durationMs ?? null;
          meta.totalTokens = evt.totalTokens ?? null;
          meta.outputTokens = evt.outputTokens ?? null;
          if (evt.contextWindows) {
            Object.assign(meta.contextWindows, evt.contextWindows);
          }
        } else if (evt.kind === "system" && evt.model) {
          meta.actualModel = evt.model;
        }
        send(evt);
      },
    }));
    } catch (err) {
      if (resumeSessionId) {
        sessionTurnLocks.delete(resumeSessionId);
      }
      markSessionDone(liveTurnId);
      liveSessions.clearLaunching(launchId);
      throw err;
    }
    liveChildren.set(launchId, child);
    // Headless -p expands a leading "/skill-name" in the prompt text before
    // running it, so a leading slash-token is a reasonable (if not perfect —
    // it's a text-pattern guess, not a real event from the CLI) proxy for
    // "which skill was invoked," which the stream itself doesn't expose.
    const skillMatch = /^\/(\S+)/.exec(prompt.trim());
    done.then((summary) => {
      liveChildren.delete(launchId);
      markSessionDone(liveTurnId);
      liveSessions.clearLaunching(launchId);
      // Release the per-session turn lock (Slice 4) now the turn is over, so the
      // next turn (pane or relay) on this session can proceed.
      if (resumeSessionId) {
        sessionTurnLocks.delete(resumeSessionId);
      }
      // Send "done" FIRST, before any of the bookkeeping below that could
      // throw (a corrupt config.json, a disk-full usage-log write, etc).
      // Previously this came after appendUsageLog — if that threw, the
      // renderer never got its "done" event and the pane stayed "running"
      // forever with no way to recover short of restarting Helm.
      // durationMs/totalTokens/costUsd ride along on the same summary object
      // so the renderer can show a "12.3s · 1.2k tokens" readout under the
      // reply that just completed, reusing the CLI's own result-event numbers
      // (already collected into `meta` for the usage log) instead of adding a
      // new plumbing path just for display.
      send({
        kind: "done",
        summary: { ...summary, durationMs: meta.durationMs, totalTokens: meta.totalTokens, outputTokens: meta.outputTokens, costUsd: meta.costUsd },
      });

      // Tier-discipline guard, layer 2 (ad17e2e6): meter a FIRST MATE's own turn
      // cost into the fleet budget. The budget/kill switch already counts
      // dispatched-run cost, but a first mate doing work in its own seat (the
      // dinghy runaway) was unmetered - so an in-tier runaway never tripped the
      // ceiling. Count it here (skip Helm-internal launches like the summarize
      // turn, which aren't captain-visible work). Best-effort; never blocks done.
      if (!internal && isMetaHomeRoot(cwd) && meta.costUsd > 0) {
        try {
          addSpend(resolveMetaHome(), meta.costUsd);
        } catch (err) {
          console.error("[helm] failed to meter first-mate spend:", err);
        }
      }

      // Smart needs-you (heuristic layer, task 4d82208a follow-up): for a FIRST
      // MATE, seed the Fas-3 classification from a cheap read of its last message,
      // so a CLEAR completion stops it showing "needs you" immediately instead of
      // flagging until the next sweep. Only a clear signal commits (SV/EN, see
      // expectsUserInputHeuristic); an ambiguous message is left for the sweep's
      // Haiku classifier and keeps flagging meanwhile - the false-positive bias
      // the captain asked for. Keyed by the same session id sessionClassifications +
      // orchestratorTag use, so the renderer's needs-you gate picks it up.
      if (!internal && isMetaHomeRoot(cwd) && firstMateId && summary?.sessionId && meta.lastAssistantText) {
        try {
          const tag = expectsUserInputHeuristic(meta.lastAssistantText);
          if (tag) {
            sessionClassifications.set(summary.sessionId, { statusTag: tag, reason: "heuristic: last message", classifiedAtActivity: Date.now() });
          }
        } catch (err) {
          console.error("[helm] expects-input heuristic failed:", err);
        }
      }

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

      // Bump the Helm session index's lastActivityAt so status (waiting/idle
      // age window) and attention sorting stay fresh across turns. Only bumps
      // an existing entry (createIfAbsent:false) - never fabricates one for a
      // resumed Desktop session.
      if (!internal && summary.sessionId) {
        recordHelmSession(summary.sessionId, { createIfAbsent: false });
      }

      // Helm-internal launches (e.g. the hidden "summarize & carry over"
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
          // Skills the model invoked on its own during the run (aa9f5238).
          skillsUsed: meta.skillsInvoked,
        });

        // Native OS notification (Windows plays its default sound with it, no
        // separate audio file needed) when a prompt finishes — lets the captain
        // switch away while a run is in progress.
        const notifyConfig = loadConfig().notifyOnComplete;
        if (notifyConfig !== false && summary.sawResult && Notification.isSupported()) {
          new Notification({
            title: "Helm — prompt finished",
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
              console.error("[helm] model-fit judge failed:", err);
            });
        }
      } catch (err) {
        // Purely post-run bookkeeping (usage log, notification, judge
        // kickoff) — the renderer already has its "done" event above and
        // the pane is no longer waiting on any of this, so a failure here
        // is logged, not surfaced as a broken run.
        console.error("[helm] post-run bookkeeping failed:", err);
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

// --- Embedded Jot tab (one Jot, two mounts) ---
// Resolve the file:// URLs the Jot <webview> needs: Jot's BUILT renderer and the
// window.jot preload. Jot is a sibling repo (D:\Repo\Tools\jot) whose renderer is
// built to out/renderer (dev). Returns ok:false with a clear reason if the build
// isn't present, so the renderer can show a helpful message instead of a blank view.
// In DEV, Jot is the sibling repo (D:\Repo\Tools\jot) built to out/renderer. In a
// PACKAGED build there is no sibling repo: __dirname is inside app.asar, so the
// old relative walk resolved to <install>/resources/jot/... and nothing put it
// there - the Jot tab was broken in the installed app while working fine in dev
// (bug 914ca869). The build now ships Jot's built renderer AND the webview
// preload as extraResources, and this resolves them under resourcesPath.
// (The preload is shipped OUTSIDE the asar deliberately: a webview preload is
// loaded by URL, which is not a path Electron's asar layer can serve.)
function jotAssetPaths() {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, "jot");
    return {
      index: path.join(base, "out", "renderer", "index.html"),
      preload: path.join(base, "jot-webview-preload.cjs"),
      packaged: true,
    };
  }
  return {
    index: path.join(__dirname, "..", "..", "jot", "out", "renderer", "index.html"),
    preload: path.join(__dirname, "jot-webview-preload.cjs"),
    packaged: false,
  };
}
ipcMain.handle("jot:paths", () => {
  const { index, preload, packaged } = jotAssetPaths();
  if (!fs.existsSync(index)) {
    // Different audiences need different advice: in dev you build the sibling
    // repo; in an installed build the bundle is missing, which is a packaging
    // problem the user cannot fix with `npm run build`.
    return {
      ok: false,
      error: packaged
        ? `This Helm build didn't ship Jot's UI (expected at ${index}). Install a newer Helm build.`
        : `Jot's built renderer isn't at ${index}. Run \`npm run build\` in the jot repo.`,
    };
  }
  if (!fs.existsSync(preload)) {
    return { ok: false, error: `Jot's webview preload is missing (expected at ${preload}).` };
  }
  return {
    ok: true,
    src: pathToFileURL(index).href,
    preload: pathToFileURL(preload).href,
  };
});

// Create the @jot/core host store (once) and wire the IPC bridge so the Jot
// webview's window.jot is answered by the shared board. Idempotent - safe to call
// each time the tab opens.
ipcMain.handle("jot:mount", async () => {
  if (jotHost) {
    return { ok: true, dataDir: jotHost.dataDir };
  }
  try {
    // Point the embedded Jot at the SAME board the user's standalone Jot uses.
    // Helm knows that authoritatively via config.jot.path (e.g. <your-jot-data-dir>\
    // todos.json); use its dir. Falls back to the portable resolver otherwise.
    const jotPathCfg = loadConfig().jot?.path;
    const dataDir = jotPathCfg && jotPathCfg.trim() ? path.dirname(jotPathCfg) : undefined;
    const host = createJotHostStore(dataDir);
    await host.store.init();
    jotHostUnregister = registerJotIpc({
      ipcMain,
      store: host.store,
      dataDir: host.dataDir,
      getTargets: () => (jotWebviewWebContents ? [jotWebviewWebContents] : []),
      // Helm already owns dialog:pickFolder (returns path|null, what Jot's UI
      // expects) - let the webview fall through to it instead of double-registering.
      skipChannels: ["dialog:pickFolder"],
    });
    jotHost = host;
    return { ok: true, dataDir: host.dataDir };
  } catch (err) {
    console.error("[helm] jot:mount failed:", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

// --- Goal page: suggest a default verify command for a project folder, so
// the Point 11 verification gate (see runGoal's verifyCommand doc comment)
// is easy to turn on. Reads package.json's "scripts" (async, off the main
// thread's sync fs path) and picks "npm test" if a "test" script exists,
// else "npm run build" if a "build" script exists, else no suggestion. Any
// failure (missing/unreadable/invalid package.json) degrades to no
// suggestion rather than throwing - this is a convenience prefill, never a
// hard requirement.
ipcMain.handle("goal:suggestVerifyCommand", async (_event, { projectPath }) => {
  if (!projectPath) {
    return { ok: true, command: "" };
  }
  try {
    const pkgPath = path.join(projectPath, "package.json");
    const raw = await fs.promises.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const scripts = pkg && typeof pkg.scripts === "object" ? pkg.scripts : {};
    if (scripts.test) {
      return { ok: true, command: "npm test" };
    }
    if (scripts.build) {
      return { ok: true, command: "npm run build" };
    }
    return { ok: true, command: "" };
  } catch {
    return { ok: true, command: "" };
  }
});

// --- Repo scripts (task 8bfae7a0) ---
// A session bound to a repo can run that repo's package.json scripts DIRECTLY -
// build, release, test - without spending a model turn on it ("för att inte
// slösa tokens om man inte vill"). This is deliberately a plain child process,
// not an agent: Helm just runs the command and streams its output back.
ipcMain.handle("repo:listScripts", async (_event, { cwd } = {}) => {
  if (!cwd) {
    return { ok: false, error: "This session has no project folder.", scripts: [] };
  }
  try {
    const raw = await fs.promises.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
    return {
      ok: true,
      name: pkg?.name || null,
      scripts: Object.entries(scripts).map(([name, command]) => ({ name, command: String(command) })),
    };
  } catch (err) {
    // No package.json is the normal case for a non-node repo, not an error worth
    // shouting about - the caller just doesn't show the control.
    return { ok: false, error: err.code === "ENOENT" ? "No package.json in this folder." : err.message, scripts: [] };
  }
});

// One script run at a time per runId, so a second click can't interleave output.
const liveScriptRuns = new Map(); // runId -> child

ipcMain.handle("repo:runScript", (_event, { cwd, script, runId } = {}) => {
  if (!cwd || !script || !runId) {
    return { ok: false, error: "Missing cwd, script or runId." };
  }
  // Only a script actually declared in that package.json may run - the renderer
  // picks from the list above, and this re-checks server-side so a crafted
  // channel call can't run an arbitrary command.
  let declared = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    declared = Object.keys(pkg?.scripts || {});
  } catch (err) {
    return { ok: false, error: `Couldn't read package.json: ${err.message}` };
  }
  if (!declared.includes(script)) {
    return { ok: false, error: `"${script}" isn't a script in this package.json.` };
  }
  if (liveScriptRuns.has(runId)) {
    return { ok: false, error: "That run is already going." };
  }
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("repo:scriptEvent", { runId, ...payload });
    }
  };
  let child;
  try {
    child = spawn("npm", ["run", script], { cwd, shell: true, env: process.env });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  liveScriptRuns.set(runId, child);
  // Parse the terminal colour codes HERE, not in the renderer: the renderer is a
  // classic script and cannot import, so parsing there would mean a second copy of
  // the parser. One state object per run, shared by stdout and stderr, because an
  // escape sequence can be split across chunk boundaries (see lib/ansi.js).
  const ansi = newAnsiState();
  const emit = (buf) => send({ kind: "out", segments: parseAnsi(collapseCarriageReturns(buf.toString("utf8")), ansi) });
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  child.on("error", (err) => {
    liveScriptRuns.delete(runId);
    send({ kind: "done", code: null, error: err.message });
  });
  child.on("close", (code) => {
    liveScriptRuns.delete(runId);
    send({ kind: "done", code });
  });
  return { ok: true, pid: child.pid, command: `npm run ${script}` };
});

ipcMain.handle("repo:stopScript", (_event, { runId } = {}) => {
  const child = liveScriptRuns.get(runId);
  if (!child) {
    return { ok: false, error: "Nothing running under that id." };
  }
  // Same tree-kill reasoning as the session launcher: npm spawns a shell which
  // spawns the real tool, so signalling only the top process orphans the work.
  killChildTree(child);
  return { ok: true };
});

// Cross-instance liveness (ship-review data-safety): the goal-run history is a
// single GLOBAL file shared by every Helm instance of this build, but
// liveGoalRuns is per-process. Without a cross-process signal, instance B could
// resume a run instance A is actively driving -> two runs commit to the same
// worktree/branch -> git corruption + lost commits. So a live run stamps
// livePid + a periodically-refreshed liveHeartbeatAt on its record; another
// instance treats a run with a FRESH foreign heartbeat as owned-elsewhere
// (won't resume it, keeps showing it "running"), and a STALE one as a dead
// process's leftover (safe to resume). Heartbeat cadence + staleness window:
const GOAL_HEARTBEAT_MS = 20000;
const GOAL_HEARTBEAT_STALE_MS = 70000; // ~3.5x the cadence - tolerates a missed beat or two

// Is this run currently live in ANOTHER Helm instance (fresh foreign heartbeat)?
function isForeignLiveRun(rec) {
  return (
    !!rec &&
    !!rec.livePid &&
    rec.livePid !== process.pid &&
    typeof rec.liveHeartbeatAt === "number" &&
    Date.now() - rec.liveHeartbeatAt < GOAL_HEARTBEAT_STALE_MS
  );
}

// Refresh the heartbeat for every run live in THIS process, so another instance
// can tell our runs are still alive (vs. a crashed process's stale record).
// Only touches disk when something is actually live, so an idle Helm writes
// nothing. Cheap: a live run count is normally 0-3.
setInterval(() => {
  if (liveGoalRuns.size === 0) {
    return;
  }
  const now = Date.now();
  for (const goalRunId of liveGoalRuns.keys()) {
    try {
      upsertGoalRunRecord({ goalRunId, liveHeartbeatAt: now, updatedAt: now });
    } catch {
      // best-effort; a missed beat is tolerated by GOAL_HEARTBEAT_STALE_MS
    }
  }
}, GOAL_HEARTBEAT_MS);

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
// Shared body of a goal run, extracted from the "goal:run" IPC handler so both
// that handler AND the first-mate dispatch watcher (see the dispatch queue
// wiring below) launch runs through the exact same path - iteration clamp,
// liveGoalRuns tracking, "running" record, goal:event streaming, terminal
// record upsert. `dispatch` (optional) carries first-mate-tier metadata
// (docs/first-mate-tier-design.md section 3): { dispatchedBy, dispatchId, tier }
// stamped onto the persisted record, plus an optional `onComplete(result,
// { status, error })` hook the watcher uses to write the compact report back
// to the mate. Returns the goalRunId (the run streams/persists on its own).
function startGoalRun({
  projectPath,
  goal,
  maxIterations,
  model,
  effort,
  verifyCommand,
  escalationConfig,
  dispatch,
  resume,
}) {
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
  const runEntry = { cancelToken, currentChild: null, dispatchedBy: dispatch?.dispatchedBy || null };
  liveGoalRuns.set(goalRunId, runEntry);

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("goal:event", { goalRunId, ...payload });
    }
  };

  // Carry the dispatch metadata + project on "started" so the renderer can
  // CREATE an entry for a dispatched run it never launched itself (a run
  // started by the dispatch watcher, not the Goal page) - needed for the
  // running indicator and the fleet/tree view to see dispatched runs.
  send({
    kind: "started",
    goal,
    maxIterations: clampedMax || null,
    projectPath,
    dispatchedBy: dispatch?.dispatchedBy || null,
    tier: dispatch?.tier || null,
    startedBy: dispatch?.startedBy || null,
  });

  // Persist a compact "running" record now, before the run does anything —
  // if Helm is killed/restarted mid-run, rehydration on the next load
  // sees a stale "running" record with no live process behind it and can
  // reclassify it as interrupted, instead of the run vanishing entirely.
  // dispatchedBy/dispatchId/tier (first-mate tier, design section 3) are
  // additive: a direct/captain-initiated run leaves them null.
  upsertGoalRunRecord({
    goalRunId,
    goal,
    projectPath,
    status: "running",
    worktreePath: null,
    branchName: null,
    commitCount: null,
    stoppedReason: null,
    escalation: null,
    error: null,
    // Cross-instance liveness (see isForeignLiveRun): claim this run for THIS
    // process + start its heartbeat, so no other Helm instance resumes it.
    livePid: process.pid,
    liveHeartbeatAt: Date.now(),
    dispatchedBy: dispatch?.dispatchedBy || null,
    dispatchId: dispatch?.dispatchId || null,
    tier: dispatch?.tier || null,
    // WHO started this run, persisted on the run itself. It used to live only on a
    // Helm session record, stamped by runRelayTurn - and when the auto-captain
    // stopped going through runRelayTurn (it dispatches an autopilot run now), the
    // value stopped existing anywhere in the app, so the Auto widget's filter for
    // it could never match and the widget went blank while paid unattended runs
    // were touching repos (independent review, 2026-08-03). The run record is the
    // right home: it is what actually exists for the whole life of the work.
    startedBy: dispatch?.startedBy || null,
    // The board card this run was started for, so a restart can tell which cards
    // still have a live run behind them and un-strand the ones that do not. Without
    // it the taskId <-> run link existed only in memory (see selectStrandedAutoCards).
    autoTaskId: dispatch?.autoTaskId || null,
    // Run CONFIG, persisted so a resume (goal:resume / resumeFleet) reconstructs
    // the run faithfully. Without these, a resumed run silently reverts to
    // runGoal's defaults - most dangerously verifyCommand -> undefined -> the
    // build/test gate is dropped, so self-reported-success iterations get
    // committed WITHOUT verification (ship-review HIGH). model/effort/max/
    // escalationConfig would likewise regress. Stored as the effective values.
    verifyCommand: verifyCommand || null,
    model: model || null,
    effort: effort || null,
    maxIterations: clampedMax || null,
    escalationConfig: escalationConfig || null,
    // Which meta-home's dispatch queue this run's report belongs to. The
    // goal-run history is a single GLOBAL file, but reports are per-meta-home;
    // stamping this lets startup reconciliation resurrect a missing report only
    // in the meta-home that actually owns it (else a run dispatched under one
    // meta-home gets a spurious report written into every other one - harmless
    // with a single stable meta-home, a real bug once it varies: tests, and
    // future named mates).
    dispatchMetaHome: dispatch ? resolveMetaHome() : null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Fire-and-return: the caller gets the goalRunId immediately (so the renderer
  // can wire up its Cancel button, or the dispatch watcher can ack), while the
  // run itself proceeds and streams progress over goal:event. Errors are
  // reported over the same channel, never left to reject.
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
    // Point 12 Phase-0 escalation - opt-in, mirrors verifyCommand's own
    // opt-in shape. The renderer only ever sends a plain object (possibly
    // empty, `{}`, for "enable with defaults") when the user checked
    // "Escalate on trouble"; an unchecked box sends `undefined`, which
    // keeps runGoal's pre-existing behavior (no escalation) unchanged.
    escalationConfig: escalationConfig || undefined,
    // Phase-2 Slice 5: when present, runGoal re-attaches to this existing
    // worktree/branch (skips createWorktree + provisionDeps) instead of a fresh
    // one, so a quota-stopped / interrupted run continues where it left off.
    resume: resume || undefined,
    cancelToken,
    // Track each freshly-spawned iteration/verify child so before-quit can
    // sweep its tree (L1) and goal:cancel can kill the in-flight one
    // immediately (L2). Iterations/verify never overlap within a run, so a
    // single currentChild slot always holding the latest is sufficient.
    onChild: (child) => {
      runEntry.currentChild = child;
    },
    // Persist the worktree identity the moment it exists (Phase-2 Slice 5/6
    // follow-up): so a run interrupted by an app restart still has its worktree/
    // branch/baseCommit on the record + can be resumed (before this, those were
    // only persisted on completion, so an interrupted run had worktreePath:null
    // and was unresumable). Also stamp it resumable now - rehydration reclassifies
    // an interrupted run and the goal:resume gate needs resumable + baseCommit.
    onWorktree: ({ worktreePath, branchName, baseCommit }) => {
      // Mark resumable:true mid-run. A run that COMPLETES has this corrected by
      // the completion upsert (resumable only for quota/escalated); a run the app
      // restart INTERRUPTS never completes, so it stays resumable + now has its
      // worktree/branch/baseCommit -> goal:resume accepts it. A still-live run is
      // protected from resume by goal:resume's liveGoalRuns check, so the early
      // true is harmless.
      upsertGoalRunRecord({ goalRunId, worktreePath, branchName, baseCommit, resumable: true, updatedAt: Date.now() });
    },
    onIteration: (record) => send({ kind: "iteration", record }),
    // Forwarded to the renderer as its own "escalation" goal:event kind, on
    // the same channel as "iteration"/"done"/"error", so the Goal page can
    // show a human-gated card the moment the run actually pauses, rather
    // than waiting for the "done" event that follows shortly after (runGoal
    // still resolves normally on an escalated stop, carrying the same
    // escalation object in its own `result.escalation`).
    onEscalation: (escalation) => send({ kind: "escalation", escalation }),
  })
    .then((result) => {
      send({ kind: "done", result });
      // status stays "done" even for an escalated stop, mirroring the live
      // renderer's own model (goalRunDetailEl reads run.status === "done"
      // plus a separate `escalation` field, never a distinct "escalated"
      // status) - keeps rehydrated and live runs rendering through the
      // exact same branches.
      upsertGoalRunRecord({
        goalRunId,
        status: "done",
        worktreePath: result?.worktreePath || null,
        branchName: result?.branchName || null,
        commitCount: typeof result?.commitCount === "number" ? result.commitCount : null,
        stoppedReason: result?.stoppedReason || null,
        escalation: result?.escalation || null,
        // Persisted so a "fortsätt" can resume this run against the same worktree
        // with a cumulative commit count (Phase-2 Slice 5).
        baseCommit: result?.baseCommit || null,
        resumable: !!result?.resumable,
        // The run's OWN output, kept on the record. A research- or plan-only run's
        // entire deliverable lives in `.helm-goal/`, which became gitignored on
        // 2026-08-03 - so it is no longer committed, the run therefore ends with
        // zero commits, and the existing zero-commit cleanup then removes the
        // worktree it lived in. Without this the plan existed only in the live
        // renderer and was gone after a restart (independent review, 2026-08-03).
        // Bounded: this index is meant to stay compact, and the full text remains
        // in the run's transcript.
        plan: typeof result?.plan === "string" ? result.plan.slice(0, 20000) : null,
        notes: typeof result?.notes === "string" ? result.notes.slice(0, 20000) : null,
        // Release the cross-instance claim: the run is no longer live here.
        livePid: null,
        liveHeartbeatAt: null,
        updatedAt: Date.now(),
      });
      if (dispatch?.onComplete) {
        try {
          dispatch.onComplete(result, { status: "done" });
        } catch (err) {
          console.error("[helm] dispatch onComplete (done) failed:", err);
        }
      }
    })
    .catch((err) => {
      const errorMessage = err?.message || String(err);
      send({ kind: "error", error: errorMessage });
      upsertGoalRunRecord({
        goalRunId,
        status: "error",
        error: errorMessage,
        // A hard error (runGoal threw) is NOT cleanly resumable - clear the
        // mid-run resumable:true so it isn't offered for a "fortsätt".
        resumable: false,
        // Release the cross-instance claim: the run is no longer live here.
        livePid: null,
        liveHeartbeatAt: null,
        updatedAt: Date.now(),
      });
      if (dispatch?.onComplete) {
        try {
          dispatch.onComplete(null, { status: "error", error: errorMessage });
        } catch (hookErr) {
          console.error("[helm] dispatch onComplete (error) failed:", hookErr);
        }
      }
    })
    .finally(() => {
      liveGoalRuns.delete(goalRunId);
    });

  return { goalRunId };
}

ipcMain.handle(
  "goal:run",
  async (_event, { projectPath, goal, maxIterations, model, effort, verifyCommand, escalationConfig }) => {
    if (!projectPath || !goal) {
      return { ok: false, error: "projectPath and goal are required" };
    }
    const { goalRunId } = startGoalRun({
      projectPath,
      goal,
      maxIterations,
      model,
      effort,
      verifyCommand,
      escalationConfig,
    });
    return { ok: true, goalRunId };
  }
);

// --- Cancel an in-flight goal run: flip its cancelToken so the orchestrator
// stops at the next iteration boundary, AND kill the child process tree that
// is running right now so the in-flight iteration/verify doesn't keep running
// (up to ITERATION_TIMEOUT_MS) after the click. Killing the child makes that
// iteration's spawn resolve as a failed/errored outcome; the loop then hits
// the cancelToken check at its next boundary and exits cleanly. ---
ipcMain.handle("goal:cancel", (_event, { goalRunId }) => {
  const run = liveGoalRuns.get(goalRunId);
  if (!run) {
    return { ok: false, error: "no running goal for that id" };
  }
  run.cancelToken.cancelled = true;
  if (run.currentChild) {
    killChildTree(run.currentChild);
    run.currentChild = null;
  }
  return { ok: true };
});

// Phase-2 Slice 5: RESUME a run that STOPPED in a resumable state (quota-
// exhausted or escalated) by re-running against its EXISTING worktree + notes.md.
// A dispatched run's report-back + budget wiring is reconstructed so a resumed
// crew run still reports up. The kept worktree is the durable state that makes
// this safe (see runGoal's resume path). "fortsätt" (Slice 6) drives this.
// App-RESTART-interrupted runs are now resumable too: startGoalRun's onWorktree
// persists the worktree/branch/baseCommit + resumable:true the moment the
// worktree exists, so an interrupted run (which never completed to clear it)
// still qualifies here.
function resumeGoalRunById(goalRunId) {
  const rec = loadGoalRunHistory().find((r) => r.goalRunId === goalRunId);
  if (!rec) {
    return { ok: false, error: "No such run." };
  }
  // Only a run left in a resumable state can be resumed, and only ONCE. This
  // gate does triple duty (review): it blocks a SECOND resume of the same record
  // (two live runs on one worktree = git corruption, #1), and it excludes pre-
  // Slice-5 records that have no persisted baseCommit (whose commit count would
  // read 0 and could auto-delete their committed work, #3). resumable is cleared
  // below the moment we start, so a concurrent second call also fails this.
  if (!rec.resumable) {
    return { ok: false, error: "This run isn't in a resumable state (only a quota-stopped or escalated run, once each)." };
  }
  if (liveGoalRuns.has(goalRunId)) {
    return { ok: false, error: "That run is already live." };
  }
  // Cross-instance guard (ship-review): liveGoalRuns.has only sees THIS process.
  // If another Helm instance is actively driving this run (fresh foreign
  // heartbeat), resuming here would double-run the same worktree -> git
  // corruption + lost commits. Refuse until its owner finishes or dies (a stale
  // heartbeat means the owning process is gone, so it becomes resumable again).
  if (isForeignLiveRun(rec)) {
    return { ok: false, error: "That run is live in another Helm instance right now - resume it there, or wait for it to finish." };
  }
  if (!rec.worktreePath || !fs.existsSync(rec.worktreePath)) {
    return { ok: false, error: "The run's worktree is no longer on disk - can't resume." };
  }
  // Require a baseCommit: without it countCommitsOnBranch reads 0, so a resumed
  // run that added no NEW commit could be auto-deleted despite prior work (the
  // unborn-repo edge the review flagged). Real git projects always have one.
  if (!rec.baseCommit) {
    return { ok: false, error: "This run has no recorded base commit - can't safely resume." };
  }
  // Respect the Slice-0 guardrails: a resume launches a real autonomous run, so
  // the kill switch + budget ceiling must gate it exactly like a fresh dispatch
  // (review #2 - resume must not be a backdoor around Stop / over-budget).
  const gateHome = rec.dispatchMetaHome || resolveMetaHome();
  if (isKilled(gateHome)) {
    return { ok: false, error: "Orchestration is stopped by the kill switch - resume the orchestration first." };
  }
  if (isOverBudget(gateHome)) {
    return { ok: false, error: "Orchestration is over its budget ceiling - raise or reset the budget first." };
  }
  // Respect the per-mate WIDTH cap here too, so a mass "fortsätt" can't launch
  // more than the cap of concurrent runs for one dispatcher (review CONFIRMED:
  // resumable runs accumulate past the cap while stopped, so resuming them all
  // at once would blow it). Checked BEFORE clearing resumable, so an over-cap run
  // stays resumable and a later resume picks it up once a slot frees.
  if (rec.dispatchedBy && widthCapExceeded(liveRunSnapshot(), rec.dispatchedBy, DISPATCH_WIDTH_CAP)) {
    return { ok: false, error: `At the concurrent-run cap (${DISPATCH_WIDTH_CAP}) for this mate - resume again once one finishes.`, atCap: true };
  }
  // Consume this record so it can't be resumed again (guards #1).
  upsertGoalRunRecord({ goalRunId, resumable: false, updatedAt: Date.now() });
  const resume = { worktreePath: rec.worktreePath, branchName: rec.branchName || null, baseCommit: rec.baseCommit || null };
  let dispatch;
  if (rec.dispatchedBy) {
    const metaHome = rec.dispatchMetaHome || resolveMetaHome();
    const mateId = rec.dispatchedBy;
    const dispatchId = rec.dispatchId || crypto.randomUUID();
    const request = { goal: rec.goal, project: rec.projectPath, tier: rec.tier || "crew" };
    dispatch = {
      dispatchedBy: mateId,
      dispatchId,
      tier: rec.tier || "crew",
      onComplete: (result, meta) => {
        const report = buildDispatchReport({ dispatchId, mateId, request, result, meta });
        writeReport(metaHome, report);
        addSpend(metaHome, report.costUsd);
        writeFleetStateSnapshot(metaHome);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("dispatch:report", { dispatchId, mateId });
        }
      },
    };
  }
  const started = startGoalRun({
    projectPath: rec.projectPath,
    goal: rec.goal,
    // Reconstruct the original run config so the resume keeps its verify gate,
    // model/effort tier, iteration budget, and escalation policy (ship-review
    // HIGH: these were being dropped, silently reverting to runGoal defaults).
    verifyCommand: rec.verifyCommand || undefined,
    model: rec.model || undefined,
    effort: rec.effort || undefined,
    maxIterations: rec.maxIterations || undefined,
    escalationConfig: rec.escalationConfig || undefined,
    dispatch,
    resume,
  });
  return { ok: true, goalRunId: started.goalRunId };
}
ipcMain.handle("goal:resume", (_event, { goalRunId }) => resumeGoalRunById(goalRunId));

// Phase-2 Slice 6: the top-down "fortsätt" cascade. Resumes the resumable runs
// (quota-stopped / escalated) owned by a first mate's tree - its own directly-
// dispatched crew AND its second mates' crew. Each resume is individually gated
// by resumeGoalRunById (resumable-once, on-disk, kill/budget, AND the per-mate
// width cap), so a mass resume launches at most the cap of concurrent runs per
// mate and leaves the rest resumable for a later "fortsätt" - no guardrail is
// bypassed. A null/empty ownerMateId is a no-op (never "resume all direct runs":
// review PLAUSIBLE - the || null fallback must not become a wildcard).
function resumeFleet(ownerMateId) {
  if (!ownerMateId) {
    return { resumed: 0, total: 0 };
  }
  const history = loadGoalRunHistory();
  const ownedSecondMates = new Set(
    deriveSecondMates(history)
      .filter((s) => s.firstMateId === ownerMateId)
      .map((s) => s.secondMateId)
  );
  // Exclude still-LIVE runs: they carry resumable:true mid-run (corrected on
  // completion), but they're running, not resumable now - counting them would
  // make `total` misleading and could have the mate re-issue fortsätt in a loop
  // (review PLAUSIBLE).
  const mine = history.filter(
    (r) =>
      r.resumable &&
      !liveGoalRuns.has(r.goalRunId) &&
      !isForeignLiveRun(r) && // owned+driven by another instance - leave it be
      (r.dispatchedBy === ownerMateId || ownedSecondMates.has(r.dispatchedBy))
  );
  let resumed = 0;
  for (const r of mine) {
    if (resumeGoalRunById(r.goalRunId).ok) {
      resumed += 1;
    }
  }
  return { resumed, total: mine.length };
}
ipcMain.handle("orchestration:resumeFleet", (_event, { mateId }) => {
  return { ok: true, ...resumeFleet(mateId || null) };
});

// Phase-2 guardrail (Slice 0): the KILL SWITCH. Stops the whole orchestration
// tree - flips the persisted killed flag (so no further dispatch is accepted,
// even after a restart) AND cancels every live dispatched run right now (same
// mechanism as goal:cancel). Reversible via orchestration:resume.
ipcMain.handle("orchestration:killTree", () => {
  const metaHome = resolveMetaHome();
  setKilled(metaHome, true);
  let cancelled = 0;
  for (const run of liveGoalRuns.values()) {
    if (run.cancelToken) {
      run.cancelToken.cancelled = true;
    }
    if (run.currentChild) {
      killChildTree(run.currentChild);
      run.currentChild = null;
    }
    cancelled += 1;
  }
  // Relay turns (internal Opus second-mate turns) live in liveChildren under a
  // "relay-" key, NOT in liveGoalRuns, so the loop above misses them. Kill those
  // too, or an in-flight relay keeps burning tokens after the kill switch
  // (ship-review). Their done.then still runs on kill - it releases the lock,
  // drops the child handle, and books the partial spend - so this is clean.
  // Non-relay children in liveChildren are the captain's own interactive
  // sessions and must NOT be killed by an orchestration kill.
  for (const [key, child] of liveChildren) {
    if (key.startsWith("relay-")) {
      killChildTree(child);
      cancelled += 1;
    }
  }
  return { ok: true, cancelled };
});

// ============================ Auto-captain (ea0546d1) ========================
// Starts work on tasks the user hands it, so the board drives execution without
// opening a session and prompting each time. Design: docs/auto-captain-design.md.
//
// The safety shape, and none of it is optional:
//   - OFF by default. Nothing fires until config.autoCaptain.enabled is true.
//   - START only. A run lands in review; only the user moves anything to done.
//   - Capped. AUTO_WIDTH_CAP runs at once, the rest wait.
//   - The orchestration kill switch stops it, like everything else that spends.
//   - A card it will not start gets a tag AND a written reason on the board.
//   - A card judged unclear is not re-judged until the card CHANGES. Without that
//     the triage would re-run every minute, forever, on the same words.
const AUTO_TICK_MS = 60_000;
// Iterations one auto-started task's run gets. Modest on purpose: a task that
// cannot be finished in this many passes is a task whose card needs rewriting, and
// a runaway autonomous run is expensive in both money and review time.
const AUTO_RUN_MAX_ITERATIONS = 6;
let autoTickInFlight = false;
// taskId -> { taskId, title, projectPath, startedAt, secondMateId }. In memory
// only: a run that did not survive a restart is not running, so remembering it
// would just block the cap on nothing.
const autoRuns = new Map();
let autoLastTick = { at: 0, acted: 0, held: 0, error: null };

// Backoff for a card whose triage call FAILED (not "judged unclear" - see the
// !verdict branch below, which deliberately leaves such a card untouched so it can be
// retried rather than blamed for our own failure).
//
// Retried on every 60-second pass, that correct decision became an unbounded cost: one
// real model call per minute, forever, for a card that keeps failing - and silently,
// since a failure is not an error the captain is shown as spending. The captain asked the
// right question about the wrong thing (task 1f8cca7b: "auto kollar kön för ofta (tar
// det tokens?)"): the PASS is a board file read and costs nothing, but this path did.
//
// So a failure doubles the wait before the next attempt, capped at an hour. In memory
// only, like autoRuns: a restart is a fair reason to try again immediately.
const AUTO_TRIAGE_RETRY_BASE_MS = 2 * 60_000;
const AUTO_TRIAGE_RETRY_MAX_MS = 60 * 60_000;
const triageRetry = new Map(); // taskId -> { attempts, nextAt }

/** How long to wait before the Nth retry of a failed triage. */
function triageBackoffMs(attempts) {
  return Math.min(AUTO_TRIAGE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), AUTO_TRIAGE_RETRY_MAX_MS);
}

function noteTriageFailure(taskId, now = Date.now()) {
  const prev = triageRetry.get(taskId);
  const attempts = (prev?.attempts || 0) + 1;
  const waitMs = triageBackoffMs(attempts);
  triageRetry.set(taskId, { attempts, nextAt: now + waitMs });
  return { attempts, waitMs };
}

function autoCaptainConfig() {
  const cfg = loadConfig();
  return { enabled: cfg.autoCaptain?.enabled === true, triaged: cfg.autoCaptain?.triaged || {}, jot: cfg.jot || {} };
}

/** Drop triage memories for cards that are no longer set aside (see staleTriageEntries). */
function forgetTriaged(taskIds) {
  if (!taskIds || taskIds.length === 0) {
    return;
  }
  try {
    const cfg = loadConfig();
    const triaged = { ...(cfg.autoCaptain?.triaged || {}) };
    for (const id of taskIds) {
      delete triaged[id];
    }
    writeConfig({ ...cfg, autoCaptain: { ...(cfg.autoCaptain || {}), triaged } });
  } catch (err) {
    // A failed write means the card is judged again next pass anyway - the wrong
    // direction to fail in is the safe one here.
    console.error("[helm] auto-captain could not forget a triage verdict:", err?.message || err);
  }
}

/**
 * Forget every remembered verdict when the triage QUESTION itself has changed.
 *
 * A verdict is stored per card, keyed on the card's own wording, with no note of which question
 * produced it. So loosening the bar (TRIAGE_PROMPT_VERSION 1 -> 2, 2026-08-04) would have left
 * every already-set-aside card set aside: the very cards that motivated the loosening. Found by an
 * independent review, which demonstrated it - "en copy code knapp" stayed held, unchanged, and was
 * never re-judged.
 *
 * Runs once per version bump, before the pass plans anything, so the first tick after an update
 * re-judges what the old question rejected.
 */
function forgetTriagedOnPromptChange() {
  try {
    const cfg = loadConfig();
    const stored = cfg.autoCaptain?.triageVersion ?? 1;
    if (stored === TRIAGE_PROMPT_VERSION) {
      return 0;
    }
    const count = Object.keys(cfg.autoCaptain?.triaged || {}).length;
    writeConfig({
      ...cfg,
      autoCaptain: { ...(cfg.autoCaptain || {}), triaged: {}, triageVersion: TRIAGE_PROMPT_VERSION },
    });
    if (count > 0) {
      console.log(`[helm] auto-captain: the triage question changed - ${count} remembered verdict${count === 1 ? "" : "s"} forgotten, they will be judged again`);
    }
    return count;
  } catch (err) {
    console.error("[helm] auto-captain could not reset its triage memory:", err?.message || err);
    return 0;
  }
}

/** Remember that this exact wording was judged unclear, so it isn't re-judged. */
function rememberTriaged(taskId, fingerprint) {
  try {
    const cfg = loadConfig();
    const triaged = { ...(cfg.autoCaptain?.triaged || {}), [taskId]: fingerprint };
    writeConfig({ ...cfg, autoCaptain: { ...(cfg.autoCaptain || {}), triaged } });
  } catch (err) {
    // A failed write means this card gets triaged again next tick - wasteful, but
    // never wrong. Not worth failing the tick over.
    console.error("[helm] auto-captain could not remember a triage verdict:", err?.message || err);
  }
}

/**
 * A started card's turn has ended: move it to REVIEW and free its slot.
 *
 * Both halves were missing entirely, and each is its own bug (the captain, 2026-08-02,
 * on his first real auto start: "varför hamnade den inte i review när den var
 * klar?").
 *
 * The card: the whole promise of the auto-captain is that it starts work and you
 * decide what happens to it. Leaving the card in in-progress forever means the
 * one thing you have to do - look at what it did - is the one thing the board
 * never asks you to do. Review, never done: done stays a joint decision.
 *
 * The slot: `autoRuns` was only ever added to. Nothing removed an entry, so after
 * three auto starts the cap was permanently full and no further card could ever
 * be started until Helm was restarted. A concurrency cap that only counts up is
 * not a cap, it is a countdown to a silent stop.
 *
 * `auto-running` comes off either way. A card that says a machine is working on
 * it when nothing is running is worse than an untagged one.
 */
// NOTE: there is deliberately no auto-specific worktree helper here any more. An
// auto task is dispatched as an autopilot run, and the goal orchestrator already
// creates a worktree per run, with a run record the housekeeping sweep understands.
// A second, parallel notion of "the auto worktree" was a duplicate of that with its
// own cleanup rules to keep in sync.

function finishAutoRun(taskId, result = null, meta = null) {
  const run = autoRuns.get(taskId);
  autoRuns.delete(taskId);
  if (!run) {
    return;
  }
  const { jot } = autoCaptainConfig();
  // WHERE the work is has to be on the card. It is not the project folder: the run
  // works in its own worktree on its own branch, so without both the work is
  // effectively hidden. Read from the run's own result, which is the authority.
  const wt = result?.worktreePath || null;
  const branch = result?.branchName || null;
  const commits = typeof result?.commitCount === "number" ? result.commitCount : null;
  const where = wt
    ? `in ${wt}${branch ? ` on branch ${branch}` : ""} (an isolated worktree of ${run.projectPath}, not merged)`
    : `in ${run.projectPath}`;
  const outcome =
    meta?.status === "error"
      ? "Errored before finishing"
      : commits === 0
        ? "Finished without committing anything"
        : commits === null
          ? "Finished"
          : `Finished with ${commits} commit${commits === 1 ? "" : "s"}`;
  const res = setTaskTags(jot, taskId, {
    remove: [AUTO_RUNNING_TAG],
    status: "review",
    note:
      `[Auto-captain ${new Date().toISOString().slice(0, 10)}] ${outcome}. The work is ${where} - read it and decide. ` +
      `Nothing was marked done. Jump into ${path.basename(run.projectPath)} in the Auto widget and it can walk you through what its runs did.`,
  });
  if (!res.ok) {
    console.error("[helm] auto-captain finished a run but could not move the card:", res.error);
  }
}

/**
 * Take the "auto-running" stripe off cards whose run did not survive a restart.
 *
 * Runs once at startup. A card is left alone if a run record links it to work that
 * is genuinely still going - including in another Helm instance, whose fresh
 * heartbeat is exactly what isForeignLiveRun reads. Everything else is moved to
 * review with a note saying the run was interrupted, because the one thing the
 * board must never do is claim a machine is working on something when none is.
 */
function reconcileStrandedAutoCards() {
  const { jot } = autoCaptainConfig();
  let stranded;
  let records;
  try {
    records = loadGoalRunHistory();
    const live = new Set(
      records
        .filter((r) => r?.autoTaskId && r.status === "running" && isForeignLiveRun(r))
        .map((r) => r.autoTaskId)
    );
    for (const taskId of autoRuns.keys()) {
      live.add(taskId);
    }
    stranded = selectStrandedAutoCards(readJotState(jot), { liveTaskIds: live });
  } catch (err) {
    console.error("[helm] could not check for stranded auto cards:", err?.message || err);
    return { checked: false, freed: 0 };
  }
  let freed = 0;
  for (const todo of stranded) {
    // Say WHERE the work got to. An interrupted run still committed whatever it had
    // finished, on its own branch, and a card that omits that reads as "nothing
    // happened" when something did.
    const rec = records.find((r) => r?.autoTaskId === todo.id) || null;
    const where = rec?.worktreePath
      ? `Whatever it had finished is in ${rec.worktreePath}${rec.branchName ? ` on branch ${rec.branchName}` : ""} (not merged).`
      : "It may not have gotten as far as committing anything.";
    const res = setTaskTags(jot, todo.id, {
      remove: [AUTO_RUNNING_TAG],
      status: "review",
      note:
        `[Auto-captain ${new Date().toISOString().slice(0, 10)}] The run was interrupted - Helm stopped before it finished. ` +
        `${where} Nothing was marked done. Re-tag it "auto" to start over, or take it by hand.`,
    });
    if (res.ok) {
      freed += 1;
    } else {
      console.error("[helm] could not free a stranded auto card:", res.error);
    }
  }
  if (freed > 0) {
    console.log(`[helm] auto-captain: freed ${freed} card${freed === 1 ? "" : "s"} left tagged auto-running by an interrupted run`);
  }
  return { checked: true, freed };
}

/** Hold a card back: tag it, say why on the card itself, and don't ask again. */
function holdBack(jotConfig, todo, reason) {
  const res = setTaskTags(jotConfig, todo.id, {
    add: [NEEDS_CLARIFICATION_TAG],
    note: clarificationNote(reason),
  });
  if (!res.ok) {
    // DO NOT remember it. The memory suppresses re-triage until the card's wording
    // changes, so writing it when the tag and the explanation never reached the card
    // makes the card permanently invisible to auto with nothing on it saying why -
    // and a board write failing is not hypothetical, it is the locked-file case fixed
    // in @jot/core the same day. The captain hit exactly this (2026-08-03): "jag körde run
    // one pass" and nothing happened, on a card wearing no tag and carrying no note.
    // Not remembering costs one repeated triage call on the next pass. Remembering
    // wrongly costs the card.
    console.error("[helm] auto-captain could not tag a held task, so it stays eligible:", res.error);
    return false;
  }
  rememberTriaged(todo.id, taskFingerprint(todo));
  return true;
}

/**
 * One pass over the board. Returns a summary rather than throwing, because this
 * runs on a timer and a thrown error on a timer is an unhandled rejection.
 */
async function autoCaptainTick({ force = false } = {}) {
  if (autoTickInFlight) {
    return { ok: true, skipped: "a pass is already running" };
  }
  let { enabled, triaged, jot } = autoCaptainConfig();
  if (!enabled && !force) {
    return { ok: true, skipped: "auto-captain is off" };
  }
  const metaHome = resolveMetaHome();
  if (isKilled(metaHome)) {
    return { ok: true, skipped: "orchestration is stopped by the kill switch" };
  }
  autoTickInFlight = true;
  // Before anything is planned: if the triage QUESTION has changed since these verdicts were
  // stored, they answer a question nobody is asking any more. Re-read afterwards, or THIS pass
  // would still plan against the memory that was just thrown away and the reset would only take
  // effect a minute later.
  if (forgetTriagedOnPromptChange() >= 0) {
    ({ triaged } = autoCaptainConfig());
  }
  let acted = 0;
  let held = 0;
  // Cards this pass could not JUDGE, as opposed to judged and declined. Kept apart
  // all the way to the widget: one is a fact about the card, the other is a fact
  // about us.
  const triageFailures = [];
  try {
    const state = readJotState(jot);
    if (!state.ok) {
      autoLastTick = { at: Date.now(), acted: 0, held: 0, error: "Couldn't read the board." };
      return { ok: false, error: autoLastTick.error };
    }
    // Forget any card that is no longer set aside - most importantly one whose
    // "needs-clarification" tag you took off, which is the gesture for "look at this
    // again" and until now meant nothing. Done before planning, so the same pass that
    // notices acts on it.
    const stale = staleTriageEntries(state, triaged);
    let effectiveTriaged = triaged;
    if (stale.length > 0) {
      effectiveTriaged = { ...triaged };
      for (const id of stale) {
        delete effectiveTriaged[id];
      }
      forgetTriaged(stale);
      console.log(`[helm] auto-captain: ${stale.length} card${stale.length === 1 ? "" : "s"} no longer set aside - will be judged again`);
    }
    // Cards waiting out a triage backoff are excluded from PLANNING, not skipped inside the loop.
    //
    // Skipping them later let them occupy the concurrency cap: three backed-off cards filled all
    // three slots, a healthy fourth card was told "3 auto runs already in flight" when zero were,
    // and nothing started for up to an hour. Demonstrated by an independent review - and it was a
    // regression the backoff itself introduced, since before it those slots were at least churning.
    // Handing the planner a filtered board is the honest fix: a card that cannot be judged yet is
    // not a candidate this pass.
    const backedOff = new Set(
      [...triageRetry.entries()].filter(([, w]) => Date.now() < w.nextAt).map(([id]) => id)
    );
    const plannableState = backedOff.size > 0 ? { ...state, todos: (state.todos || []).filter((t) => !backedOff.has(t.id)) } : state;
    for (const id of backedOff) {
      const w = triageRetry.get(id);
      const card = (state.todos || []).find((t) => t.id === id);
      const mins = Math.max(1, Math.round((w.nextAt - Date.now()) / 60_000));
      triageFailures.push({
        id,
        title: card?.text || id,
        reason: `Could not be judged ${w.attempts} time${w.attempts === 1 ? "" : "s"} - waiting ${mins} more minute${mins === 1 ? "" : "s"} before trying again.`,
      });
    }
    const { act, skipped } = planAutoTick(plannableState, {
      running: autoRuns.size,
      triaged: effectiveTriaged,
      handledIds: new Set(autoRuns.keys()),
    });
    for (const todo of act) {
      // (The backoff skip that used to sit here is gone: cards waiting one out are now removed
      // BEFORE planning, so they no longer occupy the concurrency cap. See plannableState above.)
      // WHERE. A list with no folder binding cannot be acted on, and saying that
      // plainly is more useful than a triage verdict about the wording.
      const where = resolveTaskProject(todo, state.categories);
      if (!where.ok) {
        holdBack(jot, todo, where.reason);
        held += 1;
        continue;
      }
      // WHETHER. Haiku, no tools, and a null answer counts as "no".
      const verdict = await triageAutoTask({
        cwd: where.projectPath,
        systemPrompt: TRIAGE_SYSTEM_PROMPT,
        input: buildTriageInput(todo, where.category),
      });
      // A FAILED CALL IS NOT A VERDICT. triageAutoTask resolves null when it could
      // not judge at all - the model call timed out, the binary would not spawn, the
      // output did not parse. That was being handled in the same branch as "judged
      // and found unclear": the card got the needs-clarification tag and a note
      // telling the captain to add what was missing, for a card that was perfectly clear
      // (2026-08-03: "den skickar hela tiden tillbaka min task med needs
      // clarification", on a card whose triage, run by hand, answered fine in 16.4
      // seconds). Blaming the user's wording for our own failure is the worst
      // available outcome, and it also poisoned the do-not-re-judge memory.
      //
      // So: leave the card completely alone and let the next pass retry it. The
      // failure is reported as a failure, in the widget, where it belongs.
      if (!verdict) {
        // Backed off rather than retried every pass: the retry is right, one model call a
        // minute forever is not (see triageRetry).
        const { attempts, waitMs } = noteTriageFailure(todo.id);
        const mins = Math.round(waitMs / 60_000);
        triageFailures.push({
          id: todo.id,
          title: todo.text,
          reason: `The triage call could not be completed (${attempts} attempt${attempts === 1 ? "" : "s"}) - trying again in ${mins} minute${mins === 1 ? "" : "s"}.`,
        });
        console.error(`[helm] auto-captain: triage failed for "${todo.text}" - untouched, next attempt in ${mins}m`);
        continue;
      }
      // A card that answered is no longer failing, so it must not carry an old wait into
      // some later failure and start from a long delay.
      triageRetry.delete(todo.id);
      if (!verdict.dispatchable) {
        holdBack(jot, todo, verdict.reason || "The triage judged this not specific enough to hand to an agent.");
        held += 1;
        continue;
      }
      // GO.
      //
      // The shape here is the fleet's own hierarchy, and it is the shape the captain
      // asked for (2026-08-03): ONE second mate per PROJECT, with an autopilot run
      // per task underneath it.
      //
      // Two earlier shapes were wrong. Relaying every task to a single per-project
      // second mate serialised them - one session cannot hold two turns - so two
      // tasks in one repo could not both run. Giving each TASK its own second mate
      // fixed that but flattened the hierarchy: two sibling rows with no project
      // above them, each holding a duplicate copy of the same project context, and
      // nowhere to go to ask "what is happening in this repo".
      //
      // Dispatching the task as CREW under the project's second mate gets both.
      // Each autopilot run already creates its own worktree, its own branch and its
      // own run record, so parallelism is free and needs no special cleanup rules.
      // The second mate is then what it should be: the place you jump into to be
      // walked through what its runs did.
      const smId = secondMateId("direct", where.projectPath);
      try {
        // Named after the PROJECT, because that is what this row now represents.
        // The task titles belong on the crew rows underneath it. Idempotent -
        // re-proposing an existing id merges.
        // New work means this row is relevant again - see
        // unarchiveSecondMateForNewWork. Without it an archived project row swallowed
        // every later auto run for that project, silently.
        unarchiveSecondMateForNewWork(smId);
        proposeSecondMate("direct", where.projectPath, {
          brief: `Auto-started tasks for ${path.basename(where.projectPath)}. Each one runs as its own autopilot below.`,
        });
      } catch (err) {
        console.error("[helm] auto-captain could not register the second mate:", err?.message || err);
      }
      const goal = [
        `Task from the board: ${todo.text}`,
        "",
        todo.description ? todo.description.slice(0, 4000) : "(no description)",
        "",
        "Started automatically from the Auto lane. Leave the work committed on this run's own branch.",
        "Do not merge, rebase or push, and do not mark anything finished on the board - the captain does that.",
      ].join("\n");
      const dispatchId = crypto.randomUUID();
      let started;
      try {
        started = startGoalRun({
          projectPath: where.projectPath,
          goal,
          maxIterations: AUTO_RUN_MAX_ITERATIONS,
          dispatch: {
            dispatchedBy: smId,
            dispatchId,
            tier: "crew",
            // This is what makes the run visible in the Auto widget: the project's
            // node inherits "auto" from any crew run carrying it (deriveSecondMates).
            startedBy: "auto",
            autoTaskId: todo.id,
            // The report the second mate hands you when you jump in and ask what
            // happened. Without it the run would finish into silence and the only
            // trace would be commits in a folder.
            onComplete: (result, meta) => {
              try {
                const report = buildDispatchReport({
                  dispatchId,
                  mateId: smId,
                  request: { project: where.projectPath, goal, tier: "crew" },
                  result,
                  meta,
                });
                writeReport(metaHome, report);
                addSpend(metaHome, report.costUsd);
              } catch (err) {
                console.error("[helm] auto-captain could not write the run's report:", err?.message || err);
              }
              finishAutoRun(todo.id, result, meta);
            },
          },
        });
      } catch (err) {
        // Leave the card alone entirely so the next pass retries. Deliberately NOT
        // held back: nothing was decided about the card itself.
        //
        // But BACK OFF, and this is the point: the verdict above already ran, which means a
        // model call was already paid for, and triageRetry was already cleared by that success.
        // Retrying every 60 seconds therefore paid a fresh triage call every minute, forever,
        // for a card whose DISPATCH is what keeps failing - a stale git lock, a branch-name
        // collision, a full disk. That is precisely the unbounded spend the backoff exists to
        // remove, in the one branch it did not cover; found by an independent review, not by me.
        const { attempts, waitMs } = noteTriageFailure(todo.id);
        const mins = Math.round(waitMs / 60_000);
        triageFailures.push({
          id: todo.id,
          title: todo.text,
          reason: `Could not start the run (${attempts} attempt${attempts === 1 ? "" : "s"}): ${err?.message || err}. Trying again in ${mins} minute${mins === 1 ? "" : "s"}.`,
        });
        console.error(`[helm] auto-captain could not dispatch: ${err?.message || err} - next attempt in ${mins}m`);
        continue;
      }
      autoRuns.set(todo.id, {
        taskId: todo.id,
        title: todo.text,
        projectPath: where.projectPath,
        secondMateId: smId,
        goalRunId: started?.goalRunId || null,
        startedAt: Date.now(),
      });
      const moved = setTaskTags(jot, todo.id, { add: [AUTO_RUNNING_TAG], remove: [NEEDS_CLARIFICATION_TAG], status: "in-progress" });
      if (!moved.ok) {
        console.error("[helm] auto-captain dispatched but could not move the card:", moved.error);
      }
      acted += 1;
    }
    // The cards this pass declined to start, WITH the reason, so the widget can say
    // so. Without it "nothing happened" was the entire user-visible output of a pass
    // that had looked at a card and decided against it - and the one feature that
    // spends money unattended is the last place where silence should mean anything.
    // Trimmed to what a row needs; the full explanation lives on the card itself.
    autoLastTick = {
      at: Date.now(),
      acted,
      held,
      waiting: skipped.length,
      setAside: [
        ...skipped.slice(0, 8).map((s) => ({ id: s.todo?.id || null, title: s.todo?.text || "(untitled)", reason: s.reason })),
        ...triageFailures.slice(0, 4),
      ],
      triageFailed: triageFailures.length,
      error: null,
    };
    return { ok: true, acted, held, waiting: skipped.length, triageFailed: triageFailures.length };
  } catch (err) {
    autoLastTick = { at: Date.now(), acted, held, error: err?.message || String(err) };
    return { ok: false, error: autoLastTick.error };
  } finally {
    autoTickInFlight = false;
  }
}

ipcMain.handle("autoCaptain:status", () => {
  const { enabled } = autoCaptainConfig();
  return {
    ok: true,
    enabled,
    running: [...autoRuns.values()],
    cap: AUTO_WIDTH_CAP,
    lastTick: autoLastTick,
    killed: isKilled(resolveMetaHome()),
  };
});

ipcMain.handle("autoCaptain:setEnabled", (_event, { enabled } = {}) => {
  try {
    const cfg = loadConfig();
    writeConfig({ ...cfg, autoCaptain: { ...(cfg.autoCaptain || {}), enabled: enabled === true } });
    return { ok: true, enabled: enabled === true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Run one pass right now. `force` runs it even while the toggle is off, which is
// how the first live run is watched deliberately instead of waiting for a timer.
ipcMain.handle("autoCaptain:runNow", async (_event, { force = false } = {}) => autoCaptainTick({ force }));

// Clears the kill flag + zeroes spend so dispatch can resume (keeps the ceiling).
ipcMain.handle("orchestration:resume", () => {
  return { ok: true, budget: resetBudget(resolveMetaHome()) };
});

// Read the current orchestration budget (for a Dashboard readout).
ipcMain.handle("orchestration:budget", () => {
  return { ok: true, budget: readBudget(resolveMetaHome()) };
});

// Set the cost ceiling (USD); null removes the cap.
ipcMain.handle("orchestration:setCeiling", (_event, { ceilingUsd }) => {
  return { ok: true, budget: setCeiling(resolveMetaHome(), ceilingUsd) };
});

// --- Persisted goal-run index (see lib/goalRunHistory.js) — read on renderer
// startup so past runs survive an app restart. A "running" record with no
// matching entry in liveGoalRuns means the process behind it is gone (the
// app was restarted mid-run), so it's downgraded to "interrupted" here
// rather than left to render as a still-live run with a dead Cancel button.
ipcMain.handle("goal:history", () => {
  return loadGoalRunHistory().map((record) => {
    if (record.status !== "running" || liveGoalRuns.has(record.goalRunId)) {
      return record;
    }
    // A "running" record with no live process HERE is interrupted - UNLESS it's
    // genuinely live in another Helm instance (fresh foreign heartbeat), in
    // which case keep it "running" so this instance doesn't offer to resume a
    // run someone else is driving (ship-review cross-instance guard).
    if (isForeignLiveRun(record)) {
      return record;
    }
    return { ...record, status: "interrupted" };
  });
});

// --- Per-run worktree management (Goal page cleanup affordances). A
// goal-orchestrator run deliberately leaves its worktree + branch on disk for
// human review (see goalOrchestrator.js) rather than cleaning up after
// itself, which over daily use means orphaned worktrees pile up with no
// in-app visibility. These two handlers only ever act on a SPECIFIC
// worktreePath the renderer already has from a run record - never a
// generic "clean up everything" sweep. Reuses worktree.js's removeWorktree,
// which by design only removes the worktree checkout itself and leaves the
// branch ref alone (deleting a branch is a separate, more destructive
// decision it deliberately does not make) - so the branch survives after
// this and can still be found/deleted by hand via `git branch -D` if wanted. ---
ipcMain.handle("goal:openWorktree", (_event, { worktreePath }) => {
  if (!worktreePath) {
    return { ok: false, error: "worktreePath is required" };
  }
  // Give feedback instead of silently opening nothing when the worktree has
  // already been removed from disk (manually, or by an earlier Delete).
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, error: "Worktree no longer exists on disk." };
  }
  shell.openPath(worktreePath);
  return { ok: true };
});

ipcMain.handle("goal:deleteWorktree", (_event, { goalRunId, projectPath, worktreePath, force }) => {
  if (!projectPath || !worktreePath) {
    return { ok: false, error: "projectPath and worktreePath are required" };
  }
  // If the worktree is already gone from disk (removed manually or elsewhere),
  // there's nothing to remove - just clear the stale record so the dead entry
  // can be cleaned from the UI. Without this, removeWorktree throws "not a
  // registered worktree" and the user is stuck with an un-clearable row.
  if (!fs.existsSync(worktreePath)) {
    if (goalRunId) {
      removeGoalRunRecord(goalRunId);
    }
    return { ok: true, alreadyGone: true };
  }
  try {
    // Default is fail-closed on uncommitted changes (removeWorktree's contract).
    // The UI catches that specific failure and re-invokes with force:true after
    // an explicit confirm, so a dirty worktree can be discarded without dropping
    // to a terminal (bug f9a11d56: "how do I delete an uncommitted worktree?").
    removeWorktree(projectPath, worktreePath, { force: Boolean(force) });
  } catch (err) {
    const message = err?.message || String(err);
    // Signal the specific "dirty worktree" case so the renderer can offer a
    // force-discard confirm instead of just surfacing a dead-end error.
    const uncommitted = /uncommitted changes/i.test(message);
    return { ok: false, error: message, uncommitted };
  }
  if (goalRunId) {
    removeGoalRunRecord(goalRunId);
  }
  return { ok: true };
});

// Report-back "Done + clean up" cleanup: remove the run's worktree AND delete
// its branch, but ONLY when the branch is fully merged into the repo's primary
// branch (isBranchMerged) - an unmerged branch is KEPT so committed work is
// never silently dropped (the merged-to-main gate from the tiered report-back
// design). Unlike goal:deleteWorktree this does NOT remove the run record - the
// report-row "Done" acknowledges the run separately (soft, reversible), and the
// full run stays on the Goal page. Worktree removal is non-force (fail-closed on
// uncommitted changes), matching removeWorktree's own contract.
ipcMain.handle("goal:cleanupRun", (_event, { projectPath, worktreePath, branchName }) => {
  if (!projectPath) {
    return { ok: false, error: "projectPath is required" };
  }
  const result = { ok: true, worktreeRemoved: false, branchDeleted: false, branchKept: null, note: null };

  if (worktreePath) {
    if (!fs.existsSync(worktreePath)) {
      result.worktreeRemoved = true; // already gone from disk
    } else {
      try {
        removeWorktree(projectPath, worktreePath);
        result.worktreeRemoved = true;
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
  }

  // Branch deletion must run AFTER the worktree is gone (git refuses to delete a
  // branch that's checked out in a worktree) and only when merged.
  if (branchName) {
    try {
      if (isBranchMerged(projectPath, branchName)) {
        deleteBranch(projectPath, branchName);
        result.branchDeleted = true;
      } else {
        result.branchKept = branchName;
        result.note = `Branch "${branchName}" has unmerged commits - kept it (delete by hand if unwanted).`;
      }
    } catch (err) {
      result.branchKept = branchName;
      result.note = `Kept branch "${branchName}" - couldn't delete it: ${err?.message || String(err)}`;
    }
  }
  return result;
});

// --- Housekeeping sweep for finished goal worktrees + merged Helm branches ---
//
// `goal:cleanupRun` above does this correctly for ONE run, when the captain
// presses "Done + clean up" on its report row. Nothing swept the runs he never
// pressed, and nothing noticed a branch whose run record had aged out of the
// 200-record history - so those became invisible rather than merely untidy.
// the captain found three by hand on 2026-08-03, one pointing at work merged in July.
//
// Acts only where the action provably cannot lose anything (see
// worktreeSweep.js for the full decision table and why under-cleaning is the
// deliberate bias). Removals go through worktree.js's junction-safe
// removeWorktree - a plain `git worktree remove` follows a node_modules
// junction into the SHARED package folder and empties it, which is exactly what
// happened to this repo (and cascaded into Jot's build output) the same day.
let lastWorktreeSweep = null;
// True between "a sweep is scheduled" and "it finished". Without this the Goal page
// cannot tell "no sweep has ever run" from "the first one has not fired yet", and
// says the former - which is a lie for the first few seconds after launch now that
// the sweep is deferred off the startup path.
let worktreeSweepPending = false;

/** Repos worth sweeping: wherever a goal run has actually run, plus Helm itself. */
function sweepCandidateProjects() {
  const paths = new Set();
  for (const run of loadGoalRunHistory()) {
    if (run?.projectPath) {
      paths.add(run.projectPath);
    }
  }
  paths.add(path.join(__dirname, ".."));
  return [...paths].filter((p) => {
    try {
      return fs.existsSync(path.join(p, ".git"));
    } catch {
      return false;
    }
  });
}

function sweepFinishedGoalWorktrees() {
  const removed = [];
  const kept = [];
  const failed = [];
  // An auto task is dispatched as an autopilot run, so it is IN this history with a
  // status of its own - no separate feed of in-flight auto runs is needed, and the
  // live/resumable gates below already protect it.
  const allRuns = loadGoalRunHistory();
  for (const projectPath of sweepCandidateProjects()) {
    // ONCE per repo. isBranchMerged resolves the primary branch on every call -
    // up to three git spawns each - so a repo with N kept branches paid it N
    // times. An independent review measured 9.6 seconds for 30 unmerged branches
    // in a single repo, all of it blocking Electron's main thread before the first
    // render (2026-08-03).
    let primary;
    const exists = (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    };
    // "Work" means changes outside Helm's own bookkeeping - the dependency
    // junction and the orchestrator's .helm-goal/ notes are untracked in any repo
    // that has not ignored them, and keying on those would keep every finished
    // worktree forever. Fails SAFE: unreadable counts as holding work.
    const isDirty = (worktreePath) => (exists(worktreePath) ? hasUncommittedWork(worktreePath) : false);
    let plan;
    try {
      primary = primaryBranch(projectPath);
      plan = planSweep({
        projectPath,
        worktrees: listWorktrees(projectPath),
        branches: listLocalBranches(projectPath),
        runs: allRuns.filter((r) => r?.projectPath === projectPath),
        isMerged: (branchName) => isBranchMerged(projectPath, branchName, primary),
        isDirty,
        exists,
      });
    } catch (err) {
      // A repo we cannot read is skipped, never guessed at.
      failed.push({ kind: "repo", target: projectPath, reason: err?.message || String(err) });
      continue;
    }
    kept.push(...plan.keep);
    // Worktrees first: git refuses to delete a branch that is still checked out.
    let prunedAny = false;
    for (const action of plan.remove.filter((a) => a.kind === "worktree")) {
      try {
        if (action.prune) {
          // Registered but gone from disk: `git worktree remove` has nothing to do
          // and the entry would survive forever, so prune once after the loop.
          prunedAny = true;
        } else {
          // Never `force`: the sweep must be unable to discard work even if the
          // planner ever decided wrongly. ignoreBookkeeping only narrows what
          // counts as work; the refusal on real changes stays in place.
          removeWorktree(projectPath, action.target, { ignoreBookkeeping: true });
        }
        removed.push(action);
      } catch (err) {
        failed.push({ ...action, reason: err?.message || String(err) });
      }
    }
    if (prunedAny) {
      // Only if EVERY absent worktree git would deregister is one we planned to.
      // Prune is repo-global, and deregistering someone else's absent worktree can
      // make a detached commit collectable.
      const plannedPaths = new Set(
        plan.remove.filter((a) => a.kind === "worktree" && a.prune).map((a) => path.resolve(a.target).toLowerCase())
      );
      try {
        const res = pruneWorktrees(projectPath, {
          onlyIfAllMatch: (p) => plannedPaths.has(path.resolve(p).toLowerCase()),
        });
        if (!res.pruned) {
          failed.push({
            kind: "repo",
            target: projectPath,
            reason: `left the stale worktree registrations alone: pruning would also have deregistered ${res.skipped.join(", ")}`,
          });
        }
      } catch (err) {
        failed.push({ kind: "repo", target: projectPath, reason: `git worktree prune failed: ${err?.message || err}` });
      }
    }
    // Re-derive branches after the removals so a branch freed by this same pass
    // is taken now rather than a restart later. Cheap (one git call per repo).
    let secondPass;
    try {
      secondPass = planSweep({
        projectPath,
        worktrees: listWorktrees(projectPath),
        branches: listLocalBranches(projectPath),
        runs: [],
        isMerged: (branchName) => isBranchMerged(projectPath, branchName, primary),
        isDirty: () => true, // worktrees already handled above; keep them all here
        exists,
      });
    } catch {
      secondPass = { remove: [] };
    }
    for (const action of secondPass.remove.filter((a) => a.kind === "branch")) {
      try {
        // `mergedInto` (not `force`): deleteBranch re-verifies the ancestry itself
        // and only then uses git's forceful delete. Plain `-d` asks a DIFFERENT
        // question - "contained in HEAD" - so with the repo checked out on any
        // other branch it refused every merged branch and the sweep cleaned
        // nothing while logging a failure each start.
        deleteBranch(projectPath, action.target, { mergedInto: primary });
        removed.push(action);
      } catch (err) {
        failed.push({ ...action, reason: err?.message || String(err) });
      }
    }
  }
  // Deduped AND disjoint from what was removed - see reconcileSweepReport for why
  // the same branch used to appear in both lists.
  const { kept: dedupedKept } = reconcileSweepReport({ removed, kept });
  lastWorktreeSweep = { at: Date.now(), removed, kept: dedupedKept, failed };
  worktreeSweepPending = false;
  console.log(`[helm] worktree housekeeping: ${describeSweep(lastWorktreeSweep)}`);
  for (const k of dedupedKept) {
    console.log(`[helm]   kept ${k.kind} ${k.target}: ${k.reason}`);
  }
  return lastWorktreeSweep;
}

// Read the last sweep (for the Goal page's housekeeping line) or run one now.
ipcMain.handle("worktrees:sweepReport", () => ({ ok: true, report: lastWorktreeSweep, pending: worktreeSweepPending }));
ipcMain.handle("worktrees:sweep", () => {
  try {
    return { ok: true, report: sweepFinishedGoalWorktrees() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Coach signal: how far a project's PLAN.md/DECISIONS.md have drifted behind
// the code (commits since a doc was last touched). Read-only; the renderer
// shows a pane-header nudge when stale so state-of-play gets reconciled on the
// commit cadence instead of going stale under a work flurry. See docsStaleness.
ipcMain.handle("docs:staleness", (_event, { cwd }) => {
  try {
    return { ok: true, ...docsStaleness(cwd) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Same signal, board-wide: the ACTIVE half of the docs-drift nudge (task
// 0831417b). The pane-header pill only tells you once you've already opened the
// project, which is exactly backwards for drift you've stopped thinking about -
// so the dashboard lists the projects that need reconciling, with the most recent
// session in each so you can jump straight in.
//
// Deliberately jump-in only: no auto-reconcile, no dispatched doc-reconcile turn.
// Rewriting a project's DECISIONS.md unsupervised is a much bigger promise than
// pointing at it, and getting that wrong quietly corrupts the durable record this
// whole nudge exists to protect.
//
// NEVER BLOCKING, and never silently reassuring - the two things a review of the
// first cut caught.
//
// (1) The sweep is async (staleProjectsAsync) and served stale-while-revalidate.
// The first version called the SYNC sweep straight from the handler: four git
// spawns per repo, measured at ~1.1s for 13 projects, executed on the Electron
// main thread - which stalls every window's IPC, session polling and stream
// handling for that whole time, once a minute, growing with your project count.
// Now a request past the TTL kicks off a background refresh and returns the
// last-known rows immediately.
//
// (2) The reply distinguishes "looked, nothing drifting" from "could not look".
// readAllSessions returns its failure in an `error` FIELD rather than throwing, and
// docsStaleness swallows a missing git per repo - so the first version turned both
// into a confident `rows: []`, which the UI renders as "docs are current". A nudge
// that can't look must not claim there is nothing to see.
// Monotonic across invocations, not per-run: deriving the port from a per-call index
// meant two "Run checks" clicked at once handed their first child the same port, so
// one attached to the other's app - the wrong-app-attach bug, reintroduced across
// invocations instead of within one.
let checkPortCursor = 0;
let staleProjectsCache = { at: 0, rows: [], unchecked: 0, uncheckedPaths: [], considered: 0, parked: 0, dormant: 0, dormantDays: 0, error: null };
let staleProjectsRefreshing = null;
// Bumped whenever a decision invalidates an in-flight sweep (parking a project).
// The sweep captured its candidate list before that decision, so its result is
// already wrong by the time it lands - see docs:parkProject.
let staleProjectsGeneration = 0;
const STALE_PROJECTS_TTL_MS = 60_000;

async function refreshStaleProjects() {
  // Remember which decisions this sweep is based on. If that changes while the git
  // calls are in flight (the user parks a project), the result is stale before it
  // lands and must not be published.
  const generation = staleProjectsGeneration;
  // Candidate projects = where you've actually been working. An archived session's
  // project still counts: archiving the session is what leaves the docs as the only
  // record, so that is when drift matters MOST.
  const all = readAllSessions();
  const sessions = all.sessions || [];
  const cfg = loadConfig();
  const hidden = new Set(loadConfig().hiddenSessions || []);
  // Projects deliberately set aside - work repos, or ones he has decided not to
  // reconcile. Parked is NOT the same as fixed, so they are reported separately
  // rather than vanishing without trace.
  const parked = new Set((cfg.parkedDocsProjects || []).map((p) => String(p).toLowerCase()));
  const newestByPath = new Map();
  for (const s of sessions) {
    if (!s.cwd) {
      continue;
    }
    // Keyed on the RESOLVED path, matching what the sweep returns - the same repo
    // appears as both D:\Repo\... and d:/Repo/... across sessions, and a raw-string
    // key would both split one project in two and fail the lookup below.
    let key;
    try {
      key = path.resolve(s.cwd).toLowerCase();
    } catch {
      continue;
    }
    // Any session makes the project a CANDIDATE, but only a session you can
    // actually open is a jump-in target: re-opening a session you explicitly
    // removed from Helm would be the app overruling that removal.
    const jumpable = !s.isArchived && !hidden.has(s.sessionId);
    const prev = newestByPath.get(key);
    if (!prev) {
      // touchedAt tracks the newest activity from ANY session in this project,
      // jumpable or not - an archived session still proves you were working here,
      // and the age-out below must not treat archiving as abandonment.
      newestByPath.set(key, { cwd: s.cwd, jumpTarget: jumpable ? s : null, touchedAt: s.lastActivityAt || 0 });
      continue;
    }
    prev.touchedAt = Math.max(prev.touchedAt, s.lastActivityAt || 0);
    if (jumpable && (!prev.jumpTarget || (s.lastActivityAt || 0) > (prev.jumpTarget.lastActivityAt || 0))) {
      prev.jumpTarget = s;
    }
  }
  const { candidates, parked: parkedCount, dormant } = docsNudgeCandidates(
    [...newestByPath.entries()].map(([key, v]) => ({ key, cwd: v.cwd, touchedAt: v.touchedAt })),
    { parked: [...parked] }
  );
  const swept = await staleProjectsAsync(candidates);
  const rows = swept.rows.map((row) => {
    const target = newestByPath.get(row.path.toLowerCase())?.jumpTarget;
    return {
      ...row,
      name: path.basename(row.path),
      sessionId: target?.sessionId || null,
      lastActivityAt: target?.lastActivityAt || 0,
    };
  });
  if (generation !== staleProjectsGeneration) {
    // Something was parked while this ran. Publishing now would put the parked row
    // back on screen and mark it fresh for another minute. Leave the cache expired
    // so the next read starts a sweep with the current candidate list.
    return staleProjectsCache;
  }
  staleProjectsCache = {
    at: Date.now(),
    rows,
    unchecked: swept.unchecked,
    uncheckedPaths: swept.uncheckedPaths,
    considered: swept.considered,
    parked: parkedCount,
    dormant,
    dormantDays: DOCS_NUDGE_ACTIVE_DAYS,
    // A sessions-dir failure means the candidate list itself is empty for the
    // wrong reason - report it rather than letting it look like a clean board.
    error: all.error || null,
  };
  return staleProjectsCache;
}

ipcMain.handle("docs:staleProjects", async (_event, { force = false } = {}) => {
  try {
    const fresh = Date.now() - staleProjectsCache.at < STALE_PROJECTS_TTL_MS;
    if (force) {
      const c = await (staleProjectsRefreshing || (staleProjectsRefreshing = refreshStaleProjects().finally(() => {
        staleProjectsRefreshing = null;
      })));
      return { ...driftPayload(c), cached: false, pending: false };
    }
    if (!fresh && !staleProjectsRefreshing) {
      // Fire and forget: the next poll picks up the result. A failure here must not
      // become an unhandled rejection.
      staleProjectsRefreshing = refreshStaleProjects()
        .catch((err) => {
          staleProjectsCache = { ...staleProjectsCache, at: Date.now(), error: err?.message || String(err) };
          return staleProjectsCache;
        })
        .finally(() => {
          staleProjectsRefreshing = null;
        });
    }
    const c = staleProjectsCache;
    return {
      ...driftPayload(c),
      cached: fresh,
      // Nothing has ever been measured yet, so an empty list means "not known",
      // not "all current".
      pending: c.at === 0,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), rows: [], unchecked: 0, uncheckedPaths: [], considered: 0, parked: 0, dormant: 0, pending: false };
  }
});

/** One shape for the drift readout, so the cached and forced paths can't diverge. */
function driftPayload(c) {
  return {
    ok: !c.error,
    error: c.error,
    rows: c.rows,
    unchecked: c.unchecked,
    uncheckedPaths: c.uncheckedPaths || [],
    considered: c.considered,
    parked: c.parked || 0,
    dormant: c.dormant || 0,
    dormantDays: c.dormantDays || 0,
  };
}

// Park (or un-park) a project so its docs drift stops being nudged about. The captain's
// case: tidepool is a work repo he cannot reconcile while on leave, and a row
// he can never act on is what teaches him to stop reading the whole section.
// Parking is reversible and counted in the readout, so it can't quietly hide drift.
ipcMain.handle("docs:parkProject", (_event, { path: projectPath, parked = true } = {}) => {
  if (!projectPath || typeof projectPath !== "string") {
    return { ok: false, error: "No project path." };
  }
  let key;
  try {
    key = path.resolve(projectPath).toLowerCase();
  } catch {
    return { ok: false, error: "That path can't be resolved." };
  }
  // writeConfig THROWS when the file can't be written (another program holding it,
  // a full disk). Without this guard the throw crosses the channel as a rejected
  // promise, the renderer's `await` throws inside a click handler, and the button
  // is left disabled with no message - the user sees a dead control instead of
  // "couldn't park it". Every config-writing handler owes the caller an answer.
  try {
    const cfg = loadConfig();
    const current = (cfg.parkedDocsProjects || []).map((p) => String(p).toLowerCase());
    const next = parked ? [...new Set([...current, key])] : current.filter((p) => p !== key);
    writeConfig({ ...cfg, parkedDocsProjects: next });
    // Expire the cached sweep so the next read reflects the decision.
    //
    // `at: 1`, not `at: 0`. Zero is the sentinel for "never measured", which the
    // renderer reports as `pending` and draws as nothing at all - so clicking Park
    // made the whole docs-drift module vanish until the background sweep landed.
    // One is in the past, so it reads as stale-and-refetch, which is the truth.
    //
    // The generation bump handles the other half: a sweep that started BEFORE this
    // park is still running, and it ends by assigning the whole cache object
    // (candidate list and all) with a fresh timestamp. Without this it would put
    // the parked row straight back and mark it fresh for another minute.
    staleProjectsGeneration += 1;
    staleProjectsCache = { ...staleProjectsCache, at: 1 };
    return { ok: true, parked: next.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("docs:parkedProjects", () => {
  const list = (loadConfig().parkedDocsProjects || []).map((p) => ({ path: p, name: path.basename(p) }));
  return { ok: true, parked: list };
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
// data-volume trigger, not a wall-clock one (e.g. "weekly") — the captain's usage
// is bursty (some nights many runs, some days none), so a fixed calendar
// interval would either fire on stale/unchanged data or sit silent through
// a heavy stretch. The check itself is nearly free (readUsageSummary parses
// the local usage-log.jsonl already read for the on-demand report; no model
// call), so the real cost this trigger controls isn't compute — it's how
// often the captain gets re-nagged about a finding he already saw. 10 new judged
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

// Liveness readout for the Settings page (see "orchestrator:sweepStatus"
// IPC handler below) - the sweep has real cost (classification calls,
// auto-compact) but runs silently on a timer, so if it ever stalls
// (sweepInFlight stuck true) or a classify call throws, the only visible
// symptom is "sessions stopped getting tagged", which is easy to miss.
// classifiedCount is just toClassify.length from the last run that reached
// that point - cheap to record, not a new metric the sweep didn't already
// compute.
let lastSweepStatus = { lastRunAt: null, ok: null, classifiedCount: 0, error: null };

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
    const classifiedCount = await runOrchestratorSweepBody(config, { classifyOn, compactOn, accuracyCheckOn });
    lastSweepStatus = { lastRunAt: Date.now(), ok: true, classifiedCount: classifiedCount || 0, error: null };
  } catch (err) {
    lastSweepStatus = { lastRunAt: Date.now(), ok: false, classifiedCount: 0, error: String(err?.message || err) };
    throw err;
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
  // streaming a turn run OUTSIDE Helm, and compacting a live session
  // would be a real problem. "idle" (aged past the window) is safely parked,
  // and matches the captain's "aktiv men idle" framing for what to auto-compact.
  // Sessions "removed from Helm" (config.hiddenSessions) are excluded too: they
  // are gone from every Helm view, so Helm must not keep spending on classifying
  // them - and, more importantly, must not auto-COMPACT (mutate) a session the
  // user explicitly told it to stop managing. Distinct from archived (isArchived
  // above); see config.js and isHiddenFromHelm in renderer.js.
  const hidden = new Set(config.hiddenSessions || []);
  const candidates = sessions.filter(
    (s) => !s.isArchived && !hidden.has(s.sessionId) && (s.status === "waiting" || s.status === "idle")
  );

  // Returned to the caller for the "orchestrator:sweepStatus" liveness readout.
  let classifiedCount = 0;

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
      classifiedCount++;
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
        console.error("[helm] orchestrator helper classification failed:", err);
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
    // Time-since-last-activity gate (the captain's refinement) rather than the
    // coarse waiting/idle status: don't compact a session being actively
    // worked, but do tidy one left silent past idleMinutes (e.g. over
    // lunch) even if it's technically still "waiting". This also makes the
    // earlier "could it be mid-turn outside Helm?" worry moot — 30+ min
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
        console.error("[helm] auto-compact failed:", err);
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

  return classifiedCount;
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
  // confirms the heuristic is fine and isn't worth interrupting the captain about.
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

// --- First-mate tier: the dispatch request watcher (design section 1 "A1" +
// section 4). The app is the single dispatch authority: it watches the
// meta-home request inbox, and for each new request validates it, enforces the
// width + depth caps, acks accept/reject back to the mate (so the
// helm_dispatch tool can return promptly), launches the run via the SAME
// startGoalRun the Goal-page IPC uses (stamped with dispatch metadata), and on
// completion writes the compact report to the report inbox for the mate to pull
// with helm_collect_reports.
//
// fs.watch is coalescing/duplicative and platform-inconsistent, so it only ever
// TRIGGERS a full re-scan of the inbox (processDispatchRequests) rather than
// being trusted to name each file exactly once; a slow poll backstops it in
// case a watch event is missed entirely. Each request is deleted (removeRequest)
// the moment it is picked up, so a re-scan never double-launches it.
let dispatchWatcher = null;
let dispatchScanInFlight = false;

// The width + depth cap predicates are pure functions in lib/dispatchCaps.js
// (single definition, unit-testable without Electron). main.js is the sole
// authority that calls them, feeding a plain snapshot of the live dispatched
// runs from liveGoalRuns.
function liveRunSnapshot() {
  return [...liveGoalRuns.entries()].map(([goalRunId, run]) => ({
    goalRunId,
    dispatchedBy: run.dispatchedBy || null,
  }));
}

// Phase-2 Slice 4b relay (ASYNC, the captain's call): spawn an internal second-mate
// turn to handle a first mate's relayed message, then return immediately. The
// second mate does its work (dispatches crew, etc.) and reports back up via
// helm_report_up - no long synchronous tool call, so nothing can time out. It
// resumes the bound session (or starts a fresh one), guarded by the per-session
// turn lock so it never races a direct pane turn on the same session.
// Returns { ok } (turn launched) or { ok:false, error } (busy / no parent).
/**
 * Hand a message to a second mate: resume its session, or start one in the project
 * and bind it. This is the dispatch path for BOTH a first mate's relay and the
 * auto-captain - one mechanism, so the auto path can't drift into a second, less
 * careful copy of the locking and binding done here.
 *
 * `allowDirect` is what separates them. A relay only makes sense first-mate ->
 * second-mate, so a second mate with no parent is refused. The auto-captain
 * deliberately skips first mates (the card already names its project, so there is
 * no cross-project prioritising to do), and passes allowDirect to say so.
 *
 * `startedBy` is stamped on the session record so an auto-started run is
 * identifiable afterwards - it is what puts the run in the Auto column instead of
 * mixing it in with work the captain started by hand.
 */
function runRelayTurn(metaHome, { secondMateId: smId, projectPath, message, allowDirect = false, startedBy = null, onFinished = null }) {
  const binding = readBindings()[smId] || {};
  const resumeSessionId = binding.sessionId || null;
  // Lock per bound session, OR per second mate when there's no session yet - so
  // two rapid relays to an UNBOUND second mate can't both start a fresh Opus
  // session in the same repo before the first one binds (review CONFIRMED #1).
  const lockKey = resumeSessionId || "sm:" + smId;
  if (sessionTurnLocks.has(lockKey)) {
    return { ok: false, error: "That second mate is busy with a turn right now - try again once it's idle." };
  }
  // Resolve the parent first mate from the derived second mate (same source as
  // the session:start path); "direct" second mates have no first mate to report
  // up to, so a relay to one is refused (a relay only makes sense mate->mate).
  const derivedSm = deriveSecondMates(loadGoalRunHistory()).find((s) => s.secondMateId === smId);
  const parentFirstMate = derivedSm?.firstMateId;
  const parentMateId = parentFirstMate && parentFirstMate !== "direct" ? parentFirstMate : null;
  if (!parentMateId && !allowDirect) {
    return { ok: false, error: "No parent first mate for this second mate - relay only works first-mate -> second-mate." };
  }
  ensureDispatchDirs(metaHome);
  const mcpConfig = buildDispatchMcpConfig(metaHome, smId, "second-mate", parentMateId);
  sessionTurnLocks.add(lockKey);
  const childKey = "relay-" + smId + "-" + Date.now();
  let relayCostUsd = 0;
  // For a FRESH relay (no session yet) we hold "sm:<id>", but session:start locks
  // on the raw session id. When this turn mints + binds its session mid-turn, a
  // concurrent jump-in on that session wouldn't see the "sm:" key and could
  // --resume the same live transcript -> corruption. So we ALSO lock the bound
  // session id and release it with the primary key (ship-review CONFIRMED).
  let boundSessionKey = null;
  // Live-turn tracking so the second mate's session shows "working" while this
  // relay turn runs (task 5939df) - same reason as the interactive path.
  let liveTurnId = resumeSessionId || null;
  if (liveTurnId) {
    markSessionLive(liveTurnId);
  }
  let child;
  let done;
  try {
    ({ child, done } = startSession({
      cwd: projectPath,
      prompt: message,
      model: "claude-opus-4-8",
      mcpConfig,
      allowedTools: FIRST_MATE_ALLOWED_TOOLS,
      // A fresh relay turn boots the second mate with its full manual; a resumed
      // one gets the condensed delegate-vs-do reminder so the guardrail persists
      // on every turn instead of relying on it still being in context (9c358433).
      appendSystemPrompt: secondMateAppendPrompt(resumeSessionId, secondMateInstructions()),
      strictMcpConfig: false,
      resumeSessionId,
      onEvent: (evt) => {
        if (evt.kind === "session" && evt.sessionId) {
          if (!liveTurnId) {
            liveTurnId = evt.sessionId;
            markSessionLive(liveTurnId);
          }
          try {
            // Bind so the second mate owns its crew dispatches + a later
            // relay/jump-in resumes the SAME session, and index it so the
            // relay-driven session shows in the session list like a jumped-into
            // one (review PLAUSIBLE #3).
            bindSecondMateSession(smId, evt.sessionId);
            // Close the fresh-bind window (see boundSessionKey note above): the
            // session now appears in the session list, so lock its id too before
            // a jump-in can race it. Resumed turns already lock on the id via
            // lockKey, so only fresh launches need this.
            if (!resumeSessionId && !boundSessionKey) {
              boundSessionKey = evt.sessionId;
              sessionTurnLocks.add(evt.sessionId);
            }
            // createIfAbsent is always true here, not just on a fresh launch: this
            // is a SECOND-MATE-BOUND session, Helm's own durable pointer to it, and
            // relying only on the Desktop app's rolling local_*.json index left a
            // mate permanently unable to find its own session once that index
            // rotated the entry out (the first-mate sibling of this bug, fixed the
            // same day - see the comment on the first-mate recordHelmSession call).
            recordHelmSession(evt.sessionId, {
              cwd: projectPath,
              model: "claude-opus-4-8",
              title: message.trim().split("\n")[0].slice(0, 80) || "(second mate)",
              startedBy,
              createIfAbsent: true,
            });
          } catch {
            // best effort
          }
        } else if (evt.kind === "result") {
          relayCostUsd = evt.costUsd || 0;
        }
      },
    }));
  } catch (err) {
    sessionTurnLocks.delete(lockKey);
    markSessionDone(liveTurnId);
    return { ok: false, error: `Failed to start the relay turn: ${err?.message || String(err)}` };
  }
  liveChildren.set(childKey, child);
  // Fire-and-forget: on turn end, release BOTH locks (primary + any bound-session
  // key), drop the child handle (review #2 - no leak), count the turn's own cost
  // against the orchestration budget (review #3), and refresh the fleet so the
  // report-up surfaces. NOT awaited.
  done.then(() => {
    sessionTurnLocks.delete(lockKey);
    if (boundSessionKey) {
      sessionTurnLocks.delete(boundSessionKey);
    }
    markSessionDone(liveTurnId);
    liveChildren.delete(childKey);
    addSpend(metaHome, relayCostUsd);
    writeFleetStateSnapshot(metaHome);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("dispatch:report", { kind: "relay", secondMateId: smId });
    }
    if (onFinished) {
      try {
        onFinished();
      } catch (err) {
        // A caller's bookkeeping must never take the turn teardown with it.
        console.error("[helm] relay onFinished failed:", err?.message || err);
      }
    }
  });
  return { ok: true };
}

function processDispatchRequests(metaHome) {
  if (dispatchScanInFlight) {
    return;
  }
  dispatchScanInFlight = true;
  try {
    // OWNERSHIP scoping (cross-instance orphaning bug, 2026-07-12): the queue
    // lives under the shared meta-home, so a dev build and the installed build
    // both watch it - but each has its OWN mate store. Snapshot the mates THIS
    // instance owns once per scan; a request whose dispatching mate isn't ours
    // is left in the queue (not claimed) for the instance that owns it. Without
    // this, whichever instance won the claim race would double-run the goal and
    // orphan the report under a mateId absent from its store. See
    // lib/dispatchCaps.js isForeignDispatch.
    // Owned dispatchers = this instance's first mates AND its second mates (the
    // latter dispatch crew in Phase 2; their ids are the keys of second-mates.json).
    // Without the second-mate ids here, a crew dispatch whose dispatchedBy is a
    // secondMateId would be treated as foreign and never claimed (Slice 0 fix).
    const ownedMateIds = new Set([...loadMates().map((m) => m.mateId), ...Object.keys(readBindings())]);
    for (const request of readRequests(metaHome)) {
      const dispatchId = request.dispatchId;
      if (!dispatchId) {
        continue;
      }
      if (isForeignDispatch(request, ownedMateIds)) {
        continue;
      }
      // Atomically CLAIM the request before doing anything with it. This closes
      // both the in-process double-scan (fs.watch + poll) AND the cross-process
      // race where two Helm instances watch the same meta-home (review H1):
      // renameSync has exactly one winner, so only one instance launches the
      // run. We already hold the data in `request`; drop the claimed file.
      if (!claimRequest(metaHome, dispatchId)) {
        continue; // another instance / an earlier scan claimed it first
      }
      removeRequest(metaHome, dispatchId);

      const reject = (reason) => {
        writeAck(metaHome, dispatchId, { status: "rejected", reason });
      };

      // Phase-2 Slice 4b: a lightweight "propose a second mate" request from a
      // first mate (the daily-loop "lay out A/B/C" step). Just registers the lazy
      // proposal + acks with the id - no run, so it's NOT gated by budget/kill.
      if (request.kind === "propose-second-mate") {
        // No `|| request.project` fallback: resolveDispatchProject already
        // accepts a valid absolute-path escape hatch and returns null for an
        // unknown name/path - falling back to the raw string would register a
        // phantom second mate at a bogus path (review CONFIRMED).
        const proposeProject = resolveDispatchProject(request.project);
        if (!proposeProject) {
          reject(`Unknown project "${request.project}". Call helm_list_projects, or pass an explicit absolute repo path.`);
          continue;
        }
        try {
          unarchiveSecondMateForNewWork(secondMateId(request.dispatchedBy || "direct", proposeProject));
          const sm = proposeSecondMate(request.dispatchedBy || "direct", proposeProject, { brief: request.brief });
          writeAck(metaHome, dispatchId, { status: "accepted", secondMateId: sm.secondMateId });
          writeFleetStateSnapshot(metaHome);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("dispatch:report", { kind: "propose", secondMateId: sm.secondMateId });
          }
        } catch (err) {
          reject(`Failed to propose second mate: ${err?.message || String(err)}`);
        }
        continue;
      }

      // Phase-2 Slice 4b relay (async): a first mate drives a second mate without
      // the captain jumping in. Ensure the second mate exists (propose so its
      // parent resolves), then launch an internal second-mate turn fire-and-forget
      // and ack the ACCEPT immediately (the response comes later via report-up).
      // A relay spins up a real Opus second-mate turn that burns tokens on its
      // OWN, so it MUST honor the kill switch and budget ceiling (ship-review:
      // the earlier "allow the relay turn" reasoning only covered the crew it
      // dispatches, not the relay turn's own cost - a genuine guardrail bypass).
      if (request.kind === "relay") {
        if (isKilled(metaHome)) {
          reject("Orchestration stopped by the kill switch. Resume it from the Dashboard before relaying again.");
          continue;
        }
        if (isOverBudget(metaHome)) {
          reject("Orchestration paused: the token/cost budget ceiling was reached. Raise or reset the budget from the Dashboard.");
          continue;
        }
        const relayProject = resolveDispatchProject(request.project);
        if (!relayProject) {
          reject(`Unknown project "${request.project}". Call helm_list_projects, or pass an explicit absolute repo path.`);
          continue;
        }
        if (!(request.message || "").trim()) {
          reject("A relay needs a non-empty message.");
          continue;
        }
        const smId = secondMateId(request.dispatchedBy || "direct", relayProject);
        try {
          unarchiveSecondMateForNewWork(smId);
          proposeSecondMate(request.dispatchedBy || "direct", relayProject, {});
        } catch {
          // non-fatal - runRelayTurn resolves the parent from the derived mate
        }
        const relayRes = runRelayTurn(metaHome, { secondMateId: smId, projectPath: relayProject, message: request.message });
        if (relayRes.ok) {
          writeAck(metaHome, dispatchId, { status: "accepted", secondMateId: smId, async: true });
        } else {
          reject(relayRes.error);
        }
        continue;
      }

      // Phase-2 Slice 6: "fortsätt" cascade. Resume every resumable run under
      // this first mate's tree. Each resume is individually guardrail-gated.
      if (request.kind === "resume-fleet") {
        const res = resumeFleet(request.dispatchedBy || null);
        writeAck(metaHome, dispatchId, { status: "accepted", resumed: res.resumed, total: res.total });
        continue;
      }

      // Guardrails (Phase-2 Slice 0): a killed or over-budget orchestration
      // accepts no further dispatch. Checked before any work is started.
      if (isKilled(metaHome)) {
        reject("Orchestration stopped by the kill switch. Resume it from the Dashboard before dispatching again.");
        continue;
      }
      if (isOverBudget(metaHome)) {
        reject("Orchestration paused: the token/cost budget ceiling was reached. Raise or reset the budget from the Dashboard.");
        continue;
      }

      // Validate the project (known enum or explicit absolute path escape
      // hatch, design decision 5).
      const projectPath = resolveDispatchProject(request.project);
      if (!projectPath) {
        reject(`Unknown project "${request.project}". Call helm_list_projects, or pass an explicit absolute repo path.`);
        continue;
      }
      // Depth cap (belt-and-suspenders; structurally a dispatched run never
      // gets the dispatch tools).
      const snapshot = liveRunSnapshot();
      if (depthCapExceeded(snapshot, request)) {
        reject(`Dispatch refused: a dispatched run may not dispatch (depth cap ${DISPATCH_DEPTH_CAP}).`);
        continue;
      }
      // Width cap: at most DISPATCH_WIDTH_CAP concurrent dispatched runs per mate.
      const mateId = request.dispatchedBy || null;
      if (widthCapExceeded(snapshot, mateId, DISPATCH_WIDTH_CAP)) {
        reject(
          `Dispatch refused: width cap of ${DISPATCH_WIDTH_CAP} concurrent runs reached. Wait for a report before dispatching more.`
        );
        continue;
      }

      // Accept: launch through the shared startGoalRun, stamped with dispatch
      // metadata, and wire the report-back on completion.
      let goalRunId = null;
      try {
        const started = startGoalRun({
          projectPath,
          goal: request.goal,
          maxIterations: request.maxIterations || undefined,
          // Model-per-tier: the dispatch tool already defaults model to opus;
          // honor whatever the request carries.
          model: request.model || undefined,
          effort: request.effort || undefined,
          verifyCommand: request.verifyCommand || undefined,
          dispatch: {
            dispatchedBy: mateId,
            dispatchId,
            tier: request.tier || "crew",
            onComplete: (result, meta) => {
              const report = buildDispatchReport({ dispatchId, mateId, request, result, meta });
              writeReport(metaHome, report);
              // Count this run's cost against the orchestration budget (Slice 0).
              addSpend(metaHome, report.costUsd);
              writeFleetStateSnapshot(metaHome); // a run finished - refresh the cross-mate view
              // Nudge the renderer to repaint the fleet NOW so the crew report
              // surfaces under its first-mate card (and the "collect & continue"
              // triage cue appears) immediately, instead of on the next poll
              // tick. Best-effort: the poll-tick refresh still backstops it.
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("dispatch:report", { dispatchId, mateId });
              }
            },
          },
        });
        goalRunId = started.goalRunId;
      } catch (err) {
        reject(`Failed to start the dispatched run: ${err?.message || String(err)}`);
        continue;
      }
      writeAck(metaHome, dispatchId, { status: "accepted", goalRunId });
    }
  } catch (err) {
    console.error("[helm] dispatch request scan failed:", err);
  } finally {
    dispatchScanInFlight = false;
  }
}

// Builds the compact report (design section 2) from a finished dispatched run's
// runGoal result - NOT the transcript; it points to the worktree. needsCaptain
// is the load-bearing field: the escalation detail when escalated, a soft
// "review N commits" nudge when commits are ready, else null.
function buildDispatchReport({ dispatchId, mateId, request, result, meta }) {
  if (meta.status === "error" || !result) {
    return {
      dispatchId,
      dispatchedBy: mateId,
      project: request.project,
      goal: request.goal,
      tier: request.tier || "crew",
      status: "error",
      summary: meta.error || "The dispatched run errored.",
      needsCaptain: meta.error || "The dispatched run errored; inspect and re-dispatch.",
    };
  }
  const escalated = result.stoppedReason === "escalated";
  const commitCount = typeof result.commitCount === "number" ? result.commitCount : 0;
  const lastImplement = [...(result.iterations || [])]
    .reverse()
    .find((r) => r.ok && r.result && r.phase === "implement");
  const summary = escalated
    ? result.escalation?.detail || "Run paused for a human decision."
    : lastImplement?.result?.summary || `Run stopped: ${result.stoppedReason}.`;
  let needsCaptain = null;
  if (escalated) {
    needsCaptain = result.escalation?.detail || "Run paused - needs a human decision.";
  } else if (commitCount > 0) {
    needsCaptain = `${commitCount} commit(s) ready for review in ${result.branchName}.`;
  }
  const totalCost = (result.iterations || []).reduce((sum, r) => sum + (typeof r.costUsd === "number" ? r.costUsd : 0), 0);
  return {
    dispatchId,
    dispatchedBy: mateId,
    project: request.project,
    goal: request.goal,
    tier: request.tier || "second-mate",
    status: escalated ? "escalated" : "done",
    summary,
    changed: {
      commitCount,
      branchName: result.branchName || null,
      worktreePath: result.worktreePath || null,
    },
    needsCaptain,
    stoppedReason: result.stoppedReason || null,
    costUsd: Number(totalCost.toFixed(4)),
    iterations: (result.iterations || []).length,
  };
}

const DISPATCH_POLL_INTERVAL_MS = 5000;

function startDispatchWatcher() {
  const metaHome = resolveMetaHome();
  try {
    ensureDispatchDirs(metaHome);
  } catch (err) {
    console.error("[helm] could not create the dispatch inbox dirs:", err);
    return;
  }
  // Named mates: guarantee the two fixed first-mate slots exist (each with a
  // random sea-captain name) so the Fleet tree always has its two roots to show,
  // even before the captain has jumped into either.
  // Heal fleet-node parkings that can no longer mean anything (see the function's
  // own note). At startup, before the first render, so the Fleet is right the first
  // time rather than after a refresh.
  pruneStaleArchivedFleetNodes();
  // Clean up after finished autonomous runs, so their worktrees and merged
  // branches stop accumulating where nothing looks. Provably-lossless actions
  // only; everything else is kept with a reason and shown on the Goal page.
  //
  // DEFERRED, not inline: every git call in it is synchronous, and an independent
  // review measured 9.6 seconds for one repo with 30 kept branches - all of it
  // freezing the main thread before the first paint (2026-08-03). Housekeeping is
  // never urgent, so it waits until the window has had a chance to render.
  worktreeSweepPending = true;
  // AT 12 SECONDS, not 4. Every git call in the sweep is synchronous, so while it runs
  // the main process answers nothing - and at t+4s that lands exactly when the window
  // has just painted and the first clicks arrive. Measured on 2026-08-03: an unrelated
  // cheap IPC issued during startup took 421ms, while the same call in a settled app
  // takes 3ms. That is the "hela appen laggar faktiskt till ibland" and the "segare än
  // tidigare" - the review queue I suspected first costs 11ms once git's caches are
  // warm, so it was not the offender.
  //
  // Moving it is a mitigation, not the fix. The fix is for those git calls to be async,
  // which is a real change to worktree.js and its tests - filed rather than rushed.
  setTimeout(() => {
    const sweepStartedAt = Date.now();
    try {
      sweepFinishedGoalWorktrees();
      console.log(`[helm] worktree housekeeping blocked the main process for ${Date.now() - sweepStartedAt}ms`);
    } catch (err) {
      worktreeSweepPending = false;
      console.error("[helm] worktree housekeeping failed:", err?.message || err);
    }
    // Same deferral, same reason (board file I/O before first paint), and it has to
    // run whether or not the auto-captain is switched on: a card stranded by an
    // interrupted run keeps lying about being worked on even after the feature is
    // turned off.
    try {
      reconcileStrandedAutoCards();
    } catch (err) {
      console.error("[helm] stranded auto card check failed:", err?.message || err);
    }
  }, 12000);
  // Put the auto-captain's tags on the board so the feature can actually be
  // reached: "auto" is the tag the user applies, and until now nothing created
  // it, so there was nothing to pick in Jot. Idempotent, and it does not touch
  // the file when all three already exist.
  try {
    const seeded = ensureTagsExist(loadConfig().jot || {}, AUTO_CAPTAIN_TAGS);
    if (seeded.added.length > 0) {
      console.log(`[helm] added Jot tags for the auto-captain: ${seeded.added.join(", ")}`);
    }
  } catch (err) {
    console.error("[helm] could not add the auto-captain's Jot tags:", err?.message || err);
  }
  try {
    ensureMates(metaHome, configuredMateSlots());
  } catch (err) {
    console.error("[helm] could not ensure the two first mates:", err);
  }
  // Report-back reconciliation (review M2): a dispatched run that finished or
  // was interrupted while the app was down never fired its in-memory report
  // closure. Synthesize the missing report from the persisted history so the
  // mate's helm_collect_reports still hears back. liveGoalRuns is empty at
  // startup, so every terminal/interrupted dispatched record with no report is
  // covered; a still-live run is skipped (its own onComplete will report).
  try {
    const existingReportIds = new Set(readReports(metaHome).map((r) => r.dispatchId));
    const liveIds = new Set(liveGoalRuns.keys());
    const now = Date.now();
    for (const rec of recordsNeedingReport(loadGoalRunHistory(), existingReportIds, liveIds, metaHome)) {
      writeReport(metaHome, buildReportFromRecord(rec, now));
    }
  } catch (err) {
    console.error("[helm] dispatch report reconciliation failed:", err);
  }
  // Fleet-state snapshot for the fleet-aware focus survey (e07a2c5d): refresh at
  // startup + on each poll so a surveying first mate reads a reasonably fresh
  // cross-mate view. Also refreshed right after a report is written (state
  // changed) - see writeReport call in processDispatchRequests' onComplete.
  writeFleetStateSnapshot(metaHome);
  // Sweep once at startup so a request written while the app was down (or an
  // ack that never got picked up) is handled promptly.
  processDispatchRequests(metaHome);
  try {
    dispatchWatcher = fs.watch(requestsDir(metaHome), { persistent: false }, () => {
      processDispatchRequests(metaHome);
    });
  } catch (err) {
    // fs.watch can fail on some filesystems - the poll below still covers it.
    console.error("[helm] fs.watch on the dispatch inbox failed (falling back to poll only):", err);
  }
  setInterval(() => {
    processDispatchRequests(metaHome);
    writeFleetStateSnapshot(metaHome);
  }, DISPATCH_POLL_INTERVAL_MS);
}

// Assembles + writes the compact cross-mate fleet-state snapshot the
// helm_fleet_state tool serves. Best-effort - never throws into a caller.
function writeFleetStateSnapshot(metaHome) {
  try {
    writeFleetState(metaHome, assembleFleetState(activeMates(), loadGoalRunHistory(), Date.now()));
  } catch (err) {
    console.error("[helm] could not write fleet-state snapshot:", err);
  }
}

// Fire a routine: launch its prompt as a headless claude -p session (the same
// launcher every session uses), rooted at its cwd (falling back to the meta
// home). Streams events to the renderer under a fresh launchId and records the
// run in Helm's session index so it shows up like any other session, titled
// "⏰ <name>". Deliberately does NOT go through the session:start HANDLER, so a
// routine at the meta home is a plain session, never a first mate. Best-effort:
// a routine that fails to launch must not crash the scheduler.
function fireRoutine(routine) {
  try {
    const cwd = routine.cwd || resolveMetaHome();
    const launchId = crypto.randomUUID();
    const send = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("session:event", { launchId, ...payload });
      }
    };
    let recorded = false;
    let liveTurnId = null;
    // A routine fire is a Helm-owned launch too, so it gets the same pre-output
    // launching window (Epic f3d096fa).
    liveSessions.markLaunching(launchId, null);
    const { child, done } = startSession({
      cwd,
      prompt: routine.prompt,
      model: routine.model || undefined,
      effort: routine.effort || undefined,
      permissionMode: "default",
      onEvent: (evt) => {
        if (evt.kind === "session" && evt.sessionId && !liveTurnId) {
          liveTurnId = evt.sessionId;
          markSessionLive(liveTurnId);
          // Without this bind the launching entry keeps its null session id, so
          // isLaunching() can never match it and the routine's launching window
          // is silently inert.
          liveSessions.bindLaunch(launchId, liveTurnId);
        }
        // First real output ends the launching window (same rule as session:start).
        if (evt.kind === "assistant" || evt.kind === "tool_use" || evt.kind === "result") {
          liveSessions.clearLaunching(launchId);
        }
        if (evt.kind === "session" && evt.sessionId && !recorded) {
          recorded = true;
          recordHelmSession(evt.sessionId, {
            cwd,
            model: routine.model || "",
            effort: routine.effort || "",
            permissionMode: "default",
            title: `⏰ ${routine.name}`,
            createIfAbsent: true,
          });
        }
        if (evt.kind === "quota" && evt.quota) {
          recordQuota(evt.quota);
        }
        send(evt);
      },
    });
    liveChildren.set(launchId, child);
    done
      .then((summary) => {
        liveChildren.delete(launchId);
        markSessionDone(liveTurnId);
        liveSessions.clearLaunching(launchId);
        send({ kind: "done", summary });
        if (summary.sessionId) {
          recordHelmSession(summary.sessionId, { createIfAbsent: false });
        }
        if (loadConfig().notifyOnComplete !== false && summary.sawResult && Notification.isSupported()) {
          new Notification({ title: "Helm — routine ran", body: routine.name, silent: false }).show();
        }
      })
      .catch(() => {
        liveChildren.delete(launchId);
        markSessionDone(liveTurnId);
        liveSessions.clearLaunching(launchId);
      });
  } catch (err) {
    // startSession can throw synchronously (e.g. the CLI binary can't be
    // resolved). Without this clear, a misconfigured routine leaves a dead
    // launching entry behind on every scheduled fire, forever.
    liveSessions.clearLaunching(launchId);
    console.error("[helm] failed to fire routine:", routine?.name, err);
  }
}

// Fire every routine whose schedule is due. Advances the schedule (markRoutine-
// Fired) BEFORE firing so a slow run can't be re-fired on the next tick, and so
// a routine that missed several occurrences while Helm was down fires exactly
// one catch-up run. Run on an interval and once at startup (the catch-up pass).
function runDueRoutines() {
  for (const routine of dueRoutines(Date.now())) {
    markRoutineFired(routine.id, Date.now());
    fireRoutine(routine);
  }
}

// --- Scheduled prompts (task 7d9d2188) ---
// "Kvoten tar slut mitt under ett jobb, då måste jag vänta tills den resettat och
// skriva fortsätt." So a prompt can be queued and sent later - at a chosen time,
// or when the quota window has actually reset.
//
// Is the quota still spent right now? Read from the SAME accumulated windows the
// usage panel uses (bc6786c7). Only a FRESH reading counts: a window whose reset
// already elapsed says nothing about the present, so it must not be treated as
// "still limited" (that would strand every queued prompt forever).
function isQuotaCurrentlyLimited(now = Date.now()) {
  for (const { info } of quotaWindowsSnapshot()) {
    const resetsAtMs = typeof info?.resetsAt === "number" ? info.resetsAt * 1000 : null;
    if (resetsAtMs === null || resetsAtMs <= now) {
      continue; // stale/unknown - not evidence of a live limit
    }
    if (info.status === "rejected" || (typeof info.utilization === "number" && info.utilization >= 1)) {
      return true;
    }
  }
  return false;
}

function fireScheduledPrompt(entry) {
  try {
    const { done } = startSession({
      cwd: entry.cwd,
      prompt: entry.prompt,
      model: entry.model || undefined,
      effort: entry.effort || undefined,
      permissionMode: "default",
      resumeSessionId: entry.resumeSessionId || undefined,
      onEvent: (evt) => {
        if (evt.kind === "quota" && evt.quota) {
          recordQuota(evt.quota);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("session:event", { launchId: entry.id, ...evt });
        }
      },
    });
    // Launched, which is all that is known here.
    markScheduledPromptFired(entry.id, { ok: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scheduledPrompts:changed");
    }
    done
      .then((summary) => {
        // What it actually DID. Without this the entry stayed a confident "fired" however the
        // run ended, which is how a prompt that never reached the model read as sent and then
        // vanished from the queue (task a797eb69). The events it emitted went to a launchId no
        // pane listens for, so nothing else in the app would have said otherwise.
        const stderr = (summary?.stderrText || "")
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("Warning: no stdin data received"))
          .join(" ")
          .trim();
        markScheduledPromptOutcome(entry.id, {
          sawResult: !!summary?.sawResult,
          // An error result is not an answer - see markScheduledPromptOutcome.
          isError: !!summary?.resultWasError,
          code: summary?.code ?? null,
          error: summary?.resultErrorText || summary?.error || stderr || null,
        });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("scheduledPrompts:changed");
        }
      })
      .catch((err) => {
        markScheduledPromptOutcome(entry.id, { sawResult: false, error: err?.message || String(err) });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("scheduledPrompts:changed");
        }
      });
  } catch (err) {
    markScheduledPromptFired(entry.id, { ok: false, error: err?.message || String(err) });
  }
}

function runDueScheduledPrompts() {
  const now = Date.now();
  const quotaLimited = isQuotaCurrentlyLimited(now);
  // Push any quota-waiting entry that came due while the quota is STILL spent,
  // rather than firing it into the same failure. Re-resolve from the current
  // windows; if there is no usable future reset, wait a modest fixed interval.
  if (quotaLimited) {
    const nextReset = quotaResetFireAt(quotaWindowsSnapshot(), now) || now + 15 * 60 * 1000;
    for (const entry of listScheduledPrompts()) {
      if (entry.status === "pending" && entry.waitForQuota && (entry.fireAt || 0) <= now) {
        pushScheduledPrompt(entry.id, nextReset, now);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scheduledPrompts:changed");
    }
  }
  for (const entry of dueScheduledPrompts(now, { quotaLimited })) {
    fireScheduledPrompt(entry);
  }
}

// --- Review queue (task ce2d19ab) ---
// Jot decides WHAT is in review; a review record adds the evidence and the test
// steps. Anything in review with no record is returned too, flagged - hiding it
// would let unreviewed work pass as reviewed, which is the failure this exists to
// prevent.
// The review queue is EXPENSIVE: buildReviewQueue asks git for each project's HEAD and
// for what changed between two commits, and every one of those is an execFileSync in the
// main process. Measured on the captain's real board (18 records) on 2026-08-03: 69ms cold,
// then 2042ms and 842ms - and an unrelated cheap IPC issued during one took 421ms,
// because the main process was blocked outright. That is his "hela appen laggar faktiskt
// till ibland" and "mycket segare än tidigare", and I made it worse the same day by
// adding two more callers: the subnav badge at startup AND on a 60s tick, plus the
// Review widget. Three callers, each paying the full git bill.
//
// So: one computation, shared. Callers that only need a number (the badge, the widget)
// pass maxAgeMs and get the last result when it is recent enough; the page passes
// nothing and always gets a fresh one, because that is the surface where being current
// matters. Deliberately NOT a longer-lived cache: stale review state is exactly the kind
// of thing that should not be quietly out of date.
let reviewQueueCache = null; // { at, payload }
const REVIEW_QUEUE_DEFAULT_MAX_AGE_MS = 20_000;

ipcMain.handle("reviews:list", (_e, opts = {}) => {
  const maxAge = typeof opts?.maxAgeMs === "number" ? opts.maxAgeMs : 0;
  if (maxAge > 0 && reviewQueueCache && Date.now() - reviewQueueCache.at <= maxAge) {
    return { ...reviewQueueCache.payload, cached: true };
  }
  const payload = buildReviewsPayload();
  reviewQueueCache = { at: Date.now(), payload };
  return payload;
});

/**
 * Which Jot categories correspond to an actual code repo, and where it lives.
 *
 * "endast visa saker i review som faktiskt är rootade till ett repo - potentiella
 * kodändringar är de enda som behöver reviewas" (the captain, 2026-08-04). His private
 * board and his life-domain boards were filling the queue with rows that have no
 * code to review.
 *
 * Candidates are the cwds Helm has actually seen among its sessions - the same source
 * the dashboard's project chips use - narrowed to the ones that really are git
 * checkouts. The match is loose in ONE direction on purpose: a board named "Skiff"
 * belongs to the repo folder `nw-skiff`, so a containment test is used rather than
 * equality. Being too generous here shows an extra row; being too strict HIDES work
 * that needed reviewing, and that is the expensive mistake.
 */
function repoRootedCategories(records = []) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const repos = new Map(); // normalized folder name -> absolute path

  // THREE sources, because session cwds alone are not enough and getting this wrong is
  // the expensive direction. Measured against his real board: the "Helm" category came
  // back NOT A REPO, which would have hidden his own Helm work behind the code-only
  // filter by default - because he runs Helm's sessions from the meta-home, so
  // D:\Repo\Tools\helm never appears as a session cwd at all.
  //
  //   1. review records' projectPath - authoritative: a record names its own repo, and
  //      that field is now required whenever the record declares checks.
  //   2. goal-run history projectPaths - every project an autonomous run has touched.
  //   3. session cwds - projects opened by hand.
  const candidates = [
    ...records.map((r) => r.projectPath),
    ...loadGoalRunHistory().map((r) => r.projectPath),
    ...(readAllSessions()?.sessions || []).map((s) => s.cwd),
  ];
  for (const cwd of new Set(candidates.filter(Boolean))) {
    try {
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        continue;
      }
    } catch {
      continue;
    }
    const name = norm(path.basename(cwd));
    if (name && !repos.has(name)) {
      repos.set(name, cwd);
    }
  }
  return {
    /** The repo a category belongs to, or null when it is not code work at all. */
    repoFor(category) {
      const c = norm(category);
      if (!c) {
        return null;
      }
      if (repos.has(c)) {
        return repos.get(c);
      }
      for (const [name, cwd] of repos) {
        if (name.includes(c) || c.includes(name)) {
          return cwd;
        }
      }
      return null;
    },
  };
}

function buildReviewsPayload() {
  const config = loadConfig();
  const board = reviewTasks(config.jot || {});
  const metaHome = resolveMetaHome();
  // metaHome is threaded in so the queue can VERIFY that each check run was stamped
  // by the app rather than written into the record by hand.
  const records = listReviewRecords(metaHome);
  const rows = buildReviewQueue(board.tasks, records, metaHome);
  // Annotate rather than filter here: the page decides what to show, and it says how
  // many it is holding back. Dropping them in the main process would make the count
  // unknowable, and a queue that silently omits work is the failure this whole surface
  // exists to prevent.
  const roots = repoRootedCategories(records);
  for (const row of rows) {
    row.repoPath = roots.repoFor(row.category);
  }
  // The audit half: work that reached done without ever being recorded. A direct
  // board write cannot be prevented from here, only detected - and it has to surface
  // on the page he actually reads.
  const haveRecord = new Set(records.map((r) => String(r.taskId).toLowerCase()));
  // A task counts as "handled" if it has a record OR the captain has acknowledged it. The
  // audit's job is to tell him something bypassed review; once he has SEEN that,
  // repeating it for a fortnight just teaches him to skim the section (his review,
  // 2026-07-28: "när du sett dem en gång blir de bara tjat"). Acknowledging does not
  // create evidence and does not claim the work was reviewed - it only records that he
  // knows, which is the whole purpose of the signal.
  const acked = new Set((config.acknowledgedNoRecord || []).map((id) => String(id).toLowerCase()));
  const unrecordedDone = signedOffWithoutRecord(
    config.jot || {},
    (id) => haveRecord.has(String(id).toLowerCase()) || acked.has(String(id).toLowerCase())
  );
  return {
    ok: board.ok,
    error: board.error || null,
    rows,
    tally: reviewQueueTally(rows),
    doneWithoutRecord: unrecordedDone.ok ? unrecordedDone.tasks : [],
  };
}

// Review actions: move a task on the board from the review page itself, so
// signing off doesn't mean leaving Helm for Jot. A bounce back to in-progress
// takes a note, because a task sent back without a reason is what wastes the
// next session.
ipcMain.handle("reviews:setStatus", (_event, { taskId, status, note } = {}) => {
  const config = loadConfig();
  return setTaskStatus(config.jot || {}, taskId, status, note || "");
});

// Acknowledge a task that reached done with no review record: "I know this bypassed
// review." It does NOT create evidence and does not mark the work reviewed - the audit
// simply stops repeating something already seen. Kept in Helm's own config rather than
// written onto the task, because it is a fact about what the captain has read, not about the
// work.
ipcMain.handle("reviews:acknowledgeNoRecord", (_event, { taskId } = {}) => {
  if (!taskId) {
    return { ok: false, error: "No task id." };
  }
  // Same reason as docs:parkProject - a failed write must come back as an answer,
  // not as a rejected promise the renderer's `res?.ok` check never sees.
  try {
    const cfg = loadConfig();
    const set = new Set(cfg.acknowledgedNoRecord || []);
    set.add(String(taskId));
    writeConfig({ ...cfg, acknowledgedNoRecord: [...set] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// The CHANGE behind a review item, so reviewing does not mean taking the record's word
// for what it says was done (task c3dfbb42, "Kunna se diff"). Read-only: it resolves the
// task's commits (from the record, else by searching the log for the task's short id) and
// returns their patch. The answer says WHICH source was used, because a diff attributed
// by search must not look like one attributed by record.
ipcMain.handle("reviews:diff", (_event, { taskId } = {}) => {
  const metaHome = resolveMetaHome();
  const rec = readReviewRecord(metaHome, taskId);
  if (!rec) {
    return { ok: false, error: "No review record for that task, so nothing says where its code lives." };
  }
  const projectPath = rec.projectPath || null;
  const resolved = resolveTaskCommits(projectPath, taskId, rec.commits || []);
  if (resolved.commits.length === 0) {
    return { ok: false, error: resolved.error || "No commits found for this task.", source: resolved.source };
  }
  const diff = diffForCommits(projectPath, resolved.commits);
  if (!diff.ok) {
    return { ok: false, error: diff.error, source: resolved.source };
  }
  return {
    ok: true,
    source: resolved.source,
    projectPath,
    commits: resolved.commits,
    text: diff.text,
    truncated: diff.truncated,
    shown: diff.shown,
    total: diff.total,
  };
});

// What an independent reviewer would be sent in on, RECOMMENDED from the change itself
// (the captain, 2026-08-05: "en rekommendation baserat på dess komplexitet men att man själv kan
// välja"). Computed here rather than in the renderer so there is one implementation and so
// the whole diff does not have to cross IPC just to be counted.
ipcMain.handle("reviews:reviewerPlan", (_event, { taskId } = {}) => {
  const metaHome = resolveMetaHome();
  const rec = readReviewRecord(metaHome, taskId);
  if (!rec) {
    return { ok: false, error: "No review record for that task." };
  }
  const projectPath = rec.projectPath || null;
  const resolved = resolveTaskCommits(projectPath, taskId, rec.commits || []);
  // No commits is not a refusal: a reviewer can still read the record and the working
  // tree. It just means the recommendation has less to go on, and says so.
  let stats = { files: 0, added: 0, removed: 0, changedLines: 0, commits: 0, paths: [] };
  if (resolved.commits.length > 0) {
    const diff = diffForCommits(projectPath, resolved.commits);
    if (diff.ok) {
      stats = diffStats(diff.text);
    }
  }
  const recommendation = recommendReviewer({
    criticality: rec.criticality,
    files: stats.files,
    changedLines: stats.changedLines,
    commits: resolved.commits.length,
    paths: stats.paths,
  });
  return {
    ok: true,
    projectPath,
    criticality: rec.criticality || null,
    commitSource: resolved.source,
    commits: resolved.commits.length,
    stats: { files: stats.files, added: stats.added, removed: stats.removed, changedLines: stats.changedLines },
    recommendation,
    models: REVIEWER_MODELS.map(({ value, label }) => ({ value, label })),
    // Where the reviewer must write its verdict. Resolved HERE, not spelled out in the
    // renderer: the meta-home is main's to know (and a test overrides it), and two
    // spellings of one path is how a feature comes to silently do nothing.
    notePath: independentNotePath(metaHome, taskId),
  };
});

// The reviewer's own verdict, read back. It writes a file rather than calling into Helm -
// an agent can always write a file, and this is the same files-as-memory shape the rest of
// the app uses. Read-only, and guarded to the reviews directory.
ipcMain.handle("reviews:independentNote", (_event, { taskId } = {}) => {
  const file = independentNotePath(resolveMetaHome(), taskId);
  if (!file || !fs.existsSync(file)) {
    return { ok: true, present: false };
  }
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8").slice(0, 200 * 1024);
    return { ok: true, present: true, text, writtenAt: stat.mtimeMs, path: file };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/** `<meta-home>/.helm/reviews/<taskId>.independent.md`, or null for a bad id. */
function independentNotePath(metaHome, taskId) {
  const id = String(taskId || "").trim().toLowerCase();
  if (!/^[a-f0-9-]{8,64}$/.test(id)) {
    return null;
  }
  return path.join(metaHome, ".helm", "reviews", `${id}.independent.md`);
}

// Run a record's declared checks and stamp the REAL outcome (exit code + output
// tail) into it - the gauntlet. This is the half of the evidence the author of
// the work does not get to write (task bd5d7b4b / Uncle Bob's constraints).
ipcMain.handle("reviews:runChecks", async (_event, { taskId } = {}) => {
  const metaHome = resolveMetaHome();
  const rec = readReviewRecord(metaHome, taskId);
  if (!rec) {
    return { ok: false, error: "No review record for that task." };
  }
  const checks = Array.isArray(rec.checks) ? rec.checks : [];
  if (checks.length === 0) {
    return { ok: false, error: "This record declares no checks to run." };
  }
  const results = [];
  for (const check of checks) {
    // Where a check RUNS is part of the check. The first cut defaulted to the
    // meta-home, so every repo check ("node scripts/e2e/...") failed with exit 1
    // simply because it ran in the wrong directory - and a red gauntlet that is
    // red for that reason is worse than no gauntlet, because it looks like a real
    // failure and it can never be made green.
    const cwd = check.cwd || rec.projectPath || null;
    const cwdProblem = !cwd
      ? "no working directory: set projectPath on the record or cwd on the check. Refusing to guess - a check run in the wrong place fails for the wrong reason."
      : !fs.existsSync(cwd)
        ? `working directory does not exist: ${cwd}`
        : null;
    const outcome = cwdProblem
      ? { exitCode: null, tail: cwdProblem }
      : await new Promise((resolve) => {
      let out = "";
      let child;
      try {
        // A check may itself be an E2E that launches Helm under a debugger. Hand
        // it a DIFFERENT CDP port than the one this instance may have been
        // launched with, or the child attaches to us instead of to its own app
        // and the check never settles. (Per-check offset so several in one run
        // don't collide either.)
        child = spawn(check.cmd, {
          cwd,
          shell: true,
          env: { ...process.env, HELM_E2E_PORT: String(9400 + (checkPortCursor++ % 50)) },
        });
      } catch (err) {
        resolve({ exitCode: null, tail: `could not start: ${err.message}` });
        return;
      }
      // A check that hangs must not hang the review page.
      const timer = setTimeout(() => {
        killChildTree(child);
        resolve({ exitCode: null, tail: out.slice(-1200) + "\n[timed out after 5 minutes]" });
      }, 5 * 60 * 1000);
      const grab = (d) => {
        if (out.length < 200000) {
          out += d.toString("utf8");
        }
      };
      child.stdout?.on("data", grab);
      child.stderr?.on("data", grab);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, tail: `error: ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, tail: out.slice(-1200) });
      });
    });
    // The stamp can FAIL - recordCheckRun goes through reviewRecordProblems, so a
    // record that doesn't meet the bar cannot be stamped at all. Discarding this
    // return value meant the handler answered "All checks passed" while persisting
    // nothing: a failing check was announced once in a transient toast and then
    // vanished, and a reload showed "never run". A result that wasn't stored is not
    // a result, so it is reported as such.
    const stamp = recordCheckRun(metaHome, taskId, { label: check.label, cmd: check.cmd, ...outcome });
    results.push({
      label: check.label,
      exitCode: outcome.exitCode,
      ok: outcome.exitCode === 0,
      stored: stamp.ok === true,
      storeError: stamp.ok ? null : stamp.error || "could not store the result",
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("reviews:changed");
    }
  }
  const unstored = results.filter((r) => !r.stored);
  return {
    ok: true,
    results,
    // Surfaced at the top level so the renderer cannot show a green summary over
    // results that were never written.
    stored: unstored.length === 0,
    storeError: unstored.length > 0 ? unstored[0].storeError : null,
    // The card's OWN verdict on the run that was just stored, recomputed here.
    //
    // Exit codes and admissibility are different questions, and the app answered them
    // separately: the toast said "All checks passed" from the exit codes while the card
    // refused to count the run and still read "Checks not confirmed (0/1 - 1 stale)"
    // (the captain, task d6b33767: "Sager all checks passed men visar inte det pa kortet").
    // Both were right and they contradicted each other, which is worse than either being
    // wrong. Returning the gauntlet lets the toast say what the card is about to say.
    gauntlet: (() => {
      const after = readReviewRecord(metaHome, taskId);
      if (!after) {
        return null;
      }
      const projectPath = after.projectPath || null;
      const head = projectPath ? currentHead(projectPath)?.sha || null : null;
      return gauntletStatus(after, metaHome, {
        head,
        codeChanged: (from, to) => (projectPath ? codeChangedBetween(projectPath, from, to) : true),
      });
    })(),
  };
});

ipcMain.handle("scheduledPrompts:list", () => {
  return {
    ok: true,
    pending: pendingScheduledPrompts(Date.now()),
    // A prompt that was fired and never reached the model used to leave no trace anywhere in
    // the UI (task a797eb69). It is returned alongside the queue so the same bar can say so.
    failed: failedScheduledPrompts(),
    quotaLimited: isQuotaCurrentlyLimited(),
  };
});

ipcMain.handle("scheduledPrompts:acknowledge", (_event, { id } = {}) => {
  return { ok: acknowledgeScheduledPrompt(id) };
});

// "when" is either a number (absolute ms) or the string "quota-reset".
ipcMain.handle("scheduledPrompts:add", (_event, { prompt, cwd, resumeSessionId, model, effort, when } = {}) => {
  try {
    const now = Date.now();
    let fireAt;
    let waitForQuota = false;
    if (when === "quota-reset") {
      waitForQuota = true;
      // No usable reading yet (the API only reports quota alongside a request):
      // check back shortly rather than refusing to queue.
      fireAt = quotaResetFireAt(quotaWindowsSnapshot(), now) || now + 10 * 60 * 1000;
    } else if (typeof when === "number" && isFinite(when)) {
      fireAt = when;
    } else {
      return { ok: false, error: "Give a time, or \"quota-reset\"." };
    }
    const entry = scheduledPromptAdd({ prompt, cwd, resumeSessionId, model, effort, fireAt, waitForQuota, now });
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("scheduledPrompts:cancel", (_event, { id } = {}) => {
  return { ok: cancelScheduledPrompt(id) };
});

app.whenReady().then(() => {
  prunePastedImages();
  seedQuotaWindows();
  createWindow();
  setInterval(runOrchestratorSweep, ORCHESTRATOR_SWEEP_INTERVAL_MS);
  setInterval(runStaleBuildCheck, STALE_BUILD_CHECK_INTERVAL_MS);
  startDispatchWatcher();
  // Helm-owned routines scheduler: a catch-up pass now (fires anything missed
  // while Helm was closed), then a check every minute.
  runDueRoutines();
  setInterval(runDueRoutines, 60 * 1000);
  // Scheduled prompts (7d9d2188): a catch-up pass now, then every minute. The
  // catch-up matters - a prompt queued for a quota reset that happened while Helm
  // was closed should go as soon as it opens.
  pruneScheduledPrompts();
  runDueScheduledPrompts();
  setInterval(runDueScheduledPrompts, 60 * 1000);
  // Auto-captain (ea0546d1). The timer always runs; the TICK is what checks the
  // toggle, so turning it on takes effect without a restart. Deliberately no
  // catch-up pass at startup: unlike a scheduled prompt, which the user queued
  // explicitly for a moment that may have passed, an Auto card is a standing
  // instruction - firing a burst of them the instant Helm opens is exactly the
  // surprise this feature must not produce.
  setInterval(() => {
    autoCaptainTick().catch((err) => console.error("[helm] auto-captain tick failed:", err?.message || err));
  }, AUTO_TICK_MS);
  // Auto-update: no-op in dev (app.isPackaged false); checks GitHub Releases in
  // the packaged build. See lib/autoUpdate.js + docs/installer-and-auto-update.md.
  initAutoUpdate();
});

// Without this, quitting Helm while any prompt is still running leaves
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
  // Same orphan-prevention concern as liveChildren, but for goal-run children:
  // each in-flight goal run's currently-spawned iteration/verify process tree.
  // Without this, quitting mid-goal-run leaves the goal's claude.exe/verify
  // trees orphaned (goal children are tracked in liveGoalRuns, not
  // liveChildren). Synchronous kill for the same teardown-race reason.
  for (const [goalRunId, run] of liveGoalRuns) {
    if (run.currentChild) {
      killChildTree(run.currentChild, { sync: true });
    }
    // Release this run's cross-instance claim on a CLEAN quit, so a restart (or
    // another instance) can resume it immediately instead of waiting out the
    // stale-heartbeat window. A crash skips this - that's what the window is for.
    try {
      upsertGoalRunRecord({ goalRunId, livePid: null, updatedAt: Date.now() });
    } catch {
      // best-effort during teardown
    }
  }
  liveGoalRuns.clear();
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
