import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";

/**
 * Main-process client for the off-main worker (see worker/heavy.mjs).
 *
 * The design rule here is that this can only ever make Helm FASTER, never less capable.
 * Every call takes an `inProcess` fallback - the exact synchronous code that ran before -
 * and uses it whenever the worker is not available, has not come up yet, dies mid-call,
 * or takes implausibly long. A perf optimisation that can break a feature when a child
 * process fails to spawn is not worth having, and the failure would be invisible: the
 * page would just stop loading.
 *
 * utilityProcess rather than worker_threads because it is Electron's own supported way to
 * run Node work off the main process, and rather than child_process.fork because a
 * packaged app has no node binary to fork - process.execPath is Electron itself.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_HEAVY_WORKER_MODULE is a test seam. The fallback below is the safety net the whole
// design rests on - "if the worker cannot start, everything still works, just slower" - and
// until it was pointed at a deliberately broken worker, that sentence was an argument rather
// than a tested fact (review, 2026-08-12). scripts/e2e/test-heavy-worker-fallback.mjs points
// it at a worker that never reports ready.
const WORKER_PATH = process.env.HELM_HEAVY_WORKER_MODULE || path.join(__dirname, "..", "worker", "heavy.mjs");

// Long enough that a genuinely slow job (a cold review build on a spinning disk) is not
// abandoned, short enough that a wedged worker cannot hold a view hostage. On timeout the
// call falls back in-process, so the ceiling is "slow", never "broken".
const CALL_TIMEOUT_MS = 30_000;
// A restart storm helps nobody: if the worker keeps dying, stop paying to respawn it and
// just use the fallback path, which is what the app did for its whole life until now.
const MAX_RESTARTS = 3;

let child = null;
let readyPromise = null;
let ready = false; // the worker answered the ready handshake - see heavyWorkerStatus
let restarts = 0;
let disabled = false;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }
let lastError = null;

/**
 * Whether the worker is actually carrying the load, for the honest answer in diagnostics.
 *
 * `alive` means the READY HANDSHAKE SUCCEEDED, not merely that a child object exists. It
 * used to mean the latter, and that made this function lie in the one case it was added to
 * expose: a worker whose module graph fails to load (the file's own comment calls an ESM
 * entry point in a utility process "exactly the thing that can silently not load") never
 * reports ready and never exits, so a child object sits there forever while every job runs
 * on the main process. Status said alive:true throughout (found by review, 2026-08-12).
 */
export function heavyWorkerStatus() {
  return { alive: !!child && ready && !disabled, disabled, restarts, lastError };
}

function failAllPending(reason) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function spawn() {
  child = utilityProcess.fork(WORKER_PATH, [], {
    serviceName: "helm-heavy",
    // The worker reads files and runs git; it needs no window, no Electron API and no
    // elevated anything.
    stdio: "inherit",
  });
  const spawned = child;
  readyPromise = new Promise((resolve, reject) => {
    let timer = null;
    const settle = (fn, value) => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      spawned.off("message", onReady);
      fn(value);
    };
    function onReady(message) {
      if (message && message.ready) {
        ready = true;
        settle(resolve, true);
      }
    }
    spawned.on("message", onReady);
    // A worker that never says "ready" is a worker that failed to load its module graph
    // (an ESM entry point in a utility process is exactly the thing that can silently not
    // load). Reject rather than hang, so the first caller falls back immediately.
    //
    // And then KILL it. Leaving the child object in place was the bug: nothing ever exited,
    // so the exit handler below never ran, `child` stayed non-null, and every later call
    // awaited this same already-rejected promise - a permanent silent fallback that
    // heavyWorkerStatus still reported as healthy. Killing it makes the exit path run, which
    // clears the child and counts the failure toward MAX_RESTARTS like any other death.
    timer = setTimeout(() => {
      settle(reject, new Error("worker did not report ready"));
      try {
        spawned.kill();
      } catch {
        // already gone; the exit handler will still fire
      }
    }, 10_000);
    spawned.once("exit", () => settle(reject, new Error("worker exited before reporting ready")));
  });
  // Nothing may call this promise's rejection "unhandled": ensureWorker awaits it, but a
  // rejection that lands before anyone awaits would otherwise surface as a process-level
  // warning about a failure this file is designed to absorb.
  readyPromise.catch(() => {});

  child.on("message", (message) => {
    if (!message || message.ready) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return; // a reply for a call that already timed out and fell back
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error || "worker job failed"));
    }
  });

  child.once("exit", (code) => {
    lastError = `worker exited (code ${code})`;
    child = null;
    ready = false;
    readyPromise = null;
    // Every in-flight call must be told, or its caller waits forever for a process that
    // no longer exists. They fall back in-process, so nothing is lost but time.
    failAllPending(lastError);
    restarts += 1;
    if (restarts > MAX_RESTARTS) {
      disabled = true;
      console.error(`[helm] heavy worker died ${restarts} times; running heavy jobs on the main process from now on`);
    }
  });
}

async function ensureWorker() {
  if (disabled) {
    return null;
  }
  if (!child) {
    try {
      spawn();
    } catch (err) {
      lastError = String(err?.message || err);
      disabled = true;
      return null;
    }
  }
  try {
    await readyPromise;
    return child;
  } catch (err) {
    lastError = String(err?.message || err);
    return null;
  }
}

/**
 * Run a job off the main process, falling back to running it here if that is not possible.
 *
 * @param {string} kind             a job name the worker knows (see worker/heavy.mjs).
 * @param {object} args             structured-cloneable arguments.
 * @param {Function} inProcess      the synchronous original; used whenever the worker cannot.
 * @returns {Promise<any>}
 */
export async function runHeavy(kind, args, inProcess) {
  const worker = await ensureWorker();
  if (!worker) {
    return inProcess();
  }
  const id = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`worker job '${kind}' timed out`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, kind, args });
      } catch (err) {
        // postMessage can throw before the message is ever sent - the whole config object
        // crosses this boundary, and anything non-cloneable in it fails here. Registering
        // the entry and the timer first and then not cleaning them up left a 30-second
        // timer and a map entry behind on every such call (found by review, 2026-08-12).
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  } catch (err) {
    // Deliberately not re-thrown. The caller asked for a review queue, not for a report on
    // our process topology - so it gets one, computed here, exactly as it was before this
    // file existed. Logged once per failure so a permanently-fallback app is diagnosable
    // rather than merely slow for reasons nobody can see.
    lastError = String(err?.message || err);
    console.error(`[helm] heavy worker could not run '${kind}' (${lastError}); running it on the main process instead`);
    return inProcess();
  }
}

/** Stop the worker, e.g. on app quit, so it cannot outlive the app. */
export function stopHeavyWorker() {
  if (child) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    child = null;
    readyPromise = null;
  }
  failAllPending("app is quitting");
}
