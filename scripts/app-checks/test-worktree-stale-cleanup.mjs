// E2E: a goal run whose worktree is already gone from disk can still be cleaned
// up from the UI (Delete clears the stale record instead of erroring), and Open
// gives feedback instead of silently doing nothing. Real launched Helm via
// CDP. Drives the IPC handlers directly with a nonexistent path.
//
// Run:  node scripts/e2e/test-worktree-stale-cleanup.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[worktree-stale-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const MISSING = "D:/definitely/not/a/real/worktree-xyz";

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Open on a missing worktree -> explicit error (not silent).
  const openRes = await app.eval(`window.helm.openGoalWorktree(${JSON.stringify(MISSING)})`);
  log("openGoalWorktree(missing):", JSON.stringify(openRes));
  assert(openRes && openRes.ok === false && /no longer exists/i.test(openRes.error || ""), "Open on a missing worktree returns an explicit error");

  // Delete on a missing worktree -> succeeds as a stale-record cleanup, not an error.
  const delRes = await app.eval(`window.helm.deleteGoalWorktree({ goalRunId: "stale-xyz", projectPath: ${JSON.stringify(MISSING)}, worktreePath: ${JSON.stringify(MISSING + "/wt")} })`);
  log("deleteGoalWorktree(missing):", JSON.stringify(delRes));
  assert(delRes && delRes.ok === true && delRes.alreadyGone === true, "Delete on a missing worktree clears the stale record (ok + alreadyGone), doesn't error");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: stale/missing worktree is cleanable + Open gives feedback." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
