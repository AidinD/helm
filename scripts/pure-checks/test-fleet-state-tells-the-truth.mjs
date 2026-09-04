// The cross-mate picture reports the DERIVED outcome, and never suppresses a captain signal.
//
// `fleetState.js` is what `helm_fleet_state` serves, so it is the picture one mate reads about
// another mate's work. It used to read the STORED `status` and re-derive "needs the captain"
// from a formula of its own. Both were wrong in the same direction, measured against the real
// store on 2026-09-02: 48 of 56 records say `status: "done"` and 34 of those did not finish.
// A coordinator surveying the fleet was being told that failed work was done.
//
// The dangerous half is the second one, and it is why this check exists rather than a one-line
// diff being trusted. The old formula was:
//
//     needsCaptain = !!escalation || status === "error" || (status === "done" && commits > 0)
//
// Feed a TRUTHFUL status into that and it gets worse, not better: a run that really failed but
// left commits behind stops matching `done && commits > 0`, so it comes out
// needsCaptain:false - work that needs a human, marked as not needing one. Fixing the status
// without the formula would have introduced exactly the suppression this repo's standing rule
// forbids: flag in doubt, never suppress a real signal.
//
// So the assertions below pin the pair together. Change one without the other and this goes
// red on the suppression, not on a cosmetic difference.
import { assembleFleetState } from "../../src/lib/fleetState.js";
import { annotateGoalRunRecord } from "../../src/lib/goalRunHistory.js";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const MATES = [{ mateId: "second-mate-1", name: "One", status: "active" }];

// Field names taken from what the real writer persists (upsertGoalRunRecord), not invented:
// a hand-written fixture missing a field the writer always sets is how this suite has fooled
// itself before.
function run(over) {
  return {
    goalRunId: over.goalRunId || "run-1",
    dispatchedBy: "second-mate-1",
    projectPath: "C:/work/widget-press",
    branchName: "helm/goal-run-1",
    commitCount: 0,
    status: "done",
    stoppedReason: "goal_reached",
    verifyCommand: null,
    updatedAt: 1,
    ...over,
  };
}

function only(records) {
  return assembleFleetState(MATES, records, Date.now()).dispatched[0];
}

// --- the suppression that made this a paired change ---------------------------------------
{
  // Really failed, and left commits behind. The old formula's `done && commits > 0` no longer
  // matches once the status is truthful, so this is the row that would quietly stop asking.
  const row = only([run({ status: "done", stoppedReason: "two_consecutive_failures", commitCount: 3 })]);
  ok(row.status !== "done", `a run that died failing is not reported as done (${row.status})`);
  ok(
    row.needsCaptain === true,
    "and it STILL needs the captain - a failed run with commits is the case a status-only fix would have silenced"
  );
}

// --- the stored status is not trusted ------------------------------------------------------
{
  const row = only([run({ status: "done", stoppedReason: "max_iterations_reached", commitCount: 2 })]);
  ok(row.status !== "done", `a run cut off at its iteration cap is not "done" just because the record says so (${row.status})`);
}
{
  const row = only([run({ status: "done", stoppedReason: "no_op_convergence", commitCount: 0 })]);
  ok(row.status !== "done", `nor is a run that converged having produced nothing (${row.status})`);
}
{
  // The one that really did finish, so the fix is not simply pessimism.
  const row = only([run({ status: "done", stoppedReason: "goal_reached", commitCount: 4 })]);
  ok(row.status === "done", `a run that reached its goal with commits IS done (${row.status})`);
  ok(row.needsCaptain === true, "and needs the captain, because finished work is work to look at");
}

// --- an escalation is never suppressed, whatever else is true ------------------------------
{
  const row = only([
    run({ status: "done", stoppedReason: "escalated", commitCount: 0, escalation: { signal: "ambiguity_reported" } }),
  ]);
  ok(row.needsCaptain === true, "an escalated run needs the captain even with no commits - that is what escalating means");
}

// --- liveness is a different question from outcome ----------------------------------------
{
  // The annotation reads a record still marked running as interrupted, which is right for a
  // corpse and wrong for a run genuinely in flight. Reclassifying it here would tell another
  // mate that live work is dead, and dead work is work to take over.
  const row = only([run({ status: "running", stoppedReason: null, commitCount: 1 })]);
  ok(row.status === "running", `a running run is still reported as running (${row.status})`);
  ok(row.needsCaptain === false, "and does not need the captain yet - it has not stopped");
}

// --- one rule, not a second spelling ------------------------------------------------------
{
  // Whether the caller pre-annotates or not must not change the answer. A caller-dependent
  // answer means there are two rules again, which is the whole defect being closed.
  const raw = run({ status: "done", stoppedReason: "two_consecutive_failures", commitCount: 3 });
  const pre = only([annotateGoalRunRecord(raw)]);
  const post = only([raw]);
  ok(
    pre.status === post.status && pre.needsCaptain === post.needsCaptain,
    `a pre-annotated record and a raw one get the same answer (${pre.status}/${pre.needsCaptain} vs ${post.status}/${post.needsCaptain})`
  );
}

// --- the derived fields do not leak into the picture --------------------------------------
{
  const row = only([run({})]);
  ok(!("outcome" in row), "the compact row does not carry the whole outcome object - this lands in a mate's context");
  ok(typeof row.status === "string" && typeof row.needsCaptain === "boolean", "just the two values a coordinator needs");
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: fleet state derives the outcome through one rule, and a failed run with commits still asks for the captain."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
