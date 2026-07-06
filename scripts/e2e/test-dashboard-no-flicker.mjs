// E2E: the dashboard does NOT rebuild on an unchanged poll tick (the flicker
// bug). renderDashboardPage does innerHTML="" + full rebuild; the 30s timer
// used to call it unconditionally, so the page flickered while idle. The fix
// gates it behind the same fingerprint the sidebar uses. This proves: an
// unchanged refresh() leaves the rendered DOM intact (a tagged child survives),
// but a real change still rebuilds it (the tag is gone). Real launched Maestro.
//
// Run:  node scripts/e2e/test-dashboard-no-flicker.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dashboard-no-flicker-e2e]", ...a);
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
const hasSentinel = () => app.eval(`!!document.querySelector("#dashboardPage [data-e2e-sentinel]")`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof refresh === "function" && typeof renderDashboardPage === "function"`)) {
      break;
    }
    await wait(100);
  }

  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });

  // Let one refresh settle so lastDashboardFingerprint is synced to current
  // state and the page is fully rendered.
  await app.eval(`refresh()`);
  await wait(900);
  const hadChild = await app.eval(`!!document.querySelector("#dashboardPage").firstElementChild`);
  assert(hadChild, "dashboard rendered content to tag");

  // Tag the current DOM. innerHTML="" on a rebuild would destroy this.
  await app.eval(`document.querySelector("#dashboardPage").firstElementChild.setAttribute("data-e2e-sentinel", "1")`);
  assert(await hasSentinel(), "sentinel attached to the live dashboard DOM");

  // Unchanged refresh - the gate should skip the rebuild, so the sentinel survives.
  await app.eval(`refresh()`);
  await wait(900);
  assert(await hasSentinel(), "an unchanged refresh() does NOT rebuild the dashboard (no flicker)");

  // Force the gate to see a change (bogus stored fingerprint) - it must rebuild,
  // destroying the sentinel. Proves the fix didn't just freeze the dashboard.
  await app.eval(`lastDashboardFingerprint = "e2e-forced-mismatch"`);
  await app.eval(`refresh()`);
  await wait(900);
  assert(!(await hasSentinel()), "a changed refresh() DOES rebuild the dashboard (still live)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: dashboard rebuilds on change, stays put when idle." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
