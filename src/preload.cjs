const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit API surface exposed to the renderer. No Node access leaks.
contextBridge.exposeInMainWorld("maestro", {
  getSessions: () => ipcRenderer.invoke("sessions:get"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  startSession: (opts) => ipcRenderer.invoke("session:start", opts),
  onSessionEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
});
