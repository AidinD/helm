// E2E: away-from-desk attention delivery wiring. Asserts the IPC surface
// (notifyAttention + setAttentionCount), the Settings toggle, and that the
// taskbar-count helper runs clean. The focus-gated OS notification + the actual
// badge value are OS/main-side and can't be asserted from CDP - those are
// covered by code review (main.js gates on !isFocused() + config).
//
// Run:  node scripts/e2e/test-attention-notify.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[attn-notify-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const api = await app.eval(`JSON.stringify({ notify: typeof window.helm.notifyAttention, count: typeof window.helm.setAttentionCount })`);
  const a = JSON.parse(api);
  assert(a.notify === "function", "window.helm.notifyAttention is exposed");
  assert(a.count === "function", "window.helm.setAttentionCount is exposed");

  // The taskbar-count helper runs without throwing (with injected attention).
  const ran = await app.eval(`(() => {
    try {
      unseenGoalAttention.add("x");
      state.sessions = [{ sessionId: "w1", status: "waiting", isArchived: false, title: "W", lastActivityAt: 1 }];
      updateAttentionTaskbarCount();
      return "ok";
    } catch (e) { return "throw: " + e.message; }
  })()`);
  log("updateAttentionTaskbarCount:", ran);
  assert(ran === "ok", "updateAttentionTaskbarCount computes + calls setAttentionCount without throwing");

  // Settings exposes the new toggle.
  await app.eval(`(() => { navigateToPage("settings"); return true; })()`);
  await app.waitForSelector("#settingsPage", 8000, { visible: true });
  const hasToggle = await app.eval(`/Notify when something needs you/.test(document.getElementById("settingsPage").innerText)`);
  assert(hasToggle, "Settings has the 'Notify when something needs you' toggle");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: attention-notify IPC + count helper + settings toggle wired." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
