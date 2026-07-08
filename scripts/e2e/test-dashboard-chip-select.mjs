// E2E: picking a project chip in the Dashboard's "New session" panel must
// NOT tear down and rebuild the whole dashboard page. dashChipEl used to call
// renderDashboardPage() (page.innerHTML = "" + full rebuild) on every chip
// click - felt like "I click a chip near the bottom and land back at the top
// of the dashboard". Fixed to call fillDashboardSections() (targeted slot
// repaint) instead.
//
// Asserted via a marker element planted as a direct child of #dashboardPage:
// a full rebuild wipes it (innerHTML=""), a targeted slot repaint does not.
// scrollTop itself is NOT a reliable signal here - real dashboard content can
// be tall enough on its own to keep scrollTop numerically valid after a
// rebuild, masking the regression this test exists to catch.
//
// The duplicate-repo domain guard and the domain remove control (both added
// alongside this fix) go through native OS dialogs (pickDomainFolder) that
// CDP cannot drive, so they are exercised manually rather than here - see
// DECISIONS.md.
//
// Run:  node scripts/e2e/test-dashboard-chip-select.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dashboard-chip-e2e]", ...a);
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
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  await app.waitForSelector(".dash-chip-grid .dash-chip", 8000);

  // Plant a marker as a direct child of #dashboardPage - survives a targeted
  // slot repaint, gets wiped by a full page.innerHTML rebuild.
  await app.eval(`(() => {
    const page = document.getElementById("dashboardPage");
    const marker = document.createElement("div");
    marker.id = "__e2e_marker";
    page.appendChild(marker);
    return !!document.getElementById("__e2e_marker");
  })()`);

  const clicked = await app.eval(`(() => {
    const chip = [...document.querySelectorAll(".dash-chip-grid .dash-chip")].find(c => !c.textContent.includes("+ other") && !c.textContent.includes("+ new domain"));
    if (!chip) return null;
    chip.click();
    return chip.textContent;
  })()`);
  log("clicked chip:", clicked);
  assert(!!clicked, "a real project chip exists and was clicked");

  // Let the async click handler's fillDashboardSections() settle.
  await new Promise((r) => setTimeout(r, 300));

  const markerSurvived = await app.eval(`!!document.getElementById("__e2e_marker")`);
  assert(markerSurvived, "the dashboard page is NOT fully torn down and rebuilt on a chip click (marker survived)");

  const selectedClass = await app.eval(`(() => {
    const sel = document.querySelector(".dash-chip-grid .dash-chip-selected");
    return sel ? sel.textContent : null;
  })()`);
  assert(selectedClass === clicked, `the clicked chip is marked selected (got ${JSON.stringify(selectedClass)})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: chip selection preserves scroll position." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
