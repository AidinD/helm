// Jumping into a fresh AUTO second mate must open with its crew's runs to review, not blank.
// Ship-review finding on the auto-captain-identity fix: pendingSecondMateReviewNudge scoped by
// `firstMateId !== "direct" ? dispatchedBy === firstMateId : true`. The auto node's firstMateId
// is "auto" (not "direct"), and its crew is dispatched under the auto second mate's own sm_ id
// (never the literal "auto"), so every auto run was filtered out and the second mate opened
// BLANK - the "2nd mate is empty" regression, now for the auto lane. Fix: treat "auto" like
// "direct" (top-of-chain: crew is ALL the project's runs).
//
// Drives the real renderer function in a launched app (no model tokens).
//
// Run:  node scripts/e2e/test-second-mate-auto-review-nudge.mjs
import { launch } from "../checks-lib/harness.mjs";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const P = "D:/Repo/Work/Internal/some-project";
  const res = await app.eval(`(() => {
    state.config = state.config || {};
    state.config.acknowledgedGoalRuns = [];
    goalRuns.clear();
    // A terminal, not-yet-acknowledged auto crew run - dispatched under the auto second mate's
    // OWN id (sm_...), NOT the literal "auto", exactly as the auto dispatch records it.
    goalRuns.set("run-x", {
      goalRunId: "run-x", projectPath: ${JSON.stringify(P)}, status: "done",
      dispatchedBy: "sm_autohash", startedBy: "auto", goal: "Wire the daily quiz screen",
      ordinal: 1, commitCount: 2, branchName: "helm/goal-x",
    });
    const nudge = (firstMateId) => pendingSecondMateReviewNudge({ firstMateId, projectPath: ${JSON.stringify(P)}, secondMateId: "sm_autohash", crew: [] });
    return { auto: nudge("auto"), direct: nudge("direct"), firstMate: nudge("mate_real") };
  })()`);

  ok(/Wire the daily quiz screen/.test(res.auto), `an AUTO node's review nudge LISTS its crew run (${JSON.stringify(res.auto).slice(0, 120)})`);
  ok(/Wire the daily quiz screen/.test(res.direct), "a direct node lists it too (both are top-of-chain)");
  // The proof the fix put "auto" on the correct side: a REAL first-mate parent scopes by
  // dispatchedBy === its mate id, so a run dispatched under the second mate's sm_ id is NOT
  // included - which is exactly the (wrong) behaviour "auto" got before the fix.
  ok(res.firstMate === "", `a real first-mate parent scopes by its own id, so this run is excluded (${JSON.stringify(res.firstMate)})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 6)) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: an auto second mate opens with its crew's runs to review (not blank), because 'auto' is top-of-chain like 'direct'."
    : "VERIFY FAILED."
);
process.exit(exit);
