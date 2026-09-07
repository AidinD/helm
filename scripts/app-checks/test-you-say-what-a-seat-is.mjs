// The add-widget menu offers no seat that already exists, and a first mate can be made the
// assistant from its own card.
//
// HIS WORDS, looking at a menu listing nine of them: "det bör inte First mate - [namn] finnas -
// ingen av dem bör finnas, bara new first mate. Sen ska en first mate skapas ... där bör man
// kunna sätta en tagg, en toggle eller vad som helst som säger åt den att den är en assistent.
// Varför går inte det? varför ser jag en massa olika first mate i listan? makes no sense"
//
// It made no sense because the causation ran backwards. Helm minted seats - one per project he
// opened, plus an assistant seat that a list call created - and then offered them back to him in
// a menu. So the nine were not seats he had made, and the board's crowding stopped being the
// governor it was supposed to be: he would remove a widget to calm the board and the menu handed
// it straight back.
//
// Making a seat is the action now, and saying what it is happens on the seat.
//
// THE HOLE THIS OPENS, and the third assertion block is the whole reason it is here: with the
// menu no longer listing seats, a project seat that gets no widget when it is created has no
// way onto the board at all. Placement used to be one marker for all of them - "the seats were
// placed once" - which would have made every project opened after that first render invisible.
// It is a remembered set now, so a new seat arrives and one he removed stays removed.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-you-say-what-a-seat-is.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[seat-identity]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seatid-"));
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

  // --- nothing is minted behind his back --------------------------------------------------
  const start = await app.eval(`(async () => {
    const listed = await window.helm.listMates();
    return {
      assistant: listed?.assistant?.name || null,
      pool: (listed?.active || []).map((m) => m.name),
      projects: (listed?.projects || []).length,
    };
  })()`);
  log(JSON.stringify(start));

  assert(
    start.assistant === null,
    `no assistant seat exists until he says so (${JSON.stringify(start.assistant)}) - listing the seats does not mint one`
  );
  assert(start.pool.length >= 2, `while the coordinator pool is there as before (${start.pool.join(", ")})`);

  // --- the menu offers making one, and nothing else ----------------------------------------
  await app.eval(`(async () => {
    await window.helm.ensureSeatForProject(${JSON.stringify(projectA)});
  })()`);
  await app.eval(`navigateToPage("dashboard")`);
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  const menu = await app.eval(`(async () => {
    await saveWidgetLayout([{ id: "w-quota", type: "quota", span: 4 }], { projectSeatsPlaced: [] });
    await renderDashboardPage();
    document.querySelector(".wd-add").click();
    await new Promise((r) => setTimeout(r, 250));
    return { rows: [...document.querySelectorAll("#contextMenu .item")].map((e) => (e.textContent || "").trim()) };
  })()`);
  log(JSON.stringify(menu.rows));

  assert(menu.rows.length > 0, "the add menu opened and has items");
  // Asserted by absence, with the "it opened" assertion above first - a count of what remains
  // would pass at zero for the wrong reason if the menu failed to build at all.
  assert(
    !menu.rows.some((r) => /^First mate ·/.test(r)),
    `and not one existing seat is offered (${JSON.stringify(menu.rows.filter((r) => /^First mate ·/.test(r)))})`
  );
  assert(menu.rows.some((r) => r.includes("New first mate")), "while making one is still right there");

  // INHERITED from test-add-widget-offers-one-kind.mjs, which this check replaced on
  // 2026-09-06. That one existed because a taxonomy was removed from the code and left in the
  // interface - the menu still had "Assistant" and "Project · <name>" categories after the
  // three widget bodies had already become one, and the one surface he actually opens was the
  // last place still describing seats as three kinds. The categories must stay gone whatever
  // else the menu does, so the assertions come along rather than dying with their file.
  assert(
    !menu.rows.some((r) => r.startsWith("Assistant")),
    `there is no separate Assistant entry (${JSON.stringify(menu.rows.filter((r) => r.startsWith("Assistant")))})`
  );
  assert(
    !menu.rows.some((r) => r.startsWith("Project ·")),
    `and no Project category (${JSON.stringify(menu.rows.filter((r) => r.startsWith("Project ·")))})`
  );

  // --- and a first mate can be told what it is ---------------------------------------------
  const promoted = await app.eval(`(async () => {
    const before = await window.helm.listMates();
    const target = before.active[0];
    const res = await window.helm.setSeatAssistant(target.mateId, true);
    const after = await window.helm.listMates();
    return {
      ok: !!res?.ok,
      error: res?.error || null,
      target: target.name,
      targetId: target.mateId,
      assistant: after?.assistant?.name || null,
      assistantId: after?.assistant?.mateId || null,
      pool: (after?.active || []).map((m) => m.name),
    };
  })()`);
  log(JSON.stringify(promoted));

  assert(promoted.ok, `a first mate can be made the assistant (${promoted.error || "ok"})`);
  assert(promoted.assistantId === promoted.targetId, `and it is THAT seat, by id, not a new one`);
  assert(
    !promoted.pool.includes(promoted.target),
    `it left the coordinator pool (${promoted.pool.join(", ")})`
  );
  // The count moves with the tag, or ensureMates reads the vacated slot as empty and mints a
  // stranger - he would have clicked "make this the assistant" and watched a new mate appear.
  assert(
    promoted.pool.length === start.pool.length - 1,
    `and nothing was spawned to replace it (${promoted.pool.length} in the pool, was ${start.pool.length})`
  );

  // Only one, ever: setting it on another seat takes it off the first.
  const moved = await app.eval(`(async () => {
    const before = await window.helm.listMates();
    const other = before.active[0];
    const res = await window.helm.setSeatAssistant(other.mateId, true);
    const after = await window.helm.listMates();
    return {
      ok: !!res?.ok,
      movedTo: after?.assistant?.mateId || null,
      otherId: other.mateId,
      taggedCount: (after?.all || []).filter((m) => m.status === "active" && (m.tags || []).includes("assistant")).length,
    };
  })()`);
  log(JSON.stringify(moved));
  assert(moved.ok && moved.movedTo === moved.otherId, "the tag moves to another seat when set there");
  assert(moved.taggedCount === 1, `and exactly one seat carries it (${moved.taggedCount}) - two would break every lookup`);

  // A project seat is refused: its root is a checkout, the assistant's store is the meta home's.
  const refused = await app.eval(`(async () => {
    const listed = await window.helm.listMates();
    const seat = (listed.projects || [])[0];
    const res = await window.helm.setSeatAssistant(seat.mateId, true);
    const after = await window.helm.listMates();
    return { ok: !!res?.ok, error: res?.error || null, stillAssistant: after?.assistant?.mateId || null };
  })()`);
  log(JSON.stringify(refused));
  assert(!refused.ok, `a project seat is refused (${JSON.stringify(refused.error)})`);
  assert(refused.stillAssistant === moved.otherId, "and the refusal changed nothing - the tag stayed where it was");

  // --- a NEW project seat still reaches the board ------------------------------------------
  // The hole the menu change opens. Driven with the marker already set, which is the state
  // every existing board is in.
  const placement = await app.eval(`(async () => {
    await saveWidgetLayout([{ id: "w-quota", type: "quota", span: 4 }], { projectSeatsPlaced: null, projectSeatsPlacedAt: Date.now() });
    await renderDashboardPage();
    const afterMigration = (state.config?.dashboardWidgets?.layout || []).map((w) => w.mateId).filter(Boolean);

    // A project opened NOW - after the old marker was set.
    const opened = await window.helm.ensureSeatForProject(${JSON.stringify(projectB)});
    await renderDashboardPage();
    const layout = (state.config?.dashboardWidgets?.layout || []).map((w) => ({ id: w.id, mateId: w.mateId }));
    return { afterMigration, newSeatId: opened?.seat?.mateId || null, layout };
  })()`);
  log(JSON.stringify(placement));

  assert(
    placement.afterMigration.length === 0,
    `an old marker still means "these have had their placement" (${placement.afterMigration.length} re-added) - the board does not refill itself`
  );
  assert(
    placement.layout.some((w) => w.mateId === placement.newSeatId),
    "but a project opened afterwards DOES get a widget - otherwise its work would exist nowhere on screen"
  );

  // And removing it keeps it removed, which is the other half of the same rule.
  const removed = await app.eval(`(async () => {
    const keep = (state.config?.dashboardWidgets?.layout || []).filter((w) => w.mateId !== ${JSON.stringify(placement.newSeatId)});
    await saveWidgetLayout(keep);
    await renderDashboardPage();
    await renderDashboardPage();
    return { layout: (state.config?.dashboardWidgets?.layout || []).map((w) => w.mateId).filter(Boolean) };
  })()`);
  log(JSON.stringify(removed));
  assert(
    !removed.layout.includes(placement.newSeatId),
    "and once he removes that widget it stays removed - the board is his"
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
console.log(
  exitCode === 0
    ? "VERIFY OK - nothing is minted behind him, the menu only makes seats, and a first mate can be told what it is"
    : "VERIFY FAILED"
);
process.exit(exitCode);
