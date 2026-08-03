// A finished run is reported under the project that owns it, once.
//
// Task 86fefa68. A terminal run the captain has not acknowledged is already a
// crew row under its project's second mate. The card-level roll-up listed it
// AGAIN - and on the captain's card under the wrong owner entirely, because that
// roll-up's bucket is "runs with no dispatcher" and an auto-captain run has no
// dispatcher either. Aidin, pointing at it: "det ser ut som autopilots - borde de
// inte ligga under respektive 2nd mate som äger dem?", and then the decision:
// "de ska ligga per projekt ja, dvs, under den second mate som startade dem,
// precis som i auto widgeten".
//
// The hazard in a de-duplicating fix is the opposite failure, and it is the worse
// one: a run that no project node claims must still be reported SOMEWHERE. A
// finished run nobody is told about is worse than one reported in an odd place. So
// that case is asserted first.
//
// Run:  node scripts/e2e/test-runs-report-under-project.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rollup-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9485";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    const mk = (id, extra = {}) => ({
      goalRunId: id,
      goal: "run " + id,
      status: "done",
      projectPath: "D:\\\\Repo\\\\Tools\\\\thing",
      ordinal: 1,
      ...extra,
    });
    // Three runs, none dispatched by a first mate - so all three land in the
    // captain's "no dispatcher" bucket the way an auto run does.
    const underNode = mk("r-under-node", { startedBy: "auto" });
    const orphan = mk("r-orphan", { projectPath: null });
    const acked = mk("r-acked");
    goalRuns.clear();
    for (const r of [underNode, orphan, acked]) {
      goalRuns.set(r.goalRunId, r);
    }
    state.config = { ...(state.config || {}), acknowledgedGoalRuns: ["r-acked"] };

    // The project node, shaped as deriveSecondMates builds it: the run is on crew.
    const node = {
      secondMateId: "sm-1",
      name: "thing",
      projectPath: "D:\\\\Repo\\\\Tools\\\\thing",
      status: "proposed",
      sessionId: null,
      startedBy: "auto",
      crew: [underNode, acked],
    };

    const shown = runIdsShownUnderNodes([node]);
    const rollupWith = fleetReportRollupEl(null, "rollup:probe-a", "Your runs finished", shown);
    const rollupWithout = fleetReportRollupEl(null, "rollup:probe-b", "Your runs finished", null);
    const nodeEl = fleetSecondMateEl(node);
    const nodeText = nodeEl.textContent;

    return {
      shownIds: [...shown],
      withText: rollupWith ? rollupWith.textContent : null,
      withoutText: rollupWithout ? rollupWithout.textContent : null,
      nodeShowsRun: nodeText.includes("r-under-node") || nodeText.includes("run r-under-node"),
      nodeShowsAcked: nodeText.includes("r-acked"),
      ackedInRollup: (rollupWith?.textContent || "").includes("r-acked"),
    };
  })()`);

  // The failure that must NOT be introduced.
  ok(
    (res.withText || "").includes("r-orphan"),
    `a run no project node claims is still reported (${JSON.stringify(res.withText)})`
  );
  // The duplicate that was the complaint.
  ok(
    !(res.withText || "").includes("r-under-node"),
    "a run already shown under its project node is not reported a second time on the card"
  );
  ok(res.nodeShowsRun, "and it IS shown under that project node - which is where Aidin asked for it");
  ok(res.shownIds.includes("r-under-node"), `the node's runs are what drive the exclusion (${res.shownIds.join(", ")})`);

  // The two surfaces must agree about an acknowledged run: the node drops it, so
  // the roll-up must not adopt it. Getting this backwards resurrects a run the
  // captain has already cleared, in a place with no way to clear it again.
  ok(!res.nodeShowsAcked, "an acknowledged run is dropped by the project node");
  ok(!res.shownIds.includes("r-acked"), "so it is not counted as shown there either");
  ok(!res.ackedInRollup, "and it does not reappear in the roll-up");

  // Without the exclusion the duplicate is demonstrably there - so the assertion
  // above is testing the fix, not an accident of the fixture.
  ok(
    (res.withoutText || "").includes("r-under-node"),
    "with the exclusion removed the duplicate comes straight back (the fixture really does reproduce it)"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
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
    ? "VERIFY OK: a finished run is reported under the project node that owns it, the card roll-up keeps only what no node claims, and an acknowledged run stays gone from both."
    : "VERIFY FAILED."
);
process.exit(exit);
