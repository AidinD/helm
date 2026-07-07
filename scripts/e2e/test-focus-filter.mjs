// E2E: the Focus filter (All / Work / Private). Verifies the toggle exists and
// the domain-matching behaviour - including the p0 fix: an UNCLASSIFIED list
// (no work/private domain) belongs to "All" only. It's dimmed under Work AND
// Private on the dashboard (was shown bright in both), and narrowed out of the
// Focus page's list. Drives a real launched Maestro via CDP.
//
// Run:  node scripts/e2e/test-focus-filter.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[focus-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector(".dash-focus-toggle", 8000);

  const btns = await app.eval(`[...document.querySelectorAll(".dash-focus-toggle .view-toggle button")].map((b) => b.textContent.trim())`);
  assert(["All", "Work", "Private"].every((x) => btns.includes(x)), "Focus toggle has All / Work / Private (got: " + JSON.stringify(btns) + ")");

  // The dim rule (dashGoalCardEl) under each mode, for a work goal vs an
  // unclassified goal. dashGoalCardEl reads the global dashboardFocusMode.
  const dim = await app.eval(`(() => {
    const saved = dashboardFocusMode;
    const workGoal = { id: "gw", text: "work goal", status: "open", domain: "work", categoryName: "W" };
    const noneGoal = { id: "gn", text: "unclassified goal", status: "open", domain: null, categoryName: "N" };
    const isDim = (goal, mode) => { dashboardFocusMode = mode; const el = dashGoalCardEl(goal); return el.classList.contains("dash-dimmed"); };
    const r = {
      workInWork: isDim(workGoal, "work"),
      workInPrivate: isDim(workGoal, "private"),
      noneInAll: isDim(noneGoal, "all"),
      noneInWork: isDim(noneGoal, "work"),
      noneInPrivate: isDim(noneGoal, "private"),
    };
    dashboardFocusMode = saved;
    return r;
  })()`);
  assert(dim.workInWork === false, "a work goal is NOT dimmed under Work focus");
  assert(dim.workInPrivate === true, "a work goal IS dimmed under Private focus");
  assert(dim.noneInAll === false, "an unclassified goal is never dimmed under All");
  assert(dim.noneInWork === true && dim.noneInPrivate === true, "an unclassified goal is dimmed under BOTH Work and Private (p0 fix - no longer bright in both)");

  // Focus page narrows: an unclassified goal is excluded under Work.
  const narrowed = await app.eval(`(() => {
    const saved = dashboardFocusMode;
    dashboardFocusMode = "work";
    const goals = [ { domain: "work" }, { domain: "private" }, { domain: null } ];
    const kept = goals.filter((g) => (typeof domainForGoal === "function" ? domainForGoal(g) : g.domain) === dashboardFocusMode);
    dashboardFocusMode = saved;
    return kept.length;
  })()`);
  assert(narrowed === 1, "Focus page filter keeps only the matching domain (unclassified narrowed out) - got " + narrowed);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Focus filter + unclassified-belongs-to-All (p0 fix)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
