// One path per concept: every stop reason the goal loop can produce is classified exactly
// once, and by a rule that lives in one place.
//
// This is direction 2 of the reliability block (task a498a8cf): "one path per concept, or a
// mirror that is tested". The block's own diagnosis was that Helm asserts things about itself
// that nothing checks, and that the drift always came from a concept spelled out twice -
// three copies of the outcome rule, two model paths for one seat, an id translation on read
// with no counterpart on write.
//
// The instance that prompted this check was self-inflicted and one day old. crewCleanup.js
// decided which finished crew runs a mate may clear away by matching
// `new Set(["goal_reached", "no_op_convergence"])` - two bare strings, no import from
// runOutcome.js, whose frozen TERMINAL_REASONS exists for exactly this reason and says so in
// its own comment. Nothing broke, and that is the point: rename a reason and the cleanup
// silently matches nothing, the feature quietly stops working, and every test stays green.
//
// So this check asserts the property rather than the spelling. Two things must hold:
//
//   TOTAL     - every reason in TERMINAL_REASONS is classified, either as clean or as
//               explicitly not clean. An unlisted reason is a decision made by omission, and
//               omission here means a run gets tidied or kept because nobody chose.
//   DISJOINT  - no reason is in both, because a reason that is both is a rule that depends on
//               which lookup ran first.
//
// The direction of the safe default matters and is asserted too: a reason that means the run
// was cut off, refused, or ran out of budget must never be clean, because clearing it removes
// the only trace of work a human was supposed to look at.
import { TERMINAL_REASONS } from "../../src/lib/runOutcome.js";
import { CLEAN_STOPS, NOT_CLEAN_STOPS, runsToAutoAcknowledge } from "../../src/lib/crewCleanup.js";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const canonical = [...TERMINAL_REASONS];
const clean = [...CLEAN_STOPS];
const notClean = Object.keys(NOT_CLEAN_STOPS);

ok(canonical.length > 0, `runOutcome.js still exports a non-empty list of stop reasons (${canonical.length})`);

// --- total -----------------------------------------------------------------------------
const unclassified = canonical.filter((r) => !CLEAN_STOPS.has(r) && !(r in NOT_CLEAN_STOPS));
ok(
  unclassified.length === 0,
  unclassified.length === 0
    ? "every stop reason the loop can produce is classified in crewCleanup.js"
    : `these stop reasons are classified NOWHERE, so whether their runs get tidied is an accident: ${unclassified.join(", ")}. Add each to CLEAN_STOPS or to NOT_CLEAN_STOPS with the reason a human would want to look.`
);

// The mirror of the same property: nothing is classified that the loop cannot produce. A
// stale entry here is how a rename hides - the old name keeps matching a set nobody reaches.
const phantom = [...clean, ...notClean].filter((r) => !canonical.includes(r));
ok(
  phantom.length === 0,
  phantom.length === 0
    ? "and nothing is classified that the loop cannot actually produce"
    : `these are classified but are not stop reasons any more, so they match nothing: ${phantom.join(", ")}`
);

// --- disjoint --------------------------------------------------------------------------
const both = clean.filter((r) => r in NOT_CLEAN_STOPS);
ok(both.length === 0, both.length === 0 ? "no reason is in both sets" : `in both sets, so the rule depends on lookup order: ${both.join(", ")}`);

// --- the safe default has a direction --------------------------------------------------
// Named individually rather than derived, because the whole risk is a NEW reason defaulting
// into the tidy side. These four are the ones whose meaning is "a human has not looked yet".
for (const reason of ["cancelled", "escalated", "quota_exhausted", "two_consecutive_failures", "max_iterations_reached"]) {
  if (!canonical.includes(reason)) {
    ok(false, `${reason} is no longer a stop reason - this check needs updating rather than deleting`);
    continue;
  }
  ok(!CLEAN_STOPS.has(reason), `${reason} is not clearable, because clearing it would erase the only trace of work worth reading`);
  ok(typeof NOT_CLEAN_STOPS[reason] === "string" && NOT_CLEAN_STOPS[reason].length > 10, `and it says WHY in a sentence rather than by omission`);
}

// --- the classification is the one the function actually uses ---------------------------
// A partition that no code path consults would be prose in a data structure's clothing. So
// drive the real function once per reason and check the decision follows the classification.
// The fixture below is hand-written, which is the weak part of this check and worth naming.
// The first version omitted `branchName` and every clean reason came back as "keep", which
// read exactly like a bug in the classification. It was not: the function also requires a
// branch, because a merge is a question about a branch. A hand-written fixture that is
// missing a field the real writer always sets makes a passing check meaningless and a
// failing one misleading, so if this ever fails, check the fixture against what actually
// writes goal-run history BEFORE believing the classification is wrong.
const merged = () => true;
for (const reason of canonical) {
  const runs = [
    {
      goalRunId: `run-${reason}`,
      dispatchedBy: "second-mate-1",
      status: "done",
      stoppedReason: reason,
      commitCount: 3,
      branchName: `helm/goal-${reason}`,
    },
  ];
  const picked = runsToAutoAcknowledge({ runs, isMerged: merged }).map((r) => r.goalRunId);
  const shouldPick = CLEAN_STOPS.has(reason);
  ok(
    picked.includes(`run-${reason}`) === shouldPick,
    `runsToAutoAcknowledge ${shouldPick ? "clears" : "keeps"} a merged run that stopped on ${reason}`
  );
}

console.log("");
console.log(
  fails === 0
    ? `VERIFY OK: all ${canonical.length} stop reasons classified exactly once, the refusals say why, and the function follows the classification.`
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
