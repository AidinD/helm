import { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAllSessions, enrichWithJot } from "./lib/sessions.js";
import { loadJot } from "./lib/jot.js";
import { loadConfig, writeConfig } from "./lib/config.js";
import { startSession } from "./lib/launcher.js";
import { suggestModelEffort } from "./lib/suggest.js";
import { readTranscript } from "./lib/transcript.js";
import { findTranscriptPath } from "./lib/paths.js";
import { listSkills, skillMdPath } from "./lib/skills.js";
import { appendUsageLog, readUsageSummary } from "./lib/usage.js";
import { judgeModelFit } from "./lib/judge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let latestQuota = null;
let launchSeq = 0;
const liveChildren = new Map(); // launchId -> child process, for the Stop button

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

// --- Start (or resume) a rooted session; stream events to the renderer ---
ipcMain.handle(
  "session:start",
  (_event, { cwd, prompt, model, effort, permissionMode, resumeSessionId, suggestedModel, suggestedEffort }) => {
    if (!cwd || !prompt) {
      return { ok: false, error: "cwd and prompt are required" };
    }
    const launchId = ++launchSeq;
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
      appendUsageLog({
        type: "run",
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
      send({ kind: "done", summary });

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
        }).then((result) => {
          if (!result) {
            return;
          }
          appendUsageLog({
            type: "modelFitVerdict",
            timestamp: Date.now(),
            model: meta.actualModel,
            verdict: result.verdict,
            reason: result.reason,
            judgeCostUsd: result.costUsd,
          });
          send({ kind: "modelFit", verdict: result.verdict, reason: result.reason });
        });
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
  child.kill();
  liveChildren.delete(launchId);
  return { ok: true };
});

function truncateForNotification(text) {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > 100 ? oneLine.slice(0, 100) + "…" : oneLine;
}

app.whenReady().then(createWindow);

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
