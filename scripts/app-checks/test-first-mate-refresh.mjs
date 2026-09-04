// E2E: the first-mate refresh pipe - when a first-mate session's context gauge
// crosses the threshold AND it's idle (not mid-task), a one-click "hand off to
// a fresh one" nudge appears. Hidden mid-task, and never shown for a normal
// (non-first-mate) session. Real launched Helm.
//
// Run:  node scripts/e2e/test-first-mate-refresh.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[first-mate-refresh-e2e]", ...a);
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

// Build a pane via openFreshDraftInPane, set it saturated + idle, re-render the
// gauge, and return whether the handoff nudge is visible + its text.
const renderPaneGauge = (overrides, paneMutations) =>
  app.eval(`(() => {
    openFreshDraftInPane("D:/Repo/Tools/helm", "t", ${JSON.stringify(overrides)});
    const p = panes.find(p => p && p.els && ${overrides.paneOverrides?.isOrchestrator ? "p.isOrchestrator" : "!p.isOrchestrator"});
    if (!p) return "no-pane";
    Object.assign(p, ${JSON.stringify(paneMutations)});
    p.els.renderContextGauge();
    const el = document.querySelector(".first-mate-handoff");
    return { hidden: el ? el.classList.contains("hidden") : true, text: el ? el.textContent : "" };
  })()`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof openFreshDraftInPane === "function"`)) {
      break;
    }
    await wait(100);
  }

  // First mate, saturated (huge context), idle -> nudge shows.
  const r1 = await renderPaneGauge(
    { paneOverrides: { isOrchestrator: true, modelDefault: "claude-sonnet-5" } },
    { sessionId: "s-fm", contextTokens: 9999999, busy: false }
  );
  assert(r1 && r1.hidden === false, "handoff nudge shows for a saturated, idle first mate");
  assert(/hand off/.test(r1.text || ""), "the nudge offers to hand off");

  // Same first mate but mid-task (busy) -> hidden (sensible-moment rule).
  const r2 = await app.eval(`(() => {
    const p = panes.find(p => p && p.isOrchestrator && p.els);
    p.busy = true; p.els.renderContextGauge();
    const el = document.querySelector(".first-mate-handoff");
    return el ? el.classList.contains("hidden") : true;
  })()`);
  assert(r2 === true, "the nudge hides while the first mate is mid-task (busy)");

  // A normal (non-first-mate) saturated session -> never shows the nudge.
  const r3 = await renderPaneGauge({}, { sessionId: "s-plain", contextTokens: 9999999, busy: false });
  assert(r3 && r3.hidden === true, "a normal session never gets the first-mate handoff nudge");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: first-mate refresh nudge appears when full+idle, hides mid-task, off for normal sessions." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
