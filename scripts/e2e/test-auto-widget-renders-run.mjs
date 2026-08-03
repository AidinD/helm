// THE END-TO-END CLAIM, MEASURED ON THE RENDERED WIDGET: an auto-started run in the
// shape the app produces TODAY appears as a row in the Auto widget.
//
// Why this file exists, plainly: a whole session went into making auto runs visible
// in that widget, and Aidin still had not seen it work - "de verkar fortfarande inte
// göra det". Every check so far was one level short of the thing he looks at. The
// source-level test asserts the predicates. test-widget-dashboard-fixes renders the
// widget, but seeds the OLD shape - a Helm SESSION carrying startedBy - which the
// app can no longer produce: an auto task is now an autopilot RUN under a project's
// second mate, and that second mate is "proposed" with no session at all.
//
// So this seeds what the dispatch really writes - a crew run record with
// startedBy:"auto" and autoTaskId, dispatchedBy the project's own second-mate id,
// plus that second mate as a PROPOSED binding with sessionId null - launches the real
// app, and reads the rendered DOM. No model call, no board, no money.
//
// Run:  node scripts/e2e/test-auto-widget-renders-run.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-autorender-"));
const PROJECT = path.join(tmp, "some-project");
fs.mkdirSync(PROJECT, { recursive: true });

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9391";

// Dynamic imports AFTER the env vars: these modules resolve their paths at import
// time, and a static import here would read the ambient values and write into the
// real dev data files.
const { secondMateId } = await import("../../src/lib/secondMates.js");
const { launch } = await import("./harness.mjs");

const SM_ID = secondMateId("direct", PROJECT);
const RUN_ID = "e2e-auto-crew-run";

fs.writeFileSync(
  process.env.HELM_CONFIG_PATH,
  JSON.stringify({ dashboardWidgets: { enabled: true }, autoCaptain: { enabled: true } }),
  "utf8"
);
// The project's second mate exactly as proposeSecondMate writes it at dispatch:
// no session, status "proposed". This is the shape that broke the old filter.
fs.writeFileSync(
  process.env.HELM_SECOND_MATES_PATH,
  JSON.stringify({
    [SM_ID]: {
      firstMateId: "direct",
      projectPath: PROJECT,
      name: "some-project",
      status: "proposed",
      sessionId: null,
      brief: "Auto-started tasks for some-project",
    },
  }),
  "utf8"
);
// The autopilot run underneath it, as startGoalRun persists it.
fs.writeFileSync(
  process.env.HELM_GOAL_RUN_HISTORY_PATH,
  JSON.stringify([
    {
      goalRunId: RUN_ID,
      goal: "Task from the board: run the fast test suite and report the outcome",
      projectPath: PROJECT,
      status: "running",
      dispatchedBy: SM_ID,
      dispatchId: "e2e-dispatch",
      tier: "crew",
      startedBy: "auto",
      autoTaskId: "e2e-card-1",
      livePid: process.pid,
      liveHeartbeatAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]),
  "utf8"
);

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(async () => {
    const matesRes = await window.helm.listMates();
    const smRes = await window.helm.listSecondMates();
    const model = await buildFleetModel(matesRes.active || [], smRes?.secondMates || []);
    const data = { mates: matesRes.active || [], secondMates: model.secondMates };
    const host = document.createElement("div");
    host.append(widgetBodyAuto(data));
    const captainHost = document.createElement("div");
    captainHost.append(widgetBodyCaptain(data));
    const node = model.secondMates.find((s) => s.secondMateId === ${JSON.stringify(SM_ID)});
    return {
      nodeFound: !!node,
      nodeStartedBy: node ? node.startedBy ?? null : null,
      nodeSessionId: node ? node.sessionId ?? null : null,
      nodeCrew: node ? (node.crew || []).length : -1,
      autoRows: host.querySelectorAll(".fleet-branch").length,
      autoText: host.textContent,
      captainText: captainHost.textContent,
    };
  })()`);

  // --- the data the app derived from the seeded run -------------------------
  ok(res.nodeFound, "the project's second mate exists in the fleet model");
  ok(res.nodeStartedBy === "auto", `and it carries startedBy "auto", inherited from its crew run (${res.nodeStartedBy})`);
  ok(res.nodeSessionId === null, "while having NO session of its own - the shape the old filter could not see");
  ok(res.nodeCrew === 1, `with the autopilot run as crew underneath it (${res.nodeCrew})`);

  // --- THE THING AIDIN LOOKS AT --------------------------------------------
  ok(res.autoRows >= 1, `the Auto widget renders a row for it (${res.autoRows})`);
  ok(res.autoText.includes("some-project"), `and the row names the project: ${JSON.stringify(res.autoText.slice(0, 160))}`);
  ok(
    !/Nothing started yet/.test(res.autoText),
    "and the widget does NOT claim nothing has started while a run is going"
  );
  ok(/Auto-captain/.test(res.autoText), "the column is titled Auto-captain, not Captain");

  // --- and it is not double-counted as the captain's own work ---------------
  ok(
    !res.captainText.includes("some-project"),
    "the same run does not also appear in the captain's own column"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   console error:", e.text);
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
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
    ? "VERIFY OK: an auto run in the shape the app produces today renders as a row in the Auto widget, named after its project, and is not duplicated into the captain's column."
    : "VERIFY FAILED."
);
process.exit(exit);
