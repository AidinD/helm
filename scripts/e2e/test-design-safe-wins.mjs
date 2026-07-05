// E2E: verify the six [safe] design-review wins render clean across the pages
// they touch (Dashboard, Routines, Agents, Plan, Settings). Real launched
// Maestro via CDP; asserts the specific text/label changes + zero console
// errors after visiting each affected view.
//
// Run:  node scripts/e2e/test-design-safe-wins.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[safe-wins-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

// Navigate via the app's own router so active-state + sub-nav stay consistent.
const goto = (page) => app.eval(`(() => { navigateToPage(${JSON.stringify(page)}); return true; })()`);
const bodyText = (id) => app.eval(`document.getElementById(${JSON.stringify(id)})?.innerText || ""`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // 1. Dashboard: no "context-budget + worktree path pending" placeholder leaks.
  await goto("dashboard");
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  const dash = await bodyText("dashboardPage");
  assert(!/worktree path pending/.test(dash), "dashboard has no 'worktree path pending' placeholder");

  // 2. Plan heading matches its tab label ("Plan", not "Interactive plan").
  await goto("lavish");
  await app.waitForSelector("#lavishPage", 8000, { visible: true });
  const plan = await bodyText("lavishPage");
  assert(/^Plan\b/m.test(plan) && !/Interactive plan/.test(plan), "Plan page heading is 'Plan', not 'Interactive plan'");

  // 3. Routines: button says "Copy path" (not the mislabeled "Open SKILL.md"),
  //    and no page-level "Open SKILL.md".
  await goto("routines");
  await app.waitForSelector("#routinesPage", 8000, { visible: true });
  const routines = await bodyText("routinesPage");
  assert(!/Open SKILL\.md/.test(routines), "Routines no longer mislabels the copy button as 'Open SKILL.md'");

  // 4. Agents legend no longer lists the never-rendered "idle / background".
  await goto("agents");
  await app.waitForSelector("#agentsPage", 8000, { visible: true });
  const agents = await bodyText("agentsPage");
  assert(!/idle \/ background/.test(agents), "Agents legend drops the 'idle / background' entry");

  // 5. Settings: no "(Fas 3)" Swedish/dev phase tags in user-facing labels.
  await goto("settings");
  await app.waitForSelector("#settingsPage", 8000, { visible: true });
  const settings = await bodyText("settingsPage");
  assert(!/\(Fas 3\)/.test(settings), "Settings toggle titles drop '(Fas 3)'");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors across all visited pages (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: all six safe design wins render clean." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
