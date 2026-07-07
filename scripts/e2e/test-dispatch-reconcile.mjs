// Unit test: report-back reconciliation (M2). Pure functions, no Electron.
//
// Run:  node scripts/e2e/test-dispatch-reconcile.mjs
import { recordsNeedingReport, buildReportFromRecord } from "../../src/lib/dispatchReconcile.js";

function log(...a) {
  console.log("[dispatch-reconcile-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

// --- recordsNeedingReport -----------------------------------------------------
const records = [
  { goalRunId: "g1", dispatchId: "d1", status: "done" }, // dispatched, terminal, no report -> needs
  { goalRunId: "g2", dispatchId: "d2", status: "running" }, // dispatched, interrupted -> needs
  { goalRunId: "g3", dispatchId: "d3", status: "done" }, // has a report already -> skip
  { goalRunId: "g4", dispatchId: null, status: "done" }, // not dispatched (direct) -> skip
  { goalRunId: "g5", dispatchId: "d5", status: "running" }, // still LIVE -> skip
];
const existing = new Set(["d3"]);
const live = new Set(["g5"]);
const need = recordsNeedingReport(records, existing, live);
const needIds = need.map((r) => r.dispatchId).sort();
assert(needIds.length === 2 && needIds[0] === "d1" && needIds[1] === "d2", "only dispatched, report-less, non-live records need a report (got: " + JSON.stringify(needIds) + ")");
assert(!need.some((r) => r.dispatchId === "d3"), "a record that already has a report is skipped");
assert(!need.some((r) => r.dispatchId === null), "a direct (non-dispatched) run is skipped");
assert(!need.some((r) => r.goalRunId === "g5"), "a still-live run is skipped (its own onComplete will report)");

// --- buildReportFromRecord ----------------------------------------------------
const now = 12345;

const interrupted = buildReportFromRecord({ dispatchId: "d2", dispatchedBy: "mate-x", goal: "g", projectPath: "P", status: "running", commitCount: 2, branchName: "b", worktreePath: "w" }, now);
assert(interrupted.status === "interrupted", "a running-but-not-live record becomes 'interrupted'");
assert(/interrupted/i.test(interrupted.needsCaptain), "interrupted report tells the captain it was interrupted");
assert(interrupted.changed.commitCount === 2 && interrupted.reconciled === true && interrupted.reportedAt === now, "interrupted report carries commit info + reconciled flag + timestamp");

const done = buildReportFromRecord({ dispatchId: "d1", dispatchedBy: "mate-x", goal: "g", projectPath: "P", status: "done", commitCount: 3, branchName: "feat", stoppedReason: "completed" }, now);
assert(done.status === "done" && /3 commit/.test(done.needsCaptain), "a done record with commits reports 'N commits ready for review'");

const errored = buildReportFromRecord({ dispatchId: "d9", goal: "g", projectPath: "P", status: "error", error: "boom" }, now);
assert(errored.status === "error" && /boom/.test(errored.needsCaptain), "an errored record surfaces the error as needsCaptain");

const escalated = buildReportFromRecord({ dispatchId: "d8", goal: "g", projectPath: "P", status: "done", escalation: { detail: "decide X" }, commitCount: 1, branchName: "b" }, now);
assert(/decide X/.test(escalated.needsCaptain), "an escalated record surfaces the escalation detail (takes priority over commit count)");

log(exitCode === 0 ? "VERIFY OK: reconciliation selects the right records + builds correct reports." : "VERIFY FAILED.");
process.exit(exitCode);
