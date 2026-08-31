// E2E: a "running" goal-run record with no live process behind it must not
// stay "running" on disk forever (bug ef0764e0). Before this fix, the ONLY
// reclassification was the goal:history IPC handler's read-time-only
// downgrade - it never wrote the correction back, so the raw file kept
// saying "running" indefinitely (found live: records 18-27 days old, dead
// pid, worktree long gone). This drives the real deferred startup
// reconciliation (reconcileStaleRunningRecords, ~12s after boot) and reads
// the RAW file back off disk afterwards - not goal:history's transformed
// copy - to prove the persisted fix, not just the old cosmetic one.
//
// Fixtures:
//   - "dead-worktree-gone": dead pid, worktree deleted -> must flip to
//     "interrupted" AND resumable must become false (can never be resumed).
//   - "dead-worktree-here": dead pid, worktree still on disk, resumable:true
//     -> must flip to "interrupted" but KEEP resumable:true (an app-restart
//     interruption is meant to stay resumable; only the missing-worktree
//     case tightens it).
//   - "foreign-live": fresh foreign heartbeat -> must be left alone,
//     completely untouched, status still "running" (ticket's explicit
//     warning: reclassifying a run another instance is actively driving is
//     worse than leaving a stale dead record).
//
// Isolation: HELM_GOAL_RUN_HISTORY_PATH points the launched app at a
// throwaway history file we seed and read back directly.
//
// Run:  node scripts/e2e/test-goal-run-reconciliation.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function log(...a) {
  console.log("[goal-reconcile-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-goal-reconcile-"));
const historyPath = path.join(tmp, "goal-run-history.json");
const worktreeHere = path.join(tmp, "wt-still-here");
fs.mkdirSync(worktreeHere, { recursive: true });
const worktreeGoneButRecorded = path.join(tmp, "wt-deleted"); // deliberately never created

const now = Date.now();
const FOREIGN_PID = 999999; // not this app's pid
const fixture = [
  {
    goalRunId: "dead-worktree-gone",
    goal: "crashed before cleanup, worktree later removed",
    projectPath: "P",
    status: "running",
    resumable: true,
    worktreePath: worktreeGoneButRecorded,
    branchName: "b",
    baseCommit: "abc",
    startedAt: now,
    updatedAt: now,
  },
  {
    goalRunId: "dead-worktree-here",
    goal: "app restarted mid-run, worktree survives",
    projectPath: "P",
    status: "running",
    resumable: true,
    worktreePath: worktreeHere,
    branchName: "b",
    baseCommit: "abc",
    startedAt: now,
    updatedAt: now,
  },
  {
    goalRunId: "foreign-live",
    goal: "genuinely live in another Helm instance",
    projectPath: "P",
    status: "running",
    resumable: true,
    worktreePath: worktreeHere,
    branchName: "b",
    baseCommit: "abc",
    livePid: FOREIGN_PID,
    liveHeartbeatAt: now, // fresh -> must be left alone
    startedAt: now,
    updatedAt: now,
  },
];
fs.writeFileSync(historyPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");

process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
const app = await launch();
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The reconciliation pass runs ~12s after boot (same deferred housekeeping
  // slot as the worktree sweep / stranded-auto-card check). Poll the RAW file
  // on disk rather than sleeping a fixed amount or reading goal:history's
  // transformed copy - this is specifically testing that the correction is
  // PERSISTED, not just returned to the renderer.
  const deadline = Date.now() + 25000;
  let raw = [];
  while (Date.now() < deadline) {
    try {
      raw = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    } catch {
      raw = [];
    }
    const gone = raw.find((r) => r.goalRunId === "dead-worktree-gone");
    if (gone && gone.status === "interrupted") {
      break;
    }
    await delay(500);
  }
  log("raw file after reconciliation:", JSON.stringify(raw.map((r) => ({ id: r.goalRunId, status: r.status, resumable: r.resumable }))));

  const gone = raw.find((r) => r.goalRunId === "dead-worktree-gone");
  const here = raw.find((r) => r.goalRunId === "dead-worktree-here");
  const foreign = raw.find((r) => r.goalRunId === "foreign-live");

  assert(!!gone && gone.status === "interrupted", `dead run with a deleted worktree is persisted as 'interrupted' (got ${gone?.status})`);
  assert(!!gone && gone.resumable === false, `a deleted-worktree run can never be resumed - resumable persisted false (got ${gone?.resumable})`);

  assert(!!here && here.status === "interrupted", `dead run whose worktree survives is persisted as 'interrupted' (got ${here?.status})`);
  assert(!!here && here.resumable === true, `a restart-interrupted run with its worktree intact stays resumable (got ${here?.resumable})`);

  assert(!!foreign && foreign.status === "running", `a run genuinely live in another instance is left completely alone (got ${foreign?.status})`);

  // Belt-and-suspenders: goal:history still reflects the same (now-persisted)
  // state to the renderer.
  const hist = await app.eval(`window.helm.getGoalRunHistory()`);
  const histGone = hist.find((r) => r.goalRunId === "dead-worktree-gone");
  const histForeign = hist.find((r) => r.goalRunId === "foreign-live");
  assert(!!histGone && histGone.status === "interrupted", "goal:history agrees the deleted-worktree run is interrupted");
  assert(!!histForeign && histForeign.status === "running", "goal:history still shows the foreign-live run as running");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: stale 'running' records are persisted as interrupted; foreign-live runs are left alone." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
