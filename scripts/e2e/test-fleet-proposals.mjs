// E2E: the fleet shows a proposals banner at the top when the first mate has
// proposed second mates (topics), and a chip engages that proposal in one click
// - so proposals surface near the queue instead of buried in a column (flow P2).
//
// Run:  node scripts/e2e/test-fleet-proposals.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[fleet-proposals-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.waitForSelector("#dashFleetSlot", 8000);

  // One eval: render a fleet with two proposed second mates, spy the engage fn,
  // click the first chip, and read what it engaged.
  const out = await app.eval(`(() => {
    window.__engaged = null;
    jumpIntoSecondMate = (sm) => { window.__engaged = sm; };
    goalRuns.clear();
    const mates = [{ mateId: "m0", slot: 0, name: "Captain Nemo", sessionId: null }];
    const secondMates = [
      { secondMateId: "p1", firstMateId: "m0", name: "helm", sessionId: null, status: "proposed", brief: "fix the fleet proposals", crew: [] },
      { secondMateId: "p2", firstMateId: "m0", name: "jot", sessionId: null, status: "proposed", brief: "schema migration", crew: [] },
    ];
    const slot = document.getElementById("dashFleetSlot");
    slot.replaceChildren(dashboardFleetSection(mates, secondMates));
    const banner = slot.querySelector(".fleet-proposals");
    const chips = slot.querySelectorAll(".fleet-proposal-chip");
    const label = banner ? banner.querySelector(".fleet-proposals-label").textContent : "";
    if (chips[0]) { chips[0].click(); }
    return { hasBanner: !!banner, chipCount: chips.length, label, engaged: window.__engaged && window.__engaged.name };
  })()`);

  assert(out.hasBanner, "the proposals banner renders at the top of the fleet");
  assert(out.chipCount === 2, `one chip per proposed topic (got ${out.chipCount})`);
  assert(/2 topics proposed/i.test(out.label), `the banner counts the proposals (got "${out.label}")`);
  assert(out.engaged === "helm", `clicking a chip engages that proposal (got ${out.engaged})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: proposals surface at the top of the fleet, one-click engage." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
