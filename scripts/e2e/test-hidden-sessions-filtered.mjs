// E2E: a session in config.hiddenSessions ("removed from Helm") is filtered out
// of EVERY user-facing derivation consistently - not just the sidebar. This is
// the fix for the latent drift found while fixing the archive bug: the sidebar
// honored hiddenSessions but the Fleet Direct derivation (and the dashboard
// needs-you queue + attention/taskbar count) did not, so a removed session
// still surfaced as a Direct card. Drives the real renderer with controlled
// state (state.sessions + state.config.hiddenSessions injected, then restored).
//
// Run:  node scripts/e2e/test-hidden-sessions-filtered.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[hidden-sessions-e2e]", ...a);
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
    if (await app.eval(`typeof augmentSecondMatesWithSessions === "function" && typeof isHiddenFromHelm === "function"`)) {
      break;
    }
    await wait(100);
  }

  // Inject two direct project sessions in the SAME cwd - one visible, one
  // "removed from Helm" via config.hiddenSessions - then exercise the
  // derivations. Everything is restored in a finally-style block below so the
  // running app's real view is never left corrupted.
  const result = await app.eval(`(() => {
    const savedSessions = state.sessions;
    const savedConfig = state.config;
    try {
      state.sessions = [
        { sessionId: "VIS_1", cliSessionId: "VIS_1", cwd: "D:/Repo/hidden-test", title: "Visible one", status: "waiting", lastActivityAt: 200 },
        { sessionId: "HID_1", cliSessionId: "HID_1", cwd: "D:/Repo/hidden-test", title: "Hidden one",  status: "waiting", lastActivityAt: 100 },
      ];
      state.config = { ...savedConfig, hiddenSessions: ["HID_1"], groups: [] };

      // 1) The shared predicate itself.
      const predicate = { vis: isHiddenFromHelm(state.sessions[0]), hid: isHiddenFromHelm(state.sessions[1]) };

      // 2) Fleet Direct derivation (the primary bug).
      const directs = augmentSecondMatesWithSessions([]).filter((s) => s.firstMateId === "direct");
      const directIds = directs.map((s) => s.sessionId);

      // 3) Sidebar DOM - rows carry data-session-id.
      renderSidebar();
      const sidebarHasVis = !!document.querySelector('#sidebarBody [data-session-id="VIS_1"]');
      const sidebarHasHid = !!document.querySelector('#sidebarBody [data-session-id="HID_1"]');

      // 4) Dashboard attention spotlight / needs-you queue.
      const motionIds = dashboardInMotionRows()
        .filter((r) => r.kind === "session")
        .map((r) => r.session.sessionId);

      return {
        predicate,
        directIds,
        sidebarHasVis,
        sidebarHasHid,
        motionIds,
      };
    } finally {
      state.sessions = savedSessions;
      state.config = savedConfig;
      renderSidebar();
    }
  })()`);

  // 1) Predicate
  assert(result.predicate.vis === false && result.predicate.hid === true, "isHiddenFromHelm is true only for the hidden session");

  // 2) Fleet Direct
  assert(result.directIds.includes("VIS_1"), "Fleet Direct lists the visible session");
  assert(!result.directIds.includes("HID_1"), "Fleet Direct does NOT list the hidden session (the primary fix)");

  // 3) Sidebar
  assert(result.sidebarHasVis === true, "sidebar shows the visible session row");
  assert(result.sidebarHasHid === false, "sidebar omits the hidden session row");

  // 4) Attention spotlight / needs-you queue
  assert(result.motionIds.includes("VIS_1"), "dashboard needs-you queue includes the visible waiting session");
  assert(!result.motionIds.includes("HID_1"), "dashboard needs-you queue excludes the hidden waiting session");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  log(
    exitCode === 0
      ? "VERIFY OK: 'removed from Helm' sessions are filtered from sidebar, Fleet Direct, and the attention queue alike."
      : "VERIFY FAILED."
  );
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
