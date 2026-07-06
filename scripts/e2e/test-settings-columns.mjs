// E2E: the Settings groups render in a two-column layout at desktop width
// (Passive in the left column; Acts + Voice in the right), collapsing logic via
// CSS media query. Real launched Maestro via CDP at a wide viewport.
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

  // The container is a grid, and the two columns actually render SIDE BY SIDE
  // at desktop width (same top, second column to the right of the first) -
  // the real proof of a two-column layout, robust to how the browser reports
  // the computed grid-template-columns value.
  const grid = await app.eval(`(() => {
    const settingsHidden = document.getElementById("settingsPage").classList.contains("hidden");
    const el = document.querySelector("#settingsPage .settings-columns");
    const cols = el.querySelectorAll(".settings-col");
    const a = cols[0].getBoundingClientRect();
    const b = cols[1].getBoundingClientRect();
    return JSON.stringify({
      settingsHidden,
      display: getComputedStyle(el).display,
      aW: Math.round(a.width), bW: Math.round(b.width),
      sameRow: Math.abs(a.top - b.top) < 4,
      sideBySide: b.left > a.right - 4,
      aRight: Math.round(a.right), bLeft: Math.round(b.left),
    });
  })()`);
  const g = JSON.parse(grid);
  log("grid:", grid);
  assert(!g.settingsHidden, "settings page is visible");
  assert(g.display === "grid", ".settings-columns is a grid");
  assert(g.aW > 100 && g.bW > 100, `both columns have real width (a=${g.aW}, b=${g.bW})`);
  assert(g.sameRow && g.sideBySide, `the two columns render side by side at desktop width (aRight=${g.aRight}, bLeft=${g.bLeft})`);

  // Left column holds the Passive group; right holds Acts + Voice.
  const layout = await app.eval(`(() => {
    const cols = document.querySelectorAll("#settingsPage .settings-col");
    const headings = (col) => [...col.querySelectorAll(".settings-group-heading")].map(h => h.textContent);
    return JSON.stringify({ nCols: cols.length, left: headings(cols[0]), right: headings(cols[1]) });
  })()`);
  const l = JSON.parse(layout);
  log("layout:", layout);
  assert(l.nCols === 2, "two .settings-col columns");
  assert(l.left.some((h) => /Passive/.test(h)), "left column has the Passive group");
  assert(l.right.some((h) => /Acts on your data/.test(h)) && l.right.some((h) => /Voice/.test(h)), "right column has Acts + Voice groups");

  // Nothing lost: still 3 groups, all 6 toggles.
  const groups = await app.eval(`document.querySelectorAll("#settingsPage .settings-group").length`);
  const toggles = await app.eval(`document.querySelectorAll("#settingsPage .settings-toggle-row").length`);
  assert(groups === 3, `all 3 groups present (got ${groups})`);
  assert(toggles === 6, `all 6 toggles present (got ${toggles})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: settings groups in a balanced two-column layout." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
