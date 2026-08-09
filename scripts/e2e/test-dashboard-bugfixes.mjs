// E2E (real launched Helm via CDP): three Dashboard/chat bug fixes from the
// 2026-07-11 batch.
//   1. The vestigial back/forward (←/→) arrows are gone from the chat pane
//      header (app-level mouse nav replaced them).
//   2. Clicking into a session focuses the composer textarea so you can type
//      immediately (no second click).
//   3. Archive-with-handoff lights the on-card spinner for a SECOND MATE. The
//      bug was a key mismatch: the producer keyed handoffBusyIds by the raw
//      session.sessionId, but the fleet node checks handoffBusyIds.has(
//      cliSessionId || sessionId). This asserts the busy class lights for the
//      cliSessionId key and NOT for the old raw sessionId key.
//
// Run:  node scripts/e2e/test-dashboard-bugfixes.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dash-bugfixes-e2e]", ...a);
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

  // --- Fix 1: chat-view back/forward arrows removed --------------------------
  const arrows = await app.eval(`(() => {
    navigateToPage("chat");
    renderWorkspace();
    const hdr = document.querySelector('.pane[data-pane="0"] .pane-header');
    if (!hdr) return { ok: false, reason: "no pane-header rendered" };
    const found = [...hdr.querySelectorAll("button")].filter((b) => b.textContent === "←" || b.textContent === "→");
    return { ok: found.length === 0, count: found.length };
  })()`);
  assert(arrows.ok, `chat pane-header has no back/forward (←/→) buttons (${arrows.count ?? arrows.reason})`);

  // --- Fix 2: clicking into a session focuses the composer -------------------
  const focus = await app.eval(`(() => {
    state.sessions = [{ sessionId: "local_focusprobe", cliSessionId: "cli_focusprobe", cwd: "D:/Repo/Tools/helm", title: "FocusProbe", status: "idle", lastActivityAt: 1 }];
    openSessionInPane(state.sessions[0], 0);
    const ta = document.querySelector('.pane[data-pane="0"] .pane-composer textarea');
    return { haveTa: !!ta, isActive: !!ta && document.activeElement === ta };
  })()`);
  assert(focus.haveTa, "composer textarea exists after opening a session");
  assert(focus.isActive, "the composer textarea is focused after clicking into a session");
  // It must SURVIVE the async transcript load (loadTranscriptInto -> renderPane,
  // which only rebuilds .pane-scroll, not the composer). Re-check after a beat.
  await wait(400);
  const stillFocused = await app.eval(`document.activeElement === document.querySelector('.pane[data-pane="0"] .pane-composer textarea')`);
  assert(stillFocused, "the composer stays focused after the async transcript load resolves");

  // --- Fix 3: 2nd-mate archive-with-handoff busy key matches the node --------
  // The classic Fleet section (#dashFleetSlot) went with the section stack (task
  // 337895ce). The Direct/second-mate node it rendered survives on the Captain
  // widget's card (fleetDirectCardEl); render that into a probe (mirrors
  // test-direct-report-rollup). The node's own id is cliSessionId || sessionId -
  // exactly the key archiveWithHandoff now uses (busyKey = cliSessionId) - so this
  // still guards the old key-mismatch bug: the raw sessionId must NOT light it.
  const renderNode = () =>
    app.eval(`(() => {
      document.querySelectorAll("#spinProbe").forEach((n) => n.remove());
      const host = document.createElement("div");
      host.id = "spinProbe";
      document.body.append(host);
      const directSms = [
        { secondMateId: "sd_spin", firstMateId: "direct", name: "SpinnerProbeSession", sessionId: "cli_spin", isSessionNode: true, crew: [] },
      ];
      host.append(fleetDirectCardEl(directSms));
      return true;
    })()`);

  await app.eval(`handoffBusyIds.clear(); true`);
  await renderNode();
  const nodeText = await app.eval(`[...document.querySelectorAll("#spinProbe .fleet-branch.secondmate")].map((b) => b.textContent).join(" || ")`);
  assert(/SpinnerProbeSession/.test(nodeText), "the seeded session renders as a Direct second-mate node");

  // The OLD, buggy key (raw sessionId) must NOT light the spinner.
  await app.eval(`(() => { handoffBusyIds.clear(); handoffBusyIds.add("local_spin"); return true; })()`);
  await renderNode();
  const litWrongKey = await app.eval(`[...document.querySelectorAll("#spinProbe .fleet-branch.card-handoff-busy")].some((b) => (b.textContent || "").includes("SpinnerProbeSession"))`);
  assert(!litWrongKey, "the raw sessionId key does NOT light the on-card spinner (regression guard for the old bug)");

  // The CORRECT key (cliSessionId || sessionId, what archiveWithHandoff now uses) lights it.
  await app.eval(`(() => { handoffBusyIds.clear(); handoffBusyIds.add("cli_spin"); return true; })()`);
  await renderNode();
  const litRightKey = await app.eval(`[...document.querySelectorAll("#spinProbe .fleet-branch.card-handoff-busy")].some((b) => (b.textContent || "").includes("SpinnerProbeSession"))`);
  assert(litRightKey, "the cliSessionId key lights the on-card spinner (the fix)");
  const badgeText = await app.eval(`[...document.querySelectorAll("#spinProbe .fleet-branch.card-handoff-busy .card-handoff-badge")].map((b) => b.textContent).join("")`);
  assert(/Saving handoff/.test(badgeText), "the lit card shows the 'Saving handoff…' spinner badge");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: arrows removed, composer auto-focus, 2nd-mate handoff spinner key fixed." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
