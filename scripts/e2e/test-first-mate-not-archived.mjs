// E2E (real launched Helm via CDP): a first mate is NEVER put in the archive-
// suggestion pile - it's a persistent role you retire (with a handoff), not
// archive. A normal idle session with no open work IS still suggested.
//
// Run:  node scripts/e2e/test-first-mate-not-archived.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[fm-not-archived-e2e]", ...a);
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
  await wait(800);

  const r = await app.eval(`(() => {
    state.config = state.config || {};
    state.config.archiveSuggestions = { enabled: true };
    // A first-mate-bound idle session + a plain idle session, both with no open Jot work.
    // lifecycleState (not raw status) is what dashboardProposalSessions() filters on
    // now (Epic f3d096fa); without it the "plain idle session IS suggested" control
    // never surfaces and the test passes/fails for the wrong reason.
    state.sessions = [
      { sessionId: "local_fm", cliSessionId: "cli_fm", cwd: "D:/x", title: "fix the login bug", status: "idle", lifecycleState: "idle", lastActivityAt: 2, jot: null },
      { sessionId: "local_plain", cliSessionId: "cli_plain", cwd: "D:/y", title: "Some idle project session", status: "idle", lifecycleState: "idle", lastActivityAt: 1, jot: null },
    ];
    mateSessionIds = new Set(["cli_fm"]);
    mateBySessionId = new Map([["cli_fm", { mateId: "m1", name: "Jack Sparrow", sessionId: "cli_fm" }]]);
    const proposals = dashboardProposalSessions();
    const ids = proposals.map((s) => s.sessionId);
    return { ids, includesFm: ids.includes("local_fm"), includesPlain: ids.includes("local_plain") };
  })()`);
  assert(r.includesFm === false, "a first-mate session is NOT in the archive-suggestion pile");
  assert(r.includesPlain === true, "a plain idle session with no open work IS still suggested (control)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: first mates excluded from archive suggestions; normal idle sessions still suggested." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
