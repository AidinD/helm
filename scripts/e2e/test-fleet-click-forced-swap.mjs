// E2E (real launched Helm, REAL mouse input via Input.dispatchMouseEvent): the
// recurring "clicking between first mates - many clicks don't register" bug.
//
// Root cause: navigating back to the Dashboard fires an ASYNC *forced* fill
// (renderDashboardPage), which can still be swapping the fleet slot when you
// press the next mate card. The pointer-held guard used to exempt forced
// refreshes, so a forced swap tore the card out mid-press and the click was
// never synthesized. Synthetic el.click() can't catch this (it always fires) -
// we inject real mouse press/release so the browser's real click synthesis
// (same element for press+release) is exercised.
//
// Asserts:
//  1. A FORCED fleet swap during a held pointer does NOT eat the click.
//  2. A non-forced swap during a held pointer doesn't either (baseline).
//  3. A force-only repaint that gets deferred still happens after release
//     (force is carried through the flush - so the archive spinner / rename
//     restore, whose state the fingerprints don't track, aren't lost).
//
// Run:  node scripts/e2e/test-fleet-click-forced-swap.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[fleet-click-e2e]", ...a);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
async function mouse(type, x, y) {
  await app.cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons: type === "mousePressed" ? 1 : 0,
    clickCount: 1,
  });
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(800);

  await app.eval(`(async () => {
    state.sessions = [
      { sessionId: "l_a", cliSessionId: "cli_a", cwd: "D:/Repo/Tools/helm", title: "mate A session", status: "active", lastActivityAt: 10 },
      { sessionId: "l_b", cliSessionId: "cli_b", cwd: "D:/Repo/Tools/helm", title: "mate B session", status: "active", lastActivityAt: 9 },
    ];
    mateBySessionId = new Map([
      ["cli_a", { mateId: "mA", name: "Anne Bonny", sessionId: "cli_a", slot: 0 }],
      ["cli_b", { mateId: "mB", name: "Mary Read", sessionId: "cli_b", slot: 1 }],
    ]);
    mateSessionIds = new Set(["cli_a", "cli_b"]);
    window.helm.listMates = async () => ({ ok: true, active: [
      { mateId: "mA", name: "Anne Bonny", sessionId: "cli_a", slot: 0, persona: null },
      { mateId: "mB", name: "Mary Read", sessionId: "cli_b", slot: 1, persona: null },
    ] });
    window.helm.listSecondMates = async () => ({ ok: true, secondMates: [] });
    navigateToPage("dashboard");
    await fillDashboardSections({ force: true });
    return true;
  })()`);
  await wait(400);

  const rect = await app.eval(`(() => {
    const card = document.querySelector(".fleet-mate-card");
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 18) };
  })()`);
  if (!rect) {
    throw new Error("no .fleet-mate-card rendered - fleet did not build");
  }

  // Count jumps without navigating away (stub keeps us on the dashboard).
  await app.eval(`(() => { window.__jumps = 0; jumpIntoFirstMate = () => { window.__jumps++; }; return true; })()`);

  const swapExpr = (force) => `(async () => {
    state.sessions[0].status = state.sessions[0].status === "active" ? "waiting" : "active";
    await fillDashboardSections({ force: ${force ? "true" : "false"} });
    return true;
  })()`;

  async function run(force, n) {
    await app.eval(`window.__jumps = 0`);
    for (let i = 0; i < n; i++) {
      await mouse("mousePressed", rect.x, rect.y);
      await app.eval(swapExpr(force)); // swap the fleet slot while pointer is held
      await mouse("mouseReleased", rect.x, rect.y);
      await wait(20);
    }
    return app.eval(`window.__jumps`);
  }

  const N = 8;
  const forced = await run(true, N);
  assert(forced === N, `a FORCED fleet swap mid-press eats no clicks (${forced}/${N} registered)`);
  const nonForced = await run(false, N);
  assert(nonForced === N, `a non-forced swap mid-press eats no clicks (${nonForced}/${N} registered)`);

  // (3) A deferred FORCED refresh keeps its force through the flush. Mark a
  // sentinel attribute on the fleet slot that only a rebuild (replaceChildren)
  // clears; press (held), fire a forced fill (must bail + queue WITH force),
  // release, and confirm the flush actually rebuilt the fleet.
  const pressPhase = await app.eval(`(async () => {
    const slot = document.getElementById("dashFleetSlot");
    // A sentinel CHILD: replaceChildren (the rebuild) removes it; a bailed
    // refresh leaves it. (An attribute on the slot itself would survive a
    // rebuild, since replaceChildren swaps children, not the slot's attrs.)
    const sentinel = document.createElement("span");
    sentinel.id = "__fleetSentinel";
    slot.append(sentinel);
    dashPointerHeld = true;                       // simulate a held pointer
    await fillDashboardSections({ force: true }); // must bail + queue with force
    return {
      bailedWithForce: dashRefreshQueued === true && dashQueuedForce === true,
      sentinelSurvivedPress: !!document.getElementById("__fleetSentinel"),
    };
  })()`);
  assert(pressPhase.bailedWithForce === true, "a forced refresh under a held pointer bails and queues WITH force preserved");
  assert(pressPhase.sentinelSurvivedPress === true, "the fleet slot was NOT rebuilt while the pointer was held (forced swap deferred)");

  // Release, then poll for the deferred forced flush to actually rebuild the
  // fleet (it awaits several IPCs, so a fixed sleep would flake).
  await app.eval(`(() => { releaseDashPointer(); return true; })()`);
  let rebuilt = false;
  for (let i = 0; i < 20 && !rebuilt; i++) {
    await wait(80);
    rebuilt = await app.eval(`!document.getElementById("__fleetSentinel")`);
  }
  assert(rebuilt === true, "the deferred forced refresh rebuilt the fleet slot after release (force not lost)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    log("  err:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: forced + non-forced swaps mid-press eat no clicks; deferred forced refresh keeps its force." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
