// E2E: an orchestrator session is detected purely by being rooted in the
// meta-home (cwd), replacing the removed manual "Mark as Helm chat" tag and
// the fragile Jot-category-name match. Verifies the meta-home resolves at
// startup, cwd matching is correct (incl. Windows case/slash normalization),
// and the manual-tag mechanism is gone. Real launched Helm.
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

  // A session rooted in the meta-home IS an orchestrator.
  assert(await app.eval(`isOrchestratorSession({ cwd: state.orchestratorHome })`), "session rooted in the meta-home is an orchestrator");

  // A session in a subfolder / different repo is NOT.
  assert(!(await app.eval(`isOrchestratorSession({ cwd: state.orchestratorHome + "/some-project" })`)), "a subfolder session is NOT an orchestrator");
  assert(!(await app.eval(`isOrchestratorSession({ cwd: "D:/Repo/Tools/helm" })`)), "a different repo is NOT an orchestrator");

  // No cwd never matches.
  assert(!(await app.eval(`isOrchestratorSession({ cwd: "" })`)), "empty cwd is not an orchestrator");
  assert(!(await app.eval(`isOrchestratorSession({})`)), "missing cwd is not an orchestrator");

  // Windows case-insensitive + slash-direction normalization still matches.
  assert(
    await app.eval(`isOrchestratorSession({ cwd: state.orchestratorHome.toUpperCase().replace(/\\//g, "\\\\") })`),
    "case + backslash variant of the meta-home still matches"
  );

  // The manual-tag mechanism is gone.
  assert(await app.eval(`typeof toggleManualHelmTag === "undefined"`), "the manual 'Mark as Helm chat' toggle function is removed");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: orchestrator detection is cwd-based; manual tag removed." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
