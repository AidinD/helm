// E2E (real launched Helm via CDP): the ASYNC half of the click-eating race.
// fillDashboardSections awaits several IPCs, so a refresh that started BEFORE a
// press can reach a replaceChildren mid-press when its awaits resolve - the
// entry-only guard didn't catch that (it's why clicks regressed after the fleet
// fingerprint started changing more often). The fix re-checks the pointer-held
// guard before EVERY slot mutation. This proves a refresh kicked off, then
// pressed during its first await, bails without swapping any slot.
//
// Run:  node scripts/e2e/test-dashboard-refresh-race-async.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dash-race-async-e2e]", ...a);
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
  await app.eval(`(() => { state.sessions = []; navigateToPage("dashboard"); return true; })()`);
  await renderDash();

  const result = await app.eval(`(async () => {
    // Reset guard state; a fleet marker to detect a swap.
    dashPointerHeld = false;
    dashRefreshQueued = false;
    const fleet = document.getElementById("dashFleetSlot");
    fleet.setAttribute("data-race-marker", "1");
    // Make the next refresh WANT to replace the fleet (new session -> fleet fp changes).
    state.sessions = [{ sessionId: "local_async", cliSessionId: "cli_async", cwd: "D:/Repo/Tools/helm", title: "AsyncRaceProbe", status: "idle", lastActivityAt: 5 }];

    // Kick off a non-forced refresh WITHOUT awaiting. It runs synchronously to
    // its first await (entry guard passes: pointer not down yet), then yields.
    const p = fillDashboardSections();
    // Now press: sets dashPointerHeld=true DURING the refresh's awaits, after the
    // entry guard already passed - exactly the regression window.
    document.getElementById("dashboardPage").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const heldAfterPress = dashPointerHeld;
    await p; // let the refresh resume - it should hit a re-check and bail

    const markerSurvived = document.getElementById("dashFleetSlot")?.getAttribute("data-race-marker") === "1";
    const showsNewNode = /AsyncRaceProbe/.test(document.getElementById("dashFleetSlot")?.innerText || "");
    return { heldAfterPress, queued: dashRefreshQueued, markerSurvived, showsNewNode };
  })()`);

  assert(result.heldAfterPress === true, "pointerdown set the held guard (mid-refresh)");
  assert(result.queued === true, "the in-flight refresh bailed at a re-check and queued for release (did not swap mid-press)");
  assert(result.markerSurvived === true, "the fleet slot was NOT replaced during the press (marker survived)");
  assert(result.showsNewNode === false, "the new node is NOT rendered yet (mutation deferred)");

  // Release: the queued refresh flushes and now swaps the fleet in.
  await app.eval(`document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
  await wait(200);
  const flushed = await app.eval(`/AsyncRaceProbe/.test(document.getElementById("dashFleetSlot")?.innerText || "")`);
  assert(flushed, "after release, the deferred refresh runs and the fleet updates");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: an in-flight refresh bails mid-press (async re-check), then flushes on release." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
