// A widget added from the menu still shows the seat you picked, after the next render.
//
// HIS WORDS, on the released 0.2.269: "i 2.269 kan jag inte ha en assistent". He could add it.
// It did not stay.
//
// WHAT WENT WRONG IS TWO CORRECT THINGS COMPOSED. The add menu was collapsed to one entry per
// seat, all writing `type: "firstMate"` - right, because there is one kind of seat. And a
// first-mate widget adopts an unclaimed mate when the one it was bound to is gone - also right,
// written when `firstMate` could only ever mean one of the numbered pool slots, so a binding
// that named nobody in the pool WAS a dead binding.
//
// Widening what the type means without widening that rule made every non-pool seat look dead.
// The standing seat and the project seats are not in the pool, so the moment the board
// re-rendered, `resolveFirstMateWidgetMates` re-pointed their widgets at a pool mate - and the
// render PERSISTS an adoption, so it did not even take a restart to become permanent. Adding
// the assistant produced a pool first mate, every time, which is exactly "I cannot have one".
//
// SO THE PROPERTY IS: adoption is for a binding whose SEAT IS GONE, never for a seat that
// exists somewhere other than the pool. Asserted through the real menu and the real render
// rather than against the resolver, because the resolver was not wrong on its own terms - the
// composition was, and only the composition can show it.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-a-seat-widget-keeps-its-seat.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[seat-widget-keeps]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seatkeeps-"));
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
    // A THIRD COORDINATOR FIRST, then promote it. Promoting takes a seat out of the pool, and
    // the assertions below need a pool left to be wrongly adopted from - with only the two
    // default seats, promoting one would leave a single candidate and an adoption bug could
    // pass by luck.
    await window.helm.addMate();
    const before = await window.helm.listMates();
    const target = (before.active || [])[before.active.length - 1];
    await window.helm.setSeatAssistant(target.mateId, true);
    const listed = await window.helm.listMates();
    return {
      standing: listed?.assistant?.name || null,
      standingId: listed?.assistant?.mateId || null,
      pool: (listed?.active || []).map((m) => m.name),
      project: (listed?.projects || [])[0]?.name || null,
      projectId: (listed?.projects || [])[0]?.mateId || null,
    };
  })()`);
  log(JSON.stringify(seats));

  // The control for every "it shows the right seat" assertion below: if these were empty, a
  // card containing none of the pool names would pass for the wrong reason.
  assert(!!seats.standing, `there is a standing seat to put on the board (${seats.standing})`);
  assert(!!seats.project, `and a project seat (${seats.project})`);
  assert(seats.pool.length >= 2, `and a pool to be wrongly adopted from (${seats.pool.join(", ")})`);

  await app.eval(`navigateToPage("dashboard")`);
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  // WRITTEN, not picked from the menu. The menu deliberately offers no existing seat since
  // 2026-09-06 ("ingen av dem bör finnas, bara new first mate"), and what this check is about
  // was never how the widget arrived - it is whether the binding survives a render. The shape
  // written here is the shape the app writes: type "firstMate", id w-seat-<mateId>.
  const added = await app.eval(`(async () => {
    await saveWidgetLayout([
      { id: "w-quota", type: "quota", span: 4 },
      { id: "w-seat-" + ${JSON.stringify(seats.standingId)}, type: "firstMate", span: 4, mateId: ${JSON.stringify(seats.standingId)} },
    ]);
    await renderDashboardPage();
    const layout = (state.config?.dashboardWidgets?.layout || []).map((w) => ({ id: w.id, type: w.type, mateId: w.mateId }));
    return { layout };
  })()`);
  log(JSON.stringify(added));

  assert(
    (added.layout || []).some((w) => w.mateId === seats.standingId),
    "a widget bound to the standing seat can be put on the board"
  );

  // THE RENDER IS THE TEST. The adoption happens here, and it is persisted, so one repaint is
  // enough to lose the seat for good - no restart needed.
  const afterRender = await app.eval(`(async () => {
    await renderDashboardPage();
    await renderDashboardPage();
    const layout = (state.config?.dashboardWidgets?.layout || []).map((w) => ({ id: w.id, type: w.type, mateId: w.mateId }));
    const cards = [...document.querySelectorAll(".wd")].map((c) => (c.textContent || "").slice(0, 160));
    return { layout, cards };
  })()`);
  log(JSON.stringify(afterRender.layout));

  assert(
    (afterRender.layout || []).some((w) => w.mateId === seats.standingId),
    "after a re-render the widget is STILL bound to the standing seat, not re-pointed at the pool"
  );
  assert(
    afterRender.cards.some((t) => t.includes(seats.standing)),
    `and the board still shows it by name (${seats.standing})`
  );

  // Same question for a project seat, because the menu writes those the same way and one fix
  // has to cover the class rather than the instance he happened to hit.
  const project = await app.eval(`(async () => {
    await saveWidgetLayout([
      { id: "w-quota", type: "quota", span: 4 },
      { id: "w-seat-" + ${JSON.stringify(seats.projectId)}, type: "firstMate", span: 4, mateId: ${JSON.stringify(seats.projectId)} },
    ]);
    await renderDashboardPage();
    await renderDashboardPage();
    const layout = (state.config?.dashboardWidgets?.layout || []).map((w) => ({ id: w.id, type: w.type, mateId: w.mateId }));
    const cards = [...document.querySelectorAll(".wd")].map((c) => (c.textContent || "").slice(0, 160));
    return { layout, cards };
  })()`);
  log(JSON.stringify(project.layout));

  assert(
    (project.layout || []).some((w) => w.mateId === seats.projectId),
    "a project seat placed as a seat widget keeps its binding too"
  );
  assert(
    project.cards.some((t) => t.includes(seats.project)),
    `and the card names that project's seat (${seats.project})`
  );

  // AND ADOPTION STILL WORKS, which is the half that must not be broken by fixing the other:
  // a widget bound to an id that is no seat at all still takes an unclaimed pool mate, because
  // that binding really is dead. Without this, "keep every binding" would pass everything
  // above and quietly reintroduce the dead widget the adoption rule was written for.
  const dead = await app.eval(`(async () => {
    await saveWidgetLayout([{ id: "w-seat-gone", type: "firstMate", span: 4, mateId: "mate_no_such_seat" }]);
    await renderDashboardPage();
    const layout = (state.config?.dashboardWidgets?.layout || []).map((w) => ({ id: w.id, type: w.type, mateId: w.mateId }));
    const cards = [...document.querySelectorAll(".wd")].map((c) => (c.textContent || "").slice(0, 160));
    return { layout, cards };
  })()`);
  log(JSON.stringify(dead.layout));

  assert(
    (dead.layout || []).some((w) => w.id === "w-seat-gone" && seats.pool.length > 0 && w.mateId !== "mate_no_such_seat"),
    "a widget bound to a seat that does not exist still adopts a mate on watch"
  );
  assert(
    dead.cards.some((t) => seats.pool.some((n) => t.includes(n))),
    "and draws that mate, so the adoption is real and not just a field change"
  );
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
console.log(exitCode === 0 ? "VERIFY OK - a seat widget keeps the seat you picked, and a dead binding still adopts" : "VERIFY FAILED");
process.exit(exitCode);
