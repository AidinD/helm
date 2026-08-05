// E2E: the dashboard refreshes per-section. A change to the queue re-renders
// ONLY the queue slot, leaving the goals slot untouched; an idle tick repaints
// nothing. This is the real anti-flicker guarantee (a single session change no
// longer tears down the whole page). Real launched Helm.
//
// Run:  node scripts/e2e/test-dashboard-section-scope.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dashboard-section-scope-e2e]", ...a);
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
const has = (sel) => app.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
const tag = (slotId, name) =>
  app.eval(`(() => { const d = document.createElement("div"); d.setAttribute("data-e2e-sentinel", ${JSON.stringify(name)}); document.getElementById(${JSON.stringify(slotId)}).appendChild(d); return true; })()`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof fillDashboardSections === "function"`)) {
      break;
    }
    await wait(100);
  }
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashQueueSlot", 8000);
  await wait(900); // let the initial force-fill (incl. goals fetch) complete

  // Was #dashGoalsSlot. The Goals section went with the goals surface, so the neighbour used
  // to prove scoping is the Fleet slot - the rule being tested is that repainting ONE section
  // leaves the others alone, and any real neighbour demonstrates it.
  assert(await has("#dashFleetSlot"), "a neighbour slot exists (shell built into stable slots)");

  // Tag both slots, then force ONLY the queue's fingerprint to change.
  await tag("dashQueueSlot", "queue");
  await tag("dashFleetSlot", "neighbour");
  await app.eval(`dashSectionFingerprints.queue = "e2e-bogus"`);
  await app.eval(`fillDashboardSections()`);
  await wait(900);

  assert(!(await has(`#dashQueueSlot [data-e2e-sentinel="queue"]`)), "a queue change re-renders the queue slot (its sentinel is gone)");
  assert(await has(`#dashFleetSlot [data-e2e-sentinel="neighbour"]`), "the neighbour slot is NOT touched by a queue-only change (its sentinel survives)");

  // Idle tick: nothing changed since the last fill, so no section repaints.
  await tag("dashQueueSlot", "queue2");
  await app.eval(`fillDashboardSections()`);
  await wait(900);
  assert(await has(`#dashQueueSlot [data-e2e-sentinel="queue2"]`), "an unchanged tick repaints nothing (queue sentinel survives)");
  assert(await has(`#dashFleetSlot [data-e2e-sentinel="neighbour"]`), "an unchanged tick leaves the neighbour in place too");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: dashboard re-renders per section; unchanged sections stay put." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
