// First-mate tier - report-back reconciliation (review finding M2).
//
// A dispatched run reports back via an in-memory onComplete closure in main.js.
// If Maestro is killed/restarted mid-run, that closure is gone: the run's work
// survives (worktree/commits), but no report is ever written, so the mate
// polling maestro_collect_reports never hears back. On startup the app scans the
// persisted run history and synthesizes a report for any dispatched run that is
// terminal (or interrupted) yet has no report on disk - so the handshake
// completes across a restart.
//
// Pure functions here (single definition, unit-testable without Electron);
// main.js feeds them loadGoalRunHistory() + readReports() + live-run ids.

/**
 * Records that were dispatched (have a dispatchId) but have no report yet AND
 * are not currently live (a live run's own onComplete will still report). These
 * need a synthesized report on startup.
 */
export function recordsNeedingReport(records, existingReportIds, liveGoalRunIds) {
  return (records || []).filter(
    (rec) => rec && rec.dispatchId && !existingReportIds.has(rec.dispatchId) && !liveGoalRunIds.has(rec.goalRunId)
  );
}

/**
 * The compact report for a dispatched run, derived from its PERSISTED history
 * record (not a live result object). Mirrors buildDispatchReport's shape. A
 * "running" record with no live process behind it is treated as "interrupted"
 * (the app died mid-run). needsCaptain is the load-bearing assign-back field.
 */
export function buildReportFromRecord(rec, now) {
  const wasRunning = rec.status === "running";
  const status = wasRunning ? "interrupted" : rec.status;
  const commitCount = typeof rec.commitCount === "number" ? rec.commitCount : 0;

  let needsCaptain = null;
  if (rec.escalation) {
    needsCaptain = rec.escalation.detail || "Run paused - needs a human decision.";
  } else if (status === "error") {
    needsCaptain = rec.error || "The dispatched run errored; inspect and re-dispatch.";
  } else if (status === "interrupted") {
    needsCaptain = "The dispatched run was interrupted by an app restart; review its worktree or re-dispatch.";
  } else if (commitCount > 0) {
    needsCaptain = `${commitCount} commit(s) ready for review in ${rec.branchName}.`;
  }

  let summary;
  if (status === "interrupted") {
    summary = "Run interrupted by an app restart (its committed work is intact in the worktree).";
  } else if (status === "error") {
    summary = rec.error || "The dispatched run errored.";
  } else {
    summary = rec.stoppedReason ? `Run stopped: ${rec.stoppedReason}.` : "Run finished.";
  }

  return {
    dispatchId: rec.dispatchId,
    dispatchedBy: rec.dispatchedBy || null,
    project: rec.projectPath,
    goal: rec.goal,
    tier: rec.tier || "second-mate",
    status,
    summary,
    changed: { commitCount, branchName: rec.branchName || null, worktreePath: rec.worktreePath || null },
    needsCaptain,
    stoppedReason: rec.stoppedReason || null,
    reportedAt: now,
    reconciled: true,
  };
}
