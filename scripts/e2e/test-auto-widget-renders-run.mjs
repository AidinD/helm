// THE END-TO-END CLAIM, MEASURED ON THE RENDERED WIDGET: an auto-started run in the
// shape the app produces TODAY appears as a row in the Auto widget.
//
// Why this file exists, plainly: a whole session went into making auto runs visible
// in that widget, and the captain still had not seen it work - "de verkar fortfarande inte
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
const { secondMateId, AUTO_CAPTAIN } = await import("../../src/lib/secondMates.js");
const { launch } = await import("./harness.mjs");

// Under the AUTO-CAPTAIN's own identity, not "direct". The auto lane used to dispatch
// under the shared "direct" second-mate id, so an Auto pass and a manual captain session on
// the same project collapsed into one node; AUTO_CAPTAIN fixed that by giving auto its own.
// deriveSecondMates now routes every startedBy:"auto" run to secondMateId(AUTO_CAPTAIN,
// project) - so a fixture that registers its binding under "direct" ends up with TWO nodes:
// the run's auto node, and an unrelated binding node carrying the name and session. The
// assertions then read the binding node and correctly find no crew and no startedBy. The
// fixture was describing the pre-fix data model (2026-08-12, first full sweep since 08-02).
const SM_ID = secondMateId(AUTO_CAPTAIN, PROJECT);
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
      firstMateId: AUTO_CAPTAIN,
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
      archiveBtns: host.querySelectorAll(".fleet-archive-btn").length,
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
  // A session-less project row had no controls at all, so there was no answer to "how
  // do I archive this?" - measured on the RENDERED row, not on the branch that builds it.
  ok(res.archiveBtns >= 1, `and the row can be archived from here (${res.archiveBtns} Archive control)`);

  // --- and it is not double-counted as the captain's own work ---------------
  ok(
    !res.captainText.includes("some-project"),
    "the same run does not also appear in the captain's own column"
  );

  // --- WHY IT WAS EMPTY FOR A WHOLE DAY ------------------------------------
  // The data above was all correct in the captain's real app, and the widget was still
  // blank. The cause was one line of config: the project's fleet node was in
  // archivedSecondMates, and the dashboard excludes archived nodes - so every auto
  // run dispatched under it was invisible. Permanently and silently: the run
  // happened, cost money and edited the repo. Locked in here as the DIAGNOSIS, so a
  // future blank widget can be told apart from this one in a single test run.
  const archived = await app.eval(`(async () => {
    const matesRes = await window.helm.listMates();
    const smRes = await window.helm.listSecondMates();
    state.config.archivedSecondMates = [${JSON.stringify(SM_ID)}];
    const model = await buildFleetModel(matesRes.active || [], smRes?.secondMates || []);
    const host = document.createElement("div");
    host.append(widgetBodyAuto({ mates: matesRes.active || [], secondMates: model.secondMates }));
    state.config.archivedSecondMates = [];
    return { rows: host.querySelectorAll(".fleet-branch").length, text: host.textContent };
  })()`);
  ok(archived.rows === 0, `an ARCHIVED project node hides its auto runs entirely (${archived.rows} rows) - this was the bug`);
  ok(
    /Nothing started yet|Off\./.test(archived.text),
    "and the widget then shows exactly the empty state the captain was looking at all day"
  );

  // --- AND THE FIX: NEW WORK UN-ARCHIVES THE ROW ---------------------------
  // Archiving says "I am done looking at this"; dispatching work to it says the
  // opposite. The two were never connected - the auto-captain re-proposed the node
  // on every dispatch, and the archive overlay outlived that every time.
  const mainSrc = fs
    .readFileSync(new URL("../../src/main.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  ok(/function unarchiveSecondMateForNewWork\(/.test(mainSrc), "main.js can un-archive a node being dispatched to");
  const proposeSites = [...mainSrc.matchAll(/proposeSecondMate\(/g)].length;
  const unarchiveCalls = [...mainSrc.matchAll(/unarchiveSecondMateForNewWork\(/g)].length - 1; // minus the definition
  ok(
    unarchiveCalls >= 3,
    `every dispatch site un-archives first (${unarchiveCalls} calls for ${proposeSites} propose sites)`
  );
  // Order matters: un-archiving AFTER the dispatch would still leave the first run
  // of a re-used project invisible.
  for (const site of ["proposeSecondMate(\"direct\", where.projectPath", "proposeSecondMate(request.dispatchedBy || \"direct\", relayProject"]) {
    const at = mainSrc.indexOf(site);
    const before = mainSrc.slice(Math.max(0, at - 400), at);
    ok(
      /unarchiveSecondMateForNewWork\(/.test(before),
      `un-archived BEFORE proposing at: ${site.slice(0, 45)}...`
    );
  }

  // --- UN-ARCHIVING RESTORES A ROW, NOT A CONVERSATION --------------------
  // the captain's objection when he saw the fix, and it is the right question: if a node
  // was archived, shouldn't new work start a FRESH session - otherwise its context
  // just keeps growing?
  //
  // It does start fresh, and not by accident: archiveSecondMateIds writes the
  // overlay AND calls removeSecondMates, which deletes the BINDING - session id
  // included. A later dispatch re-proposes the node as status "proposed" with
  // sessionId null, so the session is minted on first engagement. Un-archiving
  // therefore un-hides a row; there is nothing left to resume.
  //
  // Asserted rather than argued, because the day someone makes archiving keep the
  // binding, un-archiving would silently start resuming old sessions and the context
  // growth he asked about becomes real - with no test to notice.
  const { bindSecondMateSession, readBindings, proposeSecondMate, removeSecondMates } = await import(
    "../../src/lib/secondMates.js"
  );
  const probeProject = path.join(tmp, "archive-probe");
  const probeId = secondMateId("direct", probeProject);
  proposeSecondMate("direct", probeProject, { brief: "first round" });
  bindSecondMateSession(probeId, "session-from-before");
  ok(readBindings()[probeId]?.sessionId === "session-from-before", "a second mate can hold a session");
  removeSecondMates([probeId]); // what archiving does, beyond the overlay
  ok(readBindings()[probeId] === undefined, "archiving deletes the binding outright - the session id does not survive it");
  proposeSecondMate("direct", probeProject, { brief: "new work after archiving" });
  const reproposed = readBindings()[probeId];
  ok(reproposed?.sessionId === null, `and new work re-proposes it with NO session (${JSON.stringify(reproposed?.sessionId)})`);
  ok(reproposed?.status === "proposed", `status "proposed", so a fresh session is minted on first engagement (${reproposed?.status})`);

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
