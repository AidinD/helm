// E2E: EVERY Settings group is its own column at desktop width - side by side,
// headings top-aligned on one row, in source order, each with real width - so no
// group is stacked awkwardly under another. Real launched Helm via CDP at a wide
// viewport. Collapses to fewer columns on a narrow window (no assert).
//
// Deliberately count-free: the expected number of groups and toggles is DERIVED
// from what the page renders (every .settings-group-heading must top a column;
// every .settings-toggle-row must live inside one), never hardcoded. The old
// version asserted "3 groups" and "6 toggles" and went red the day a fourth group
// (Appearance, the theme system) shipped - drift in the test, not a regression in
// the page. Nor does it assert which CSS mechanism makes the columns (it was grid,
// it is flex now): the alignment + ordering assertions already prove the layout.
//
// Run:  node scripts/e2e/test-settings-columns.mjs
import { launch } from "../checks-lib/harness.mjs";

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
    const page = document.getElementById("settingsPage");
    const el = page.querySelector(".settings-columns");
    // The columns, in DOM (= source) order.
    const groups = [...el.querySelectorAll(":scope > .settings-group")];
    const columns = groups.map((g) => {
      const r = g.getBoundingClientRect();
      return {
        heading: g.querySelector(".settings-group-heading")?.textContent || "",
        top: Math.round(r.top),
        left: Math.round(r.left),
        w: Math.round(r.width),
        // Any control counts - a group may be toggles, selects, or both.
        controls: g.querySelectorAll(".settings-toggle-row, .settings-select-row").length,
      };
    });
    // Everything the page defines, so the expectations come from the page itself.
    const isInAColumn = (node) => groups.some((g) => g.contains(node));
    const headings = [...page.querySelectorAll(".settings-group-heading")];
    const toggles = [...page.querySelectorAll(".settings-toggle-row")];
    return JSON.stringify({
      display: getComputedStyle(el).display,
      columns,
      headings: headings.length,
      headingsInColumns: headings.filter(isInAColumn).length,
      toggles: toggles.length,
      togglesInColumns: toggles.filter(isInAColumn).length,
    });
  })()`);
  const g = JSON.parse(info);
  log("layout:", info);

  // A floor, not an exact count: below two there is no column layout left to
  // verify and every "every column ..." assertion below would pass vacuously.
  assert(g.columns.length >= 2, `at least two group columns (got ${g.columns.length})`);

  // Derived counts: whatever the page defines must ALL be in the column layout.
  assert(
    g.headings === g.headingsInColumns && g.headings === g.columns.length,
    `every settings group the page renders tops its own column (${g.headingsInColumns}/${g.headings} headings, ${g.columns.length} columns)`
  );
  assert(
    g.toggles > 0 && g.toggles === g.togglesInColumns,
    `every toggle the page renders sits inside a column (${g.togglesInColumns}/${g.toggles})`
  );
  assert(
    g.columns.every((c) => c.controls > 0),
    "no column is empty - each has at least one toggle or select row"
  );
  assert(g.columns.every((c) => c.heading.trim().length > 0), "every column has a heading");
  assert(g.columns.every((c) => c.w > 100), "each group column has real width");

  // Side by side: all columns share (about) the same top - one row, nothing
  // stacked - and their lefts increase in DOM order, i.e. visual order == source
  // order.
  const tops = g.columns.map((c) => c.top);
  const lefts = g.columns.map((c) => c.left);
  const sameTop = tops.every((t) => Math.abs(t - tops[0]) < 4);
  const increasingLeft = lefts.every((l, i) => i === 0 || lefts[i - 1] < l);
  assert(sameTop, `all group headings are top-aligned on one row (tops ${tops.join("/")})`);
  assert(
    increasingLeft,
    `columns run left-to-right in source order (${g.columns.map((c) => `${c.heading.trim()}@${c.left}`).join(", ")})`
  );

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: every settings group is its own top-aligned column." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
