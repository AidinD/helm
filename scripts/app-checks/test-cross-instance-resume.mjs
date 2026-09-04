// E2E: the cross-instance resume guard (ship-review data-safety). A run that is
// live in ANOTHER Helm instance (fresh foreign heartbeat on its record) must
// NOT be resumable here - resuming it would double-run the same worktree and
// corrupt git. A run whose foreign owner went away (stale heartbeat) is treated
// as a dead leftover and is allowed through the guard.
//
// Isolation: HELM_GOAL_RUN_HISTORY_PATH points the launched app at a throwaway
// history file we seed. Real relaunch needs a worktree, so we only assert the
// guard's decision (the foreign-live one is refused for THAT reason; the stale
// one gets past it and fails later on the missing worktree instead).
//
// Run:  node scripts/e2e/test-cross-instance-resume.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[xinstance-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-xinstance-"));
const historyPath = path.join(tmp, "goal-run-history.json");
const now = Date.now();
const FOREIGN_PID = 999999; // not this app's pid
fs.writeFileSync(
  historyPath,
  JSON.stringify([
    {
      goalRunId: "foreign-fresh", goal: "live elsewhere", projectPath: "P", status: "running",
      resumable: true, worktreePath: path.join(tmp, "wt-fresh"), branchName: "b", baseCommit: "abc",
      livePid: FOREIGN_PID, liveHeartbeatAt: now, // fresh -> owned by another instance
    },
    {
      goalRunId: "foreign-stale", goal: "owner died", projectPath: "P", status: "running",
      resumable: true, worktreePath: path.join(tmp, "wt-stale"), branchName: "b", baseCommit: "abc",
      livePid: FOREIGN_PID, liveHeartbeatAt: now - 5 * 60 * 1000, // 5 min old -> stale
    },
  ], null, 2),
  "utf8"
);

process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
const app = await launch();
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const seen = await app.eval(`window.helm.getGoalRunHistory().then(h => h.map(r => ({ id: r.goalRunId, status: r.status })))`);
  log("history the app sees:", JSON.stringify(seen));

  const fresh = await app.eval(`window.helm.resumeGoalRun("foreign-fresh")`);
  log("fresh:", JSON.stringify(fresh));
  assert(fresh && fresh.ok === false, "a foreign-fresh run is refused");
  assert(/another Helm instance/i.test(fresh?.error || ""), `refused specifically as live-elsewhere (got "${fresh?.error}")`);

  const stale = await app.eval(`window.helm.resumeGoalRun("foreign-stale")`);
  log("stale:", JSON.stringify(stale));
  // The stale one gets PAST the cross-instance guard (its owner is presumed
  // dead), then fails later on the missing worktree - so it must NOT be the
  // "another Helm instance" refusal.
  assert(stale && stale.ok === false, "the stale run still can't fully resume (no worktree on disk here)");
  assert(!/another Helm instance/i.test(stale?.error || ""), `a stale foreign heartbeat is NOT treated as live-elsewhere (got "${stale?.error}")`);
  assert(/worktree/i.test(stale?.error || ""), `the stale one falls through to the normal worktree check (got "${stale?.error}")`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: cross-instance guard refuses live-elsewhere runs, releases dead ones." : "VERIFY FAILED.");
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
