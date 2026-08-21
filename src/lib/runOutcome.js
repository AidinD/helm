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
 * Measured on the skiff board, 2026-08-18: 22 of 23 reports said "done" and not one
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
 * Every terminal reason the goal loop can actually emit. There is no goal-reached
 * value in here, and that absence is the point.
 *
 * Exported so tests can be held to it. On 2026-08-18 a fixture was found asserting
 * against `stoppedReason: "completed"` - a value nothing in the app can produce - and
 * it was fixed in that ONE file. Two days later the same fiction turned out to be in
 * eleven more: "completed" six times, "converged" four, "done" twice. Three tests were
 * failing on it and the rest were passing for the wrong reason, describing a world the
 * app cannot enter.
 *
 * test-stopped-reasons-are-real.mjs pins this list against goalOrchestrator.js's own
 * source and then scans every fixture against it, so the class is closed rather than
 * the instance. Fixing one occurrence and not looking for the others is failure 12 on
 * ship-review's list; this is the guard that makes looking automatic.
 */
export const TERMINAL_REASONS = Object.freeze([
  "cancelled",
  "escalated",
  "quota_exhausted",
  "two_consecutive_failures",
  // The only one that means the work is FINISHED rather than merely over. Added
  // 2026-08-21; before it, the loop's six reasons were all endings, so a run that
  // achieved its goal could only exit by converging or by hitting its iteration cap.
  "goal_reached",
  "no_op_convergence",
  "max_iterations_reached",
]);

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
 * @returns {{ status: string, headline: string, needsCaptain: string|null, awaitingReview: string|null }}
 *   `headline` is a plain sentence stating the outcome, meant to LEAD the summary so
 *   the last successful step's own words can never be mistaken for the run's verdict.
 *
 *   `needsCaptain` is an ALARM: something went wrong, or something critical wants a
 *   decision. It is not "there is something to do". That distinction is the whole
 *   point of the field, and on 2026-08-18 this function blurred it - a run that
 *   SUCCEEDED carried "N commits ready for review" in `needsCaptain`, so every clean
 *   run counted toward the needs-you tally. The visible result was a queue where
 *   everything was flagged, which is a queue nobody reads: ten review records were
 *   approved in a row without being read, and unreadability was the stated reason.
 *   the captain, 2026-08-20: "behöver mig i review ska betyda att något gick fel eller
 *   något är kritiskt".
 *
 *   `awaitingReview` is where that displaced information went, and it must NOT be
 *   dropped instead. Nothing else surfaces landed-but-unreviewed work, and the cost
 *   of not surfacing it is concrete: 117 crew commits reached skiff's master with
 *   nobody having read them. So a successful run still says its commits are waiting -
 *   just on a quiet line rather than as an alarm.
 */
export function classifyRunOutcome({
  stoppedReason = null,
  commitCount = 0,
  branchName = null,
  error = null,
  escalation = null,
  interrupted = false,
  // The run's own verify command, if it was configured with one. Used ONLY by the
  // goal_reached branch, to say whether "it is done" was checked by anything or is just
  // the machine's word. Derived from data the run record already carries rather than a new
  // field threaded through three builders - a fourth copy of one fact is how the copies
  // come to disagree.
  verifyCommand = null,
} = {}) {
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
    case "goal_reached":
      // The loop was TOLD the goal is met by the iteration that finished it, which is the
      // only outcome that means what "done" is supposed to mean. Everything else here is
      // an ending, not a completion.
      //
      // But TWO different things reach this branch, and reporting them identically is the
      // same mistake as reporting a finished run and an exhausted one identically:
      //
      //   with a verify command - the run said done AND its own check passed on the
      //     result. Two independent things agreeing.
      //   without one - the run said done. That is the whole of it.
      //
      // So the headline says which. Neither raises an alarm: an unchecked self-report is
      // not something going WRONG, and flagging every run that has no verify gate would
      // make the needs-you queue mean "most runs" again. What it must not do is look the
      // same as a checked one.
      //
      // With no commits it is not done either way, and the wording says which of the two
      // it might be rather than blaming the run: a goal that needed no code change is a
      // real case (already satisfied, or satisfiable by reading), and it needs a human.
      return commits
        ? {
            status: OUTCOME_DONE,
            headline: verifyCommand
              ? `Finished: the goal is met and its own check passed (${verifyCommand}).`
              : "Finished: it says the goal is met. Nothing checked that.",
            // Nothing went wrong, so nothing is alarmed. Whether the claim HOLDS is the
            // review's question, and the record for an autonomous run is a `judgment`
            // that says outright that nobody has checked it.
            needsCaptain: null,
            awaitingReview: readyForReview,
          }
        : {
            status: "no_changes",
            headline: "Reports the goal is met, but committed nothing.",
            needsCaptain: "It says the goal is met and changed no files. Check whether it was already met, or whether it decided that wrongly.",
          };
    case "no_op_convergence":
      // The loop's own comment: "either the goal is already satisfied or it's stuck."
      // With commits this is the closest thing the loop has to success; without any, it
      // sat there producing nothing, which must never read as done.
      return commits
        ? {
            status: OUTCOME_DONE,
            headline: "Converged: it stopped making further changes.",
            // The one genuinely successful outcome. Nothing went wrong, so nothing
            // is alarmed - the commits are announced on the quiet line instead.
            needsCaptain: null,
            awaitingReview: readyForReview,
          }
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
