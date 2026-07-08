// E2E: the redundant "Agents" facet is gone; Autopilot is the single home for
// autonomous runs. Sub-nav is Overview / Autopilot / Routines; each still
// renders clean; Autopilot still lists runs (drill-down intact); no dangling
// agentsPage reference crashes anything. Real launched Helm via CDP.
//
// Run:  node scripts/e2e/test-agents-facet-removed.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[agents-removed-e2e]", ...a);
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

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Sub-nav no longer has Agents.
  const subnav = await app.eval(`[...document.querySelectorAll("#dashboardSubnav button")].map(b => b.dataset.page)`);
  log("sub-nav:", JSON.stringify(subnav));
  assert(!subnav.includes("agents"), "sub-nav no longer has an Agents facet");
  assert(JSON.stringify(subnav) === JSON.stringify(["dashboard", "goal", "routines"]), "sub-nav is exactly Overview / Autopilot / Routines");

  // #agentsPage element is gone.
  assert(await app.eval(`document.getElementById("agentsPage") === null`), "#agentsPage element removed from the DOM");

  // Each remaining facet renders without error.
  for (const [page, id] of [["dashboard", "dashboardPage"], ["goal", "goalPage"], ["routines", "routinesPage"]]) {
    await app.eval(`(() => { navigateToPage(${JSON.stringify(page)}); return true; })()`);
    await app.waitForSelector("#" + id, 8000, { visible: true });
    assert(!(await isHidden(id)), `${page} facet renders`);
  }

  // Autopilot still lists runs (drill-down intact via goalRunDetailEl).
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("r1", { goalRunId: "r1", ordinal: ++goalRunSeq, goal: "A run", projectPath: "P", status: "running", iterations: [], result: null, error: null, escalation: null, latestPlan: null });
    navigateToPage("goal");
    return true;
  })()`);
  await app.waitForSelector("#goalPage .goal-run-detail", 8000);
  assert((await app.eval(`document.querySelectorAll("#goalPage .goal-run-detail").length`)) >= 1, "Autopilot still renders run cards");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Agents facet removed, Autopilot intact, no dangling crash." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
