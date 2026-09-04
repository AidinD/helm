/**
 * A mate clearing away its own finished crew - and only once the work is visible elsewhere.
 *
 * the captain, 2026-08-16: "autopilots som 2nd mate spinner upp finns kvar för mig att rensa
 * manuellt ... onödig overhead." Leaving them was intentional: the acknowledgement was his
 * only trace that the run had happened. The card is explicit that clearing them BEFORE the
 * review pipeline can show the work would hide it rather than save him a click.
 *
 * So the condition is not "the run looks finished". It is that the run's commits are already
 * reachable from the project's HEAD - its branch has been merged - because that is when the
 * review queue starts listing them. The premise is checked here too, not just relied on:
 * commitReview.js lists with `git log HEAD --not <floors>`, so if that ever stops being true
 * the safety argument changes and this check should go red rather than stay quietly green.
 *
 * Run: node scripts/e2e/test-crew-clears-its-own.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runsToAutoAcknowledge, CLEAN_STOPS } from "../../src/lib/crewCleanup.js";
import { describeSweep } from "../../src/lib/worktreeSweep.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, "..", "..", ...p), "utf8");
const mainSrc = read("src", "main.js");
const commitReviewSrc = read("src", "lib", "commitReview.js");
const sweepSrc = read("src", "lib", "worktreeSweep.js");
const rendererSrc = read("src", "renderer", "renderer.js");

const run = (over = {}) => ({
  goalRunId: `run-${Math.abs(JSON.stringify(over).length)}-${over.tag || "x"}`,
  dispatchedBy: "mate_a",
  status: "done",
  stoppedReason: "no_op_convergence",
  commitCount: 3,
  branchName: "helm/goal-abc",
  error: null,
  escalation: null,
  resumable: false,
  ...over,
});
const merged = () => true;
const unmerged = () => false;
const ids = (list) => list.map((x) => x.goalRunId);

// --- the case it exists for -------------------------------------------------------------
{
  const r = run({ tag: "clean" });
  const out = runsToAutoAcknowledge({ runs: [r], isMerged: merged });
  ok(out.length === 1, "a finished crew run whose branch is merged is cleared");
  ok(out[0].why.includes("merged"), "and the reason says why it was safe to clear");
  ok(out[0].why.includes("3 commit"), "naming what it produced, so the log is readable");
}

// --- the merge gate, which is the entire safety argument -----------------------------------
{
  const r = run({ tag: "unmerged" });
  ok(runsToAutoAcknowledge({ runs: [r], isMerged: unmerged }).length === 0, "the same run is NOT cleared while its branch is unmerged");
  // A git question that could not be answered is not a yes.
  const throwing = () => {
    throw new Error("git said no");
  };
  ok(runsToAutoAcknowledge({ runs: [r], isMerged: throwing }).length === 0, "and a merge check that throws is treated as 'not merged', not as permission");
  ok(runsToAutoAcknowledge({ runs: [run({ tag: "nobranch", branchName: null })], isMerged: merged }).length === 0, "a run with no branch at all is never cleared");
}

// --- the captain's safety rule: only what it validated and rolled up -------------------------------
{
  const kept = [
    ["it failed twice in a row", run({ tag: "failed", stoppedReason: "two_consecutive_failures" })],
    ["it was cut off at the iteration cap", run({ tag: "capped", stoppedReason: "max_iterations_reached" })],
    ["it escalated to a human", run({ tag: "esc", escalation: { why: "needs a decision" } })],
    ["it errored", run({ tag: "err", status: "error", error: "boom" })],
    ["it was interrupted", run({ tag: "int", status: "running" })],
    ["it can still be resumed", run({ tag: "res", resumable: true })],
    ["it produced nothing to review", run({ tag: "empty", commitCount: 0 })],
    ["it is the captain's own run, not a mate's crew", run({ tag: "captain", dispatchedBy: null })],
  ];
  for (const [why, r] of kept) {
    ok(runsToAutoAcknowledge({ runs: [r], isMerged: merged }).length === 0, `kept because ${why}`);
  }
  // The one that is easiest to get wrong: a capped run has commits and a merged branch and
  // looks exactly like a finished one, but it stopped because it ran out of budget.
  ok(!CLEAN_STOPS.has("max_iterations_reached"), "hitting the cap is not a clean finish - that run was cut off, not completed");
  ok(CLEAN_STOPS.has("no_op_convergence") && CLEAN_STOPS.has("goal_reached"), "converging and reaching the goal both are");
}

// --- it does not clear the same thing twice ----------------------------------------------------
{
  const r = run({ tag: "again" });
  ok(runsToAutoAcknowledge({ runs: [r], isMerged: merged, alreadyAcknowledged: [r.goalRunId] }).length === 0, "an already acknowledged run is left alone");
  ok(runsToAutoAcknowledge({ runs: [r], isMerged: merged, alreadyAcknowledged: new Set([r.goalRunId]) }).length === 0, "whether the caller passes a Set or an array");
}

// --- a realistic mixture, which is what the measurement was made of ------------------------------
{
  const mixture = [
    run({ tag: "a" }),
    run({ tag: "b", stoppedReason: "goal_reached" }),
    run({ tag: "c", stoppedReason: "two_consecutive_failures" }),
    run({ tag: "d", stoppedReason: "max_iterations_reached" }),
    run({ tag: "e", commitCount: 0 }),
    run({ tag: "f", status: "error", error: "boom" }),
  ];
  const out = runsToAutoAcknowledge({ runs: mixture, isMerged: merged });
  ok(out.length === 2, `two of six clear (${ids(out).join(", ")})`);
  ok(!runsToAutoAcknowledge({ runs: [], isMerged: merged }).length, "and an empty history clears nothing");
}

// --- the premise this all rests on ----------------------------------------------------------------
{
  // If the review queue stops listing by reachability from HEAD, "merged" is no longer the
  // same thing as "visible in review", and the safety argument above quietly stops holding.
  ok(/"log", "HEAD"/.test(commitReviewSrc), "the review queue still lists commits reachable from HEAD, which is what makes 'merged' mean 'reviewable'");
}

// --- wiring: the right place in the sweep, for the right reason -------------------------------------
{
  ok(/runsToAutoAcknowledge\(\{/.test(mainSrc), "the sweep calls it");
  ok(/isMerged: \(run\) => isBranchMerged\(projectPath, run\.branchName, primary\)/.test(mainSrc), "with the sweep's own merge check, not a second opinion");
  // Load-bearing ordering: this sweep DELETES merged branches, and after that the merge
  // question cannot be asked at all.
  const ackAt = mainSrc.indexOf("runsToAutoAcknowledge({");
  const deleteAt = mainSrc.indexOf("deleteBranch(projectPath, action.target");
  ok(ackAt > 0 && deleteAt > 0 && ackAt < deleteAt, "and it runs BEFORE the branch deletions, or there would be no merged branch left to ask about");
  ok(/kind: "crewRun", target: a\.goalRunId/.test(mainSrc), "what it cleared goes on the sweep report, so tidying never looks like work going missing");
}

// --- and the report actually says it ------------------------------------------------------------
{
  // Being on the report object is not the same as being visible. describeSweep counts only
  // the kinds it knows, so a sweep whose only work was clearing runs would have reported
  // "nothing to clean" while quietly removing rows from his board.
  ok(/cleared \$\{cr\} finished crew run/.test(sweepSrc), "the one-line sweep summary counts cleared crew runs");
  ok(/nothing to clean/.test(sweepSrc), "and still has an honest empty case");
  ok(/cleared \$\{clearedRuns\} finished crew run/.test(rendererSrc), "the Goal page's housekeeping line says it too");

  const report = describeSweep({ removed: [{ kind: "crewRun", target: "r1", reason: "merged" }], kept: [], failed: [] });
  ok(/cleared 1 finished crew run/.test(report), `a sweep that only cleared runs says so: "${report}"`);
  ok(!/nothing to clean/.test(report), "and does not also claim there was nothing to do");
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: a mate clears its own finished crew, and only once the commits are somewhere he can still see them." : "VERIFY FAILED.");
process.exit(exit);
