// E2E: the consolidated navigation (10 flat tabs -> 3 primary + gear + a
// dashboard sub-nav for the work facets). Drives a real launched Maestro via
// the CDP harness and asserts each nav surface shows the right page, that the
// primary Dashboard tab stays lit when a sub-nav facet is active (group-aware
// active state), and that no console errors fire.
//
// Run:  node scripts/e2e/test-nav-consolidation.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[nav-e2e]", ...a);
}

const app = await launch();
let exitCode = 0;
const checks = [];
function assert(cond, msg) {
  checks.push({ ok: !!cond, msg });
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

// Helpers built on the harness's eval (it has no count/isVisible of its own).
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const notHidden = (sel) =>
  app.eval(`!(document.querySelector(${JSON.stringify(sel)}) || { classList: { contains: () => true } }).classList.contains("hidden")`);
const hasClass = (sel, cls) =>
  app.eval(`(document.querySelector(${JSON.stringify(sel)}) || { classList: { contains: () => false } }).classList.contains(${JSON.stringify(cls)})`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const primaryCount = await count("#pageToggle button");
  assert(primaryCount === 3, `primary bar has 3 buttons (got ${primaryCount})`);
  const activeOnLoad = await app.getText("#pageToggle button.active");
  assert(activeOnLoad === "Dashboard", `Dashboard active on load (got ${JSON.stringify(activeOnLoad)})`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  assert(await notHidden("#settingsGear"), "settings gear present");
  assert(await notHidden("#dashboardSubnav"), "sub-nav visible on Dashboard");

  // Chat (primary) -> chatPage; sub-nav hides outside the dashboard group.
  await app.click('#pageToggle button[data-page="chat"]');
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  assert((await app.getText("#pageToggle button.active")) === "Chat", "Chat tab active after clicking Chat");
  assert(!(await notHidden("#dashboardSubnav")), "sub-nav hidden while on Chat");

  // Plan (primary) -> lavishPage.
  await app.click('#pageToggle button[data-page="lavish"]');
  await app.waitForSelector("#lavishPage", 8000, { visible: true });

  // Gear -> settingsPage, gear lit.
  await app.click("#settingsGear");
  await app.waitForSelector("#settingsPage", 8000, { visible: true });
  assert(await hasClass("#settingsGear", "active"), "gear shows active on Settings");

  // Settings utility row -> Skills (former Analysis) page.
  await app.click(".settings-utilities button");
  await app.waitForSelector("#analysisPage", 8000, { visible: true });
  const skillsHeading = await app.getText("#analysisPage h2");
  assert(skillsHeading === "Skills", `analysis page relabeled to Skills (got ${JSON.stringify(skillsHeading)})`);

  // Back to Dashboard -> sub-nav returns.
  await app.click('#pageToggle button[data-page="dashboard"]');
  await app.waitForSelector("#dashboardSubnav", 8000, { visible: true });

  // Sub-nav facet (Agents) -> agentsPage, and the PRIMARY Dashboard tab stays
  // active (group-aware) even though Agents is what we clicked.
  await app.click('#dashboardSubnav button[data-page="agents"]');
  await app.waitForSelector("#agentsPage", 8000, { visible: true });
  const primaryStillDashboard = await app.getText("#pageToggle button.active");
  assert(primaryStillDashboard === "Dashboard", `primary Dashboard stays active on a sub-nav facet (got ${JSON.stringify(primaryStillDashboard)})`);
  assert(await hasClass('#dashboardSubnav button[data-page="agents"]', "active"), "sub-nav Agents facet shows active");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  const passed = checks.filter((c) => c.ok).length;
  log(`${passed}/${checks.length} checks passed`);
  log(exitCode === 0 ? "VERIFY OK: consolidated nav works end to end." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}

process.exit(exitCode);
