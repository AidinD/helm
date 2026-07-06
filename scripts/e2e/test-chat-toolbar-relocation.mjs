// E2E: the chat-only controls (Simple/Advanced, split, background tasks) ride on
// the PRIMARY pane's header row (moved there by paneHeaderEl) - no dedicated
// bar, no extra row - and the primary tabs (Dashboard/Chat/Plan) don't shift
// when switching views. Asserts: (a) controls live inside #chatToolbar, not the
// top header; (b) #chatToolbar is a child of the primary pane's .pane-header;
// (c) it's visible only on Chat; (d) #pageToggle left-edge is stable across
// Dashboard <-> Chat <-> Plan.
//
// Run:  node scripts/e2e/test-chat-toolbar-relocation.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[chat-toolbar-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const goto = (page) => app.eval(`(() => { navigateToPage(${JSON.stringify(page)}); return true; })()`);
// Actually visible = has a layout box (offsetParent set). Robust to being
// hidden by an ancestor (#chatPage) rather than its own class.
const isVisible = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.offsetParent`);
const leftOf = (id) => app.eval(`Math.round(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().left)`);
const CTRLS = ["viewToggle", "splitToggle", "backgroundTasksBtn"];

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // (a) All three controls are inside #chatToolbar and NOT inside <header>.
  for (const id of CTRLS) {
    const inToolbar = await app.eval(`!!document.getElementById("chatToolbar")?.contains(document.getElementById(${JSON.stringify(id)}))`);
    const inHeader = await app.eval(`!!document.querySelector("header")?.contains(document.getElementById(${JSON.stringify(id)}))`);
    assert(inToolbar && !inHeader, `#${id} lives in #chatToolbar, not the top header`);
  }

  // (b) #chatToolbar sits inside the PRIMARY pane's header row (no separate bar).
  const parentIsPaneHeader = await app.eval(
    `(() => { const t = document.getElementById("chatToolbar"); const ph = document.querySelector('.pane[data-pane="0"] .pane-header'); return !!(t && ph && ph.contains(t)); })()`
  );
  assert(parentIsPaneHeader, "#chatToolbar is inside the primary pane's .pane-header (rides the New-session row)");

  // (c) Visible only on Chat.
  await goto("dashboard");
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  assert(!(await isVisible("chatToolbar")), "#chatToolbar not visible on Dashboard");
  const leftDash = await leftOf("pageToggle");

  await goto("chat");
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  assert(await isVisible("chatToolbar"), "#chatToolbar visible on Chat");
  const leftChat = await leftOf("pageToggle");

  // Right-aligned: the toolbar's right edge hugs the pane-header's right edge
  // (only the header's right padding + the empty actions span between them).
  const rightGap = await app.eval(
    `(() => { const t = document.getElementById("chatToolbar").getBoundingClientRect(); const ph = document.querySelector('.pane[data-pane="0"] .pane-header').getBoundingClientRect(); return Math.round(ph.right - t.right); })()`
  );
  log(`toolbar right-edge gap to pane-header right: ${rightGap}px`);
  assert(rightGap >= 0 && rightGap <= 30, "chat toolbar is right-aligned (small gap to pane-header right edge)");

  await goto("lavish");
  await app.waitForSelector("#lavishPage", 8000, { visible: true });
  assert(!(await isVisible("chatToolbar")), "#chatToolbar not visible on Plan");
  const leftPlan = await leftOf("pageToggle");

  // (d) The primary tab bar must not shift horizontally across views.
  log(`#pageToggle left: dashboard=${leftDash} chat=${leftChat} plan=${leftPlan}`);
  assert(leftDash === leftChat && leftChat === leftPlan, "#pageToggle left-edge is identical across Dashboard/Chat/Plan (no jump)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: controls on pane header, no extra row, tabs stable." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
