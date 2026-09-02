/**
 * A second mate clearing away its own finished crew, once the work is visible somewhere else.
 *
 * ## Why this was deliberately not built before
 *
 * the captain, 2026-08-16: "autopilots som 2nd mate spinner upp finns kvar för mig att rensa
 * manuellt ... onödig overhead för mig att behöva rensa manuellt." Leaving them was
 * intentional, and the reason was that the acknowledgement was his only trace that the run
 * had happened at all. Clearing them before there was anywhere else to see the work would
 * have hidden it rather than saved him a click.
 *
 * ## What makes it safe now, as a mechanism rather than a promise
 *
 * The condition is not "the run looks finished". It is that the run's commits are ALREADY
 * REACHABLE from the project's HEAD - which is to say, its branch has been merged.
 *
 * That is the literal coupling to the review pipeline, and it had to be checked rather than
 * assumed. The review queue lists unbound commits with `git log HEAD --not <floors>`
 * (commitReview.js), so a commit sitting on an unmerged `helm/goal-*` branch is not in it.
 * Acknowledging such a run would remove the only trace of it from every surface at once.
 * Once the branch is merged the same commits appear as review rows on their own, and the
 * acknowledgement is exactly what the card called it: tidying.
 *
 * That also decides WHEN this runs. Nothing here can fire when a run finishes, because a
 * branch is never merged at that moment. It belongs to the housekeeping sweep, which is
 * already the thing that asks whether a branch has been merged.
 *
 * ## What is never cleared
 *
 * the captain's own safety rule: a second mate may only clear what it validated and rolled up.
 * Anything that failed, escalated or could not be verified stays, because that is by
 * definition what needs him.
 *
 * The "rolled up" half is NOT checked as a separate condition, and that is a decision rather
 * than an omission. A report is written for every dispatched run, and reconciled at startup
 * for any run whose in-memory reporter died - so its presence adds no information. What it
 * would add is a false negative: reports are pruned after fourteen days, so requiring one
 * would quietly stop clearing anything older than that, for a reason nobody would connect to
 * the pruning.
 *
 * Measured against the 54 dispatched runs in the installed history on 2026-09-01:
 *
 *     12  done / no_op_convergence      / commits      <- cleared
 *      2  done / goal_reached           / commits      <- cleared
 *     12  done / two_consecutive_failures / commits    <- kept: it failed
 *      9  done / max_iterations_reached / commits      <- kept: it was cut off, not finished
 *      5  done / no_op_convergence      / no commits   <- kept: nothing to review
 *      4  done / two_consecutive_failures / no commits <- kept
 *      4  done / max_iterations_reached / no commits   <- kept
 *      3  error                                        <- kept
 *      3  interrupted                                  <- kept
 *
 * So 14 of 54 - a quarter of the manual clearing - and not one of them a run that failed,
 * was cut off, or produced nothing. `no_op_convergence` is included and carries the most
 * weight (12 of the 14): it means the agent kept reporting success and stopped changing
 * anything, which with commits on the branch is a run that did its work and converged.
 * Excluding it would leave two runs and make the feature pointless.
 */

/**
 * Stop reasons that describe a run finishing rather than being stopped.
 *
 * `max_iterations_reached` is NOT here and that is the important omission: hitting the cap
 * means the run was cut off mid-way, which is a thing to look at, not a thing to tidy.
 *
 * ## Why this is a total partition and not just a list
 *
 * The first version of this file spelled two of the loop's stop reasons as bare strings with
 * no link back to `runOutcome.js`, whose own `TERMINAL_REASONS` exists precisely so the class
 * is closed rather than the instance. That is one concept with two spellings, and it fails in
 * the quietest possible way: rename a reason and nothing matches, so this feature silently
 * stops tidying anything and no test goes red.
 *
 * A shared import alone would not have been enough either. The dangerous direction is a NEW
 * stop reason, because whichever way an unlisted reason falls is a decision made by omission.
 * So the two sets below must together cover every reason the loop can produce, and
 * `test-one-path-per-stop-reason.mjs` asserts exactly that. Adding a reason to
 * `TERMINAL_REASONS` now breaks a test until somebody says which side it belongs on, which is
 * the whole point: the default is a question, not a behaviour.
 */
export const CLEAN_STOPS = new Set(["goal_reached", "no_op_convergence"]);

/**
 * Every other reason the loop can stop for, each one a deliberate refusal to tidy.
 *
 * Kept as data rather than prose so the partition above can be checked mechanically. The
 * value is the reason a human would want to look, which is also the reason not to clear it.
 */
export const NOT_CLEAN_STOPS = Object.freeze({
  cancelled: "somebody stopped it on purpose, so what it left behind is theirs to judge",
  escalated: "it asked for a human, and clearing it would answer by tidying",
  quota_exhausted: "it ran out of budget mid-way, so the work is unfinished by definition",
  two_consecutive_failures: "it died failing, and the failure is the thing worth reading",
  max_iterations_reached: "it was cut off mid-way, which is a thing to look at, not to tidy",
});

/**
 * Which finished crew runs a mate may clear away by itself.
 *
 * Pure. `isMerged` is injected rather than called here so this can be tested without a repo,
 * and so the one git question it depends on is visible in the signature instead of buried.
 *
 * @param {object} args
 * @param {Array<object>} args.runs Goal-run history records.
 * @param {(run: object) => boolean} args.isMerged Are this run's commits reachable from the
 *   project's HEAD? The whole safety argument rests on this being a real answer.
 * @param {Set<string>|string[]} [args.alreadyAcknowledged]
 * @returns {Array<{goalRunId: string, why: string}>}
 */
export function runsToAutoAcknowledge({ runs = [], isMerged, alreadyAcknowledged = [] } = {}) {
  const acked = alreadyAcknowledged instanceof Set ? alreadyAcknowledged : new Set(alreadyAcknowledged || []);
  const out = [];
  for (const run of runs) {
    if (!run || !run.goalRunId || acked.has(run.goalRunId)) {
      continue;
    }
    // The captain's own runs are his to clear. This is a mate tidying after its own crew.
    if (!run.dispatchedBy) {
      continue;
    }
    if (run.status !== "done" || run.error || run.escalation || run.resumable) {
      continue;
    }
    if (!CLEAN_STOPS.has(run.stoppedReason)) {
      continue;
    }
    if (!((run.commitCount || 0) > 0)) {
      // A run that finished cleanly and produced nothing has no review row to become, so
      // acknowledging it would erase the only sign it ever ran.
      continue;
    }
    if (!run.branchName) {
      continue;
    }
    let merged = false;
    try {
      merged = isMerged(run) === true;
    } catch {
      // A git question that could not be answered is not a yes. Keeping the row costs a
      // click; clearing it on a failed check costs the trace.
      merged = false;
    }
    if (!merged) {
      continue;
    }
    out.push({
      goalRunId: run.goalRunId,
      why: `finished (${run.stoppedReason}) with ${run.commitCount} commit${run.commitCount === 1 ? "" : "s"}, and its branch is merged - the commits are in the review queue now`,
    });
  }
  return out;
}
