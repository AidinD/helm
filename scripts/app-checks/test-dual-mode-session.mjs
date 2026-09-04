// E2E: the two modes are ONE canonical session. Orchestrating a project via the
// first mate (relay) and jumping directly into that project's second mate must
// resolve to the SAME bound session, not two divergent ones. Deterministic:
// both modes key off secondMateId(firstMate, project), so a session the relay
// bound is exactly the one a later jump-in resumes.
//
// Run:  node scripts/e2e/test-dual-mode-session.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[dual-mode-e2e]", ...a);
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

  const out = await app.eval(`(() => {
    // Both modes derive the SAME second-mate id from (firstMate, project); that
    // shared id (secondMateId(), unit-tested in test-second-mates) is why they
    // can't diverge. Here we confirm the renderer's jump-in honors a bound
    // session, so a relay that bound one is exactly what jump-in resumes.
    const smId = "sm_dual_test";

    // Simulate the relay having minted + BOUND a session for this second mate.
    const RELAY_SESSION = "sess-relay-dual";
    state.sessions = (state.sessions || []).filter((s) => s.cliSessionId !== RELAY_SESSION);
    state.sessions.push({ id: RELAY_SESSION, cliSessionId: RELAY_SESSION, cwd: "D:/Repo/proj-dual", title: "dual", status: "idle" });

    // Spy the two open paths so we can see which one jump-in takes.
    window.__opened = null;
    window.__freshDraft = null;
    openSessionInPane = (session) => { window.__opened = session.cliSessionId || session.sessionId; };
    openFreshDraftInPane = (cwd, text) => { window.__freshDraft = { cwd, text }; };
    navigateToPage = () => {};

    // Jump into the second mate the relay bound (sessionId = the relay's session).
    jumpIntoSecondMate({ secondMateId: smId, firstMateId: "mate_dual", projectPath: "D:/Repo/proj-dual", name: "proj-dual", sessionId: RELAY_SESSION });

    return {
      opened: window.__opened,
      freshDraft: window.__freshDraft,
    };
  })()`);

  assert(out.opened === "sess-relay-dual", `jumping in RESUMES the relay's bound session, not a new one (got ${JSON.stringify(out.opened)})`);
  assert(!out.freshDraft, `jump-in did NOT open a fresh divergent draft (got ${JSON.stringify(out.freshDraft)})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: relay + jump-in resolve to one canonical session." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
