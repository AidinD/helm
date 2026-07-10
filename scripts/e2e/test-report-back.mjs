// E2E: the Dashboard "Report-back" section surfaces a COMPACT result for every
// terminal dispatched/autopilot run - status + one-line what-changed + a
// needs-captain flag - so the captain sees outcomes without opening each run.
// Real launched Helm via CDP. Injects runs into goalRuns and re-renders (no real
// goal run needed). Orchestration-model phase 2 ("Structured report-back").
//
// Run:  node scripts/e2e/test-report-back.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[report-back-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const isHidden = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.classList.contains("hidden")`);
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // #pageToggle is static HTML and can become visible a hair BEFORE renderer.js
  // finishes evaluating its top-level `let goalRuns = new Map()`, so seeding
  // immediately races that and can throw "goalRuns is not defined". Settle first.
  await new Promise((r) => setTimeout(r, 800));

  // Inject a spread of terminal runs + one live run (which must NOT appear in
  // report-back - it's not a finished result yet).
  await app.eval(`(() => {
    goalRuns.clear();
    // done WITH commits + an implement iteration summary -> needs captain, "what changed" = the summary.
    goalRuns.set("doneCommits", { goalRunId: "doneCommits", ordinal: ++goalRunSeq, goal: "Add the export button", projectPath: "P", dispatchedBy: null,
      status: "done", result: { commitCount: 3, branchName: "helm/goal-abc", stoppedReason: "done" },
      iterations: [{ ok: true, phase: "implement", result: { success: true, summary: "Wired the export button to the CSV writer" } }], error: null, escalation: null, latestPlan: null });
    // done CLEAN, no commits -> no needs-captain flag.
    goalRuns.set("doneClean", { goalRunId: "doneClean", ordinal: ++goalRunSeq, goal: "Investigate flaky test", projectPath: "P", dispatchedBy: null,
      status: "done", result: { commitCount: 0, branchName: "helm/goal-def", stoppedReason: "converged" }, iterations: [], error: null, escalation: null, latestPlan: null });
    // escalated (status done + escalation) -> paused, needs captain, dispatched origin.
    goalRuns.set("esc", { goalRunId: "esc", ordinal: ++goalRunSeq, goal: "Refactor auth layer", projectPath: "P", dispatchedBy: "mate_work",
      status: "done", result: { commitCount: 1, branchName: "helm/goal-ghi" }, iterations: [], error: null, escalation: { signal: "ambiguity_reported", detail: "Unclear which token store to use" }, latestPlan: null });
    // errored -> failed, needs captain.
    goalRuns.set("err", { goalRunId: "err", ordinal: ++goalRunSeq, goal: "Upgrade the bundler", projectPath: "P", dispatchedBy: null,
      status: "error", result: null, iterations: [], error: "npm build failed", escalation: null, latestPlan: null });
    // still running -> NOT a report-back row.
    goalRuns.set("live", { goalRunId: "live", ordinal: ++goalRunSeq, goal: "Live run in progress", projectPath: "P", dispatchedBy: null,
      status: "running", result: null, iterations: [{ ok: true, phase: "implement", result: { success: true, summary: "step" } }], error: null, escalation: null, latestPlan: null });
    return true;
  })()`);

  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashReportSlot .dash-queue-row", 8000);

  const slotText = await app.eval(`document.querySelector("#dashReportSlot").innerText`);
  log("report-back slot text:\n" + slotText);

  // The four terminal runs appear; the live one does not.
  assert(/Report-back/i.test(slotText), "the Report-back section header renders");
  assert(/Add the export button/.test(slotText), "the done-with-commits run appears");
  assert(/Wired the export button to the CSV writer/.test(slotText), "its 'what changed' line is the implement iteration's own summary");
  assert(/3 commits ready for review in helm\/goal-abc/.test(slotText), "its needs-captain nudge names the commit count + branch");
  assert(/Investigate flaky test/.test(slotText), "the clean-done run appears");
  assert(/Refactor auth layer/.test(slotText), "the escalated run appears");
  assert(/Unclear which token store to use/.test(slotText), "the escalated run's what-changed is its escalation detail");
  assert(/Dispatched: "Refactor auth layer"/.test(slotText), "a dispatched run is labelled 'Dispatched'; an autopilot one 'Autopilot'");
  assert(/Upgrade the bundler/.test(slotText), "the errored run appears");
  assert(!/Live run in progress/.test(slotText), "a still-running run is NOT in report-back (it's not a finished result)");

  // Rows counts: 4 terminal rows, and exactly 3 of them (commits/escalated/error) carry the needs accent.
  const rowCount = await count("#dashReportSlot .dash-queue-row");
  const needsRows = await count("#dashReportSlot .dash-queue-row.dash-report-needs");
  assert(rowCount === 4, `four report rows render (got ${rowCount})`);
  assert(needsRows === 3, `exactly the commits+escalated+errored rows carry the needs-captain accent (got ${needsRows})`);

  // The done check icon shows on the clean run, the warning on needs-captain ones.
  const doneIcons = await count("#dashReportSlot .dash-state-done");
  const needsIcons = await count("#dashReportSlot .dash-state-needs");
  assert(doneIcons === 1, `the clean-done run gets the calm check icon (got ${doneIcons})`);
  assert(needsIcons === 3, `the three needs-captain runs get the warning icon (got ${needsIcons})`);

  // Clicking a report row navigates to the Goal page (full run detail).
  const clicked = await app.eval(`(() => {
    const rows = [...document.querySelectorAll('#dashReportSlot .dash-queue-row')];
    const r = rows.find((x) => /Add the export button/.test(x.textContent));
    if (r) { r.click(); return true; }
    return false;
  })()`);
  assert(clicked, "found and clicked the done-with-commits report row");
  await app.waitForSelector("#goalPage", 8000, { visible: true });
  assert(!(await isHidden("goalPage")), "clicking a report row navigates to the Goal page");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: terminal runs report back compactly on the Dashboard." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
