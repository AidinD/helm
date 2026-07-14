// E2E: a captain can actually clear a handled crew run from the fleet, and clean
// its worktree, from the crew row itself. Regression for two gaps (Aidin: "I
// don't know what to do with these - I can't get rid of them, and there are 4
// worktrees I don't know what to do with"):
//   1. The fleet crew list wasn't acknowledged-filtered, so "Done" removed the
//      button but not the row - a handled/errored run stayed under its second
//      mate forever.
//   2. reportRowDoneBtn read run.result?.worktreePath, but a fleet crew row's
//      run is a history RECORD with worktreePath at the TOP level - so the crew
//      "Done" never offered to remove the worktree (orphaned worktrees).
//
// Run:  node scripts/e2e/test-crew-dismiss.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[crew-dismiss-e2e]", ...a);
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
    state.config = state.config || {};
    state.config.acknowledgedGoalRuns = ["ack-err"];
    const sm = { secondMateId: "sm1", firstMateId: "m0", name: "helm", sessionId: null, status: "created", crew: [
      { goalRunId: "ack-err", status: "error", worktreePath: "P/wt-ack", branchName: "b1", goal: "already handled errored run", iterations: [{}] },
      { goalRunId: "live-err", status: "error", worktreePath: "P/wt-live", branchName: "b2", goal: "errored run still to handle", iterations: [{}] },
    ]};
    const el = fleetSecondMateEl(sm);
    const rowLabels = [...el.querySelectorAll(".fleet-crew-label")].map((x) => x.textContent);
    // A fleet crew row's run is a history record (worktreePath top-level). The
    // Done button must recognize that worktree so it can offer to remove it.
    const withWtRecord = reportRowDoneBtn({ goalRunId: "r", worktreePath: "P/wt", branchName: "b" }).title;
    const noWtRecord = reportRowDoneBtn({ goalRunId: "r2" }).title;
    return {
      rows: rowLabels.length,
      labels: rowLabels,
      doneOffersWorktreeForRecord: /keep or remove/i.test(withWtRecord),
      plainDoneWhenNoWorktree: !/worktree/i.test(noWtRecord),
    };
  })()`);

  assert(out.rows === 1, `a Done'd (acknowledged) crew run is cleared from the fleet - only the unhandled one remains (got ${out.rows}: ${JSON.stringify(out.labels)})`);
  assert(/still to handle/.test((out.labels || [])[0] || ""), "the remaining row is the unhandled errored run");
  assert(out.doneOffersWorktreeForRecord, "the crew-row Done offers to remove the worktree for a history-record run (top-level worktreePath)");
  assert(out.plainDoneWhenNoWorktree, "a run with no worktree still gets a plain Done");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: handled crew clears from the fleet + its worktree is cleanable from Done." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
