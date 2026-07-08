// E2E: dismissing an archive proposal persists (survives recompute) and is
// activity-keyed - the session stays hidden until its lastActivityAt changes,
// then re-surfaces ("not now", not "never"). Real launched Helm via CDP.
// Everything runs in ONE eval so the app's periodic session refresh can't
// overwrite the injected state.sessions between steps.
//
// Run:  node scripts/e2e/test-dismiss-persist.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dismiss-persist-e2e]", ...a);
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

  const res = JSON.parse(
    await app.eval(`(() => {
      const has = () => dashboardProposalSessions().some((s) => s.sessionId === "prop-1");
      state.config.archiveSuggestions = { enabled: true };
      state.config.dismissedArchiveProposals = {};
      state.sessions = [{
        sessionId: "prop-1", cliSessionId: "prop-1", title: "Idle finished session",
        status: "idle", isArchived: false, isOrchestrator: false, lastActivityAt: 1000,
        jot: null, model: "claude-sonnet-5", attentionScore: 0
      }];
      const baseline = has();
      // Dismiss (activity-keyed at lastActivityAt=1000).
      state.config.dismissedArchiveProposals = { "prop-1": 1000 };
      const afterDismiss = has();
      // New activity -> stale dismissal -> should re-surface.
      state.sessions[0].lastActivityAt = 2000;
      const afterActivity = has();
      return JSON.stringify({ baseline, afterDismiss, afterActivity });
    })()`)
  );
  log("result:", JSON.stringify(res));

  assert(res.baseline === true, "an eligible idle session is proposed for archiving (baseline)");
  assert(res.afterDismiss === false, "a dismissed session is filtered out of the proposals");
  assert(res.afterActivity === true, "the session re-surfaces once its activity changes (dismissal is 'not now')");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: dismiss persists + is activity-keyed (re-surfaces on change)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
