// E2E: the chat-specific header controls (Simple/Advanced, Background tasks) are visible ONLY on
// the Chat view. Real launched Helm via CDP.
//
// This file also used to test the Focus track's domain sorting; that track was removed, and the
// nav button it clicked to reach Chat went with an earlier restructure. Both are handled below.
//
// Run:  node scripts/e2e/test-header-and-focus-sort.mjs
import { launch } from "../checks-lib/harness.mjs";

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
// The chat-only controls are RELOCATED into the pane header (which only renders
// on the Chat page), not toggled via a "hidden" class - so assert on effective
// visibility (offsetParent === null when their ancestor page is not shown),
// which is what actually matters to the user, not a class that is no longer the
// mechanism.
const isHidden = (id) =>
  app.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return !el || el.offsetParent === null; })()`);
const CHAT_CTRLS = ["viewToggle", "backgroundTasksBtn"]; // splitToggle removed with split view

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });

  // On Dashboard (default), the chat-only header controls must be hidden.
  for (const id of CHAT_CTRLS) {
    assert(await isHidden(id), `#${id} hidden on Dashboard`);
  }

  // On Chat, they must be visible. Chat lives in #headerUtilityNav now (moved
  // out of #pageToggle by the "Demote Chat/Plan" nav restructure - #pageToggle
  // holds only the Dashboard tab today).
  // Chat has NO nav button any more - it lost its place in both bars and is reached through
  // Ctrl+K and the Dashboard. Navigate the way the palette does, so this test is about the CHAT-ONLY
  // CONTROLS (what it exists for) rather than about a button that was removed.
  await app.eval('navigateToPage("chat")');
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  for (const id of CHAT_CTRLS) {
    assert(!(await isHidden(id)), `#${id} visible on Chat`);
  }

  // The second half of this file tested the Focus track: selecting Work/Private on the Dashboard
  // and asserting that matching goals sorted to the top while others dimmed. That whole track was
  // removed on 2026-08-04 (task 22f85eda's sibling - the toggle 'gjorde inget vettigt'), so there is
  // no toggle to click, no dimming class to read, and nothing to repoint it at. Its own removal is
  // asserted by test-focus-track-removed.mjs; what survives here is the header half.
  await app.eval('navigateToPage("dashboard")');
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  for (const id of CHAT_CTRLS) {
    assert(await isHidden(id), `#${id} is hidden again after leaving Chat`);
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: the chat-only header controls appear on Chat and nowhere else." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
