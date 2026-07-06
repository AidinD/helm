// E2E: the chat-only controls (Simple/Advanced, split, background tasks) were
// MOVED out of the global header into their own row (#chatToolbar) that only
// shows on Chat - so the primary tabs (Dashboard/Chat/Plan) no longer shift
// when switching views. Asserts: (a) controls live inside #chatToolbar, not the
// header; (b) toolbar visible only on Chat; (c) #pageToggle left-edge is stable
// across Dashboard <-> Chat <-> Plan (the "tabs jumping" regression).
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
const isHidden = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.classList.contains("hidden")`);
const leftOf = (id) => app.eval(`Math.round(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().left)`);
const CTRLS = ["viewToggle", "splitToggle", "backgroundTasksBtn"];

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // (a) All three controls are inside #chatToolbar and NOT inside <header>.
  for (const id of CTRLS) {
    const inToolbar = await app.eval(`!!document.getElementById("chatToolbar")?.contains(document.getElementById(${JSON.stringify(id)}))`);
    const inHeader = await app.eval(`!!document.querySelector("header")?.contains(document.getElementById(${JSON.stringify(id)}))`);
    assert(inToolbar && !inHeader, `#${id} lives in #chatToolbar, not the header`);
  }

  // (b) Toolbar visibility follows the Chat view only.
  await goto("dashboard");
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  assert(await isHidden("chatToolbar"), "#chatToolbar hidden on Dashboard");
  const leftDash = await leftOf("pageToggle");

  await goto("chat");
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  assert(!(await isHidden("chatToolbar")), "#chatToolbar visible on Chat");
  const leftChat = await leftOf("pageToggle");

  await goto("lavish");
  await app.waitForSelector("#lavishPage", 8000, { visible: true });
  assert(await isHidden("chatToolbar"), "#chatToolbar hidden on Plan");
  const leftPlan = await leftOf("pageToggle");

  // (c) The primary tab bar must not shift horizontally across views.
  log(`#pageToggle left: dashboard=${leftDash} chat=${leftChat} plan=${leftPlan}`);
  assert(leftDash === leftChat && leftChat === leftPlan, "#pageToggle left-edge is identical across Dashboard/Chat/Plan (no jump)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: controls relocated + primary tabs stable." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
