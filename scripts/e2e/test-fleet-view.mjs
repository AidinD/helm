// E2E: the Dashboard fleet/tree view renders the orchestration hierarchy -
// runs grouped by the mate that dispatched them (mate -> runs -> crew), with
// needsCaptain surfaced. Real launched Maestro.
//
// Run:  node scripts/e2e/test-fleet-view.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[fleet-view-e2e]", ...a);
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
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof dashboardFleetSection === "function"`)) {
      break;
    }
    await wait(100);
  }

  // Inject a fleet: two runs under a first mate (one running, one done w/ commits)
  // and one direct/escalated run.
  await app.eval(`(() => {
    goalRuns.clear();
    const mk = (id, extra) => goalRuns.set(id, { goalRunId: id, ordinal: ++goalRunSeq, goal: "goal " + id, projectPath: "P", status: "running", iterations: [{iteration:1},{iteration:2}], result: null, error: null, escalation: null, latestPlan: null, dispatchedBy: null, tier: null, ...extra });
    mk("fr1", { dispatchedBy: "mate-work", status: "running" });
    mk("fr2", { dispatchedBy: "mate-work", status: "done", result: { commitCount: 3 }, iterations: [{iteration:1},{iteration:2},{iteration:3}] });
    mk("fr3", { dispatchedBy: null, status: "running", escalation: { detail: "needs a decision" } });
    return true;
  })()`);

  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashFleetSlot", 8000);
  await wait(900); // force-fill (incl. goals fetch) settles

  assert((await count("#dashFleetSlot .dash-fleet")) === 1, "the fleet section renders");
  assert((await count("#dashFleetSlot .fleet-mate")) === 2, "two mate groups (a first mate + Direct)");
  const mateNames = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-mate-name")].map(e => e.textContent)`);
  assert(mateNames.some((n) => /mate-work/.test(n)), "a first-mate group is labeled by its mate id (got: " + JSON.stringify(mateNames) + ")");
  assert(mateNames.some((n) => /Direct/.test(n)), "the direct/captain group is present");

  assert((await count("#dashFleetSlot .fleet-run")) === 3, "all three runs render as tree nodes");
  assert((await count("#dashFleetSlot .fleet-run-dot.st-running")) >= 1, "a running run shows the running status dot");
  assert((await count("#dashFleetSlot .fleet-run-dot.st-done")) === 1, "the done run shows the done status dot");
  assert((await count("#dashFleetSlot .fleet-run-dot.st-escalated")) === 1, "the escalated run shows the escalated status dot");

  // Assign-back: escalated -> "needs you", done-with-commits -> "review".
  const needsTags = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-run-needs")].map(e => e.textContent)`);
  assert(needsTags.includes("needs you"), "the escalated run surfaces a 'needs you' tag (assign-back)");
  assert(needsTags.includes("review"), "the done-with-commits run surfaces a 'review' tag");

  // Empty fleet -> no section.
  await app.eval(`goalRuns.clear(); renderDashboardPage(); true`);
  await wait(700);
  assert((await count("#dashFleetSlot .dash-fleet")) === 0, "no fleet section when there are no runs");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: fleet tree renders the mate -> runs -> crew hierarchy." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
