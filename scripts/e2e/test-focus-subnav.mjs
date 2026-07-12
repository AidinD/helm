// E2E: Focus is a first-class dashboard sub-nav tab now, so the captain can't
// get stranded there after clicking through from a goal card (flow P2). Asserts
// the button exists, navigating lights it, and the focus page shows.
//
// Run:  node scripts/e2e/test-focus-subnav.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[focus-subnav-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Click the button (via the delegated data-page handler) and read the result
  // in the SAME eval, so the boot's own navigateToPage("dashboard") or a refresh
  // tick can't re-navigate in the gap between separate evals.
  const out = await app.eval(`(() => {
    const btn = document.querySelector('#dashboardSubnav button[data-page="focus"]');
    if (!btn) { return { hasBtn: false }; }
    btn.click();
    const dash = document.querySelector('#pageToggle button[data-page="dashboard"]');
    return {
      hasBtn: true,
      focusActive: btn.classList.contains("active"),
      focusShown: !document.getElementById("focusPage").classList.contains("hidden"),
      dashLit: dash ? dash.classList.contains("active") : false,
    };
  })()`);
  assert(out.hasBtn, "the Focus sub-nav button exists");
  assert(out.focusActive, "the Focus button is highlighted while on Focus");
  assert(out.focusShown, "the focus page is visible");
  assert(out.dashLit, "the primary Dashboard tab stays lit on Focus");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Focus is a reachable, highlighted sub-nav tab." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
