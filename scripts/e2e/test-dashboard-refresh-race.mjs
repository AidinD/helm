// E2E (real launched Helm via CDP): a dashboard section re-render must not eat
// a click on a fleet card. The bug ("sometimes clicks on first mates don't
// register, when switching between them") was a re-render race - a non-forced
// refresh (30s poll / streamed session event / a mate's status flipping after
// you jump in) swapped the fleet slot out from under the pointer, so the click
// landed on a detached node and was lost.
//
// The fix defers non-forced refreshes while the pointer is held on the
// dashboard, then runs the latest one AFTER the click resolves. This test
// drives that race deterministically: press a card, fire a refresh that WANTS
// to replace the slot, and prove (a) the pressed node survives, (b) a click on
// it still registers, and (c) the deferred refresh flushes after release.
//
// Run:  node scripts/e2e/test-dashboard-refresh-race.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dash-race-e2e]", ...a);
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

  // Render the dashboard. ensureMates yields two first mates by default, so the
  // fleet renders at least one .fleet-mate-card without any seeding.
  await app.eval(`(() => { state.sessions = []; navigateToPage("dashboard"); return true; })()`);
  await renderDash();

  const setup = await app.eval(`(() => {
    const card = document.querySelector("#dashFleetSlot .fleet-mate-card");
    if (!card) return { ok: false };
    window.__probeCard = card;
    window.__jumped = null;
    // Stub jumpIntoFirstMate so a click has an observable, side-effect-free
    // result (no real session spawn / navigation). It's a top-level function
    // binding; the card's handler calls it late-bound, so this reassignment
    // takes effect for the click below.
    jumpIntoFirstMate = function (m) { window.__jumped = (m && m.mateId) || "hit"; };
    return { ok: true };
  })()`);
  assert(setup.ok, "the dashboard renders at least one first-mate card to press");

  // (a) Press the card, then fire a refresh that WOULD replace the fleet slot
  // (a new Direct session changes the fleet fingerprint). With the pointer held
  // the refresh must be deferred: the pressed node stays connected and the new
  // node is NOT rendered yet.
  const deferred = await app.eval(`(async () => {
    window.__probeCard.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    state.sessions = [{ sessionId: "local_race", cliSessionId: "cli_race", cwd: "D:/Repo/Tools/helm", title: "RaceProbeSession", status: "idle", lastActivityAt: 9 }];
    await fillDashboardSections(); // non-forced: this is what the poll/event does
    const slotText = document.querySelector("#dashFleetSlot").innerText;
    return { stillConnected: window.__probeCard.isConnected, newNodeShown: /RaceProbeSession/.test(slotText) };
  })()`);
  assert(deferred.stillConnected, "the pressed card node survives a refresh fired while the pointer is held");
  assert(!deferred.newNodeShown, "the refresh is deferred (the new session node is NOT rendered mid-press)");

  // (b) A click on the still-present node registers.
  const clicked = await app.eval(`(() => {
    window.__probeCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return window.__jumped;
  })()`);
  assert(!!clicked, "a click on the held card still registers (jumpIntoFirstMate ran)");

  // (c) After release, the deferred refresh flushes (the new node appears).
  await app.eval(`document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
  await wait(120);
  const flushed = await app.eval(`/RaceProbeSession/.test(document.querySelector("#dashFleetSlot").innerText)`);
  assert(flushed, "the deferred refresh runs after pointer release (the new session node now renders)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: fleet-card clicks survive a concurrent dashboard refresh." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
