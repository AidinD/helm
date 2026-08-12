// The heavy jobs (the review queue, the session read) moved OFF the main process into an
// Electron utilityProcess, because they were blocking the one thread that also has to keep
// the window responsive - 93-212ms every 30 seconds for the session poll, and 1.4s to 6s
// for a review-queue build, measured on the captain's machine 2026-08-12.
//
// The client falls back to running the job on the main process whenever the worker cannot,
// which is what makes the change safe - and also what makes it SILENT. If the worker never
// starts, everything still works, exactly as slowly as before, and nothing says so. This
// check exists because "did the optimisation actually engage?" cannot be answered by the
// app looking fine.
//
// It launches the real app, so it runs in the SLOW lane.
// Run:  node scripts/e2e/test-heavy-worker.mjs
import { launch } from "./harness.mjs";

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

  // Asking for the sessions is what first wakes the worker (the 30s poll uses the same
  // path), so the status below reflects a worker that has actually run a job, not one
  // that merely spawned.
  const sessions = await app.eval(`window.helm.getSessions().then(r => ({
    count: (r.sessions || []).length,
    error: r.error || null,
    hasConfig: !!r.config,
  }))`);
  ok(!sessions.error, `the session list still loads through the worker (error: ${sessions.error || "none"})`);
  ok(typeof sessions.count === "number" && sessions.hasConfig, `and it comes back complete: ${sessions.count} sessions, config present`);

  const status = await app.eval(`window.helm.getHeavyWorkerStatus()`);
  ok(
    status.alive === true,
    `the utility process is ALIVE and carrying the jobs (${JSON.stringify(status)}) - if this fails the app is silently back to doing everything on the main thread, which is the whole regression this file guards`
  );
  ok(status.disabled === false && status.restarts === 0, "and it has not been dying and respawning behind the scenes");

  // The review queue is the expensive one. It must come back with the same shape the page
  // reads, through the worker's structured-clone boundary - a Map or a class instance
  // would not survive that trip, and the page would break in a way no unit test sees.
  const reviews = await app.eval(`window.helm.listReviews().then(r => ({
    ok: r.ok,
    rows: (r.rows || []).length,
    hasTally: !!r.tally && typeof r.tally.total === "number",
    unbound: (r.unboundCommits || []).length,
    sampleRowKeys: r.rows && r.rows[0] ? Object.keys(r.rows[0]).length : 0,
    firstRowHasRepoPath: !!(r.rows && r.rows[0] && 'repoPath' in r.rows[0]),
    firstRowHasCommitsFlag: !!(r.rows && r.rows[0] && 'hasCommits' in r.rows[0]),
  }))`);
  ok(reviews.ok, "the review queue builds through the worker");
  ok(reviews.hasTally, "its tally survives the structured-clone trip back to main");
  ok(
    reviews.rows === 0 || (reviews.firstRowHasRepoPath && reviews.firstRowHasCommitsFlag),
    `rows keep the fields the page renders from (repoPath, hasCommits) - ${reviews.rows} rows, ${reviews.sampleRowKeys} keys on the first`
  );

  // Second call: served from cache, and the worker must still be healthy afterwards.
  const again = await app.eval(`window.helm.listReviews({ maxAgeMs: 20000 }).then(r => ({ cached: !!r.cached, rows: (r.rows||[]).length }))`);
  ok(again.cached === true, "a second call with an age allowance is served from cache rather than rebuilding - the phase-1 fix, still working through the new path");
  ok(again.rows === reviews.rows, "and the cached payload is the same queue, not a truncated one");

  const after = await app.eval(`window.helm.getHeavyWorkerStatus()`);
  ok(after.alive === true && after.restarts === 0, "the worker survived a full review build without crashing");

  // THE assertion this whole phase exists for.
  //
  // On 2026-08-03 this repo recorded the symptom precisely: "an unrelated cheap IPC issued
  // during one took 421ms, because the main process was blocked outright". So: start a
  // FRESH review build (no age allowance = no cache) without awaiting it, and immediately
  // time a trivial IPC. If the build still ran on the main thread, that trivial call queues
  // behind it and the number is hundreds of milliseconds. Off-thread, it answers at once.
  const contention = await app.eval(`(async () => {
    const build = window.helm.listReviews();          // deliberately NOT awaited
    const t0 = performance.now();
    await window.helm.getVersion();                   // the cheapest IPC there is
    const cheapMs = performance.now() - t0;
    const t1 = performance.now();
    await build;
    return { cheapMs, buildMs: cheapMs + (performance.now() - t1) };
  })()`);
  console.log(`      cheap IPC took ${contention.cheapMs.toFixed(0)}ms while a ${contention.buildMs.toFixed(0)}ms review build was running`);
  ok(
    contention.cheapMs < 250,
    `a trivial IPC stays responsive DURING a full review build (${contention.cheapMs.toFixed(0)}ms) - this is the exact measurement that read 421ms when the build ran on the main thread`
  );
} finally {
  await app.close();
}

console.log(
  exit === 0
    ? "VERIFY OK: the heavy jobs really do run off the main process in the running app, and their results come back intact."
    : "VERIFY FAILED."
);
process.exit(exit);
