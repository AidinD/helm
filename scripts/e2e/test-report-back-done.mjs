// E2E (real launched Helm via CDP): tiered report-back phase 2 - marking a run
// "Done" from a report-back row. Done is a soft acknowledge: it drops the run
// from the report-back glance surfaces (Dashboard + fleet roll-up) but keeps it
// in history. A run with a worktree offers a small choice (clean up vs keep);
// a run without one acknowledges directly.
//
// Config is isolated to a temp file via HELM_CONFIG_PATH so acknowledging here
// never touches the real config. The worktree/branch cleanup git logic itself
// is covered by test-worktree-branch.mjs; this test drives the acknowledge +
// filtering + the "keep the worktree" menu path (no real git needed).
//
// Run:  node scripts/e2e/test-report-back-done.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpConfig = path.join(os.tmpdir(), `helm-reportdone-${process.pid}.json`);
process.env.HELM_CONFIG_PATH = tmpConfig;

const { launch } = await import("./harness.mjs");

function log(...a) {
  console.log("[report-done-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function renderDash() {
  await app.eval(`(async () => { await fillDashboardSections({ force: true }); return true; })()`);
  await app.eval(`(async () => { await fillDashboardSections({ force: true }); return true; })()`);
  await wait(250);
}
const reportText = () => app.eval(`document.querySelector("#dashReportSlot").innerText`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  await app.eval(`(async () => {
    state.config = await window.helm.setConfig({ acknowledgedGoalRuns: [] });
    goalRuns.clear();
    // Captain run, clean, NO worktree -> Done acknowledges directly.
    goalRuns.set("noWt", { goalRunId:"noWt", ordinal:++goalRunSeq, goal:"DONE_no_worktree_run", projectPath:"P", dispatchedBy:null, status:"done", result:{ commitCount:0, stoppedReason:"converged" }, iterations:[], error:null, escalation:null });
    // Captain run WITH a worktree -> Done offers a choice.
    goalRuns.set("wt", { goalRunId:"wt", ordinal:++goalRunSeq, goal:"DONE_with_worktree_run", projectPath:"P", dispatchedBy:null, status:"done", result:{ commitCount:2, branchName:"helm/goal-wt", worktreePath:"D:/nope/helm-worktrees/wt" }, iterations:[], error:null, escalation:null });
    navigateToPage("dashboard");
    return true;
  })()`);
  await renderDash();

  let text = await reportText();
  assert(/DONE_no_worktree_run/.test(text) && /DONE_with_worktree_run/.test(text), "both seeded runs appear in report-back initially");

  // --- Done on the no-worktree run: acknowledges directly (no menu) ----------
  const clickedNoWt = await app.eval(`(() => {
    const rows = [...document.querySelectorAll("#dashReportSlot .dash-queue-row")];
    const row = rows.find((r) => /DONE_no_worktree_run/.test(r.textContent));
    const btn = row && row.querySelector(".dash-report-done");
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  })()`);
  assert(clickedNoWt, "found and clicked the Done button on the no-worktree run");
  await wait(400);
  text = await reportText();
  assert(!/DONE_no_worktree_run/.test(text), "the no-worktree run is removed from report-back after Done");
  assert(/DONE_with_worktree_run/.test(text), "the other run is still shown");
  const ackedNoWt = await app.eval(`(state.config.acknowledgedGoalRuns || []).includes("noWt")`);
  assert(ackedNoWt, "the run id is recorded in config.acknowledgedGoalRuns (soft, non-destructive)");

  // --- Done on the with-worktree run: a choice menu; pick "keep the worktree" -
  const openedMenu = await app.eval(`(() => {
    const rows = [...document.querySelectorAll("#dashReportSlot .dash-queue-row")];
    const row = rows.find((r) => /DONE_with_worktree_run/.test(r.textContent));
    const btn = row && row.querySelector(".dash-report-done");
    if (!btn) return { ok:false };
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 200 }));
    const menu = document.getElementById("contextMenu");
    const items = [...menu.querySelectorAll(".item")].map((i) => i.textContent);
    return { ok:true, hidden: menu.classList.contains("hidden"), items };
  })()`);
  assert(openedMenu.ok, "found and clicked the Done button on the with-worktree run");
  assert(!openedMenu.hidden, "a choice menu opens for a run that has a worktree");
  assert(openedMenu.items.some((t) => /clean up worktree/.test(t)) && openedMenu.items.some((t) => /keep the worktree/.test(t)), `the menu offers both cleanup and keep (got ${JSON.stringify(openedMenu.items)})`);

  await app.eval(`(() => {
    const item = [...document.querySelectorAll("#contextMenu .item")].find((i) => /keep the worktree/.test(i.textContent));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  })()`);
  await wait(400);
  text = await reportText();
  assert(!/DONE_with_worktree_run/.test(text), "the with-worktree run is removed from report-back after 'Done, keep the worktree'");
  const ackedWt = await app.eval(`(state.config.acknowledgedGoalRuns || []).includes("wt")`);
  assert(ackedWt, "the with-worktree run id is also acknowledged");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: report-back Done acknowledges runs (with a cleanup choice for worktree runs)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
  try {
    fs.rmSync(tmpConfig, { force: true });
  } catch {
    // best-effort
  }
}
process.exit(exitCode);
