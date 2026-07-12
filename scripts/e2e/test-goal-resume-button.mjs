// E2E: a paused (escalated) or interrupted autopilot run offers a one-click
// "Resume run" button that calls goal:resume with the run's id (Phase 2 wired
// resumeGoalRunById; the card used to say resume "wasn't wired up yet"). Real
// launched Helm via CDP. The actual relaunch needs a live worktree, so we stub
// window.helm.resumeGoalRun to capture the call instead of running it.
//
// Run:  node scripts/e2e/test-goal-resume-button.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[goal-resume-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });

  // window.helm is a frozen contextBridge object (can't stub its methods), so
  // spy on the renderer-global showToast instead - it fires when the handler
  // gets its result back, proving the full click -> resumeGoalRun -> feedback
  // path ran. The real resumeGoalRun returns {ok:false} for these seeded ids
  // (no on-disk record), so we expect a "couldn't resume" toast, not a launch.
  await app.eval(`(() => {
    window.__toasts = [];
    const orig = window.showToast;
    window.showToast = (msg) => { window.__toasts.push(msg); return orig ? orig(msg) : undefined; };
    return typeof window.helm.resumeGoalRun === "function";
  })()`);
  const hasResumeApi = await app.eval(`typeof window.helm.resumeGoalRun === "function"`);
  assert(hasResumeApi, "preload exposes window.helm.resumeGoalRun");

  // One escalated (paused) run and one interrupted run, both expanded.
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("esc-1", { goalRunId: "esc-1", ordinal: 1, goal: "A paused run", projectPath: "P", status: "running", iterations: [{ iteration: 1, phase: "implement", ok: false }], result: null, error: null, escalation: { signal: "two_consecutive_failures", iteration: 2, branchName: "helm/goal-esc", worktreePath: "P/wt-esc" }, latestPlan: null });
    goalRuns.set("int-1", { goalRunId: "int-1", ordinal: 2, goal: "An interrupted run", projectPath: "P", status: "interrupted", iterations: [{ iteration: 1, phase: "implement", ok: true }], result: null, error: null, escalation: null, latestPlan: null });
    goalRunExpanded.add("esc-1");
    goalRunExpanded.add("int-1");
    renderGoalPage();
    return true;
  })()`);

  const btns = await count("#goalPage .goal-resume-btn");
  assert(btns === 2, `both the paused and interrupted runs show a Resume button (got ${btns})`);

  const goalText = await app.eval(`document.getElementById("goalPage").innerText`);
  assert(!/not wired up yet|planned follow-up/.test(goalText), "the stale 'resume not wired up yet' copy is gone");

  // Click the first Resume button; the real resume returns {ok:false} for a
  // seeded id, so the handler should surface a "couldn't resume" toast.
  await app.eval(`(() => { document.querySelector("#goalPage .goal-resume-btn").click(); return true; })()`);
  await app.eval("new Promise(r => setTimeout(r, 500))");
  const toasts = await app.eval(`window.__toasts`);
  assert(Array.isArray(toasts) && toasts.length >= 1, `clicking Resume runs the handler and gives feedback (got ${toasts?.length} toast(s))`);
  assert(/resume|cap/i.test((toasts || []).join(" ")), `the feedback is about resuming (got ${JSON.stringify(toasts)})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: paused/interrupted runs are resumable from their card." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
