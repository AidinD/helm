import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAllSessions, enrichWithJot } from "./lib/sessions.js";
import { loadJot } from "./lib/jot.js";
import { startSession } from "./lib/launcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let latestQuota = null;
let launchSeq = 0;

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
}

// --- Overview: read + enrich sessions (reuses the Session Radar read layer) ---
ipcMain.handle("sessions:get", () => {
  const { error, sessions } = readAllSessions();
  const jotIndex = loadJot({});
  enrichWithJot(sessions, jotIndex, {});
  return {
    error,
    sessions,
    jot: { ok: jotIndex.ok, categories: jotIndex.categories },
    quota: latestQuota,
    generatedAt: Date.now(),
  };
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

// --- Start a rooted session; stream events to the renderer ---
ipcMain.handle("session:start", (_event, { cwd, prompt, model }) => {
  if (!cwd || !prompt) {
    return { ok: false, error: "cwd and prompt are required" };
  }
  const launchId = ++launchSeq;
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session:event", { launchId, ...payload });
    }
  };
  const { done } = startSession({
    cwd,
    prompt,
    model,
    onEvent: (evt) => {
      if (evt.kind === "quota" && evt.quota) {
        latestQuota = evt.quota;
      }
      send(evt);
    },
  });
  done.then((summary) => send({ kind: "done", summary }));
  return { ok: true, launchId };
});

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
