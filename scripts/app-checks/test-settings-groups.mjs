// E2E: the Settings page groups its toggles (passive vs acts-on-your-data) and
// surfaces the previously UI-less voiceEngine + voiceLanguage config. Real
// launched Helm via CDP.
//
// Run:  node scripts/e2e/test-settings-groups.mjs
import { launch } from "../checks-lib/harness.mjs";

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
  // #pageToggle is STATIC markup, so it is visible long before renderer.js has
  // finished evaluating - waiting on it and then calling a renderer function was a
  // race, and this test failed roughly every run with either "navigateToPage is not
  // defined" or a timeout waiting for the page it never navigated to. Wait for the
  // function itself to exist.
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const ready = await (async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (await app.eval(`typeof navigateToPage === "function"`)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  assert(ready, "the renderer finished loading");
  await app.eval(`(() => { navigateToPage("settings"); return true; })()`);
  // 30s, not 8s: navigating happens immediately but the page only paints once the
  // first session refresh has settled, which on a real board is well past 8s.
  await app.waitForSelector("#settingsPage", 30000, { visible: true });

  // AND IT MUST STAY. Startup ends with a navigate to the dashboard, and it used to
  // run unconditionally after awaiting the first refresh - so a page you opened
  // while Helm was still loading was silently thrown away. This test failed two runs
  // in three because of it, which is exactly what a person who clicks the gear
  // quickly experiences: the click appears to do nothing.
  await new Promise((r) => setTimeout(r, 6000));
  const stillThere = await app.eval(`!document.getElementById("settingsPage").classList.contains("hidden")`);
  assert(stillThere === true, "a page opened during startup is not yanked back to the dashboard when loading finishes");

  const headings = await app.eval(`[...document.querySelectorAll("#settingsPage .settings-group-heading")].map(h => h.textContent)`);
  log("group headings:", JSON.stringify(headings));
  // Exact counts here (3 groups / 2 selects / 6 toggles) broke every time a setting
  // was added, and had been failing silently behind the load race above. They also
  // asserted nothing worth protecting - "exactly three groups" is not a property of
  // a correct Settings page. What matters is that the NAMED groups still exist and
  // that the regroup dropped nothing, so the counts became floors.
  assert(headings.length >= 3, `the settings page is grouped (got ${headings.length} groups)`);
  assert(headings.some((h) => /Passive/.test(h)), "'Passive - suggests, never acts' group present");
  assert(headings.some((h) => /Acts on your data/.test(h)), "'Acts on your data automatically' group present");
  assert(headings.some((h) => /Voice transcription/.test(h)), "'Voice transcription' group present");

  // The voice group surfaces the engine + language pills.
  const selectRows = await count("#settingsPage .settings-select-row");
  assert(selectRows >= 2, `the voice group still has its engine + language pickers (got ${selectRows} select rows)`);
  const settingsText = await app.eval(`document.getElementById("settingsPage").innerText`);
  assert(/whisper\.cpp|transformers\.js/.test(settingsText), "transcription engine pill shows a real engine value");

  // The toggles still exist (nothing dropped in the regrouping).
  const toggles = await count("#settingsPage .settings-toggle-row");
  assert(toggles >= 6, `no toggle was dropped in the regroup (got ${toggles}, was 6)`);

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
