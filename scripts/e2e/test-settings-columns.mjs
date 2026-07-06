// E2E: each Settings group is its own column at desktop width (auto-fit grid) -
// Passive | Acts | Voice side by side, headings top-aligned - so no group is
// stacked awkwardly under another. Real launched Maestro via CDP at a wide
// viewport. Collapses to fewer columns on a narrow window (auto-fit, no assert).
//
// Run:  node scripts/e2e/test-settings-columns.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[settings-columns-e2e]", ...a);
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
  await app.eval(`(() => { navigateToPage("settings"); return true; })()`);
  await app.waitForSelector("#settingsPage .settings-columns", 8000);

  const info = await app.eval(`(() => {
    const el = document.querySelector("#settingsPage .settings-columns");
    const groups = [...el.querySelectorAll(":scope > .settings-group")];
    const rows = groups.map((g) => {
      const r = g.getBoundingClientRect();
      return { heading: g.querySelector(".settings-group-heading")?.textContent || "", top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) };
    });
    return JSON.stringify({ display: getComputedStyle(el).display, nGroups: groups.length, rows });
  })()`);
  const g = JSON.parse(info);
  log("layout:", info);

  assert(g.display === "grid", ".settings-columns is a grid");
  assert(g.nGroups === 3, `three groups as direct grid columns (got ${g.nGroups})`);
  assert(g.rows.every((r) => r.w > 100), "each group column has real width");

  // Side by side: all three share (about) the same top and have increasing left.
  const [a, b, c] = g.rows;
  const sameTop = Math.abs(a.top - b.top) < 4 && Math.abs(b.top - c.top) < 4;
  const increasingLeft = a.left < b.left && b.left < c.left;
  assert(sameTop, `all three group headings are top-aligned on one row (tops ${a.top}/${b.top}/${c.top})`);
  assert(increasingLeft, `columns are ordered left-to-right (lefts ${a.left}/${b.left}/${c.left})`);

  // Correct order: Passive, then Acts, then Voice.
  assert(/Passive/.test(a.heading), "first column is Passive");
  assert(/Acts on your data/.test(b.heading), "second column is Acts on your data");
  assert(/Voice/.test(c.heading), "third column is Voice transcription");

  const toggles = await app.eval(`document.querySelectorAll("#settingsPage .settings-toggle-row").length`);
  assert(toggles === 6, `all 6 toggles preserved (got ${toggles})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: each settings group is its own top-aligned column." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
