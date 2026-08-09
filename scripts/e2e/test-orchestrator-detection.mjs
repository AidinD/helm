// E2E: an orchestrator (first-mate) session is detected by being BOUND to an
// active mate, not by its cwd. This replaced an earlier cwd-only rule (commit
// 4ba33f3, "Fix: only bound-to-mate sessions classify as a first mate"): the
// captain keeps personal chats in the meta-home dir too, and those must not read
// as first mates - only a mate binding does. This verifies the meta-home still
// resolves at startup (it seeds a fresh orchestrator session's cwd), that a
// mate-bound session IS an orchestrator while an unbound one at the same root is
// NOT, and that the older manual "Mark as Helm chat" tag is gone. Real launched Helm.
//
// Run:  node scripts/e2e/test-orchestrator-detection.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[orchestrator-detection-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof isOrchestratorSession === "function"`)) {
      break;
    }
    await wait(100);
  }
  // startup() fetches the meta-home; give it a moment to resolve.
  await wait(500);

  const home = await app.eval(`state.orchestratorHome`);
  assert(typeof home === "string" && home.length > 0, `meta-home resolved at startup (got: ${JSON.stringify(home)})`);

  // Detection is by mate binding, not by cwd. Seed a binding and check both keys
  // (cliSessionId and sessionId) the predicate accepts.
  await app.eval(`mateSessionIds = new Set(["bound-cli", "bound-sid"])`);
  assert(await app.eval(`isOrchestratorSession({ cliSessionId: "bound-cli" })`), "a session bound to a mate (by cliSessionId) IS an orchestrator");
  assert(await app.eval(`isOrchestratorSession({ sessionId: "bound-sid" })`), "a session bound to a mate (by sessionId) IS an orchestrator");

  // The captain's OWN chats live in the meta-home dir too - being rooted there is
  // NOT enough; without a mate binding it is not a first mate. This is the exact
  // regression commit 4ba33f3 fixed, so cwd must not resurrect the classification.
  assert(!(await app.eval(`isOrchestratorSession({ cwd: state.orchestratorHome, cliSessionId: "unbound", sessionId: "unbound" })`)), "an UNBOUND session rooted in the meta-home is NOT an orchestrator");
  assert(!(await app.eval(`isOrchestratorSession({ cwd: state.orchestratorHome })`)), "cwd alone (no binding) does not make a session an orchestrator");

  // A null/absent session never matches (the predicate's own guard).
  assert(!(await app.eval(`isOrchestratorSession(null)`)), "a null session is not an orchestrator");
  assert(!(await app.eval(`isOrchestratorSession({})`)), "a session with no ids is not an orchestrator");

  // The manual-tag mechanism is gone.
  assert(await app.eval(`typeof toggleManualHelmTag === "undefined"`), "the manual 'Mark as Helm chat' toggle function is removed");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: orchestrator detection is by mate binding (not cwd); manual tag removed." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
