// E2E: the Goal page offers Open/Delete worktree actions on finished runs (that
// leave a worktree on disk) and NOT on live/running runs (whose worktree is in
// use) or runs with no worktree. Real launched Helm via CDP. Injects runs
// into goalRuns and re-renders - actual deletion needs a real git worktree, so
// that path is only exercised in a live run, not here.
//
// Run:  node scripts/e2e/test-goal-worktree-actions.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[worktree-actions-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });

  // Three runs: a finished one WITH a worktree, a running one, and a finished
  // one WITHOUT a worktree (errored before creating one).
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("done-wt", { goalRunId: "done-wt", ordinal: ++goalRunSeq, goal: "Finished with worktree", projectPath: "P", status: "done", iterations: [], result: { worktreePath: "P-worktrees/goal-x", branchName: "helm/goal-x", stoppedReason: "completed" }, error: null, escalation: null, latestPlan: null });
    goalRuns.set("running-1", { goalRunId: "running-1", ordinal: ++goalRunSeq, goal: "Still running", projectPath: "P", status: "running", iterations: [], result: null, error: null, escalation: null, latestPlan: null });
    goalRuns.set("err-nowt", { goalRunId: "err-nowt", ordinal: ++goalRunSeq, goal: "Errored, no worktree", projectPath: "P", status: "error", iterations: [], result: null, error: "boom", escalation: null, latestPlan: null });
    // Finished runs collapse to a one-line summary by default now - force them
    // expanded so the full .goal-run-detail (with worktree actions) renders.
    goalRunExpanded.add("done-wt");
    goalRunExpanded.add("err-nowt");
    renderGoalPage();
    return true;
  })()`);

  const blocks = await count("#goalPage .goal-run-detail");
  assert(blocks === 3, `three run blocks rendered (got ${blocks})`);

  // Only the finished-with-worktree run gets the actions group.
  const actionGroups = await count("#goalPage .goal-worktree-actions");
  assert(actionGroups === 1, `worktree actions shown only for the finished run with a worktree (got ${actionGroups})`);

  // Bug d8b36df6: every head control (collapse + worktree actions) clusters in a
  // single right-aligned group, so the worktree actions live INSIDE it (not as a
  // sibling with a competing margin-left:auto that left "collapse" floating).
  const wtInsideRight = await app.eval(
    `!!document.querySelector("#goalPage .goal-run-head-right .goal-worktree-actions")`
  );
  assert(wtInsideRight === true, "worktree actions nested inside the .goal-run-head-right group");

  const goalText = await app.eval(`document.getElementById("goalPage").innerText`);
  assert(/Open worktree/.test(goalText), "'Open worktree' button present");
  assert(/Delete worktree/.test(goalText), "'Delete worktree' button present");

  // The running run still gets its Cancel button (and no worktree actions).
  const cancelBtns = await count("#goalPage .goal-run-detail .goal-cancel-btn");
  assert(cancelBtns === 1, `the running run keeps its Cancel button (got ${cancelBtns})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: worktree actions gated to finished runs with a worktree." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
