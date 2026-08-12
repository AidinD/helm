// A first-mate widget follows whoever is on watch, instead of dying with one mate.
//
// Aidin, task acb34a24: "first mate widgeten är bunden till en specifik first mate -
// när man retirerar en first mate måste man byta ut widgeten, det är ganska störigt."
// Retiring a first mate respawns a fresh one in the same slot with a NEW id, so the
// widget's binding pointed at a mate that no longer existed and the board showed a
// dead tile until he replaced it by hand.
//
// Two levels, on purpose:
//  - the assignment decision as a pure function (this is where the bug lived - which
//    widget shows whom, not how it draws);
//  - the real thing: seed two mates and two widgets, RETIRE one through the same IPC
//    the card's own button uses, repaint, and read the widget titles off the board.
//
// Run:  node scripts/e2e/test-first-mate-widget-rebinds.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-matewidget-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

const matesPath = path.join(tmp, "mates.json");
fs.writeFileSync(
  matesPath,
  JSON.stringify({
    mates: [
      { mateId: "M1", slot: 0, name: "Alpha", root: metaHome, status: "active", createdAt: Date.now() },
      { mateId: "M2", slot: 1, name: "Beta", root: metaHome, status: "active", createdAt: Date.now() },
    ],
  }),
  "utf8"
);
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    dashboardWidgets: {
      enabled: true,
      layout: [
        { id: "w-mate-M1", type: "firstMate", span: 4, mateId: "M1" },
        { id: "w-mate-M2", type: "firstMate", span: 4, mateId: "M2" },
      ],
    },
  }),
  "utf8"
);

process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_MATES_PATH = matesPath;
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9519";
const { launch } = await import("./harness.mjs");

const titles = `[...document.querySelectorAll(".wd .wd-title")].map((t) => t.textContent.trim())`;

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the decision, in isolation ---------------------------------------------
  const decided = await app.eval(`(() => {
    const mates = (ids) => ids.map((id) => ({ mateId: id }));
    const w = (id, mateId) => ({ id, type: "firstMate", mateId });
    const asObj = (m) => Object.fromEntries([...m.entries()]);
    return {
      // Nothing moves while both mates are there.
      stable: asObj(resolveFirstMateWidgetMates([w("a", "M1"), w("b", "M2")], mates(["M1", "M2"]))),
      // M1 retired, a fresh mate M3 took its slot: the widget adopts M3, and the
      // widget already showing M2 is left alone.
      adopts: asObj(resolveFirstMateWidgetMates([w("a", "M1"), w("b", "M2")], mates(["M3", "M2"]))),
      // Two dead bindings, one mate: the first widget takes it, the second stays empty
      // rather than both widgets showing the same mate.
      noDouble: asObj(resolveFirstMateWidgetMates([w("a", "M1"), w("b", "M2")], mates(["M3"]))),
      // No mates at all - an empty slot, not a crash.
      none: asObj(resolveFirstMateWidgetMates([w("a", "M1")], mates([]))),
      // A non-firstMate widget is never given a mate.
      others: asObj(resolveFirstMateWidgetMates([{ id: "q", type: "quota" }], mates(["M1"]))),
      // The layout rewrite reports whether anything was adopted, so a repaint that
      // changes nothing does not write config on every tick.
      changedWhenAdopting: rebindFirstMateWidgets([w("a", "M1")], mates(["M3"])).changed,
      changedWhenStable: rebindFirstMateWidgets([w("a", "M1")], mates(["M1"])).changed,
      changedWhenNothingToAdopt: rebindFirstMateWidgets([w("a", "M1")], mates([])).changed,
    };
  })()`);
  ok(JSON.stringify(decided.stable) === JSON.stringify({ a: "M1", b: "M2" }), `a live binding is left alone (${JSON.stringify(decided.stable)})`);
  ok(JSON.stringify(decided.adopts) === JSON.stringify({ a: "M3", b: "M2" }), `a dead binding adopts the mate nobody shows (${JSON.stringify(decided.adopts)})`);
  ok(JSON.stringify(decided.noDouble) === JSON.stringify({ a: "M3", b: null }), `two widgets never show the same mate (${JSON.stringify(decided.noDouble)})`);
  ok(JSON.stringify(decided.none) === JSON.stringify({ a: null }), `with no mates the slot is empty (${JSON.stringify(decided.none)})`);
  ok(JSON.stringify(decided.others) === JSON.stringify({}), "only first-mate widgets are assigned a mate");
  ok(decided.changedWhenAdopting === true, "adopting counts as a change worth persisting");
  ok(decided.changedWhenStable === false, "a stable board persists nothing");
  ok(decided.changedWhenNothingToAdopt === false, "and neither does an empty slot with nobody to adopt");

  // --- the board, before ------------------------------------------------------
  // POLLED, not read once. navigateToPage("dashboard") kicks off a render of its own that
  // nothing awaits, so awaiting a second renderDashboardPage() raced it: the widget
  // dashboard commits its DOM in an atomic swap, and the read could land between the two.
  // Every later assertion in this file reads the same board successfully, which is what
  // gave it away - the mates were always there, this one look was simply too early
  // (2026-08-12; this was one of six failures in the first full sweep since 2026-08-02).
  const before = await app.eval(`(async () => {
    navigateToPage("dashboard");
    await renderDashboardPage();
    let titles = [];
    for (let i = 0; i < 60; i++) {
      titles = ${titles};
      if (titles.includes("First mate · Alpha") && titles.includes("First mate · Beta")) { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { titles };
  })()`);
  ok(
    before.titles.includes("First mate · Alpha") && before.titles.includes("First mate · Beta"),
    `both mates are on the board to begin with (${JSON.stringify(before.titles)})`
  );

  // --- retire one, exactly as the card's own button does ----------------------
  const after = await app.eval(`(async () => {
    const res = await window.helm.retireMate("M1", null, null, true);
    // mates:retire answers with the RESPAWNED mate (the one that took the slot), not the
    // whole roster - so this reads res.mate rather than an active list that is not there.
    const listed = await window.helm.listMates();
    await renderDashboardPage();
    return {
      retire: {
        ok: !!(res && res.ok),
        respawned: res && res.mate ? { mateId: res.mate.mateId, name: res.mate.name, slot: res.mate.slot } : null,
        active: ((listed && listed.active) || []).map((m) => ({ mateId: m.mateId, name: m.name, slot: m.slot })),
      },
      titles: ${titles},
      empties: [...document.querySelectorAll(".wd")].map((w) => (w.querySelector(".wd-empty, .pane-empty")?.textContent || "").trim()).filter(Boolean),
    };
  })()`);
  ok(after.retire.ok, `the retire went through (${JSON.stringify(after.retire.active)})`);
  const fresh = after.retire.respawned;
  ok(!!fresh && fresh.mateId !== "M1", `and respawned a mate with a NEW id, which is what broke the old binding (${JSON.stringify(fresh)})`);
  ok(
    after.retire.active.some((m) => m.mateId === fresh?.mateId) && !after.retire.active.some((m) => m.mateId === "M1"),
    `the roster now holds the respawn and not the retired mate (${JSON.stringify(after.retire.active)})`
  );

  // THE point: the widget shows the new mate without being replaced.
  ok(
    after.titles.includes(`First mate · ${fresh.name}`),
    `the widget adopted the respawned mate (${JSON.stringify(after.titles)})`
  );
  ok(
    !after.titles.includes("First mate · Alpha"),
    "and no longer shows the retired one"
  );
  ok(
    after.titles.includes("First mate · Beta"),
    `while the other widget keeps its own mate (${JSON.stringify(after.titles)})`
  );
  ok(
    !after.empties.some((t) => /No first mate for this slot/.test(t)),
    `no dead tile is left behind (${JSON.stringify(after.empties)})`
  );
  // Persisted, so the adoption survives a restart and is not re-decided each repaint.
  // Read from the config FILE, not from renderer memory: an in-memory layout that was
  // never written would look identical here and lose the adoption on the next launch.
  const onDisk = (JSON.parse(fs.readFileSync(configPath, "utf8")).dashboardWidgets?.layout || [])
    .filter((w) => w.type === "firstMate")
    .map((w) => ({ id: w.id, mateId: w.mateId }));
  ok(
    onDisk.some((w) => w.id === "w-mate-M1" && w.mateId === fresh.mateId),
    `the adoption is written to config.json, so a restart keeps it (${JSON.stringify(onDisk)})`
  );

  // --- and the Add-widget menu agrees ----------------------------------------
  // The menu used to dedupe by widget ID. After an adoption the widget's id still
  // carries the RETIRED mate's id, so an id check would offer the adopted mate again
  // and put a second widget on the board for the same mate.
  const menu = await app.eval(`(async () => {
    document.querySelector(".wd-add").click();
    await new Promise((r) => setTimeout(r, 200));
    const items = [...document.querySelectorAll("#contextMenu .item")].map((i) => i.textContent.trim());
    closeContextMenu();
    return items;
  })()`);
  ok(
    !menu.some((t) => t === `First mate · ${fresh.name}`),
    `the adopted mate is not offered a second widget (${JSON.stringify(menu)})`
  );
  ok(
    !menu.some((t) => t === "First mate · Beta"),
    "nor is the one that already has one"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 200));
  }
} catch (err) {
  exit = 1;
  console.error("ERR", err.stack || err.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: a first-mate widget adopts a mate on watch when its own is retired, without doubling up or leaving a dead tile."
    : "VERIFY FAILED."
);
process.exit(exit);
