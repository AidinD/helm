// Demo / verification for the Electron E2E harness (harness.mjs).
//
// Proves the harness works end to end against Maestro:
//   1. launch Maestro with remote debugging
//   2. wait for the main UI (#pageToggle)
//   3. screenshot the dashboard (chat page)
//   4. click the "Focus" facet in the dashboard sub-nav
//   5. wait for #focusPage to become visible, screenshot again
//   6. read any console errors
//   7. clean shutdown (only the launched instance is killed)
//
// Run:  node scripts/e2e/demo.mjs
// Screenshots land in scripts/e2e/screenshots/.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { launch } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "screenshots");
const shot1 = path.join(outDir, "01-dashboard.png");
const shot2 = path.join(outDir, "02-focus.png");

function log(...a) {
  console.log("[demo]", ...a);
}

const app = await launch();
let exitCode = 0;
try {
  log("launched Maestro; waiting for main UI…");
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  log("main UI ready.");

  // The chat page should be the default active page.
  const activeTab = await app.getText("#pageToggle button.active");
  log("active tab on load:", JSON.stringify(activeTab));

  const size1 = await app.screenshot(shot1);
  log(`screenshot 1 (dashboard): ${shot1} — ${size1} bytes`);

  log('clicking the "Focus" facet in the dashboard sub-nav…');
  await app.click('#dashboardSubnav button[data-page="focus"]');
  await app.waitForSelector("#focusPage", 10000, { visible: true });
  const nowActive = await app.getText("#dashboardSubnav button.active");
  log("active tab after click:", JSON.stringify(nowActive));

  const size2 = await app.screenshot(shot2);
  log(`screenshot 2 (focus):     ${shot2} — ${size2} bytes`);

  const errors = app.getConsoleErrors();
  const allConsole = app.getConsole();
  log(`console messages collected: ${allConsole.length} (errors: ${errors.length})`);
  if (errors.length) {
    for (const e of errors) {
      log("  console error:", e.text);
    }
  }

  // Independent proof the PNGs are real and non-trivial.
  const s1 = statSync(shot1).size;
  const s2 = statSync(shot2).size;
  const bothReal = s1 > 5000 && s2 > 5000;
  log(`PNG on disk: ${s1} + ${s2} bytes — ${bothReal ? "OK" : "TOO SMALL"}`);

  const focusReached = nowActive === "Focus";
  if (!bothReal || !focusReached) {
    exitCode = 1;
    log("VERIFY FAILED:", { bothReal, focusReached });
  } else {
    log("VERIFY OK: two real screenshots, Focus tab reached, console read.");
  }
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  log("shutting down (killing only the launched instance)…");
  const killOut = await app.close();
  log("cleanup output:", killOut || "(nothing killed)");
}

process.exit(exitCode);
