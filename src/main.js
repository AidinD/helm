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
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAllSessions, enrichWithJot, setSessionArchived, forkTranscriptAtUserMessage, switchSessionRootFolder } from "./lib/sessions.js";
import { loadJot, loadGoals, addSubtask, formatJotSummaryForClassifier, projectBoardSummary } from "./lib/jot.js";
import { loadConfig, writeConfig } from "./lib/config.js";
import { startSession } from "./lib/launcher.js";
import { suggestModelEffort } from "./lib/suggest.js";
import { readTranscript } from "./lib/transcript.js";
import { liveSubAgents } from "./lib/subAgents.js";
import { findTranscriptPath, projectsRoot, encodeProjectDir } from "./lib/paths.js";
import { listSkills, skillMdPath } from "./lib/skills.js";
import { appendUsageLog, readUsageSummary, computeSuggestionAccuracyVerdict } from "./lib/usage.js";
import { judgeModelFit } from "./lib/judge.js";
import { classifySessionStatus, estimateSessionContextTokens, compactSession, getTranscriptSize } from "./lib/orchestratorHelper.js";
import { savePastedImage, prunePastedImages } from "./lib/images.js";
import { computeVersionString, captureRunningBuildIdentity, checkForNewerBuild } from "./lib/version.js";
import { runGoal } from "./lib/goalOrchestrator.js";
import { loadGoalRunHistory, upsertGoalRunRecord, removeGoalRunRecord } from "./lib/goalRunHistory.js";
import { removeWorktree, isBranchMerged, deleteBranch } from "./lib/worktree.js";
import { loadDomains, registerDomain, removeDomain } from "./lib/domains.js";
import { ensureMates, activeMates, findMateById, loadMates, renameMate, retireAndRespawn, bindMateSession, consumeMateHandoff, setMatePersona, rethemeMateNames } from "./lib/mates.js";
import { personaOverlay, PERSONAS } from "./lib/personas.js";
import { listSlashItems } from "./lib/slashCommands.js";
import { trackHelmUsage, summarizeHelmUsage } from "./lib/helmUsage.js";
import { initAutoUpdate } from "./lib/autoUpdate.js";
import { deriveSecondMates, bindSecondMateSession, renameSecondMate } from "./lib/secondMates.js";
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
import { widthCapExceeded, depthCapExceeded } from "./lib/dispatchCaps.js";
import { listRoutines, createRoutine, updateRoutine, removeRoutine, dueRoutines, markRoutineFired } from "./lib/helmRoutines.js";
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
ipcMain.handle("skills:list", (_event, cwd) => listSkills(cwd));

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
ipcMain.handle("skills:open", (_event, { name, origin, cwd }) => {
  const file = skillMdPath(name, origin, cwd);
  if (!file) {
    return { ok: false, error: "SKILL.md not found" };
  }
  shell.openPath(file);
  return { ok: true };
});

// --- Read a skill's SKILL.md for the in-app rendered viewer (same readable-
// HTML treatment as context docs). Path is resolved server-side via the
// guarded skillMdPath; capped like context:read. ---
ipcMain.handle("skills:read", (_event, { name, origin, cwd } = {}) => {
  const file = skillMdPath(name, origin, cwd);
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
    for (const name of ["DECISIONS.md", "PLAN.md"]) {
      const p = path.join(cwd, name);
      out.projectDocs.push({ kind: "projectDoc", name, path: p, exists: fs.existsSync(p) });
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
  if (kind === "projectDoc") {
    // Guarded to the known durable-doc names in the session's own cwd.
    if (!cwd || (name !== "DECISIONS.md" && name !== "PLAN.md")) {
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
ipcMain.handle("session:archive", (_event, { sessionId, archived }) => {
  const shouldArchive = archived !== false;
  const cfg = loadConfig();
  const set = new Set(cfg.archivedSessions || []);
  if (shouldArchive) {
    set.add(sessionId);
  } else {
    set.delete(sessionId);
  }
  const nextCfg = { ...cfg, archivedSessions: [...set] };
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
const FIRST_MATE_ALLOWED_TOOLS = ["helm_dispatch", "helm_collect_reports", "helm_list_projects", "helm_fleet_state"].map(
  (t) => `mcp__${FIRST_MATE_MCP_SERVER}__${t}`
);

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

function buildFirstMateMcpConfig(metaHome, mateId) {
  // Named mates: the session is bound to one of the two fixed mate slots by the
  // mateId the renderer passes. Fall back to the first active mate if none was
  // given (a direct meta-home launch that didn't pick a slot) so a first mate
  // always has a stable identity. ensureMates guarantees the two slots exist.
  const active = ensureMates(metaHome);
  const mate = (mateId && findMateById(mateId)) || active[0];
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
          HELM_MATE_ID: mate.mateId,
          HELM_PROJECTS: JSON.stringify(knownProjects()),
          HELM_WIDTH_CAP: String(DISPATCH_WIDTH_CAP),
        },
      },
    },
  };
  return JSON.stringify(config);
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
    return { ok: true, active: ensureMates(metaHome), all: loadMates() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), active: [], all: [] };
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
ipcMain.handle("mates:retire", (_event, { mateId, handoff, persona }) => {
  try {
    // `persona` set = a deliberate persona switch: respawn into it. Absent =
    // an ordinary retire, which resets the fresh mate to the plain coordinator.
    const mate = retireAndRespawn(mateId, handoff || null, persona || null);
    return { ok: true, mate };
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

// Records a Helm-created session into config.helmSessions so readAllSessions
// can surface it (the headless `claude -p` launcher never writes a Desktop
// local_*.json - see config.js/DECISIONS). Upserts: immutable fields are set
// once (on create), lastActivityAt always bumps. `createIfAbsent:false` means
// "only bump an existing entry" - used on resume/completion so resuming a
// DESKTOP session (which Helm didn't create) never fabricates a stray entry.
function recordHelmSession(sessionId, { cwd, model, effort, permissionMode, title, createIfAbsent } = {}) {
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
  (_event, { cwd, prompt, model, effort, permissionMode, resumeSessionId, suggestedModel, suggestedEffort, internal, mateId }) => {
    if (!cwd || !prompt) {
      return { ok: false, error: "cwd and prompt are required" };
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
    const meta = { toolsUsed: [], costUsd: 0, numTurns: 0, durationMs: null, totalTokens: null, actualModel: model || null, lastAssistantText: "", contextWindows: {} };
    // First-mate tier (design section 5): attach the dispatch MCP tools ONLY
    // when this launch is a first mate (rooted in the meta home). A dispatched
    // second-mate run is a runGoal (never routed through here) rooted in a
    // project worktree, so it structurally never gets these tools. Best-effort:
    // a failure to build the config must not break launching a normal session.
    let mcpConfig;
    let allowedTools;
    let appendSystemPrompt;
    let strictMcpConfig;
    try {
      if (isMetaHomeRoot(cwd)) {
        const metaHome = resolveMetaHome();
        ensureDispatchDirs(metaHome);
        mcpConfig = buildFirstMateMcpConfig(metaHome, mateId);
        // Pre-approve exactly the dispatch tools so the headless first mate can
        // call them without a permission prompt it can't answer (review M3).
        allowedTools = FIRST_MATE_ALLOWED_TOOLS;
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
          const mate = mateId ? findMateById(mateId) : null;
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
      }
    } catch (err) {
      console.error("[helm] failed to build first-mate launch config:", err);
    }
    const { child, done } = startSession({
      cwd,
      prompt,
      model,
      effort,
      permissionMode,
      resumeSessionId,
      mcpConfig,
      allowedTools,
      appendSystemPrompt,
      strictMcpConfig,
      onEvent: (evt) => {
        if (evt.kind === "session" && evt.sessionId && !internal) {
          // Record into Helm's own index the moment the session id appears, so
          // a session shows in Direct/Fleet while its first turn is still
          // running - not only once it completes. createIfAbsent only on a
          // FRESH launch (no resume); a resumed Desktop session isn't ours to
          // index. Title defaults to the first prompt line (renamable via the
          // display-only titleOverrides overlay).
          recordHelmSession(evt.sessionId, {
            cwd,
            model,
            effort,
            permissionMode,
            title: prompt.trim().split("\n")[0].slice(0, 80) || "(untitled)",
            createIfAbsent: !resumeSessionId,
          });
        }
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
      // forever with no way to recover short of restarting Helm.
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
    dispatchedBy: dispatch?.dispatchedBy || null,
    dispatchId: dispatch?.dispatchId || null,
    tier: dispatch?.tier || null,
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
    cancelToken,
    // Track each freshly-spawned iteration/verify child so before-quit can
    // sweep its tree (L1) and goal:cancel can kill the in-flight one
    // immediately (L2). Iterations/verify never overlap within a run, so a
    // single currentChild slot always holding the latest is sufficient.
    onChild: (child) => {
      runEntry.currentChild = child;
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

// --- Persisted goal-run index (see lib/goalRunHistory.js) — read on renderer
// startup so past runs survive an app restart. A "running" record with no
// matching entry in liveGoalRuns means the process behind it is gone (the
// app was restarted mid-run), so it's downgraded to "interrupted" here
// rather than left to render as a still-live run with a dead Cancel button.
ipcMain.handle("goal:history", () => {
  return loadGoalRunHistory().map((record) =>
    record.status === "running" && !liveGoalRuns.has(record.goalRunId)
      ? { ...record, status: "interrupted" }
      : record
  );
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

ipcMain.handle("goal:deleteWorktree", (_event, { goalRunId, projectPath, worktreePath }) => {
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
    removeWorktree(projectPath, worktreePath);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
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

function processDispatchRequests(metaHome) {
  if (dispatchScanInFlight) {
    return;
  }
  dispatchScanInFlight = true;
  try {
    for (const request of readRequests(metaHome)) {
      const dispatchId = request.dispatchId;
      if (!dispatchId) {
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
              writeReport(metaHome, buildDispatchReport({ dispatchId, mateId, request, result, meta }));
              writeFleetStateSnapshot(metaHome); // a run finished - refresh the cross-mate view
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
  try {
    ensureMates(metaHome);
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
    const { child, done } = startSession({
      cwd,
      prompt: routine.prompt,
      model: routine.model || undefined,
      effort: routine.effort || undefined,
      permissionMode: "default",
      onEvent: (evt) => {
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
          latestQuota = evt.quota;
        }
        send(evt);
      },
    });
    liveChildren.set(launchId, child);
    done
      .then((summary) => {
        liveChildren.delete(launchId);
        send({ kind: "done", summary });
        if (summary.sessionId) {
          recordHelmSession(summary.sessionId, { createIfAbsent: false });
        }
        if (loadConfig().notifyOnComplete !== false && summary.sawResult && Notification.isSupported()) {
          new Notification({ title: "Helm — routine ran", body: routine.name, silent: false }).show();
        }
      })
      .catch(() => liveChildren.delete(launchId));
  } catch (err) {
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

app.whenReady().then(() => {
  prunePastedImages();
  createWindow();
  setInterval(runOrchestratorSweep, ORCHESTRATOR_SWEEP_INTERVAL_MS);
  setInterval(runStaleBuildCheck, STALE_BUILD_CHECK_INTERVAL_MS);
  startDispatchWatcher();
  // Helm-owned routines scheduler: a catch-up pass now (fires anything missed
  // while Helm was closed), then a check every minute.
  runDueRoutines();
  setInterval(runDueRoutines, 60 * 1000);
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
  for (const run of liveGoalRuns.values()) {
    if (run.currentChild) {
      killChildTree(run.currentChild, { sync: true });
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
