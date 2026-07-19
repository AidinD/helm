// One portable resolver for where Jot's data lives, shared by every Helm code
// path that touches it (lib/jot.js's board read, jotHostStore.js's embedded-tab
// store). No hardcoded path, no electron dependency - so anyone can run Helm and
// it finds Jot's data the same way Jot itself does (task b89aa99b):
//   JOT_DATA_DIR override, else the OS roaming-appData location for the Jot app.
// This mirrors Jot's own data-dir.ts (app.getPath('userData') == %APPDATA%/jot on
// Windows) without needing electron here.
import os from "node:os";
import path from "node:path";

function osAppData() {
  if (process.env.APPDATA) {
    return process.env.APPDATA; // Windows roaming appData
  }
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config"); // Linux
}

export function resolveJotDataDir() {
  const override = process.env.JOT_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return path.join(osAppData(), "jot");
}

export function resolveJotTodosPath(dataDir = resolveJotDataDir()) {
  return path.join(dataDir, "todos.json");
}
