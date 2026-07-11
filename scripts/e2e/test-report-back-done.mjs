// E2E (real launched Helm via CDP): "Done" on a report-back row - now living in
// the first-mate card's roll-up (there is no separate captain Report-back
// section anymore). Done is a soft acknowledge: the run drops out of the roll-up
// but stays in history. A run with a worktree offers a cleanup/keep choice; one
// without acknowledges directly.
//
// Config is isolated via HELM_CONFIG_PATH so acknowledging never touches the
// real config. The worktree/branch git logic is covered by
// test-worktree-branch.mjs; this drives acknowledge + the "keep" menu path.
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
// The roll-up's row text for the mate we dispatched from. Find it by
// textContent (which includes collapsed/hidden rows, unlike innerText), open
// it, then read the rows.
const rollupText = () =>
  app.eval(`(() => {
    const el = [...document.querySelectorAll("#dashFleetSlot .fleet-report-rollup")].find((r) => /DONE_/.test(r.textContent));
    if (el) { el.classList.add("open"); }
    return el ? (el.querySelector(".fleet-report-rows")?.textContent || "") : "";
  })()`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  const mateId = await app.eval(`(async () => { const m = await window.helm.listMates(); return m.active[0].mateId; })()`);
  assert(!!mateId, "resolved a real first-mate id to dispatch from");

  await app.eval(`(async () => {
    state.config = await window.helm.setConfig({ acknowledgedGoalRuns: [] });
    goalRuns.clear();
    goalRuns.set("noWt", { goalRunId:"noWt", ordinal:++goalRunSeq, goal:"DONE_no_worktree_run", projectPath:"P", dispatchedBy:${JSON.stringify(mateId)}, status:"done", result:{ commitCount:0, stoppedReason:"converged" }, iterations:[], error:null, escalation:null });
    goalRuns.set("wt", { goalRunId:"wt", ordinal:++goalRunSeq, goal:"DONE_with_worktree_run", projectPath:"P", dispatchedBy:${JSON.stringify(mateId)}, status:"done", result:{ commitCount:2, branchName:"helm/goal-wt", worktreePath:"D:/nope/helm-worktrees/wt" }, iterations:[], error:null, escalation:null });
    navigateToPage("dashboard");
    return true;
  })()`);
  await renderDash();

  let text = await rollupText();
  assert(/DONE_no_worktree_run/.test(text) && /DONE_with_worktree_run/.test(text), "both runs appear in the mate roll-up initially");

  // Helper: click the Done button on a roll-up row matching a goal substring.
  const clickDone = (needle) =>
    app.eval(`(() => {
      const el = [...document.querySelectorAll("#dashFleetSlot .fleet-report-rollup")].find((r) => /DONE_/.test(r.textContent));
      el && el.classList.add("open");
      const rows = [...(el?.querySelectorAll(".fleet-report-rows .dash-queue-row") || [])];
      const row = rows.find((r) => new RegExp(${JSON.stringify(needle)}).test(r.textContent));
      const btn = row && row.querySelector(".dash-report-done");
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 200 }));
      return true;
    })()`);

  // --- Done on the no-worktree run: acknowledges directly (no menu) ----------
  const clickedNoWt = await clickDone("DONE_no_worktree_run");
  assert(clickedNoWt, "found and clicked Done on the no-worktree run in the roll-up");
  await wait(400);
  text = await rollupText();
  assert(!/DONE_no_worktree_run/.test(text), "the no-worktree run leaves the roll-up after Done");
  assert(/DONE_with_worktree_run/.test(text), "the other run is still in the roll-up");
  const ackedNoWt = await app.eval(`(state.config.acknowledgedGoalRuns || []).includes("noWt")`);
  assert(ackedNoWt, "the run id is recorded in config.acknowledgedGoalRuns (soft, non-destructive)");

  // --- Done on the with-worktree run: a choice menu; pick "keep the worktree" -
  const clickedWt = await clickDone("DONE_with_worktree_run");
  assert(clickedWt, "found and clicked Done on the with-worktree run");
  const menu = await app.eval(`(() => {
    const m = document.getElementById("contextMenu");
    return { hidden: m.classList.contains("hidden"), items: [...m.querySelectorAll(".item")].map((i) => i.textContent) };
  })()`);
  assert(!menu.hidden, "a choice menu opens for a run that has a worktree");
  assert(menu.items.some((t) => /clean up worktree/.test(t)) && menu.items.some((t) => /keep the worktree/.test(t)), `the menu offers both cleanup and keep (got ${JSON.stringify(menu.items)})`);

  await app.eval(`(() => {
    const item = [...document.querySelectorAll("#contextMenu .item")].find((i) => /keep the worktree/.test(i.textContent));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  })()`);
  await wait(400);
  const ackedWt = await app.eval(`(state.config.acknowledgedGoalRuns || []).includes("wt")`);
  assert(ackedWt, "the with-worktree run is acknowledged via 'Done, keep the worktree'");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Done in the roll-up acknowledges runs (with a cleanup choice for worktree runs)." : "VERIFY FAILED.");
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
