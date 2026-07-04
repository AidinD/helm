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
  archiveSession: (sessionId, archived) => ipcRenderer.invoke("session:archive", { sessionId, archived }),
  forkSession: (cliSessionId, userMsgIndex) => ipcRenderer.invoke("session:fork", { cliSessionId, userMsgIndex }),
  switchSessionRootFolder: (cliSessionId, sessionId, newCwd) =>
    ipcRenderer.invoke("session:switchRootFolder", { cliSessionId, sessionId, newCwd }),
  getUsageSummary: () => ipcRenderer.invoke("usage:summary"),
  getVersion: () => ipcRenderer.invoke("app:version"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  startSession: (opts) => ipcRenderer.invoke("session:start", opts),
  stopSession: (launchId) => ipcRenderer.invoke("session:stop", { launchId }),
  onSessionEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
});
