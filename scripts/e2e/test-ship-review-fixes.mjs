// Regression tests for the two worst things the pre-release review found on
// 2026-08-02. Both were reproduced by the reviewer with probes; both are the kind
// of defect that only shows up in a sequence of actions, not in a single call.
//
// 1. Dismissing a first mate ERASED the teardown it had just performed.
//    mates:remove loaded config, called tearDownSecondMatesFor (which writes
//    config.json twice - archiving each second mate's session and adding their ids
//    to the archived-second-mates overlay), then wrote its STALE copy back over the
//    top. Both lists came back empty, so the dismissed mate's second mates
//    reappeared in the Fleet under a parent that no longer existed and their
//    sessions un-archived: exactly the orphan state the teardown exists to prevent.
//
// 2. Parking every drifting project DELETED the only un-park control.
//    The docs-drift section returned nothing when it had no rows left, but the
//    footnote it dropped along with it is the sole host of "show parked". Park them
//    all and the state was recoverable only by hand-editing config.json.
//
// Run: node scripts/e2e/test-ship-review-fixes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-shipfix-"));
const configPath = path.join(tmp, "config.json");
const smPath = path.join(tmp, "second-mates.json");
fs.writeFileSync(configPath, JSON.stringify({}), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = smPath;
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "history.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = "9386";

const readCfg = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
const J = JSON.stringify;

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // ---- 1. dismissing a first mate keeps its teardown ----------------------
  const mates = await app.eval(`(async () => { await window.helm.addMate(); return window.helm.listMates(); })()`);
  ok((mates?.active || []).length === 3, `three first mates to work with (${(mates?.active || []).length})`);
  const victim = mates.active[2];

  // Give it a second mate with a session, so the teardown has real work to do.
  fs.writeFileSync(
    smPath,
    JSON.stringify({
      sm_doomed: { firstMateId: victim.mateId, projectPath: "D:/proj", name: "Doomed", status: "created", sessionId: "cli_doomed" },
    }),
    "utf8"
  );
  // Pre-seed the overlays the teardown is supposed to end up writing, then confirm
  // the dismiss does not wipe pre-existing entries either.
  const seeded = readCfg();
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...seeded, archivedSessions: ["already_archived"], archivedSecondMates: ["sm_already"] }),
    "utf8"
  );

  const removed = await app.eval(`window.helm.removeMate(${J(victim.mateId)})`);
  ok(removed?.ok === true, `the first mate is dismissed (${J(removed?.error || "ok")})`);

  const after = readCfg();
  ok(
    (after.archivedSessions || []).includes("already_archived"),
    `the pre-existing archived session survived the dismiss (${J(after.archivedSessions)})`
  );
  ok(
    (after.archivedSecondMates || []).includes("sm_already"),
    `and so did the pre-existing archived second mate (${J(after.archivedSecondMates)})`
  );
  ok(
    (after.archivedSecondMates || []).includes("sm_doomed"),
    `the dismissed mate's second mate is recorded as archived - the teardown was NOT erased (${J(after.archivedSecondMates)})`
  );
  ok(after.firstMateSlots === 2, `and the slot count came down in the same step (${after.firstMateSlots})`);
  const bindings = JSON.parse(fs.readFileSync(smPath, "utf8"));
  ok(!bindings.sm_doomed, "its binding is gone, so nothing points at a parent that no longer exists");

  // ---- 2. the un-park control survives parking everything -----------------
  const drift = await app.eval(`(async () => {
    // Two fabricated drifting rows and one parked, then park them ALL and check the
    // section still exists with a way back.
    const payload = (rows, parked) => ({
      ok: true, rows, considered: 3, unchecked: 0, uncheckedPaths: [],
      parked, dormant: 0, dormantDays: 60,
    });
    const two = document.createElement("div");
    two.append(await widgetBodyDocsDrift(null, null, async () => payload(
      [{ path: "D:/a", name: "a", commitsSince: 20, threshold: 8 }], 1)));
    const none = document.createElement("div");
    none.append(await widgetBodyDocsDrift(null, null, async () => payload([], 3)));
    const classicNone = await dashboardDriftSection(async () => payload([], 3));
    const classicClean = await dashboardDriftSection(async () => payload([], 0));
    return {
      withRows: two.textContent,
      allParkedWidget: none.textContent,
      allParkedWidgetHasUnpark: !!none.querySelector(".wd-drift-park"),
      allParkedClassic: classicNone ? classicNone.textContent : null,
      allParkedClassicHasUnpark: !!classicNone?.querySelector(".wd-drift-park"),
      trulyCleanIsNull: classicClean === null,
    };
  })()`);
  ok(/show parked/.test(drift.withRows), "the un-park link is there while rows remain");
  ok(
    drift.allParkedClassic !== null,
    `parking EVERYTHING does not delete the section on the classic board (${J(drift.allParkedClassic)})`
  );
  ok(drift.allParkedClassicHasUnpark, "and the un-park control is still reachable there");
  ok(drift.allParkedWidgetHasUnpark, "same on the widget board");
  ok(/3 parked/.test(drift.allParkedWidget), `it says how many are parked (${J(drift.allParkedWidget)})`);
  // The section must still go quiet when there is genuinely nothing to say.
  ok(drift.trulyCleanIsNull, "with nothing drifting AND nothing parked it disappears, as before");

  // ---- 3. parking does not make the module read as "never measured" -------
  const pending = await app.eval(`(async () => {
    await window.helm.staleProjects({ force: true });
    await window.helm.parkDocsProject("D:/Repo/Tools/loom", true);
    const res = await window.helm.staleProjects();
    return { pending: res.pending, at0: res.pending === true };
  })()`);
  ok(
    pending.pending !== true,
    `after parking, the sweep reads as stale rather than never-measured - the section does not blink out (pending=${pending.pending})`
  );

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(
  fails === 0
    ? "\nVERIFY OK: dismissing a mate keeps its teardown, and parking everything still leaves a way back."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
