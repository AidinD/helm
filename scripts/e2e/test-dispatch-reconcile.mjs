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

// --- recordsNeedingReport with a meta-home filter -----------------------------
// The global history holds records dispatched under different meta-homes; only
// the ones belonging to THIS meta-home should be reconciled here.
const mhRecords = [
  { goalRunId: "h1", dispatchId: "e1", status: "done", dispatchMetaHome: "/home/A" }, // mine
  { goalRunId: "h2", dispatchId: "e2", status: "running", dispatchMetaHome: "/home/B" }, // other meta-home
  { goalRunId: "h3", dispatchId: "e3", status: "done" }, // legacy record, no meta-home stamp
];
const mineOnly = recordsNeedingReport(mhRecords, new Set(), new Set(), "/home/A");
const mineIds = mineOnly.map((r) => r.dispatchId).sort();
assert(mineIds.length === 1 && mineIds[0] === "e1", "with a meta-home filter, only records dispatched under it are reconciled (got: " + JSON.stringify(mineIds) + ")");
assert(!mineOnly.some((r) => r.dispatchMetaHome === "/home/B"), "a record dispatched under another meta-home is skipped");
assert(!mineOnly.some((r) => r.dispatchId === "e3"), "a legacy record with no meta-home stamp is skipped when a filter is passed (isolated meta-home stays clean)");
const noFilter = recordsNeedingReport(mhRecords, new Set(), new Set());
assert(noFilter.length === 3, "with NO meta-home filter, behavior is unchanged - all report-less dispatched records qualify (back-compat)");

// --- buildReportFromRecord ----------------------------------------------------
const now = 12345;

const interrupted = buildReportFromRecord({ dispatchId: "d2", dispatchedBy: "mate-x", goal: "g", projectPath: "P", status: "running", commitCount: 2, branchName: "b", worktreePath: "w" }, now);
assert(interrupted.status === "interrupted", "a running-but-not-live record becomes 'interrupted'");
assert(/interrupted/i.test(interrupted.needsCaptain), "interrupted report tells the captain it was interrupted");
assert(interrupted.changed.commitCount === 2 && interrupted.reconciled === true && interrupted.reportedAt === now, "interrupted report carries commit info + reconciled flag + timestamp");

// NOTE: this case used to pass `stoppedReason: "completed"` - a value the goal loop
// cannot produce. Its only terminal reasons are cancelled / escalated / quota_exhausted
// / two_consecutive_failures / no_op_convergence / max_iterations_reached; there is no
// goal-reached state at all. Asserting against an invented success reason is a small
// version of the bug this whole area had (see runOutcome.js): a report that claimed
// success because nothing said otherwise.
const done = buildReportFromRecord({ dispatchId: "d1", dispatchedBy: "mate-x", goal: "g", projectPath: "P", status: "done", commitCount: 3, branchName: "feat", stoppedReason: "no_op_convergence" }, now);
assert(done.status === "done" && /3 commit/.test(done.needsCaptain), "a converged record WITH commits reports 'N commits ready for review'");

const stalled = buildReportFromRecord({ dispatchId: "d3", dispatchedBy: "mate-x", goal: "g", projectPath: "P", status: "done", commitCount: 0, branchName: "feat", stoppedReason: "max_iterations_reached" }, now);
assert(stalled.status !== "done", `a record that ran out of iterations does not report 'done' (got '${stalled.status}')`);
assert(!!stalled.needsCaptain, "and it still assigns something back rather than reporting that nothing needs attention");

const errored = buildReportFromRecord({ dispatchId: "d9", goal: "g", projectPath: "P", status: "error", error: "boom" }, now);
assert(errored.status === "error" && /boom/.test(errored.needsCaptain), "an errored record surfaces the error as needsCaptain");

const escalated = buildReportFromRecord({ dispatchId: "d8", goal: "g", projectPath: "P", status: "done", escalation: { detail: "decide X" }, commitCount: 1, branchName: "b" }, now);
assert(/decide X/.test(escalated.needsCaptain), "an escalated record surfaces the escalation detail (takes priority over commit count)");

log(exitCode === 0 ? "VERIFY OK: reconciliation selects the right records + builds correct reports." : "VERIFY FAILED.");
process.exit(exitCode);
