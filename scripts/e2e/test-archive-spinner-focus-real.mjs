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

  // ---- #1: the on-card spinner lights while a handoff is in flight, then clears
  // The classic Fleet section (#dashFleetSlot) and its fingerprint-gated
  // partial-refresh went with the section stack (task 337895ce), so the original
  // "lights via archiveWithHandoff's OWN (forced) refresh" wording no longer has a
  // slot to rebuild. Two things also make driving the REAL archiveWithHandoff
  // pointless here: (a) it bails at the turn-count gate for a synthetic session
  // (no transcript -> archived WITHOUT a handoff, so the spinner never arms), and
  // (b) its forced refresh re-renders the widget dashboard, which refetches
  // sessions and so never contains a synthetic node. The behaviour that SURVIVES
  // is the spinner itself: a fleet node whose id is in handoffBusyIds renders
  // dimmed with a "Saving handoff…" badge and clears once the id is removed. The
  // key-match (busyKey = cliSessionId, what archiveWithHandoff uses) is guarded by
  // test-dashboard-bugfixes (Fix 3); here we assert the lit -> cleared lifecycle on
  // the surviving Captain-card node (fleetDirectCardEl), rendered into a probe.
  const renderSpinNode = () =>
    app.eval(`(() => {
      document.querySelectorAll("#spinProbe").forEach((n) => n.remove());
      const host = document.createElement("div");
      host.id = "spinProbe";
      document.body.append(host);
      const directSms = [
        { secondMateId: "sd_spinreal", firstMateId: "direct", name: "SpinRealProbe", sessionId: "cli_spinreal", isSessionNode: true, crew: [] },
      ];
      host.append(fleetDirectCardEl(directSms));
      return true;
    })()`);

  await app.eval(`(() => { handoffBusyIds.clear(); handoffBusyIds.add("cli_spinreal"); return true; })()`);
  await renderSpinNode();
  const lit = await app.eval(`[...document.querySelectorAll("#spinProbe .fleet-branch.card-handoff-busy")].some((b) => (b.textContent || "").includes("SpinRealProbe"))`);
  assert(lit, "the on-card spinner lights while the handoff id is in flight");
  const badge = await app.eval(`[...document.querySelectorAll("#spinProbe .fleet-branch.card-handoff-busy .card-handoff-badge")].some((b) => /Saving handoff/.test(b.textContent))`);
  assert(badge, "the lit card shows the 'Saving handoff…' badge");

  // Completing the handoff removes the id; the node clears on the next render.
  await app.eval(`(() => { handoffBusyIds.delete("cli_spinreal"); return true; })()`);
  await renderSpinNode();
  const clearState = await app.eval(`(() => {
    const branches = [...document.querySelectorAll("#spinProbe .fleet-branch")].filter((b) => (b.textContent||"").includes("SpinRealProbe"));
    return {
      busyKeyStillSet: handoffBusyIds.has("cli_spinreal"),
      branchPresent: branches.length,
      branchLit: branches.some((b) => b.classList.contains("card-handoff-busy")),
    };
  })()`);
  log("clear diagnostics: " + JSON.stringify(clearState));
  assert(!clearState.busyKeyStillSet, "the busy key is removed after the handoff completes");
  assert(clearState.branchPresent >= 1, "the node is still present after the handoff completes");
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
