/**
 * The off-main worker.
 *
 * Helm's main process is the one thread that answers every IPC, drives every window
 * event and keeps the UI responsive - and it was also the thread doing the filesystem
 * and git work. Measured on Aidin's machine 2026-08-12: starting a single git process
 * costs ~70ms on Windows before it does anything, the review queue spent ~1.4s of that
 * per build even after the phase-1 batching, and reading the session list cost 93-212ms
 * every 30 seconds. While any of that ran, the whole app was unresponsive. That is the
 * "hela appen laggar faktiskt till ibland" this exists to end.
 *
 * The important part is not that these two jobs moved. It is that there is now somewhere
 * for heavy work to live, so the NEXT expensive feature does not quietly put the freeze
 * back - which is exactly what happened to the 2026-08-03 fix that only added a cache.
 *
 * Contract, deliberately tiny:
 *   in   { id, kind, args }
 *   out  { id, ok: true, result } | { id, ok: false, error }
 *
 * Rules for anything added here:
 *   - It must not import electron. This process has no Electron APIs by design.
 *   - It must not WRITE. Main is the single writer of config.json and every other piece
 *     of app state; a job that needs something persisted RETURNS it and lets main write.
 *     Two processes writing the same file is a corruption race, not a speed-up.
 */
import { readAllSessions } from "../lib/sessions.js";
import { buildReviewQueuePayload } from "../lib/reviewQueueBuild.js";

const jobs = {
  /** The review queue. Returns { payload, watermarks } - main persists the watermarks. */
  reviewQueue: ({ metaHome, config }) => buildReviewQueuePayload({ metaHome, config }),

  /** The session list, including the transcript tail-read that derives each status. */
  sessions: ({ attentionWindowMs } = {}) => readAllSessions({ attentionWindowMs }),
};

process.parentPort.on("message", async (event) => {
  const { id, kind, args } = event.data || {};
  try {
    const job = jobs[kind];
    if (!job) {
      throw new Error(`unknown job: ${kind}`);
    }
    // Awaited so a job may become async later without changing this contract.
    const result = await job(args || {});
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    // The error is flattened to a string on purpose: an Error does not survive the
    // structured clone intact, and a job failing must never look like a job hanging -
    // the client's fallback depends on getting an answer either way.
    process.parentPort.postMessage({ id, ok: false, error: String(err?.stack || err?.message || err) });
  }
});

// Tell the client the module graph loaded and jobs can be dispatched. Without this the
// client cannot distinguish "starting" from "silently failed to load", and would have to
// discover the difference by timing out on the first real request.
process.parentPort.postMessage({ ready: true, jobs: Object.keys(jobs) });
