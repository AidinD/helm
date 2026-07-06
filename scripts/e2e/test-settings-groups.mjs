// E2E: the Settings page groups its toggles (passive vs acts-on-your-data) and
// surfaces the previously UI-less voiceEngine + voiceLanguage config. Real
// launched Maestro via CDP.
//
// Run:  node scripts/e2e/test-settings-groups.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[settings-groups-e2e]", ...a);
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
  await app.eval(`(() => { navigateToPage("settings"); return true; })()`);
  await app.waitForSelector("#settingsPage", 8000, { visible: true });

  const headings = await app.eval(`[...document.querySelectorAll("#settingsPage .settings-group-heading")].map(h => h.textContent)`);
  log("group headings:", JSON.stringify(headings));
  assert(headings.length === 3, `three settings groups (got ${headings.length})`);
  assert(headings.some((h) => /Passive/.test(h)), "'Passive - suggests, never acts' group present");
  assert(headings.some((h) => /Acts on your data/.test(h)), "'Acts on your data automatically' group present");
  assert(headings.some((h) => /Voice transcription/.test(h)), "'Voice transcription' group present");

  // The voice group surfaces the engine + language pills.
  const selectRows = await count("#settingsPage .settings-select-row");
  assert(selectRows === 2, `two select rows (engine + language) in the voice group (got ${selectRows})`);
  const settingsText = await app.eval(`document.getElementById("settingsPage").innerText`);
  assert(/whisper\.cpp|transformers\.js/.test(settingsText), "transcription engine pill shows a real engine value");

  // The toggles still exist (nothing dropped in the regrouping).
  const toggles = await count("#settingsPage .settings-toggle-row");
  assert(toggles === 6, `all 6 toggles preserved across the regroup (got ${toggles})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: settings grouped + voice config surfaced." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
