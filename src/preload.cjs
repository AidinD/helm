const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit API surface exposed to the renderer. No Node access leaks.
contextBridge.exposeInMainWorld("maestro", {
  getSessions: () => ipcRenderer.invoke("sessions:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  suggestModelEffort: (prompt) => ipcRenderer.invoke("suggest:modelEffort", prompt),
  getJotGoals: () => ipcRenderer.invoke("jot:goals"),
  addJotSubtask: (parentId, text) => ipcRenderer.invoke("jot:addSubtask", { parentId, text }),
  getTranscript: (ids) => ipcRenderer.invoke("transcript:get", ids),
  listSkills: (cwd) => ipcRenderer.invoke("skills:list", cwd),
  openSkill: (opts) => ipcRenderer.invoke("skills:open", opts),
  openGlobalClaudeMd: () => ipcRenderer.invoke("claudeMd:openGlobal"),
  openProjectClaudeMd: (cwd) => ipcRenderer.invoke("claudeMd:openProject", cwd),
  projectClaudeMdExists: (cwd) => ipcRenderer.invoke("claudeMd:projectExists", cwd),
  copyToClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
  saveImage: (base64Data, ext) => ipcRenderer.invoke("image:save", { base64Data, ext }),
  transcribeVoice: (samples, language) => ipcRenderer.invoke("voice:transcribe", { samples, language }),
  // True real-time streaming transcription (continuous voice input via
  // whisper-stream.exe, see src/lib/whisperStream.js). startVoiceStream
  // resolves with { ok, streamId } (or { ok: false, error } if the binary/
  // model isn't installed); onVoiceStreamEvent fires { streamId, kind:
  // "partial" | "committed" | "error" | "exit", text? } as they arrive.
  startVoiceStream: (language) => ipcRenderer.invoke("voice:streamStart", { language }),
  stopVoiceStream: (streamId) => ipcRenderer.invoke("voice:streamStop", { streamId }),
  onVoiceStreamEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("voice:streamEvent", listener);
    return () => ipcRenderer.removeListener("voice:streamEvent", listener);
  },
  archiveSession: (sessionId, archived) => ipcRenderer.invoke("session:archive", { sessionId, archived }),
  forkSession: (cliSessionId, userMsgIndex) => ipcRenderer.invoke("session:fork", { cliSessionId, userMsgIndex }),
  switchSessionRootFolder: (cliSessionId, sessionId, newCwd) =>
    ipcRenderer.invoke("session:switchRootFolder", { cliSessionId, sessionId, newCwd }),
  getUsageSummary: () => ipcRenderer.invoke("usage:summary"),
  getVersion: () => ipcRenderer.invoke("app:version"),
  // Stale-build indicator: getBuildStatus() returns the running build's own
  // identity plus whatever the last periodic on-disk check found; onBuildStaleUpdate
  // fires only when that check's result actually changes (see runStaleBuildCheck
  // in main.js), not on every tick.
  getBuildStatus: () => ipcRenderer.invoke("build:status"),
  onBuildStaleUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("build:staleUpdate", listener);
    return () => ipcRenderer.removeListener("build:staleUpdate", listener);
  },
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  // Lavish (interactive-plan) v1 — read an HTML artifact file by path, wrap
  // it into an SDK-injected srcdoc, and format collected annotations to text.
  readArtifactFile: (filePath) => ipcRenderer.invoke("lavish:readFile", filePath),
  buildArtifactSrcdoc: (artifactHtml) => ipcRenderer.invoke("lavish:buildSrcdoc", artifactHtml),
  formatAnnotations: (annotations, domSnapshot) =>
    ipcRenderer.invoke("lavish:formatPrompt", { annotations, domSnapshot }),
  startSession: (opts) => ipcRenderer.invoke("session:start", opts),
  stopSession: (launchId) => ipcRenderer.invoke("session:stop", { launchId }),
  onSessionEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
  // Fas 3 Point 11 — autonomous goal orchestrator. runGoal starts a run and
  // resolves with { ok, goalRunId }; progress arrives over onGoalEvent (its
  // own channel, parallel to session events); cancelGoal flips the run's
  // cancel flag so it stops between iterations.
  runGoal: (opts) => ipcRenderer.invoke("goal:run", opts),
  suggestVerifyCommand: (projectPath) => ipcRenderer.invoke("goal:suggestVerifyCommand", { projectPath }),
  cancelGoal: (goalRunId) => ipcRenderer.invoke("goal:cancel", { goalRunId }),
  onGoalEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("goal:event", listener);
    return () => ipcRenderer.removeListener("goal:event", listener);
  },
});
