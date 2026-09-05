// The add-widget menu offers ONE kind of widget: a seat, by name.
//
// HIS WORDS, and this check exists because the first attempt satisfied them everywhere except
// where he could see it: "jag vill att assistenten ska vara samma widget som en first mate" and
// then, looking at the menu, "jag förstår inte varför inte allting är samma widget fortfarande?
// jag diskuterade ju tidigare att jag ville att allt skulle vara first mate och något annat
// bestämmer om det blir en assistant eller project".
//
// The rendering was merged - three widget bodies became one - and the MENU was not. So the
// board drew one card everywhere while the one surface he actually opens still listed three
// categories: "Assistant", "Project · <name>", "First mate · <name>". A taxonomy removed from
// the code and left in the interface is not removed.
//
// WHAT DECIDES WHAT A SEAT IS is its tag and its root, which show on its card and in this
// menu's hint. Not the widget it is offered under.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-add-widget-offers-one-kind.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[add-widget]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-addmenu-"));
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

  const opened = await app.eval(`(async () => {
    await window.helm.ensureSeatForProject(${JSON.stringify(projectA)});
    await window.helm.ensureSeatForProject(${JSON.stringify(projectB)});
    const listed = await window.helm.listMates();
    return {
      pooled: (listed?.active || []).map((m) => m.name),
      standing: listed?.assistant?.name || null,
      projects: (listed?.projects || []).map((m) => m.name),
    };
  })()`);
  log(JSON.stringify(opened));

  await app.eval(`navigateToPage("dashboard")`);
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  // Read the menu the tile builds, on an EMPTY board so every seat is on offer.
  const menu = await app.eval(`(async () => {
    await saveWidgetLayout([{ id: "w-quota", type: "quota", span: 4 }]);
    await renderDashboardPage();
    const tile = document.querySelector(".wd-add");
    tile.click();
    await new Promise((r) => setTimeout(r, 250));
    const rows = [...document.querySelectorAll("#contextMenu .item")].map((e) =>
      (e.textContent || "").trim()
    );
    return { rows };
  })()`);
  log(JSON.stringify(menu.rows));

  assert(menu.rows.length > 0, "the add menu opened and has items");

  const seatRows = menu.rows.filter((r) => r.startsWith("First mate ·"));
  const everySeat = [opened.standing, ...opened.pooled, ...opened.projects].filter(Boolean);

  // THE POINT: one entry per seat, all under one label.
  assert(
    seatRows.length === everySeat.length,
    `one entry per seat, all reading "First mate" (${seatRows.length} of ${everySeat.length})`
  );
  for (const name of everySeat) {
    assert(
      seatRows.some((r) => r.includes(name)),
      `${name} is offered by NAME rather than by category`
    );
  }

  // AND THE CATEGORIES ARE GONE. Asserted by absence, because a count of what remains would
  // pass at zero for the wrong reason if the menu failed to build at all - which is why the
  // "the menu opened" assertion above comes first.
  assert(
    !menu.rows.some((r) => r === "Assistant" || r.startsWith("Assistant")),
    "there is no separate Assistant entry"
  );
  assert(!menu.rows.some((r) => r.startsWith("Project ·")), "and no Project category");

  // The fleet action stays - adding a seat to the pool is where he goes looking for it.
  assert(
    menu.rows.some((r) => r.includes("New first mate")),
    "while adding a new one to the fleet is still offered"
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
console.log(exitCode === 0 ? "VERIFY OK - one kind of widget, one entry per seat, offered by name" : "VERIFY FAILED");
process.exit(exitCode);
