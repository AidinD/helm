// E2E (real launched Helm via CDP): tiered report-back phase 3 - the jump-in
// triage nudge. Jumping into a FRESH first-mate session that has crew reports
// waiting seeds the composer with a nudge to pull them (helm_collect_reports)
// and triage. Only its OWN dispatched runs count; captain/Autopilot runs don't.
// A mate with nothing waiting gets no nudge (empty composer).
//
// The report-back MECHANISM (inbox + helm_collect_reports + first-mate
// instructions) already existed; this is the last-mile surfacing that gets the
// mate to consume + act on it the moment you engage it.
//
// Run:  node scripts/e2e/test-mate-triage-nudge.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[triage-nudge-e2e]", ...a);
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
const composerValue = () => app.eval(`document.querySelector('.pane[data-pane="0"] .pane-composer textarea')?.value || ""`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  // Seed: two terminal runs dispatched by mate_probe (one clean, one commits ->
  // needs captain), plus a captain/Autopilot run that must NOT enter the nudge.
  await app.eval(`(() => {
    state.config = state.config || {};
    state.config.acknowledgedGoalRuns = [];
    goalRuns.clear();
    // One genuinely successful run and one that genuinely failed - which is what
    // "1 of 2 needs the captain" is asserting below. Both fixtures were wrong for that
    // intent before 2026-08-20: the "clean" one committed nothing (so it converged
    // without doing anything, which DOES want a look), and the other carried no stopped
    // reason at all (so it classified as an outcome nobody can name).
    goalRuns.set("p1", { goalRunId:"p1", ordinal:++goalRunSeq, goal:"PROBE_clean_run", projectPath:"P", dispatchedBy:"mate_probe", status:"done", result:{ commitCount:2, branchName:"helm/goal-p1", stoppedReason: "no_op_convergence" }, iterations:[], error:null, escalation:null });
    goalRuns.set("p2", { goalRunId:"p2", ordinal:++goalRunSeq, goal:"PROBE_commits_run", projectPath:"P", dispatchedBy:"mate_probe", status:"done", result:{ commitCount:3, branchName:"helm/goal-p2", stoppedReason: "two_consecutive_failures" }, iterations:[], error:null, escalation:null });
    goalRuns.set("cap", { goalRunId:"cap", ordinal:++goalRunSeq, goal:"CAPTAIN_own_run", projectPath:"P", dispatchedBy:null, status:"done", result:{ commitCount:0 }, iterations:[], error:null, escalation:null });
    return true;
  })()`);

  // Jump into a FRESH mate (no bound session) that dispatched p1 + p2.
  await app.eval(`(() => { jumpIntoFirstMate({ mateId: "mate_probe", sessionId: null, name: "ProbeMate" }); return true; })()`);
  await wait(400);
  const seeded = await composerValue();
  log("composer seed:\n" + seeded);
  assert(/2 crew reports waiting/.test(seeded), "the nudge counts the mate's 2 waiting reports");
  assert(/1 need the captain/.test(seeded), "the nudge flags the 1 that needs the captain");
  assert(/helm_collect_reports/.test(seeded), "the nudge directs the mate to helm_collect_reports");
  assert(/PROBE_clean_run/.test(seeded) && /PROBE_commits_run/.test(seeded), "the nudge lists the mate's own runs");
  assert(!/CAPTAIN_own_run/.test(seeded), "a captain/Autopilot run is NOT in this mate's triage nudge");

  // A mate with nothing waiting gets no nudge (empty composer).
  await app.eval(`(() => { jumpIntoFirstMate({ mateId: "mate_empty", sessionId: null, name: "EmptyMate" }); return true; })()`);
  await wait(400);
  const empty = await composerValue();
  assert(empty === "", "a mate with no waiting reports gets an empty composer (no nudge)");

  // Acknowledged runs drop out of the nudge too (consistent with report-back).
  await app.eval(`(async () => { state.config.acknowledgedGoalRuns = ["p1","p2"]; return true; })()`);
  await app.eval(`(() => { jumpIntoFirstMate({ mateId: "mate_probe", sessionId: null, name: "ProbeMate" }); return true; })()`);
  await wait(300);
  const afterAck = await composerValue();
  assert(afterAck === "", "once its runs are acknowledged, the mate gets no nudge");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: jump-in triage nudge seeds a fresh mate with its own waiting reports." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
