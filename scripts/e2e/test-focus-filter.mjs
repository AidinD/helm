// E2E: the Focus filter (All / Work / Private). The dashboard toggle is now
// 3-way (was Work/Private), and the Focus page gained the same toggle which
// actually narrows its goal list. Drives a real launched Maestro via CDP.
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
// Texts of the buttons inside a .dash-focus-toggle within `scope` selector.
const toggleTexts = (scope) =>
  app.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(scope)} + ' .dash-focus-toggle'); if (!el) return null; return [...el.querySelectorAll('button')].map((b) => b.textContent.trim()); })()`
  );
const activeText = (scope) =>
  app.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(scope)} + ' .dash-focus-toggle button.active'); return el ? el.textContent.trim() : null; })()`
  );

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });

  // Dashboard toggle is now 3-way.
  const dashBtns = await toggleTexts("#dashboardPage");
  log("dashboard toggle:", JSON.stringify(dashBtns));
  assert(
    Array.isArray(dashBtns) && ["All", "Work", "Private"].every((x) => dashBtns.includes(x)),
    "dashboard Focus toggle has All / Work / Private"
  );
  assert((await activeText("#dashboardPage")) === "All", "dashboard Focus defaults to All (no dimming)");

  // Focus page has the same 3-way toggle.
  await app.click('#dashboardSubnav button[data-page="focus"]');
  await app.waitForSelector("#focusPage", 8000, { visible: true });
  const focusBtns = await toggleTexts("#focusPage");
  log("focus page toggle:", JSON.stringify(focusBtns));
  assert(
    Array.isArray(focusBtns) && ["All", "Work", "Private"].every((x) => focusBtns.includes(x)),
    "Focus page has an All / Work / Private filter"
  );
  assert((await activeText("#focusPage")) === "All", "Focus page defaults to All");

  // Clicking Work on the Focus page activates it (the shared state flips).
  await app.eval(
    "(() => { const b = [...document.querySelectorAll('#focusPage .dash-focus-toggle button')].find((x) => x.textContent.trim() === 'Work'); if (b) b.click(); })()"
  );
  await app.waitForSelector("#focusPage", 5000, { visible: true });
  assert((await activeText("#focusPage")) === "Work", "clicking Work on the Focus page makes it the active filter");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  log(exitCode === 0 ? "VERIFY OK: Focus filter (All/Work/Private) works on dashboard + Focus page." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}

process.exit(exitCode);
