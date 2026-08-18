/**
 * What actually happened to a dispatched run - as one word a mate can act on.
 *
 * WHY THIS FILE EXISTS. The report a crew run hands back used to carry exactly three
 * statuses: "error" when the process itself died, "escalated" when it paused for a
 * human, and "done" for LITERALLY EVERYTHING ELSE. The autopilot loop has no
 * goal-reached terminal state at all - it stops when it runs out of iterations, when
 * it fails twice in a row, or when it stops changing anything - and all three of those
 * were reported as done.
 *
 * Measured on the crewline board, 2026-08-18: 22 of 23 reports said "done" and not one
 * had reached its goal. Nine had stopped changing anything, seven had died from
 * repeated failures, six had run out of iterations. Six produced zero commits while
 * also reporting that nothing needed the captain's attention.
 *
 * The second mate reads `status` first. Telling it "done" for a run that died is not a
 * cosmetic labelling problem - it is the reason finished-but-broken work kept being
 * treated as finished.
 *
 * One definition, used by both report builders (the live onComplete path in main.js and
 * the restart-reconciliation path in dispatchReconcile.js), because they drifted apart
 * once already.
 */

/** The only outcome that means "this ran to a clean stop with work to show". */
export const OUTCOME_DONE = "done";

/**
 * Outcomes that mean a human has to look before this work counts as anything. Exported
 * so a caller can ask the question without re-listing the strings and getting it wrong.
 */
export const UNFINISHED_OUTCOMES = new Set(["error", "escalated", "interrupted", "cancelled", "failed", "incomplete", "no_changes", "unknown"]);

export function isUnfinished(status) {
  return UNFINISHED_OUTCOMES.has(String(status));
}

/**
 * @param {object} run
 * @param {string|null} [run.stoppedReason] the loop's own terminal reason.
 * @param {number} [run.commitCount]
 * @param {string|null} [run.branchName]
 * @param {string|null} [run.error] set when the process itself failed.
 * @param {object|null} [run.escalation]
 * @param {boolean} [run.interrupted] the app died mid-run (reconciliation path).
 * @returns {{ status: string, headline: string, needsCaptain: string|null }}
 *   `headline` is a plain sentence stating the outcome, meant to LEAD the summary so
 *   the last successful step's own words can never be mistaken for the run's verdict.
 */
export function classifyRunOutcome({ stoppedReason = null, commitCount = 0, branchName = null, error = null, escalation = null, interrupted = false } = {}) {
  const commits = typeof commitCount === "number" && commitCount > 0 ? commitCount : 0;
  const where = branchName ? ` in ${branchName}` : "";
  const readyForReview = commits ? `${commits} commit${commits === 1 ? "" : "s"} ready for review${where}.` : null;

  if (escalation) {
    const detail = escalation.detail || "Run paused - needs a human decision.";
    return { status: "escalated", headline: detail, needsCaptain: detail };
  }
  if (error) {
    return { status: "error", headline: error, needsCaptain: `${error} Inspect and re-dispatch.` };
  }
  if (interrupted) {
    return {
      status: "interrupted",
      headline: "Interrupted by an app restart; committed work is intact in the worktree.",
      needsCaptain: `Interrupted by an app restart - review its worktree or re-dispatch.${readyForReview ? ` ${readyForReview}` : ""}`,
    };
  }

  switch (stoppedReason) {
    case "quota_exhausted":
      return {
        status: "interrupted",
        headline: "Stopped early: the token quota ran out. This run is resumable.",
        needsCaptain: `Ran out of quota before finishing - resume it.${readyForReview ? ` ${readyForReview}` : ""}`,
      };
    case "cancelled":
      return {
        status: "cancelled",
        headline: "Cancelled before it finished.",
        needsCaptain: `Cancelled before finishing.${readyForReview ? ` ${readyForReview}` : ""}`,
      };
    case "two_consecutive_failures":
      return {
        status: "failed",
        headline: "Stopped after two iterations failed in a row - it did NOT reach the goal.",
        needsCaptain: `Failed twice in a row and gave up.${readyForReview ? ` ${readyForReview} They are partial work, not a finished goal.` : " Nothing was committed."}`,
      };
    case "max_iterations_reached":
      return {
        status: "incomplete",
        headline: "Ran out of iterations before reaching the goal.",
        needsCaptain: `Hit its iteration cap before finishing.${readyForReview ? ` ${readyForReview} They are partial work.` : " Nothing was committed."}`,
      };
    case "no_op_convergence":
      // The loop's own comment: "either the goal is already satisfied or it's stuck."
      // With commits this is the closest thing the loop has to success; without any, it
      // sat there producing nothing, which must never read as done.
      return commits
        ? { status: OUTCOME_DONE, headline: "Converged: it stopped making further changes.", needsCaptain: readyForReview }
        : {
            status: "no_changes",
            headline: "Stopped without changing anything - either the goal was already met, or it was stuck.",
            needsCaptain: "Finished without committing anything. Check whether the goal was already met or the run was stuck.",
          };
    default:
      // Includes a null/unrecognised reason. Deliberately NOT treated as success: an
      // outcome nobody can name is exactly the case worth surfacing (prefer a false
      // flag over a silently swallowed one).
      return {
        status: "unknown",
        headline: `Stopped for an unrecognised reason${stoppedReason ? ` (${stoppedReason})` : ""}.`,
        needsCaptain: `Stopped for a reason Helm does not recognise${stoppedReason ? ` (${stoppedReason})` : ""} - check the worktree.${readyForReview ? ` ${readyForReview}` : ""}`,
      };
  }
}

/**
 * The report summary. The outcome leads; the last completed step follows it as context.
 *
 * The old builder used the last SUCCESSFUL implement iteration's own one-liner as the
 * whole summary, so a run that died at the end showed a cheerful commit-message-shaped
 * sentence describing the last thing that worked - the single most misleading field in
 * the report.
 */
export function buildOutcomeSummary(headline, lastStepSummary, status) {
  const step = (lastStepSummary || "").trim();
  if (!step) {
    return headline;
  }
  if (status === OUTCOME_DONE || status === "escalated") {
    return step;
  }
  return `${headline} Last completed step: ${step}`;
}
