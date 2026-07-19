// E2E (deterministic, no API turns): renderPane coalescing (task f41a7f4e -
// "input lags when Helm is working on something else"). renderPane does a full
// transcript rebuild and used to fire synchronously on every streaming assistant
// event; scheduleRenderPane now coalesces a burst within one frame to a SINGLE
// rebuild and defers it (yielding the main thread to input between frames).
// Exercised in the real loaded renderer via CDP eval by spying on renderPane.
//
// Run:  node scripts/e2e/test-render-coalesce.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[render-coalesce-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-coalesce-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const r = await app.eval(`(async () => {
    // Wait past the coalescing task. setTimeout (NOT rAF) - rAF is throttled when
    // the window is hidden/occluded, which both stalls the fix and would hang this
    // test in a background E2E window.
    const settle = () => new Promise((res) => setTimeout(res, 20));
    // Spy: count actual renderPane executions by wrapping the global.
    const orig = renderPane;
    let calls = 0;
    renderPane = (...a) => { calls += 1; return orig(...a); };
    try {
      // 1) A burst of 10 scheduled renders for the same pane collapses to 1.
      calls = 0;
      for (let i = 0; i < 10; i++) { scheduleRenderPane(0); }
      const duringBurst = calls; // still 0 - nothing ran synchronously
      await settle();
      const afterBurst = calls; // exactly 1 rebuild for the whole burst
      // 2) A separate later burst renders again (not permanently suppressed).
      calls = 0;
      for (let i = 0; i < 5; i++) { scheduleRenderPane(0); }
      await settle();
      const secondBurst = calls;
      // 3) A direct renderPane cancels a pending scheduled one (no double-run).
      calls = 0;
      scheduleRenderPane(0);
      renderPane(0);            // direct - should supersede the pending task
      const afterDirect = calls; // 1 (the direct call)
      await settle();
      const afterDirectSettled = calls; // still 1 - the pending task was cancelled
      // 4) Two different panes each get their own coalesced render.
      calls = 0;
      scheduleRenderPane(0); scheduleRenderPane(1); scheduleRenderPane(0); scheduleRenderPane(1);
      await settle();
      const twoPanes = calls; // 2 (one per pane)
      return { duringBurst, afterBurst, secondBurst, afterDirect, afterDirectSettled, twoPanes };
    } finally {
      renderPane = orig;
    }
  })()`);

  assert(r.duringBurst === 0, `a burst of scheduled renders does NOT run synchronously (got ${r.duringBurst})`);
  assert(r.afterBurst === 1, `10 scheduled renders in one frame collapse to exactly 1 rebuild (got ${r.afterBurst})`);
  assert(r.secondBurst === 1, `a later burst still renders (coalescing isn't a permanent latch) (got ${r.secondBurst})`);
  assert(r.afterDirect === 1, `a direct renderPane runs immediately (got ${r.afterDirect})`);
  assert(r.afterDirectSettled === 1, `a direct renderPane cancels the pending scheduled one (no double-run) (got ${r.afterDirectSettled})`);
  assert(r.twoPanes === 2, `two different panes each coalesce to their own single render (got ${r.twoPanes})`);

  log(exitCode === 0 ? "VERIFY OK: streaming renders coalesce per-pane onto a frame (1 rebuild per burst) and defer, freeing the main thread for input (f41a7f4e)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
