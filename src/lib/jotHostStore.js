// Data layer behind Helm's coming embedded Jot tab ("one Jot, two mounts" -
// DECISIONS 2026-07-18). Helm HOSTS a @jot/core store bound to the SAME todos.json
// a standalone Jot uses; its embedded webview renders Jot's built UI against this
// store, and the auto-captain writes tags/lane-moves through it. @jot/core is the
// framework-agnostic data core Jot was split into (its store already has an event
// bus + file-watch, so external changes reload and Helm's mounts stay in sync).
//
// NOT wired into Helm's startup yet - this is the tested foundation the Jot tab
// (webview + core-backed preload) will build on.
import path from "node:path";
import { app } from "electron";
import { TodoStore, LocalJsonStorage } from "@jot/core";

// Resolve the SAME data dir a standalone Jot uses, PORTABLY (no hardcoded path):
// JOT_DATA_DIR override, else the OS userData location for the Jot app
// (%APPDATA%/jot on Windows). Helm can't call Jot's own app.getPath('userData')
// (that returns HELM's userData), so derive Jot's default from the roaming appData
// base + 'jot' - identical to what Jot's data-dir.ts resolves to.
export function resolveJotDataDir() {
  const override = process.env.JOT_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return path.join(app.getPath("appData"), "jot");
}

// Create a HOST-mode @jot/core store bound to the shared Jot data. The caller owns
// its lifecycle (init(), and stopWatching on teardown via the store's own API).
export function createJotHostStore(dataDir = resolveJotDataDir()) {
  const store = new TodoStore(new LocalJsonStorage(path.join(dataDir, "todos.json")), dataDir);
  return { store, dataDir };
}
