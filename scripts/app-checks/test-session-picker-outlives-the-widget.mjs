// The "+ Session" picker is on the dashboard itself, not inside the captain widget.
//
// WHY THIS IS A CHECK AND NOT A TIDY-UP. Picking a project in that menu is what opens the
// project's seat (the captain, 2026-09-04: "utlosaren ar nar jag valjer projekt i + Session"). Stage
// 4 removes the captain widget. Leaving the picker inside it would delete the only way to open
// a project on the same commit that makes project seats the way you work - so the picker moves
// first, is verified here, and only then does the widget go.
//
// ASSERTED THROUGH THE RENDERED PAGE, not the source, because the point is that a person can
// click it. A source scan would say the code exists; it would not say the button reached the
// screen, which is the whole property.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-session-picker-outlives-the-widget.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[session-picker]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-picker-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  await app.eval(`navigateToPage("dashboard")`);
  // Wait for the grid rather than calling the render directly: navigateToPage starts its own
  // render, and a second concurrent call bails on the newer token - which reads as an empty
  // dashboard when the page is in fact about to draw.
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  const res = await app.eval(`(async () => {
    const page = document.getElementById("dashboardPage") || document.querySelector(".wd-grid")?.parentElement;
    const all = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "+ Session");
    const grid = document.querySelector(".wd-grid");
    return {
      count: all.length,
      // Outside the widget grid = on the page's own topbar, which is what survives the cut.
      outsideGrid: all.filter((b) => !grid || !grid.contains(b)).length,
      insideGrid: all.filter((b) => grid && grid.contains(b)).length,
      insideCaptainCard: all.filter((b) => !!b.closest(".fleet-mate-card")).length,
      hasGrid: !!grid,
      pageFound: !!page,
      // A menu with no items would be a button that looks fine and does nothing.
      menuItems: (await newSessionFolderMenuItems()).length,
    };
  })()`);
  log(JSON.stringify(res));

  assert(res.hasGrid, "the dashboard rendered its widget grid");
  assert(res.count === 1, `exactly one "+ Session" button on the page (${res.count})`);
  assert(res.outsideGrid === 1, `and it is outside the widget grid, on the page itself (${res.outsideGrid})`);
  assert(res.insideGrid === 0, `with none left inside a widget (${res.insideGrid})`);
  assert(
    res.insideCaptainCard === 0,
    `and none inside the captain card that stage 4 deletes (${res.insideCaptainCard})`
  );
  // The button has to DO something. A moved control that opens an empty menu is the failure
  // that would otherwise pass every structural assertion above.
  assert(res.menuItems > 0, `its menu offers somewhere to go (${res.menuItems} items)`);
} catch (err) {
  exitCode = 1;
  log("ERROR:", err?.message || err);
} finally {
  try {
    await app?.close();
  } catch {
    // A close failure must not turn a passing check red.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (exitCode !== 0) {
  console.log("VERIFY FAILED");
} else {
  console.log("VERIFY OK - the project picker is on the dashboard and survives the removal of the captain widget");
}
process.exit(exitCode);
