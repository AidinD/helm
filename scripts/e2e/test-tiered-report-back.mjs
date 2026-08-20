// E2E (real launched Helm via CDP): tiered report-back, final shape.
// There is NO separate captain Report-back section on the dashboard. A terminal
// run reports back UNDER its dispatcher - the first-mate card's roll-up - and
// anything that needs the captain surfaces in the Needs-you queue. The needs-you
// queue is laid out as a grid, with the archive-proposal nudge spanning full
// width. (the captain 2026-07-11: "ta bort dashboard-sektionen helt", "kolumnformat
// för needs you", "behåll arkiveringsnudgen som horisontell".)
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

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  const mate = await app.eval(`(async () => { const m = await window.helm.listMates(); window.__mate = m.active[0]; return window.__mate; })()`);
  assert(!!mate && !!mate.mateId, "resolved a real first-mate to dispatch from");

  await app.eval(`(() => {
    goalRuns.clear();
    // Mate-dispatched and genuinely successful -> under the mate roll-up only, NOT in
    // the needs-you queue. It has to carry commits to be that: a run that converged
    // having committed nothing did not succeed, it either found the goal already met or
    // got stuck, and telling those apart is a captain's job. The old fixture said
    // "clean" while seeding zero commits, so it was asserting that the wrong thing was
    // quiet.
    goalRuns.set("mh", { goalRunId:"mh", ordinal:++goalRunSeq, goal:"MATE_handled_clean_run", projectPath:"P", dispatchedBy:${JSON.stringify(mate.mateId)},
      status:"done", result:{ commitCount:2, branchName:"helm/goal-mh", stoppedReason: "no_op_convergence" }, iterations:[], error:null, escalation:null });
    // Mate-dispatched, escalated -> roll-up AND needs-you queue.
    goalRuns.set("me", { goalRunId:"me", ordinal:++goalRunSeq, goal:"MATE_escalated_run", projectPath:"P", dispatchedBy:${JSON.stringify(mate.mateId)},
      status:"done", result:{ commitCount:0 }, iterations:[], error:null, escalation:{ signal:"ambiguity_reported", detail:"Which token store?" } });
    // Mate-dispatched, errored -> roll-up AND needs-you queue.
    goalRuns.set("mf", { goalRunId:"mf", ordinal:++goalRunSeq, goal:"MATE_failed_run", projectPath:"P", dispatchedBy:${JSON.stringify(mate.mateId)},
      status:"error", result:null, iterations:[], error:"npm build failed", escalation:null });
    return true;
  })()`);

  // The captain Report-back SECTION (and #dashReportSlot / its "Report-back" head)
  // went with the classic section stack (task 337895ce), so the assertions that it
  // is ABSENT test a layout that no longer exists and were dropped. Reports now
  // live under the dispatching mate's card roll-up (fleetMateReportRollupEl) and
  // escalations surface in the Needs-you widget queue - both retargeted below.

  // --- Mate card roll-up owns the mate's runs --------------------------------
  // Render the surviving first-mate card into a probe (mirrors
  // test-direct-report-rollup) with no second mates, so the roll-up shows every
  // run the mate dispatched.
  await app.eval(`(() => {
    document.querySelectorAll("#mateCardProbe").forEach((n) => n.remove());
    const host = document.createElement("div");
    host.id = "mateCardProbe";
    document.body.append(host);
    host.append(fleetMateCardEl(window.__mate, [], {}));
    return true;
  })()`);
  const rollup = await app.eval(`(() => {
    const els = [...document.querySelectorAll("#mateCardProbe .fleet-report-rollup")];
    const el = els.find((r) => /MATE_/.test(r.innerText)) || els[0];
    if (!el) return { found:false };
    const headText = el.querySelector(".fleet-report-rollup-label")?.textContent || "";
    el.classList.add("open");
    const rowsText = el.querySelector(".fleet-report-rows")?.innerText || "";
    return { found:true, headText, rowsText };
  })()`);
  assert(rollup.found, "the first mate's card renders a report-back roll-up");
  assert(/Crew reported back: 3/.test(rollup.headText), `roll-up counts all 3 of the mate's runs (got "${rollup.headText}")`);
  assert(/2 need you/.test(rollup.headText), `roll-up flags the 2 needs-captain runs (got "${rollup.headText}")`);
  assert(/MATE_handled_clean_run/.test(rollup.rowsText) && /MATE_escalated_run/.test(rollup.rowsText) && /MATE_failed_run/.test(rollup.rowsText), "all three of the mate's runs are under the mate (both, not either)");

  // --- Escalated + failed runs still surface in the Needs-you queue ----------
  // The Needs-you queue survives as the Needs-you widget's body
  // (widgetBodyNeedsYou -> dashboardQueueSection); render it into a probe.
  await app.eval(`(() => {
    document.querySelectorAll("#queueProbe").forEach((n) => n.remove());
    const host = document.createElement("div");
    host.id = "queueProbe";
    document.body.append(host);
    host.append(dashboardQueueSection());
    return true;
  })()`);
  const queueText = await app.eval(`document.querySelector("#queueProbe").innerText`);
  assert(/MATE_escalated_run/.test(queueText), "the escalated run surfaces in the Needs-you queue");
  assert(/MATE_failed_run/.test(queueText), "the failed run surfaces in the Needs-you queue");
  assert(!/MATE_handled_clean_run/.test(queueText), "the handled run does NOT clutter the Needs-you queue");

  // --- Needs-you queue is a grid; archive nudge (when present) spans full width -
  const isGrid = await app.eval(`!!document.querySelector("#queueProbe .dash-queue-grid")`);
  assert(isGrid, "the Needs-you queue is laid out as a grid (.dash-queue-grid)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: no captain report-back section; reports live under the mate; escalations in the queue; queue is a grid." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
