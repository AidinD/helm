// E2E: a RUNNING Autopilot run is now visible - (a) an ambient pulsing count on
// the Dashboard tab (app-wide), and (b) a "working" row in the Dashboard
// in-motion queue. Before this, a run had NO presence until it errored/escalated
// (the captain's task 2dd992c8). Real launched Maestro.
//
// Run:  node scripts/e2e/test-running-indicator.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[running-indicator-e2e]", ...a);
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
const hidden = (sel) => app.eval(`document.querySelector(${JSON.stringify(sel)}).classList.contains("hidden")`);
const injectRun = (id, extra) =>
  app.eval(`goalRuns.set(${JSON.stringify(id)}, { goalRunId: ${JSON.stringify(id)}, ordinal: ++goalRunSeq, goal: "demo goal ${id}", projectPath: "P", status: "running", iterations: [{ iteration: 1, phase: "implement", ok: true }], result: null, error: null, escalation: null, latestPlan: null, ...${JSON.stringify(extra || {})} }); true`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof updateRunningIndicator === "function"`)) {
      break;
    }
    await wait(100);
  }

  // (a) Ambient nav indicator -------------------------------------------------
  assert(await hidden("#dashboardRunningIndicator"), "indicator starts hidden (no runs)");

  await injectRun("rr1");
  await app.eval(`updateRunningIndicator()`);
  assert(!(await hidden("#dashboardRunningIndicator")), "indicator shows once a run is running");
  assert((await app.eval(`document.querySelector("#dashboardRunningIndicator .run-count")?.textContent`)) === "1", "indicator counts 1 running run");
  assert((await app.eval(`document.querySelectorAll("#dashboardRunningIndicator .run-dot").length`)) === 1, "indicator has a pulse dot");

  await injectRun("rr2");
  await app.eval(`updateRunningIndicator()`);
  assert((await app.eval(`document.querySelector("#dashboardRunningIndicator .run-count")?.textContent`)) === "2", "indicator counts 2 running runs");

  // Finishing runs hides it again.
  await app.eval(`goalRuns.get("rr1").status = "done"; goalRuns.get("rr2").status = "done"; updateRunningIndicator(); true`);
  assert(await hidden("#dashboardRunningIndicator"), "indicator hides again once no run is running");

  // (b) Dashboard in-motion row -----------------------------------------------
  await app.eval(`goalRuns.clear(); true`);
  await injectRun("rr3");
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashQueueSlot", 8000);
  await wait(900); // let the force-fill (incl. goals fetch) settle
  const rowTexts = await app.eval(`[...document.querySelectorAll("#dashQueueSlot .dash-queue-row")].map(r => r.textContent)`);
  assert(rowTexts.some((t) => /working/.test(t)), "a running run shows as a 'working' row in the in-motion queue (got: " + JSON.stringify(rowTexts) + ")");
  assert((await app.eval(`document.querySelectorAll("#dashQueueSlot .dash-queue-row .dash-pulse-dot").length`)) >= 1, "the running row uses the working pulse dot, not the needs-you warning");

  await app.eval(`goalRuns.clear(); updateRunningIndicator(); true`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: running runs are visible (ambient count + working row)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
