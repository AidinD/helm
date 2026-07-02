import { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAllSessions, enrichWithJot, setSessionArchived } from "./lib/sessions.js";
import { loadJot } from "./lib/jot.js";
import { loadConfig, writeConfig } from "./lib/config.js";
import { startSession } from "./lib/launcher.js";
import { suggestModelEffort } from "./lib/suggest.js";
import { readTranscript } from "./lib/transcript.js";
import { findTranscriptPath } from "./lib/paths.js";
import { listSkills, skillMdPath } from "./lib/skills.js";
import { appendUsageLog, readUsageSummary } from "./lib/usage.js";
import { judgeModelFit } from "./lib/judge.js";
import { savePastedImage, prunePastedImages } from "./lib/images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let latestQuota = null;
const liveChildren = new Map(); // launchId -> child process, for the Stop button

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
  const jotIndex = loadJot(config.jot || {});
  enrichWithJot(sessions, jotIndex, config.jot?.weights || {});
  // Title overrides are applied AFTER Jot matching so a renamed display title
  // never breaks the category-name match, which relies on the real title.
  const overrides = config.titleOverrides || {};
  for (const session of sessions) {
    if (overrides[session.sessionId]) {
      session.title = overrides[session.sessionId];
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

// --- Archive/unarchive a session in the desktop app's own state. Always a
// direct response to an explicit click in the renderer (manual "Archive", or
// approving an orchestrator-proposed suggestion) — never called on a timer or
// any other unattended trigger. ---
ipcMain.handle("session:archive", (_event, { sessionId, archived }) => {
  return setSessionArchived(sessionId, archived !== false);
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

// --- Aggregate usage summary (models + tools most used) ---
ipcMain.handle("usage:summary", () => readUsageSummary());

// --- Full chat history for a session (for the pane view) ---
ipcMain.handle("transcript:get", (_event, { cliSessionId, sessionId }) => {
  const transcriptPath = findTranscriptPath([cliSessionId, sessionId]);
  return readTranscript(transcriptPath);
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
    const meta = { toolsUsed: [], costUsd: 0, numTurns: 0, actualModel: model || null, lastAssistantText: "" };
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
      send({ kind: "done", summary });

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

function truncateForNotification(text) {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > 100 ? oneLine.slice(0, 100) + "…" : oneLine;
}

app.whenReady().then(() => {
  prunePastedImages();
  createWindow();
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
