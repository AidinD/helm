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
import { TodoStore, LocalJsonStorage } from "@jot/core";
import { resolveJotDataDir } from "./jotDataDir.js";

export { resolveJotDataDir };

// Create a HOST-mode @jot/core store bound to the shared Jot data (same todos.json
// a standalone Jot uses - resolved portably via jotDataDir.js, no hardcoded path).
// The caller owns its lifecycle (init(), and dispose() on teardown).
export function createJotHostStore(dataDir = resolveJotDataDir()) {
  const store = new TodoStore(new LocalJsonStorage(path.join(dataDir, "todos.json")), dataDir);
  return { store, dataDir };
}
