const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit API surface exposed to the renderer. No Node access leaks.
contextBridge.exposeInMainWorld("maestro", {
  getSessions: () => ipcRenderer.invoke("sessions:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  suggestModelEffort: (prompt) => ipcRenderer.invoke("suggest:modelEffort", prompt),
  getTranscript: (ids) => ipcRenderer.invoke("transcript:get", ids),
  listSkills: (cwd) => ipcRenderer.invoke("skills:list", cwd),
  openSkill: (opts) => ipcRenderer.invoke("skills:open", opts),
  getUsageSummary: () => ipcRenderer.invoke("usage:summary"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  startSession: (opts) => ipcRenderer.invoke("session:start", opts),
  stopSession: (launchId) => ipcRenderer.invoke("session:stop", { launchId }),
  onSessionEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
});
