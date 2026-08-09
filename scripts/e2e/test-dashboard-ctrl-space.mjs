// E2E (deterministic, no API turns): ctrl+space on the dashboard jumps into the
// first "needs you" chat (task 93975f46). First press elsewhere goes to the
// dashboard; a second press while already there opens the top needs-you session.
//
// Run:  node scripts/e2e/test-dashboard-ctrl-space.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[ctrl-space-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-ctrlspace-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    // A single waiting (needs-you) session, nothing else in motion. The ctrl+space
    // target is dashboardInMotionRows().needsAction, which reads lifecycleState ===
    // "waiting" (Epic f3d096fa), not raw status - so the fixture must set it.
    state.sessions = [{ sessionId: "sNeed", cliSessionId: "cNeed", cwd: "D:/x", title: "needs me", status: "waiting", lifecycleState: "waiting", isArchived: false }];
    mateBySessionId = new Map();
    secondMateBySessionId = new Map();
    navigateToPage("dashboard");
    const onDash = isDashboardVisible();
    document.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, code: "Space", key: " ", bubbles: true, cancelable: true }));
    const pane = panes[focusedPaneIndex];
    return { onDash, openedSession: pane && pane.sessionId, chatVisible: !document.getElementById("chatPage").classList.contains("hidden") };
  })()`);
  assert(res.onDash === true, "starts on the dashboard");
  assert(res.chatVisible === true, "ctrl+space navigated to the chat page");
  assert(res.openedSession === "sNeed", `ctrl+space opened the first needs-you chat (got ${JSON.stringify(res.openedSession)})`);

  log(exitCode === 0 ? "VERIFY OK: ctrl+space on the dashboard jumps into the first needs-you chat." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
