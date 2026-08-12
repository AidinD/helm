// The safety net, actually exercised.
//
// Moving the review build and the session read off the main process is only safe because
// every call falls back to running in-process when the worker cannot. That was an argument,
// not a tested fact - test-heavy-worker only ever covered the happy path, and an independent
// review (2026-08-12) showed the failure it was supposed to guard slipping straight past:
// a worker that loads but never reports ready left a live child object behind, so
// `heavyWorkerStatus()` reported `alive: true` while every job silently ran on the main
// process, and the existing check's two status assertions both passed.
//
// This launches the app pointed at a worker that answers nothing, and requires:
//   - the app still WORKS (this is the whole point of a fallback),
//   - and it says so honestly, rather than claiming a worker is carrying the load.
//
// It launches the app, so it runs in the SLOW lane.
// Run:  node scripts/e2e/test-heavy-worker-fallback.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Set BEFORE launch: the harness copies process.env into the app it spawns.
process.env.HELM_HEAVY_WORKER_MODULE = path.join(here, "fixtures", "never-ready-worker.mjs");

const { launch } = await import("./harness.mjs");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const app = await launch();
try {
  await app.waitForSelector("#pageToggle");

  // The session list must still come back, complete. This is the fallback doing its job.
  const sessions = await app.eval(`window.helm.getSessions().then(r => ({ count: (r.sessions||[]).length, error: r.error || null, hasConfig: !!r.config }))`);
  ok(!sessions.error && sessions.hasConfig, `the session list still loads with a broken worker (error: ${sessions.error || "none"})`);
  ok(sessions.count > 0, `and it is complete, not empty: ${sessions.count} sessions`);

  // And the expensive one.
  const reviews = await app.eval(`window.helm.listReviews().then(r => ({ ok: r.ok, rows: (r.rows||[]).length, hasTally: !!r.tally }))`);
  ok(reviews.ok && reviews.hasTally, `the review queue still builds with a broken worker (${reviews.rows} rows)`);

  // The honesty half. A silent fallback is the failure mode this status field exists to
  // expose, so reporting the worker as alive here is worse than the fallback itself.
  const status = await app.eval(`window.helm.getHeavyWorkerStatus()`);
  ok(
    status.alive === false,
    `heavyWorkerStatus reports alive:false when the worker never completed its handshake (${JSON.stringify(status)}) - it said TRUE before this fix, so the one field meant to reveal a silent fallback was itself silent`
  );
  ok(typeof status.lastError === "string" && status.lastError.length > 0, `and it carries why (${status.lastError})`);

  // The COST of being honest, pinned. The first version of this fix killed the never-ready
  // worker but let the next call spawn another, so a packaged build whose module graph will
  // not load paid the full 10-second ready timeout on each of the user's first four heavy
  // operations - roughly 40 seconds of stalls, where the bug it replaced cost 10 (measured by
  // the second review, 2026-08-12). One timeout must now be enough to give up.
  ok(
    status.disabled === true,
    `one failed handshake disables the worker for the session (${JSON.stringify(status)}) - without this each later call respawns and waits out the 10s timeout again, which made the honest version four times slower than the lie it replaced`
  );
  ok(
    status.restarts <= 1,
    `and it stopped after a single attempt (restarts: ${status.restarts}), rather than burning through MAX_RESTARTS at ten seconds each`
  );
  ok(/did not report ready|exited/i.test(status.lastError), `and the reason survives rather than being overwritten by a bare exit code (${status.lastError})`);
} finally {
  await app.close();
}

console.log(
  exit === 0
    ? "VERIFY OK: with a worker that never answers, Helm still works and admits the worker is not carrying the load."
    : "VERIFY FAILED."
);
process.exit(exit);
