// E2E: goal-run errors/escalations surface even when off-page - a persistent
// attention badge on the Dashboard tab tracks unseen failed/paused runs and
// clears when you visit the Goal/Agents facet. Real launched Maestro via CDP.
// The actual toast fires from the IPC onGoalEvent path (needs a real/simulated
// event); here we drive the badge state machine directly (unseenGoalAttention +
// updateGoalAttentionBadge + navigateToPage clearing), which is the persistent,
// discoverable half. Also asserts showToast exists (the transient half).
//
// Run:  node scripts/e2e/test-goal-attention-badge.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[attn-badge-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const badgeHidden = () => app.eval(`!!document.getElementById("dashboardAttentionBadge")?.classList.contains("hidden")`);
const badgeText = () => app.eval(`document.getElementById("dashboardAttentionBadge")?.textContent || ""`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The transient half exists.
  assert(await app.eval(`typeof showToast === "function"`), "showToast helper exists (transient toast path)");

  // Badge starts clear.
  assert(await badgeHidden(), "attention badge hidden with no unseen runs");

  // Two runs error/escalate while off-page -> badge shows the count.
  await app.eval(`(() => { unseenGoalAttention.add("run-a"); unseenGoalAttention.add("run-b"); updateGoalAttentionBadge(); return true; })()`);
  assert(!(await badgeHidden()), "badge appears when runs need attention");
  assert((await badgeText()) === "2", `badge shows the unseen count (got "${await badgeText()}")`);

  // >9 collapses to "9+".
  await app.eval(`(() => { for (let i=0;i<12;i++) unseenGoalAttention.add("r"+i); updateGoalAttentionBadge(); return true; })()`);
  assert((await badgeText()) === "9+", `badge caps at 9+ (got "${await badgeText()}")`);

  // Visiting the Goal facet counts as "seen" -> clears.
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });
  assert(await badgeHidden(), "badge clears after visiting the Goal facet");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: attention badge tracks + clears unseen goal-run attention." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
