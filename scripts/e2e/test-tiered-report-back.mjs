// E2E (real launched Helm via CDP): tiered report-back, phase 1 (view routing).
// A terminal run reports back to WHOEVER dispatched it:
//   - captain/Autopilot-initiated (dispatchedBy null) -> Captain Dashboard.
//   - mate-dispatched + handled -> stays UNDER that mate's card roll-up only.
//   - mate-dispatched + needs-captain (escalated / commits-ready / failed) ->
//     bubbles UP to the Dashboard AND stays under the mate (both, not either).
// Plus: the Dashboard report list is a responsive grid (.dash-report-grid).
// See docs/orchestration-model.md "Tiered report-back".
//
// Run:  node scripts/e2e/test-tiered-report-back.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[tiered-report-e2e]", ...a);
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

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  // Use a real first-mate id so its card renders the roll-up for these runs.
  const mateId = await app.eval(`(async () => { const m = await window.helm.listMates(); return m.active[0].mateId; })()`);
  assert(!!mateId, "resolved a real first-mate id to dispatch from");

  await app.eval(`(() => {
    goalRuns.clear();
    // Captain/Autopilot-initiated, clean done -> Captain Dashboard.
    goalRuns.set("cap", { goalRunId:"cap", ordinal:++goalRunSeq, goal:"CAPTAIN_clean_autopilot_run", projectPath:"P", dispatchedBy:null,
      status:"done", result:{ commitCount:0, stoppedReason:"converged" }, iterations:[], error:null, escalation:null });
    // Mate-dispatched, handled (clean) -> under the mate only, NOT the Dashboard.
    goalRuns.set("mh", { goalRunId:"mh", ordinal:++goalRunSeq, goal:"MATE_handled_clean_run", projectPath:"P", dispatchedBy:${JSON.stringify(mateId)},
      status:"done", result:{ commitCount:0, stoppedReason:"converged" }, iterations:[], error:null, escalation:null });
    // Mate-dispatched, escalated -> Dashboard AND mate.
    goalRuns.set("me", { goalRunId:"me", ordinal:++goalRunSeq, goal:"MATE_escalated_run", projectPath:"P", dispatchedBy:${JSON.stringify(mateId)},
      status:"done", result:{ commitCount:0 }, iterations:[], error:null, escalation:{ signal:"ambiguity_reported", detail:"Which token store?" } });
    // Mate-dispatched, commits ready -> Dashboard AND mate.
    goalRuns.set("mc", { goalRunId:"mc", ordinal:++goalRunSeq, goal:"MATE_commits_run", projectPath:"P", dispatchedBy:${JSON.stringify(mateId)},
      status:"done", result:{ commitCount:3, branchName:"helm/goal-mc" }, iterations:[], error:null, escalation:null });
    navigateToPage("dashboard");
    return true;
  })()`);
  await renderDash();

  // --- Dashboard report-back: captain-owned + escalated only -----------------
  const dashText = await app.eval(`document.querySelector("#dashReportSlot").innerText`);
  assert(/CAPTAIN_clean_autopilot_run/.test(dashText), "captain/Autopilot run shows on the Dashboard report-back");
  assert(/MATE_escalated_run/.test(dashText), "an escalated mate run bubbles up to the Dashboard");
  assert(/MATE_commits_run/.test(dashText), "a commits-ready mate run bubbles up to the Dashboard");
  assert(!/MATE_handled_clean_run/.test(dashText), "a HANDLED mate run does NOT appear on the Dashboard (stays under its mate)");

  const isGrid = await app.eval(`!!document.querySelector("#dashReportSlot .dash-report-grid")`);
  assert(isGrid, "the Dashboard report list is laid out as a responsive grid (.dash-report-grid)");

  // --- Mate card roll-up: all three of its runs, 2 need you ------------------
  const rollup = await app.eval(`(() => {
    const heads = [...document.querySelectorAll("#dashFleetSlot .fleet-report-rollup")];
    // Find the roll-up that owns these seeded runs.
    const el = heads.find((r) => /MATE_/.test(r.innerText)) || heads[0];
    if (!el) return { found: false };
    const headText = el.querySelector(".fleet-report-rollup-label")?.textContent || "";
    // Expand it and read the rows.
    el.classList.add("open");
    const rowsText = el.querySelector(".fleet-report-rows")?.innerText || "";
    return { found: true, headText, rowsText, hasNeeds: el.classList.contains("has-needs") };
  })()`);
  assert(rollup.found, "the first mate's card renders a report-back roll-up");
  assert(/Crew reported back: 3/.test(rollup.headText), `roll-up counts all 3 of the mate's runs (got "${rollup.headText}")`);
  assert(/2 need you/.test(rollup.headText), `roll-up flags the 2 needs-captain runs (got "${rollup.headText}")`);
  assert(rollup.hasNeeds, "the roll-up carries the has-needs accent");
  assert(/MATE_handled_clean_run/.test(rollup.rowsText), "the handled run IS under the mate (its real home)");
  assert(/MATE_escalated_run/.test(rollup.rowsText) && /MATE_commits_run/.test(rollup.rowsText), "the escalated + commits runs also stay under the mate (both, not either)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: report-back is tiered - captain board carries owned+escalated, mate card owns its crew." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
