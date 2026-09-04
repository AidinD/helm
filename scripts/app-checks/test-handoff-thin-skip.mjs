// E2E (real launched Helm via CDP): archive-with-handoff skips the handoff for
// a thin/throwaway session (below HANDOFF_MIN_TURNS) - no summarize call, no
// DECISIONS.md write, just archive. A substantial session still summarizes.
// Fail-open: an unreadable/empty transcript falls through to summarizing.
// (the captain caught a test session polluting DECISIONS.md via the handoff.)
//
// Run:  node scripts/e2e/test-handoff-thin-skip.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[handoff-thin-e2e]", ...a);
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

// Install stubs: control the transcript turn count, and observe whether
// summarizeSession / archiveSession get called. Returns whether the
// window.helm.getTranscript stub could be installed (contextBridge objects are
// sometimes read-only).
async function setup(turns) {
  return app.eval(`(() => {
    window.__summarizeCalled = false;
    window.__archiveCalled = false;
    summarizeSession = () => { window.__summarizeCalled = true; return Promise.resolve({ text: "" }); };
    archiveSession = () => { window.__archiveCalled = true; return Promise.resolve(); };
    // sessionTurnCount is a top-level fn (reassignable), unlike the window.helm
    // bridge methods - stub it to control the guard's turn count.
    sessionTurnCount = () => Promise.resolve(${turns});
    return typeof sessionTurnCount === "function";
  })()`);
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  await setup(2);

  // --- Thin session (2 turns < 4): skip the handoff, archive straight --------
  await app.eval(`(async () => { await archiveWithHandoff({ sessionId: "s_thin", cliSessionId: "s_thin", cwd: "D:/Repo/Tools/helm", title: "just testing, ignore" }); return true; })()`);
  await wait(200);
  let state = await app.eval(`({ summarized: window.__summarizeCalled, archived: window.__archiveCalled })`);
  assert(!state.summarized, "thin session: summarizeSession is NOT called (no wasted model call / no DECISIONS write)");
  assert(state.archived, "thin session: it is still archived");

  // --- Substantial session (10 turns): summarize as usual --------------------
  await setup(10);
  await app.eval(`(async () => { await archiveWithHandoff({ sessionId: "s_big", cliSessionId: "s_big", cwd: "D:/Repo/Tools/helm", title: "real work session" }); return true; })()`);
  await wait(200);
  state = await app.eval(`({ summarized: window.__summarizeCalled, archived: window.__archiveCalled })`);
  assert(state.summarized, "substantial session: summarizeSession IS called (handoff preserved)");

  // --- Fail-open: empty/unreadable transcript (0 turns) still summarizes ------
  await setup(0);
  await app.eval(`(async () => { await archiveWithHandoff({ sessionId: "s_empty", cliSessionId: "s_empty", cwd: "D:/Repo/Tools/helm", title: "unknown" }); return true; })()`);
  await wait(200);
  state = await app.eval(`({ summarized: window.__summarizeCalled })`);
  assert(state.summarized, "fail-open: a 0-turn (unreadable) transcript summarizes rather than silently skipping");

  const errors = app.getConsoleErrors();
  const unexpected = errors.filter((e) => !/archive|capture|handoff/i.test(e.text || ""));
  assert(unexpected.length === 0, `no unexpected console errors (got ${unexpected.length})`);
  for (const e of unexpected) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: thin sessions skip the handoff; substantial + unreadable ones summarize." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
