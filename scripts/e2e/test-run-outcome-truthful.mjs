// A dispatched run's report must say what actually happened.
//
// THE BUG THIS LOCKS DOWN, measured on the real crewline board 2026-08-18: 22 of 23
// reports said status "done" and NOT ONE had reached its goal. Nine had stopped
// changing anything, seven had died after failing twice in a row, six had run out of
// iterations. Six committed nothing while also reporting that nothing needed the
// captain's attention. The second mate reads `status` first, so "done" for a dead run
// is why broken work kept being treated as finished.
//
// The autopilot loop has no goal-reached terminal state AT ALL - it only stops when it
// runs out, fails, or stops changing things - so "the loop ended" can never be read as
// "the goal was met". That is the invariant here.
//
// Run:  node scripts/e2e/test-run-outcome-truthful.mjs
import { classifyRunOutcome, buildOutcomeSummary, isUnfinished, OUTCOME_DONE } from "../../src/lib/runOutcome.js";
import { buildReportFromRecord } from "../../src/lib/dispatchReconcile.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- every terminal reason the loop can actually produce --------------------
// Taken from goalOrchestrator.js's own assignments. If a new reason is added there and
// not here, the default branch below catches it as "unknown" rather than as success.
const REASONS = ["two_consecutive_failures", "max_iterations_reached", "no_op_convergence", "quota_exhausted", "cancelled"];

for (const reason of REASONS) {
  const withWork = classifyRunOutcome({ stoppedReason: reason, commitCount: 5, branchName: "helm/goal-x" });
  const barren = classifyRunOutcome({ stoppedReason: reason, commitCount: 0 });
  const successish = reason === "no_op_convergence";
  ok(
    successish ? withWork.status === OUTCOME_DONE : withWork.status !== OUTCOME_DONE,
    `${reason} with commits -> ${withWork.status}${successish ? " (converged with work is the loop's only success path)" : " (NOT done)"}`
  );
  ok(barren.status !== OUTCOME_DONE, `${reason} with NOTHING committed is never "done" (got ${barren.status})`);
  ok(!!barren.needsCaptain, `${reason} with nothing committed still assigns something back (got: ${String(barren.needsCaptain).slice(0, 54)}…)`);
}

// An unrecognised reason must surface, not pass as success - a new stop reason added
// upstream would otherwise silently become "done" again, which is exactly how this got
// here the first time.
const novel = classifyRunOutcome({ stoppedReason: "some_reason_nobody_wrote_yet", commitCount: 3, branchName: "b" });
ok(novel.status === "unknown" && !!novel.needsCaptain, `an unrecognised stop reason surfaces as "${novel.status}" with an assign-back, not as done`);
const nothingAtAll = classifyRunOutcome({});
ok(nothingAtAll.status !== OUTCOME_DONE, `a completely empty record is not "done" either (got ${nothingAtAll.status})`);

// Crash and escalation keep their existing meanings.
ok(classifyRunOutcome({ error: "spawn failed" }).status === "error", "a process failure is still error");
ok(classifyRunOutcome({ escalation: { detail: "needs a decision" } }).status === "escalated", "an escalation is still escalated");
ok(classifyRunOutcome({ interrupted: true, stoppedReason: null }).status === "interrupted", "an app restart mid-run is interrupted, not done");

// --- the summary must not read like success --------------------------------
// The old builder used the last SUCCESSFUL implement step's own one-liner as the whole
// summary, so a run that died showed a cheerful commit-message-shaped sentence about
// the last thing that worked. That single field is what made the reports readable and
// wrong at the same time.
const failed = classifyRunOutcome({ stoppedReason: "two_consecutive_failures", commitCount: 6, branchName: "b" });
const misleading = "feat: add InvoiceView single-invoice component with draft-edit";
const summary = buildOutcomeSummary(failed.headline, misleading, failed.status);
ok(!summary.startsWith(misleading), "a failed run's summary does not OPEN with the last thing that worked");
ok(summary.includes("did NOT reach the goal") || summary.startsWith(failed.headline), "it leads with the outcome");
ok(summary.includes(misleading), "and still keeps the last completed step as context - the detail is useful, the framing was the lie");
const clean = classifyRunOutcome({ stoppedReason: "no_op_convergence", commitCount: 4, branchName: "b" });
ok(buildOutcomeSummary(clean.headline, misleading, clean.status) === misleading, "a genuinely converged run keeps its own plain summary, no ceremony");

// --- replay the REAL reports through the new classifier ---------------------
// Verbatim (stoppedReason, commitCount) pairs from the 23 crewline reports on disk,
// 2026-08-18. The point of replaying real data is that a hand-written case list would
// have matched the author's assumptions - which is how the old one-entry-per-model
// test stayed green through this same class of bug.
const REAL = [
  ...Array(8).fill(["no_op_convergence", 9]),
  ...Array(1).fill(["no_op_convergence", 0]),
  ...Array(6).fill(["two_consecutive_failures", 8]),
  ...Array(1).fill(["two_consecutive_failures", 0]),
  ...Array(3).fill(["max_iterations_reached", 4]),
  ...Array(3).fill(["max_iterations_reached", 0]),
  ...Array(1).fill([null, 0]),
];
const replayed = REAL.map(([stoppedReason, commitCount]) => classifyRunOutcome({ stoppedReason, commitCount, branchName: "helm/goal-x" }));
const stillDone = replayed.filter((r) => r.status === OUTCOME_DONE).length;
ok(REAL.length === 23, `replaying all ${REAL.length} real crewline reports`);
ok(stillDone === 8, `only the 8 that converged WITH work still read as done - was 22 of 23 (now ${stillDone})`);
ok(
  replayed.filter((r) => isUnfinished(r.status)).length === 15,
  `the other 15 now name what happened instead of claiming success (${[...new Set(replayed.map((r) => r.status))].join(", ")})`
);
ok(replayed.every((r) => r.status === OUTCOME_DONE || r.needsCaptain), "and every unfinished one assigns something back - six of them used to say nothing needed attention");

// --- both builders must agree ----------------------------------------------
// They are two functions building the same report (live completion vs. reconciliation
// after a restart) and they drifted apart once already.
const rec = { dispatchId: "d1", dispatchedBy: "sm_x", projectPath: "/p", goal: "g", status: "done", stoppedReason: "two_consecutive_failures", commitCount: 2, branchName: "helm/goal-y" };
const report = buildReportFromRecord(rec, 1);
ok(report.status === "failed", `the restart-reconciliation path classifies identically (got ${report.status})`);
ok(!!report.needsCaptain, "and assigns it back");
ok("model" in report, "and carries a model field - reports used to carry none at all, which is why a two-day mislabel was invisible");

// --- and the THIRD copy: what the captain actually looks at -----------------
// The renderer builds its own goalRunReport() because a classic script cannot import an
// ES module. It had the same bug independently: every clean finish returned "done", so a
// run that died drew a green check, and with nothing committed its needsCaptain was null -
// which is what decides whether the run bubbles up to the captain's board at all. So the
// failures were not merely mislabelled on screen, they were invisible on it.
//
// A mirror nobody checks is exactly how three copies of one rule drifted apart, so assert
// the vocabularies agree rather than trusting the comment that says they do.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rendererSrc = readFileSync(path.join(repo, "src", "renderer", "renderer.js"), "utf8");
const fn = rendererSrc.slice(rendererSrc.indexOf("function goalRunReport("), rendererSrc.indexOf("function isTerminalRun("));
ok(fn.length > 500, `found the renderer's own report builder (${fn.length} chars)`);

for (const reason of REASONS) {
  ok(fn.includes(reason), `the renderer classifies ${reason} explicitly rather than lumping it into "done"`);
}
for (const status of ["no_changes", "failed", "incomplete", "unknown"]) {
  ok(fn.includes(`"${status}"`), `and it uses the same word as runOutcome.js for ${status} - two vocabularies for one concept is how this drifted`);
}
ok(
  !/return \{ status: "done", changed, needsCaptain, commitCount, branchName \};/.test(fn),
  "the unconditional done-return is gone from the renderer, not merely commented around"
);
ok(
  /Last completed step:/.test(fn),
  "and the renderer also leads with the outcome instead of the last step that happened to work"
);

console.log(
  exit === 0
    ? "VERIFY OK: a run that did not reach its goal can no longer report that it did - on the live path, the restart path, or the captain's own screen."
    : "VERIFY FAILED."
);
process.exit(exit);
