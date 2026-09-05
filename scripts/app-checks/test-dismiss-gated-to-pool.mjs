// A first-mate widget's "Dismiss ... from the fleet" action, and its title, must be
// gated to POOL mates only.
//
// Review finding: the add menu (and the "seat widget keeps its seat" fix) now writes
// `type: "firstMate"` widgets for the standing assistant seat and project seats too,
// not only for numbered pool coordinators. The widget options menu offered "Dismiss
// <name> from the fleet" for ANY firstMate widget with a mateId, with no check that
// the mateId is actually a pool mate. Clicking it on a standing/project seat calls
// window.helm.removeMate, which tears down that seat's real second-mate/crew work
// (tearDownSecondMatesFor) but never removes the seat itself (retireMateSlot is a
// no-op for a seat with slot: null) - a false "X left the fleet" toast, the widget
// gone, the seat unchanged, its subordinate work permanently destroyed.
//
// Same root cause hit the widget title: it looked the shown name up in data.mates
// only, so a standing/project-seat widget rendered a generic "First mate" title
// instead of "First mate · <name>".
//
// Both must look up (and gate on) the SEAT set, not the pool: title via
// everySeatIn(data), and the Dismiss item only when the mateId is present in
// data.mates specifically.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-dismiss-gated-to-pool.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[dismiss-gated-to-pool]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-dismissgate-"));
const metaHome = path.join(tmp, "meta-home");
const projectA = path.join(tmp, "Repo", "Alpha");
for (const d of [metaHome, projectA]) {
  fs.mkdirSync(d, { recursive: true });
}

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const seats = await app.eval(`(async () => {
    await window.helm.ensureSeatForProject(${JSON.stringify(projectA)});
    const listed = await window.helm.listMates();
    return {
      standingId: listed?.assistant?.mateId || null,
      standingName: listed?.assistant?.name || null,
      projectId: (listed?.projects || [])[0]?.mateId || null,
      projectName: (listed?.projects || [])[0]?.name || null,
      poolId: (listed?.active || [])[0]?.mateId || null,
      poolName: (listed?.active || [])[0]?.name || null,
    };
  })()`);
  log(JSON.stringify(seats));

  // The control: every id/name must exist, or a later "menu item is absent" assertion
  // could pass for the wrong reason (nothing was ever rendered).
  assert(!!seats.standingId, `there is a standing seat (${seats.standingName})`);
  assert(!!seats.projectId, `and a project seat (${seats.projectName})`);
  assert(!!seats.poolId, `and a pool mate to contrast against (${seats.poolName})`);

  await app.eval(`navigateToPage("dashboard")`);
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  // One firstMate-typed widget per seat kind: standing, project, and pool.
  const layout = await app.eval(`(async () => {
    const layout = [
      { id: "w-standing", type: "firstMate", span: 4, mateId: ${JSON.stringify(seats.standingId)} },
      { id: "w-project", type: "firstMate", span: 4, mateId: ${JSON.stringify(seats.projectId)} },
      { id: "w-pool", type: "firstMate", span: 4, mateId: ${JSON.stringify(seats.poolId)} },
    ];
    await saveWidgetLayout(layout);
    await renderDashboardPage();
    return (state.config?.dashboardWidgets?.layout || []).map((w) => ({ id: w.id, mateId: w.mateId }));
  })()`);
  log(JSON.stringify(layout));

  // Guard against rebind adopting one of these away before the menu is even opened.
  assert(
    layout.some((w) => w.id === "w-standing" && w.mateId === seats.standingId) &&
      layout.some((w) => w.id === "w-project" && w.mateId === seats.projectId) &&
      layout.some((w) => w.id === "w-pool" && w.mateId === seats.poolId),
    "all three widgets kept their bindings through the render (precondition for the checks below)"
  );

  async function titleAndMenuFor(widgetId) {
    return app.eval(`(async () => {
      const card = document.querySelector('.wd[data-widget-id="${widgetId}"]');
      const title = card?.querySelector(".wd-title")?.textContent || null;
      card?.querySelector(".wd-opts")?.click();
      await new Promise((r) => setTimeout(r, 250));
      const items = [...document.querySelectorAll("#contextMenu .item")].map((e) => (e.textContent || "").trim());
      document.getElementById("contextMenu").classList.add("hidden");
      return { title, items };
    })()`);
  }

  const standing = await titleAndMenuFor("w-standing");
  log("standing:", JSON.stringify(standing));
  assert(
    standing.title === `First mate · ${seats.standingName}`,
    `the standing-seat widget's title names the seat, not a generic "First mate" (got "${standing.title}")`
  );
  assert(
    !standing.items.some((t) => /Dismiss .* from the fleet/.test(t)),
    `the standing seat's options menu does NOT offer "Dismiss ... from the fleet" (got ${JSON.stringify(standing.items)})`
  );

  const project = await titleAndMenuFor("w-project");
  log("project:", JSON.stringify(project));
  assert(
    project.title === `First mate · ${seats.projectName}`,
    `the project-seat widget's title names the seat (got "${project.title}")`
  );
  assert(
    !project.items.some((t) => /Dismiss .* from the fleet/.test(t)),
    `the project seat's options menu does NOT offer "Dismiss ... from the fleet" (got ${JSON.stringify(project.items)})`
  );

  const pool = await titleAndMenuFor("w-pool");
  log("pool:", JSON.stringify(pool));
  assert(
    pool.title === `First mate · ${seats.poolName}`,
    `the pool widget's title names the mate too (got "${pool.title}")`
  );
  assert(
    pool.items.some((t) => /Dismiss .* from the fleet/.test(t)),
    `a REAL pool mate's options menu still offers "Dismiss ... from the fleet" - the gate must not over-hide it (got ${JSON.stringify(pool.items)})`
  );

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
} catch (err) {
  exitCode = 1;
  log("ERROR:", err?.message || err);
} finally {
  try {
    await app?.close();
  } catch {
    // a close failure must not turn a passing check red
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log(
  exitCode === 0
    ? "VERIFY OK - Dismiss-from-the-fleet and the widget title are gated to real pool mates"
    : "VERIFY FAILED"
);
process.exit(exitCode);
