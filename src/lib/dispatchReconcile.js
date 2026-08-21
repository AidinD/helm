// First-mate tier - report-back reconciliation (review finding M2).
//
// A dispatched run reports back via an in-memory onComplete closure in main.js.
// If Helm is killed/restarted mid-run, that closure is gone: the run's work
// survives (worktree/commits), but no report is ever written, so the mate
// polling helm_collect_reports never hears back. On startup the app scans the
// persisted run history and synthesizes a report for any dispatched run that is
// terminal (or interrupted) yet has no report on disk - so the handshake
// completes across a restart.
//
// Pure functions here (single definition, unit-testable without Electron);
// main.js feeds them loadGoalRunHistory() + readReports() + live-run ids.

import { classifyRunOutcome } from "./runOutcome.js";

/**
 * Records that were dispatched (have a dispatchId) but have no report yet AND
 * are not currently live (a live run's own onComplete will still report). These
 * need a synthesized report on startup.
 *
 * The goal-run history is a single GLOBAL file, but reports are per-meta-home.
 * When `metaHome` is given, only records dispatched under THAT meta-home are
 * reconciled - so a run dispatched under meta-home A never gets a spurious
 * report written into meta-home B (harmless with one stable meta-home, a real
 * bug once it varies: E2E tests use a fresh temp meta-home each run, and named
 * mates may root elsewhere). Records predating this field (no dispatchMetaHome)
 * are only reconciled when no metaHome filter is passed, so an isolated
 * meta-home stays clean.
 */
export function recordsNeedingReport(records, existingReportIds, liveGoalRunIds, metaHome) {
  return (records || []).filter(
    (rec) =>
      rec &&
      rec.dispatchId &&
      !existingReportIds.has(rec.dispatchId) &&
      !liveGoalRunIds.has(rec.goalRunId) &&
      (metaHome == null || rec.dispatchMetaHome === metaHome)
  );
}

/**
 * The compact report for a dispatched run, derived from its PERSISTED history
 * record (not a live result object). Mirrors buildDispatchReport's shape. A
 * "running" record with no live process behind it is treated as "interrupted"
 * (the app died mid-run). needsCaptain is the load-bearing assign-back field.
 */
export function buildReportFromRecord(rec, now) {
  const commitCount = typeof rec.commitCount === "number" ? rec.commitCount : 0;
  // Same single definition as the live path in main.js. These two builders drifted
  // apart once already, and both were calling every non-crashed run "done".
  const outcome = classifyRunOutcome({
    stoppedReason: rec.stoppedReason,
    commitCount,
    branchName: rec.branchName,
    // Same as the live path: lets goal_reached say whether anything checked the claim.
    verifyCommand: rec.verifyCommand || null,
    error: rec.status === "error" ? rec.error || "The dispatched run errored." : null,
    escalation: rec.escalation || null,
    interrupted: rec.status === "running",
  });

  return {
    dispatchId: rec.dispatchId,
    dispatchedBy: rec.dispatchedBy || null,
    project: rec.projectPath,
    goal: rec.goal,
    tier: rec.tier || "crew",
    status: outcome.status,
    summary: outcome.headline,
    model: rec.resolvedModel || rec.model || null,
    changed: { commitCount, branchName: rec.branchName || null, worktreePath: rec.worktreePath || null },
    needsCaptain: outcome.needsCaptain,
    // Same split as the live path: alarm in needsCaptain, landed-but-unread work
    // on its own quiet line. Kept in both builders because they drifted apart
    // once already and both ended up calling every non-crashed run "done".
    awaitingReview: outcome.awaitingReview || null,
    stoppedReason: rec.stoppedReason || null,
    reportedAt: now,
    reconciled: true,
  };
}
