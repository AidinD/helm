// E2E: the Direct (captain) fleet card shows a report roll-up for the captain's
// OWN finished runs, so a Direct/Autopilot run you launched yourself doesn't
// vanish from the Dashboard the moment it stops running (flow review P1).
//
// Run:  node scripts/e2e/test-direct-report-rollup.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[direct-rollup-e2e]", ...a);
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

  // Seed a finished captain-launched run (no dispatchedBy) with commits to
  // review, plus a Direct session node, and render the Direct card DIRECTLY.
  // The classic Fleet section (dashboardFleetSection / #dashFleetSlot) was
  // removed with the classic dashboard (task 337895ce); the Direct card
  // (fleetDirectCardEl) survives and is what the Captain widget renders, so the
  // test now drives it straight into a probe container.
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("cap-done", {
      goalRunId: "cap-done", ordinal: 1, goal: "A captain-launched run that finished",
      projectPath: "D:/Repo/x", status: "done", dispatchedBy: null, iterations: [{},{}],
      result: { worktreePath: "D:/Repo/x-worktrees/goal-a", branchName: "helm/goal-a", stoppedReason: "completed", commitCount: 3 },
      error: null, escalation: null, latestPlan: null,
    });
    document.querySelectorAll("#rollupProbe").forEach((n) => n.remove());
    const host = document.createElement("div");
    host.id = "rollupProbe";
    document.body.append(host);
    const directSms = [
      { secondMateId: "sd", firstMateId: "direct", name: "x", sessionId: "ds", isSessionNode: true, crew: [] },
    ];
    host.append(fleetDirectCardEl(directSms));
    return true;
  })()`);
  await app.eval("new Promise(r => setTimeout(r, 250))");

  const direct = await app.eval(`!!document.querySelector("#rollupProbe .fleet-mate-card.direct")`);
  assert(direct, "the Direct card renders");

  const rollups = await count("#rollupProbe .fleet-mate-card.direct .fleet-report-rollup");
  assert(rollups === 1, `the Direct card shows a report roll-up for the captain's own runs (got ${rollups})`);

  const rollupText = await app.eval(`(() => { const el = document.querySelector("#rollupProbe .fleet-mate-card.direct .fleet-report-rollup"); return el ? el.innerText : ""; })()`);
  assert(/finished: 1/i.test(rollupText), `the roll-up counts the finished run (got "${rollupText.split("\\n")[0]}")`);

  // Expand it and confirm a report row for the run is inside.
  await app.eval(`(() => { document.querySelector("#rollupProbe .fleet-mate-card.direct .fleet-report-rollup-head").click(); return true; })()`);
  await app.eval("new Promise(r => setTimeout(r, 200))");
  const rows = await count("#rollupProbe .fleet-mate-card.direct .fleet-report-rollup .dash-queue-row");
  assert(rows >= 1, `expanding shows the run's report row (got ${rows})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: captain's own finished runs surface on the Direct card." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
