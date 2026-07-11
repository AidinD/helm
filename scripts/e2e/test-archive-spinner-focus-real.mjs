// E2E (real launched Helm via CDP): reproduce the ACTUAL trigger paths for two
// fixes that a prior test passed while the real behavior stayed broken - the
// lesson being to exercise the path the user really takes, not a synthetic one.
//
//  #2 composer focus: the Fleet/dashboard jump-in calls openSessionInPane()
//     and THEN navigateToPage("chat"), so focus() ran while #chatPage was still
//     hidden (a no-op). The earlier test navigated to chat FIRST, hiding the
//     bug. Here we open WHILE the dashboard is showing (chat hidden), then
//     navigate, and assert the composer ends up focused (the rAF-deferred fix).
//
//  #1 archive spinner: archiveWithHandoff adds handoffBusyIds then did a
//     fingerprint-gated (non-forced) refresh - but handoffBusyIds isn't in the
//     fleet fingerprint, so the slot never rebuilt and the spinner never lit.
//     The earlier test forced the render manually, hiding the bug. Here we call
//     the REAL archiveWithHandoff (stubbing summarizeSession so no model call)
//     and assert the card lights via its own refresh, then clears.
//
// Run:  node scripts/e2e/test-archive-spinner-focus-real.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[archive-focus-real-e2e]", ...a);
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
async function renderDash() {
  await app.eval(`(async () => { await fillDashboardSections({ force: true }); return true; })()`);
  await app.eval(`(async () => { await fillDashboardSections({ force: true }); return true; })()`);
  await wait(250);
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(900);

  // ---- #2: jump-in from the dashboard (chat hidden) lands focus in composer -
  const focusResult = await app.eval(`(async () => {
    state.sessions = [{ sessionId: "local_focusreal", cliSessionId: "cli_focusreal", cwd: "D:/Repo/Tools/helm", title: "FocusRealProbe", status: "idle", lastActivityAt: 1 }];
    // Land on the dashboard so #chatPage is hidden (the jump-in starting point).
    navigateToPage("dashboard");
    await new Promise((r) => setTimeout(r, 60));
    const chatHiddenBefore = document.getElementById("chatPage").classList.contains("hidden");
    // Use the REAL jump-in path (now navigates to chat FIRST, then opens+focuses).
    jumpIntoSecondMate({ sessionId: "cli_focusreal", projectPath: "D:/Repo/Tools/helm", secondMateId: "sm_focus", name: "FocusRealProbe" });
    return { chatHiddenBefore };
  })()`);
  assert(focusResult.chatHiddenBefore, "precondition: chat was hidden before the jump-in (dashboard starting point)");
  await wait(150);
  const focused = await app.eval(`document.activeElement === document.querySelector('.pane[data-pane="0"] .pane-composer textarea')`);
  assert(focused, "the composer is focused after a jump-in from the dashboard (navigate-first makes the sync focus land)");

  // ---- #1: real archiveWithHandoff lights the on-card spinner ---------------
  await app.eval(`(() => {
    state.sessions = [{ sessionId: "local_spinreal", cliSessionId: "cli_spinreal", cwd: "D:/Repo/Tools/helm", title: "SpinRealProbe", status: "idle", lastActivityAt: 2 }];
    handoffBusyIds.clear();
    // Stub the slow handoff summarize so no real model call happens, and hold it
    // PENDING so we can observe the spinner in its lit state.
    window.__resolveSum = null;
    summarizeSession = () => new Promise((res) => { window.__resolveSum = () => res({ text: "" }); });
    navigateToPage("dashboard");
    return true;
  })()`);
  await renderDash();

  const stubApplied = await app.eval(`/__resolveSum|text:\\s*""/.test(summarizeSession.toString())`);
  assert(stubApplied, "summarizeSession stub applied (so no real model call)");

  // Kick off the REAL archive-with-handoff path (do not await - it's pending on the stub).
  await app.eval(`(() => { archiveWithHandoff(state.sessions[0]); return true; })()`);
  // Let archiveWithHandoff's own (now forced) refresh rebuild the fleet.
  await wait(500);
  const lit = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-branch.card-handoff-busy")].some((b) => (b.textContent || "").includes("SpinRealProbe"))`);
  assert(lit, "the on-card spinner lights via archiveWithHandoff's own refresh (not a forced manual render)");
  const badge = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-branch.card-handoff-busy .card-handoff-badge")].some((b) => /Saving handoff/.test(b.textContent))`);
  assert(badge, "the lit card shows the 'Saving handoff…' badge");

  // Resolve the summarize; the spinner should clear.
  const hadResolver = await app.eval(`typeof window.__resolveSum === "function"`);
  assert(hadResolver, "summarizeSession was actually invoked (its resolver is set)");
  await app.eval(`window.__resolveSum && window.__resolveSum()`);
  await wait(600);
  const clearState = await app.eval(`(() => {
    const branches = [...document.querySelectorAll("#dashFleetSlot .fleet-branch")].filter((b) => (b.textContent||"").includes("SpinRealProbe"));
    return {
      busyKeyStillSet: handoffBusyIds.has("cli_spinreal"),
      branchPresent: branches.length,
      branchLit: branches.some((b) => b.classList.contains("card-handoff-busy")),
    };
  })()`);
  log("clear diagnostics: " + JSON.stringify(clearState));
  assert(!clearState.busyKeyStillSet, "the busy key is removed after the handoff completes");
  assert(!clearState.branchLit, "the spinner clears after the handoff completes");

  const errors = app.getConsoleErrors();
  // archiveSession on a synthetic session may log an archive-failed error; that's
  // expected here (the seeded session isn't a real backend session). Only fail on
  // OTHER console errors.
  const unexpected = errors.filter((e) => !/archive/i.test(e.text || ""));
  assert(unexpected.length === 0, `no unexpected console errors (got ${unexpected.length})`);
  for (const e of unexpected) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: focus lands from a jump-in; archive spinner lights via the real path." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
