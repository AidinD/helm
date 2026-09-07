// A red nightly lane shows up in Helm, and "could not ask" never renders as the all-clear.
//
// HIS ASK, in three words: "visa röd nattbana i helm". The app lane runs on a schedule on
// GitHub's runners. It went red the night after the tier merge and again the night after,
// naming seven checks, and nobody read it for two days (2026-09-07). Every one of those seven
// was a check describing a mechanism that had moved. The lane worked perfectly; the reading of
// it did not exist.
//
// SO THE WHOLE VALUE IS IN THE THIRD STATE. A widget that answers pass/fail has to put "could
// not ask" somewhere, and both places are lies: as a pass it is the docs-drift bug this repo
// already paid for once, and as a failure it cries wolf every time a laptop is offline until he
// stops believing it - which is how the app lane went unread in the first place. Three states,
// three renderings, and this check drives all of them.
//
// The fetcher is injected, the same seam widgetBodyDocsDrift has. That is deliberate rather
// than convenient: driving these states through the real reader would need a repo whose CI is
// failing, a repo that is offline and a repo mid-run, all at once, on a machine that must not
// depend on the network to be green.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/app-checks/test-ci-widget-shows-a-red-lane.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[ci-widget]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-ciwidget-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

// The four readouts, in the shapes ciHealth.js actually produces. Written out here rather than
// built by calling that module, so a change to its output shape shows up as a failure in this
// check instead of both sides moving together and agreeing about nothing.
const RED = {
  ok: true,
  pending: false,
  considered: 2,
  allClear: false,
  failingWorkflows: 1,
  failing: [
    {
      name: "helm",
      path: "D:/Repo/Tools/helm",
      reachable: true,
      failing: [
        {
          workflow: "app-lane",
          state: "failing",
          why: "failure",
          run: { url: "https://github.com/AidinD/helm/actions/runs/34089559226", createdAt: "2026-09-07T06:09:05Z" },
        },
      ],
      unknown: [],
    },
  ],
  unknown: [],
  unreachable: [],
  green: [{ name: "pompom", path: "D:/Repo/Tools/pompom", reachable: true, failing: [], unknown: [] }],
};

const CANNOT_ASK = {
  ok: true,
  pending: false,
  considered: 1,
  allClear: false,
  failingWorkflows: 0,
  failing: [],
  unknown: [],
  unreachable: [{ name: "loom", path: "D:/Repo/Tools/loom", reachable: false, error: "gh: not authenticated", failing: [], unknown: [] }],
  green: [],
};

const GREEN = {
  ok: true,
  pending: false,
  // Fourteen looked at, three with lanes - the real proportion this feature met on his machine.
  // The sentence has to count the second number.
  considered: 14,
  withLanes: 3,
  allClear: true,
  failingWorkflows: 0,
  failing: [],
  unknown: [],
  unreachable: [],
  green: [{ name: "helm" }, { name: "nib" }, { name: "pompom" }],
};

const PENDING = { ok: true, pending: true, considered: 0, allClear: false, failingWorkflows: 0, failing: [], unknown: [], unreachable: [], green: [] };

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`navigateToPage("dashboard")`);
  await app.waitForSelector(".wd-grid", 30000, { visible: true });

  const render = async (payload) =>
    await app.eval(`(async () => {
      const host = document.createElement("div");
      host.append(await widgetBodyCiHealth({}, {}, async () => (${JSON.stringify(payload)})));
      return {
        text: (host.textContent || "").trim(),
        rows: host.querySelectorAll(".wd-drift-line").length,
        crit: host.querySelectorAll(".wd-drift-count.crit").length,
        counts: [...host.querySelectorAll(".wd-drift-count")].map((e) => e.textContent),
        buttons: [...host.querySelectorAll("button")].map((b) => b.textContent),
        titles: [...host.querySelectorAll(".wd-drift-count")].map((e) => e.title),
      };
    })()`);

  // --- 1. A RED LANE IS ON THE BOARD, BY NAME -----------------------------------------------
  const red = await render(RED);
  log(JSON.stringify(red));
  assert(red.rows === 1, `a failing project is one row (${red.rows})`);
  assert(/helm/.test(red.text), "named, so it is not a count he has to trust");
  assert(
    red.counts.includes("app-lane"),
    `and the LANE is named, because "helm is red" is not actionable and "app-lane failed" is (${JSON.stringify(red.counts)})`
  );
  assert(red.crit === 1, `the failing row is marked critical (${red.crit})`);
  assert(
    red.buttons.some((b) => /Open run/.test(b)),
    `with the run one click away (${JSON.stringify(red.buttons)}) - evidence six clicks deep is how a red lane goes unread`
  );
  // The green project alongside it must NOT be listed: the widget's job is to be quiet about
  // what is fine, or it becomes a wall nobody scans.
  assert(!/pompom/.test(red.text), "while the green project beside it stays off the board");

  // --- 2. COULD NOT ASK IS ITS OWN STATE ----------------------------------------------------
  const unasked = await render(CANNOT_ASK);
  log(JSON.stringify(unasked));
  assert(unasked.rows === 1, `a project we could not ask is still a row (${unasked.rows}) - never folded into silence`);
  assert(/loom/.test(unasked.text), "named too");
  assert(
    unasked.counts.includes("not known"),
    `and reads as not known rather than as passing or failing (${JSON.stringify(unasked.counts)})`
  );
  // NOT critical, and this is the assertion that keeps the widget worth reading. An unknown is
  // missing news, not bad news; colouring it red is how a signal trains somebody to ignore it.
  assert(unasked.crit === 0, `and is NOT marked critical (${unasked.crit}) - missing news is not bad news`);
  assert(
    unasked.titles.some((t) => /not authenticated/.test(t || "")),
    `while the reason is there to read (${JSON.stringify(unasked.titles)})`
  );
  assert(
    !/green/i.test(unasked.text) && !/Every lane/.test(unasked.text),
    `and the all-clear sentence is absent (${JSON.stringify(unasked.text.slice(0, 120))}) - THE bug this widget exists to not have`
  );

  // --- 3. THE ALL-CLEAR, ONLY WHEN IT WAS EARNED --------------------------------------------
  const green = await render(GREEN);
  log(JSON.stringify(green));
  assert(green.rows === 0, `an all-clear has no rows (${green.rows})`);
  assert(/Every lane green in 3 projects with CI/.test(green.text), `and says so as reassurance (${JSON.stringify(green.text)})`);
  assert(
    !/14/.test(green.text),
    "counting the projects that HAVE lanes, not the fourteen considered - a claim the size of the evidence"
  );

  // --- 4. AND NOTHING MEASURED YET SAYS SO --------------------------------------------------
  const pending = await render(PENDING);
  log(JSON.stringify(pending));
  assert(/Checking CI/.test(pending.text), `before the first read it says it is checking (${JSON.stringify(pending.text)})`);
  assert(!/green/i.test(pending.text), "and not that everything is fine, which would be a guess dressed as a result");

  // --- 5. THE WIDGET IS ON HIS BOARD WITHOUT HIM GOING TO FIND IT ---------------------------
  // The seeding mechanism exists precisely because an attention signal you have to look for is
  // not much of a nudge - and this widget was added BECAUSE a signal went unread.
  const seeded = await app.eval(`(async () => {
    state.config = { ...state.config, dashboardWidgets: { layout: [{ id: "w-quota", type: "quota", span: 4 }], seeded: {} } };
    let written = null;
    await seedNewWidgets((patch) => { written = patch; return true; });
    return {
      types: (written?.dashboardWidgets?.layout || []).map((w) => w.type),
      marked: !!written?.dashboardWidgets?.seeded?.ciHealth,
    };
  })()`);
  log(JSON.stringify(seeded));
  assert(seeded.types.includes("ciHealth"), `it seeds onto an already-arranged board (${JSON.stringify(seeded.types)})`);
  assert(seeded.marked, "and is marked as seeded, so removing it afterwards is permanent");

  // And in the catalog, so it can be added back deliberately.
  const catalog = await app.eval(`(() => ({ known: !!WIDGET_CATALOG.ciHealth, label: WIDGET_CATALOG.ciHealth?.label || null }))()`);
  assert(catalog.known, `the type is in the catalog (${catalog.label}) - an unknown type is dropped from a saved layout`);

  const errors = await app.eval(`(window.__consoleErrors || []).length`);
  assert(errors === 0 || errors === undefined, `no console errors (${errors})`);
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
    ? "VERIFY OK - a red lane is named on the board with its run one click away, could-not-ask is its own uncoloured state, and the all-clear is only shown when it was earned"
    : "VERIFY FAILED"
);
process.exit(exitCode);
