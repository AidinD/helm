// A seat opened against a repository can be put on the board, and its widget names that repo.
//
// WHY THIS HAS TO EXIST BEFORE THE CAPTAIN WIDGET IS REMOVED. The decision rests on a property
// stated as deliberate: a seat with live work always has a widget, because the board's
// crowding is the governor on concurrency and a seat that can run hidden makes the board stop
// showing the cost. Stage 4 removes the captain widget - the surface today's project sessions
// appear on - so project seats need a surface of their own FIRST, or the removal hides work
// rather than relocating it.
//
// THE ONE BEHAVIOUR THAT IS DELIBERATELY NOT COPIED from the first-mate widget: adoption. An
// empty first-mate widget takes the next unclaimed mate, which is fine when any coordinator is
// as good as any other. A project widget names ONE repository, so adopting another project's
// seat would silently retitle the card and point its actions at a different checkout. An empty
// one stays empty and says so. Asserted, because "it renders" would pass either way.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-project-seat-gets-a-widget.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[project-seat-widget]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seatwidget-"));
const metaHome = path.join(tmp, "meta-home");
const projectA = path.join(tmp, "Repo", "Alpha");
const projectB = path.join(tmp, "Repo", "Beta");
for (const d of [metaHome, projectA, projectB]) {
  fs.mkdirSync(d, { recursive: true });
}

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Open two projects the way the captain does - through the same IPC "+ Session" calls.
  const opened = await app.eval(`(async () => {
    const a = await window.helm.ensureSeatForProject(${JSON.stringify(projectA)});
    const b = await window.helm.ensureSeatForProject(${JSON.stringify(projectB)});
    // The meta-home is a usual pick and is NOT a project - it must mint nothing.
    const home = await window.helm.ensureSeatForProject(${JSON.stringify(metaHome)});
    const listed = await window.helm.listMates();
    return {
      a: a?.seat?.name || null,
      b: b?.seat?.name || null,
      homeSeat: home?.seat || null,
      projects: (listed?.projects || []).map((s) => s.name),
      active: (listed?.active || []).length,
      aId: a?.seat?.mateId || null,
    };
  })()`);
  log(JSON.stringify(opened));

  assert(!!opened.a && !!opened.b, "opening two projects returns two named seats");
  assert(opened.homeSeat === null, "opening the meta-home returns no seat, because it is not a project");
  assert(opened.projects.length === 2, `and mates:list reports exactly the two (${opened.projects.length})`);
  assert(opened.active === 2, `while the coordinator pool is untouched at two (${opened.active})`);

  // Put one on the board and read what it drew.
  await app.eval(`navigateToPage("dashboard")`);
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  const widgetId = `w-project-${opened.aId}`;
  const placed = await app.eval(`(async () => {
    const id = ${JSON.stringify(widgetId)};
    await saveWidgetLayout([{ id, type: "projectSeat", span: 4, mateId: ${JSON.stringify(opened.aId)} }]);
    await renderDashboardPage();
    const card = document.querySelector('[data-widget-id="' + id + '"]');
    return { rendered: !!card, text: card ? (card.textContent || "").slice(0, 200) : "" };
  })()`);
  log(JSON.stringify(placed));

  assert(placed.rendered, "a project widget can be placed on the board");
  assert(placed.text.includes(opened.a), `and it names that project's seat (${JSON.stringify(opened.a)})`);
  assert(
    !placed.text.includes(opened.b),
    "and shows only that one - not whichever seat happens to be around"
  );

  // ADOPTION MUST NOT HAPPEN. Point a project widget at a seat id that does not exist and it
  // must stay empty rather than grabbing project B, which is unclaimed and right there.
  const orphan = await app.eval(`(async () => {
    await saveWidgetLayout([{ id: "w-project-gone", type: "projectSeat", span: 4, mateId: "mate_does_not_exist" }]);
    await renderDashboardPage();
    const card = document.querySelector('[data-widget-id="w-project-gone"]');
    return { text: card ? (card.textContent || "") : null };
  })()`);
  assert(orphan.text !== null, "a widget bound to a missing seat still renders something");
  // NEITHER seat, not just the other one. A first pass here checked only for project B, and a
  // mutation that adopted [0] - project A - slipped through it. An adoption check has to name
  // every seat that exists, or it only rules out the adoption the author happened to imagine.
  assert(
    !orphan.text.includes(opened.a) && !orphan.text.includes(opened.b),
    "and it adopts NO seat - not the other project, not the first one in the list"
  );
  assert(
    /\+ Session/.test(orphan.text) || /Open the project/.test(orphan.text),
    `it says how to bring the project back instead (${JSON.stringify((orphan.text || "").slice(0, 120))})`
  );
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
  console.log("VERIFY OK - a project seat has a widget of its own, naming its repo, and never adopts another's");
}
process.exit(exitCode);
