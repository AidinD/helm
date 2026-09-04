// E2E: the Goal page offers Open/Delete worktree actions on finished runs (that
// leave a worktree on disk) and NOT on live/running runs (whose worktree is in
// use) or runs with no worktree. Real launched Helm via CDP. Injects runs
// into goalRuns and re-renders - actual deletion needs a real git worktree, so
// that path is only exercised in a live run, not here.
//
// Run:  node scripts/e2e/test-goal-worktree-actions.mjs
import { launch } from "../checks-lib/harness.mjs";

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
    goalRuns.set("done-wt", { goalRunId: "done-wt", ordinal: ++goalRunSeq, goal: "Finished with worktree", projectPath: "P", status: "done", iterations: [], result: { worktreePath: "P-worktrees/goal-x", branchName: "helm/goal-x", stoppedReason: "no_op_convergence" }, error: null, escalation: null, latestPlan: null });
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

  // Bug d8b36df6: worktree actions cluster in the right-aligned group...
  const wtInsideRight = await app.eval(
    `!!document.querySelector("#goalPage .goal-run-head-right .goal-worktree-actions")`
  );
  assert(wtInsideRight === true, "worktree actions nested inside the .goal-run-head-right group");
  // ...and the collapse control is a ▾ chevron at the FAR LEFT of the head - the
  // same spot the ▶ expand chevron sits on the collapsed row - NOT in the right
  // group (the captain: "collapse should be where the expand button is"). Assert it's
  // the head's first child and not inside the right group.
  const collapsePlacement = await app.eval(`(() => {
    const head = document.querySelector("#goalPage .goal-run-detail .goal-run-head");
    const chev = head ? head.querySelector(".goal-collapse-chev") : null;
    if (!chev) return { hasChev: false };
    return {
      hasChev: true,
      isFirstChild: head.firstElementChild === chev,
      inRightGroup: !!chev.closest(".goal-run-head-right"),
    };
  })()`);
  assert(collapsePlacement.hasChev, "an expanded run shows the collapse chevron");
  assert(collapsePlacement.isFirstChild, "the collapse chevron is the head's FIRST (left-most) child, mirroring the expand chevron");
  assert(collapsePlacement.inRightGroup === false, "the collapse chevron is NOT in the right-aligned group (so it can't float mid-head)");

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
