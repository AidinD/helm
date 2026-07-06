// E2E: nav restructuring (A/C/E). A) Skills + Archive live in their own header
// utility nav, reachable in one click (not buried in Settings). C) the "Goal"
// facet is renamed "Autopilot". E) "Focus" is gone from the sub-nav but still
// opens as the click-through detail from a dashboard goal card, with the
// Dashboard tab staying lit. Real launched Maestro via CDP.
//
// Run:  node scripts/e2e/test-nav-restructure.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[nav-restructure-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const isHidden = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.classList.contains("hidden")`);
const goto = (p) => app.eval(`(() => { navigateToPage(${JSON.stringify(p)}); return true; })()`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // A) Skills + Archive in the header utility nav, reachable in one click.
  const utilBtns = await app.eval(`[...document.querySelectorAll("#headerUtilityNav button")].map(b => ({ p: b.dataset.page, t: b.textContent }))`);
  log("header utility nav:", JSON.stringify(utilBtns));
  assert(utilBtns.some((b) => b.p === "analysis" && /Skills/.test(b.t)), "header has a Skills button");
  assert(utilBtns.some((b) => b.p === "archive" && /Archive/.test(b.t)), "header has an Archive button");

  await app.eval(`document.querySelector('#headerUtilityNav button[data-page="analysis"]').click()`);
  await app.waitForSelector("#analysisPage", 8000, { visible: true });
  assert(!(await isHidden("analysisPage")), "clicking Skills opens the analysis (Skills) page in one click");
  const skillsActive = await app.eval(`document.querySelector('#headerUtilityNav button[data-page="analysis"]').classList.contains("active")`);
  const gearActiveOnSkills = await app.eval(`document.getElementById("settingsGear").classList.contains("active")`);
  assert(skillsActive && !gearActiveOnSkills, "Skills button is active and the gear is NOT (Skills left the Settings group)");

  await app.eval(`document.querySelector('#headerUtilityNav button[data-page="archive"]').click()`);
  await app.waitForSelector("#archivePage", 8000, { visible: true });
  assert(!(await isHidden("archivePage")), "clicking Archive opens the Archive page in one click");

  // Settings no longer carries the old Skills/Archive utility row.
  await goto("settings");
  await app.waitForSelector("#settingsPage", 8000, { visible: true });
  const settingsHasUtil = await app.eval(`!!document.querySelector("#settingsPage .settings-utilities")`);
  assert(!settingsHasUtil, "Settings page no longer has the buried Skills/Archive row");

  // C) The "Goal" facet reads "Autopilot".
  const subnav = await app.eval(`[...document.querySelectorAll("#dashboardSubnav button")].map(b => ({ p: b.dataset.page, t: b.textContent }))`);
  log("sub-nav:", JSON.stringify(subnav));
  assert(subnav.some((b) => b.p === "goal" && b.t === "Autopilot"), "the goal facet button reads 'Autopilot'");
  await goto("goal");
  await app.waitForSelector("#goalPage", 8000, { visible: true });
  const goalHeading = await app.eval(`document.querySelector("#goalPage h2")?.textContent || ""`);
  assert(goalHeading === "Autopilot", `goal page heading is 'Autopilot' (got '${goalHeading}')`);

  // E) Focus is gone from the sub-nav (4 buttons, no "focus")...
  assert(subnav.length === 4 && !subnav.some((b) => b.p === "focus"), "sub-nav has 4 buttons and no Focus");
  // ...but navigateToPage("focus") still shows focusPage, with the Dashboard
  // tab lit and no sub-nav button active (it's the goal-card detail view).
  await goto("focus");
  await app.waitForSelector("#focusPage", 8000, { visible: true });
  assert(!(await isHidden("focusPage")), "focusPage still renders (reachable as the goal-card detail)");
  const dashTabActiveOnFocus = await app.eval(`document.querySelector('#pageToggle button[data-page="dashboard"]').classList.contains("active")`);
  const anySubnavActiveOnFocus = await app.eval(`[...document.querySelectorAll("#dashboardSubnav button")].some(b => b.classList.contains("active"))`);
  assert(dashTabActiveOnFocus, "the Dashboard primary tab stays active while viewing Focus");
  assert(!anySubnavActiveOnFocus, "no sub-nav button is active on Focus (it has no button)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Skills/Archive surfaced, Goal->Autopilot, Focus demoted to detail view." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
