// E2E: (1) chat-specific header controls (Simple/Advanced, split, Background
// tasks) are hidden except on the Chat view; (2) the dashboard sorts matching-
// domain goals to the top when a Work/Private focus is active. Real launched
// Maestro via CDP.
//
// Run:  node scripts/e2e/test-header-and-focus-sort.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[hdr-e2e]", ...a);
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
const CHAT_CTRLS = ["viewToggle", "backgroundTasksBtn"]; // splitToggle removed with split view

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });

  // On Dashboard (default), the chat-only header controls must be hidden.
  for (const id of CHAT_CTRLS) {
    assert(await isHidden(id), `#${id} hidden on Dashboard`);
  }

  // On Chat, they must be visible.
  await app.click('#pageToggle button[data-page="chat"]');
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  for (const id of CHAT_CTRLS) {
    assert(!(await isHidden(id)), `#${id} visible on Chat`);
  }

  // Back to Dashboard; select Work; matching/neutral goals should float to top,
  // so the FIRST goal card must not be dimmed.
  await app.click('#pageToggle button[data-page="dashboard"]');
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  await app.eval(
    "(() => { const b = [...document.querySelectorAll('#dashboardPage .dash-focus-toggle button')].find((x) => x.textContent.trim() === 'Work'); if (b) b.click(); })()"
  );
  await app.waitForSelector("#dashboardPage", 5000, { visible: true });
  const firstCardDimmed = await app.eval(
    "(() => { const c = document.querySelector('#dashboardPage .dash-goals-grid .dash-goal-card'); return c ? c.classList.contains('dash-dimmed') : null; })()"
  );
  log("first goal card dimmed after selecting Work:", JSON.stringify(firstCardDimmed));
  assert(firstCardDimmed === false, "first dashboard goal card is NOT dimmed after selecting Work (matching sorted to top)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: header controls chat-only + dashboard focus-sort work." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
