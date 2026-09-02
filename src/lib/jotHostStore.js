// Data layer behind Helm's embedded Jot tab ("one Jot, two mounts" -
// DECISIONS 2026-07-18). Helm HOSTS a @jot/core store bound to the SAME todos.json
// a standalone Jot uses; its embedded webview renders Jot's built UI against this
// store, and the auto-captain writes tags/lane-moves through it. @jot/core is the
// framework-agnostic data core Jot was split into (its store already has an event
// bus + file-watch, so external changes reload and Helm's mounts stay in sync).
import path from "node:path";
import { resolveJotDataDir } from "./jotDataDir.js";
import { jotUnavailableMessage } from "./jot.js";

export { resolveJotDataDir };

// @jot/core is loaded LAZILY, and that is the whole point of this line.
//
// It is declared as `file:../jot/dist-core` - a sibling checkout. `npm install` in a
// clone that has no jot repo next to it still exits 0 and leaves a DANGLING symlink, so
// nothing warns you. A static `import ... from "@jot/core"` at the top of this file then
// made the failure terminal in the worst possible way: this module is imported by
// main.js, so Electron printed "App threw an error during load /
// ERR_MODULE_NOT_FOUND: Cannot find package '@jot/core'" to a console nobody was
// watching and opened NO WINDOW AT ALL. Reproduced on 2026-09-02 for card 6c84414b -
// a first-time user with no Jot got a Helm that simply did not start.
//
// A packaged Helm bundles @jot/core, so this path is normally taken; deferring the
// import costs one dynamic import the first time the Jot tab mounts and turns the
// absence of one optional feature's dependency into that feature's own error message.
let corePromise = null;

async function loadJotCore() {
  if (!corePromise) {
    corePromise = import("@jot/core");
  }
  try {
    return await corePromise;
  } catch (err) {
    // Let a later mount try again rather than caching the rejection forever.
    corePromise = null;
    const reason = new Error(
      "Helm could not load @jot/core, the data core behind the embedded Jot tab. In an " +
        "installed Helm that means the build did not ship it, which is a packaging problem: " +
        "install a newer build. Running from a source checkout, it means the sibling jot " +
        "repository is missing or unbuilt - clone jot next to helm, build it, then run " +
        `npm install again. (${err?.message || err})`
    );
    reason.code = "JOT_CORE_MISSING";
    throw reason;
  }
}

// Create a HOST-mode @jot/core store bound to the shared Jot data (same todos.json
// a standalone Jot uses - resolved portably via jotDataDir.js, no hardcoded path).
// The caller owns its lifecycle (init(), and dispose() on teardown).
//
// Async because of the lazy import above. Throws an Error with code JOT_CORE_MISSING
// when @jot/core is not installed, which callers should report rather than crash on.
export async function createJotHostStore(dataDir = resolveJotDataDir()) {
  const { TodoStore, LocalJsonStorage } = await loadJotCore();
  const store = new TodoStore(new LocalJsonStorage(path.join(dataDir, "todos.json")), dataDir);
  return { store, dataDir };
}

// Is @jot/core loadable in this build at all? Used by the Jot tab to tell "your Jot
// board does not exist yet" apart from "this Helm cannot render a Jot board", which are
// different problems with different fixes.
export async function jotCoreAvailable() {
  try {
    await loadJotCore();
    return { available: true, error: null };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Should the embedded Jot tab mount a host store, and if not, what does the person
 * reading the tab need to be told?
 *
 * PURE, and separate from the mount itself, because this is the decision the Jot-less
 * user's whole experience turns on and it deserves a test that does not need Electron.
 *
 * The refusal that matters is `no-board` at the DEFAULT location. @jot/core's own
 * `init()` writes the file it failed to read, so mounting there does not fail - it
 * MANUFACTURES an empty board inside another app's data directory and renders it. The
 * tab then shows a clean, empty Jot, which reads as "you have no tasks" when the truth
 * is "Jot has never run on this machine". Refusing, and saying which of those it is, is
 * the only version of this that cannot mislead.
 *
 * An EXPLICIT `jot.path` is the exception: pointing Helm at a board is an instruction,
 * and creating that file is carrying it out rather than guessing.
 *
 * @param {{available: boolean, path: string|null, explicitPath: boolean, reason: string|null}} boardStatus
 * @param {{available: boolean, error: string|null}} coreStatus
 * @returns {{mount: boolean, error: string|null, reason: string|null}}
 */
export function jotMountDecision(boardStatus, coreStatus) {
  if (!coreStatus?.available) {
    return { mount: false, error: coreStatus?.error || "@jot/core is not available.", reason: "core-missing" };
  }
  if (boardStatus?.available) {
    return { mount: true, error: null, reason: null };
  }
  if (boardStatus?.reason === "no-board" && boardStatus.explicitPath) {
    // The user named this file. Mounting creates it, which is what they asked for.
    return { mount: true, error: null, reason: null };
  }
  return { mount: false, error: jotUnavailableMessage(boardStatus), reason: boardStatus?.reason || "no-board" };
}
