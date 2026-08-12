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
const WORKER_PATH = path.join(__dirname, "..", "worker", "heavy.mjs");

// Long enough that a genuinely slow job (a cold review build on a spinning disk) is not
// abandoned, short enough that a wedged worker cannot hold a view hostage. On timeout the
// call falls back in-process, so the ceiling is "slow", never "broken".
const CALL_TIMEOUT_MS = 30_000;
// A restart storm helps nobody: if the worker keeps dying, stop paying to respawn it and
// just use the fallback path, which is what the app did for its whole life until now.
const MAX_RESTARTS = 3;

let child = null;
let readyPromise = null;
let restarts = 0;
let disabled = false;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }
let lastError = null;

/** Whether the worker is actually carrying the load, for the honest answer in diagnostics. */
export function heavyWorkerStatus() {
  return { alive: !!child && !disabled, disabled, restarts, lastError };
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
        settle(resolve, true);
      }
    }
    spawned.on("message", onReady);
    // A worker that never says "ready" is a worker that failed to load its module graph
    // (an ESM entry point in a utility process is exactly the thing that can silently not
    // load). Reject rather than hang, so the first caller falls back immediately.
    timer = setTimeout(() => settle(reject, new Error("worker did not report ready")), 10_000);
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
      worker.postMessage({ id, kind, args });
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
