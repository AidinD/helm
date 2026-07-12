// E2E: P3 polish. (1) The needs-you queue no longer double-lists a dispatched
// (crew) running run that already shows as a crew row in the fleet - only
// captain-launched Direct running runs stay in the queue. (2) The "Done" button
// tooltip sets expectations about the worktree (kept by default).
//
// Run:  node scripts/e2e/test-queue-dedup.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[queue-dedup-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const out = await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("crew-run", { goalRunId: "crew-run", ordinal: 1, goal: "dispatched crew run", projectPath: "P", status: "running", dispatchedBy: "m0", escalation: null, iterations: [{}] });
    goalRuns.set("direct-run", { goalRunId: "direct-run", ordinal: 2, goal: "captain's own run", projectPath: "P", status: "running", dispatchedBy: null, escalation: null, iterations: [{}] });
    const running = dashboardRunningRuns().map((r) => r.goalRunId).sort();
    // P3b: Done tooltip differs by worktree presence.
    const withWt = reportRowDoneBtn({ goalRunId: "w", result: { worktreePath: "P/wt" } }).title;
    const noWt = reportRowDoneBtn({ goalRunId: "n", result: null }).title;
    return { running, withWt, noWt };
  })()`);

  assert(out.running.length === 1 && out.running[0] === "direct-run",
    `only the Direct running run stays in the queue (got ${JSON.stringify(out.running)})`);
  assert(/keep or remove its worktree/i.test(out.withWt), `Done tooltip on a worktree run mentions keep/remove (got "${out.withWt}")`);
  assert(!/worktree/i.test(out.noWt), `Done tooltip on a no-worktree run stays simple (got "${out.noWt}")`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: queue dedups dispatched crew runs; Done sets worktree expectations." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
