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

// Its OWN debug port. This file passes on its own and failed in the full sweep - the class
// the suite's own notes call "interference between tests, not a real failure". It set no env
// at all, so it shared the default port with about 176 other app tests: if the previous
// test's Electron has not fully exited, this one attaches to THAT instance, which is running
// somebody else's seeded fleet, and the first assertion ("at least one first-mate card to
// press") fails against a board that was never meant for it (2026-08-12).
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9361";

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

  // The Dashboard is the widget grid now (task 337895ce); the first-mate cards it
  // renders (widgetBodyFirstMate -> fleetMateCardEl) live in .wd-grid. The classic
  // #dashFleetSlot and its per-slot swap are gone, but the pointer-held guard that
  // defers a refresh while a card is pressed survives - that is the behaviour under
  // test. Press a FIRST-mate card (not the Captain/.direct card, which has no
  // jumpIntoFirstMate handler).
  const setup = await app.eval(`(() => {
    const card = document.querySelector(".wd-grid .fleet-mate-card:not(.direct)");
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

  // (a) Press the card, then fire a NON-forced refresh that WOULD rebuild the
  // board (a seeded goal run changes widgetDashboardFingerprint - and unlike a
  // session it survives the render's own getSessions refetch, so the flush later
  // actually rebuilds). With the pointer held the refresh must be deferred: the
  // pressed node stays connected and the board is NOT rebuilt yet. A sentinel child
  // of #dashboardPage proves it - an atomic renderDashboardPage (page.replaceChildren)
  // removes it; a bailed refresh leaves it.
  const deferred = await app.eval(`(async () => {
    const page = document.getElementById("dashboardPage");
    const sentinel = document.createElement("span");
    sentinel.id = "__raceSentinel";
    page.append(sentinel);
    window.__probeCard.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    goalRuns.set("race", { goalRunId: "race", ordinal: ++goalRunSeq, goal: "RaceProbeRun", projectPath: "P", status: "running", iterations: [], result: null, error: null, escalation: null, latestPlan: null });
    await fillDashboardSections(); // non-forced: this is what the poll/event does
    return { stillConnected: window.__probeCard.isConnected, rebuilt: !document.getElementById("__raceSentinel") };
  })()`);
  assert(deferred.stillConnected, "the pressed card node survives a refresh fired while the pointer is held");
  assert(!deferred.rebuilt, "the refresh is deferred (the board is NOT rebuilt mid-press)");

  // (b) A click on the still-present node registers.
  const clicked = await app.eval(`(() => {
    window.__probeCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return window.__jumped;
  })()`);
  assert(!!clicked, "a click on the held card still registers (jumpIntoFirstMate ran)");

  // (c) After release, the deferred refresh flushes (the board rebuilds - the
  // sentinel is gone).
  await app.eval(`document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
  await wait(300);
  const flushed = await app.eval(`!document.getElementById("__raceSentinel")`);
  assert(flushed, "the deferred refresh runs after pointer release (the board rebuilds)");

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
