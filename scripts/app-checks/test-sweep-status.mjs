// E2E: the Settings page shows a background-sweep liveness readout, backed by
// the new orchestrator:sweepStatus IPC. Real launched Helm via CDP.
//
// Run:  node scripts/e2e/test-sweep-status.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[sweep-status-e2e]", ...a);
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

  // The IPC resolves with the expected shape.
  const shape = await app.eval(`(async () => { const s = await window.helm.getSweepStatus(); return JSON.stringify({ keys: Object.keys(s || {}).sort() }); })()`);
  log("sweepStatus shape:", shape);
  const keys = JSON.parse(shape).keys;
  assert(["classifiedCount", "error", "lastRunAt", "ok"].every((k) => keys.includes(k)), "getSweepStatus resolves with { lastRunAt, ok, classifiedCount, error }");

  // Settings shows the readout line (resolves async after a beat).
  await app.eval(`(() => { navigateToPage("settings"); return true; })()`);
  await app.waitForSelector("#settingsPage .settings-sweep-status", 8000);
  // Give the single .then() a moment to resolve the text.
  await app.waitForSelector("#pageToggle", 1000, { visible: true }).catch(() => {});
  const text = await app.eval(`document.querySelector("#settingsPage .settings-sweep-status")?.textContent || ""`);
  log("readout text:", JSON.stringify(text));
  assert(/^Background sweep:/.test(text), "Settings shows a 'Background sweep:' liveness line");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: sweep liveness readout wired end to end." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
