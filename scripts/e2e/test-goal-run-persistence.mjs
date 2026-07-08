// E2E: goal runs persist across restart. Writes a fake goal-run-history.json
// (one "done", one stale "running" whose process is gone), launches Helm,
// and confirms: goal:history downgrades the stale "running" to "interrupted",
// rehydrateGoalRuns seeds goalRuns from it, and the Goal page renders the past
// runs (the interrupted one with its explanatory status, neither with a Cancel
// button). Cleans up the history file afterwards.
//
// Run:  node scripts/e2e/test-goal-run-persistence.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const historyPath = path.join(__dirname, "..", "..", "goal-run-history.json");

function log(...a) {
  console.log("[goal-persist-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

// Preserve any real history file so the dev app's state isn't clobbered.
const hadExisting = fs.existsSync(historyPath);
const backup = hadExisting ? fs.readFileSync(historyPath, "utf8") : null;

const now = 1751800000000; // fixed timestamp (Date.now() avoided for determinism)
const fixture = [
  { goalRunId: "persist-done-1", goal: "A finished run", projectPath: "X", status: "done", worktreePath: "wt/a", branchName: "helm/goal-a", commitCount: 2, stoppedReason: "completed", escalation: null, error: null, startedAt: now, updatedAt: now },
  { goalRunId: "persist-running-1", goal: "A run cut off by restart", projectPath: "X", status: "running", worktreePath: null, branchName: null, commitCount: null, stoppedReason: null, escalation: null, error: null, startedAt: now, updatedAt: now },
];
fs.writeFileSync(historyPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");

const app = await launch();
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // goal:history downgrades the stale "running" (no live process) to interrupted.
  const hist = await app.eval(`window.helm.getGoalRunHistory()`);
  const running = hist.find((r) => r.goalRunId === "persist-running-1");
  const done = hist.find((r) => r.goalRunId === "persist-done-1");
  assert(!!done && done.status === "done", "finished run persists as 'done'");
  assert(!!running && running.status === "interrupted", `stale 'running' run downgraded to 'interrupted' (got ${running?.status})`);

  // rehydrateGoalRuns seeded the in-memory Map from disk.
  const mapInfo = await app.eval(`JSON.stringify({ size: goalRuns.size, statuses: [...goalRuns.values()].map(r => r.status).sort() })`);
  log("goalRuns after rehydrate:", mapInfo);
  const info = JSON.parse(mapInfo);
  assert(info.size >= 2, `goalRuns rehydrated with the persisted runs (size ${info.size})`);

  // Goal page renders the past runs; interrupted one shows its status text and
  // no Cancel button (only status === "running" gets Cancel).
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });
  const blocks = await app.eval(`document.querySelectorAll("#goalPage .goal-run-detail").length`);
  assert(blocks >= 2, `Goal page renders the rehydrated run blocks (got ${blocks})`);
  const interruptedShown = await app.eval(`/Interrupted by an app restart/.test(document.getElementById("goalPage").innerText)`);
  assert(interruptedShown, "interrupted run shows its explanatory status line");
  const cancelBtns = await app.eval(`document.querySelectorAll("#goalPage .goal-run-detail .goal-cancel-btn").length`);
  assert(cancelBtns === 0, `no Cancel button on non-running rehydrated runs (got ${cancelBtns})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: goal runs persist + rehydrate + interrupted reclassification." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.close();
  // Restore/remove the history file so we don't leave the fixture behind.
  if (hadExisting) {
    fs.writeFileSync(historyPath, backup, "utf8");
  } else {
    try {
      fs.unlinkSync(historyPath);
    } catch {
      // ignore
    }
  }
  log("cleanup: history file restored/removed");
}
process.exit(exitCode);
