// No fixture may invent a stopped-reason the goal loop cannot produce.
//
// WHY. On 2026-08-18 a test was found asserting against `stoppedReason: "completed"`,
// which nothing in the app can emit. It was fixed in that one file. Two days later the
// same fiction was still in eleven others - "completed" six times, "converged" four,
// "done" twice - and three of those tests were failing because of it while the rest
// passed for the wrong reason, describing a world the app cannot enter. That is failure
// 12 on ship-review's own list, verbatim: one instance fixed, the class left open.
//
// So this closes the class in two steps, and the first matters more than the second:
//
//   1. The canonical list in runOutcome.js is pinned against goalOrchestrator.js's OWN
//      SOURCE. A list maintained by hand beside the loop is just a second place to be
//      wrong; this fails if the loop gains or loses a terminal reason and nobody
//      updates the list.
//   2. Every fixture in scripts/e2e is scanned against that list.
//
// Comments are stripped before scanning. A source-scan check that matches its own
// explanatory comment is failure 2 on the same list, and this file's own header names
// the fictional values - so without stripping, this test would fail on itself.
//
// A value that is deliberately NOT real - there is one, testing the branch for an
// outcome nobody can name - has to be declared below. That keeps the escape hatch
// explicit and countable instead of being whatever slipped through.
//
// Run:  node scripts/e2e/test-stopped-reasons-are-real.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TERMINAL_REASONS, classifyRunOutcome } from "../../src/lib/runOutcome.js";

const E2E = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(E2E, "..", "..");

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    failures++;
  }
};

// Values a fixture is allowed to invent, each because it is testing what happens with a
// reason the app does NOT recognise. Adding to this list is a deliberate act.
const DELIBERATE_FICTION = new Set(["some_reason_nobody_wrote_yet"]);

// --- 1. the list must match the loop --------------------------------------
const loopSrc = fs.readFileSync(path.join(REPO, "src", "lib", "goalOrchestrator.js"), "utf8");
const emitted = new Set([...loopSrc.matchAll(/stoppedReason\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]));

ok(emitted.size > 0, `found the loop's own assignments to read (${emitted.size})`);
const missingFromList = [...emitted].filter((r) => !TERMINAL_REASONS.includes(r));
const notEmitted = TERMINAL_REASONS.filter((r) => !emitted.has(r));
ok(
  missingFromList.length === 0,
  `every reason the loop assigns is in TERMINAL_REASONS${missingFromList.length ? ` - MISSING: ${missingFromList.join(", ")}` : ""}`
);
ok(
  notEmitted.length === 0,
  `and nothing in TERMINAL_REASONS is stale${notEmitted.length ? ` - the loop never assigns: ${notEmitted.join(", ")}` : ""}`
);
// This assertion used to say the loop had NO goal-reached state, and that it was the
// reason "it stopped" must never render as "it succeeded". It was true for a long time and
// stopped being true on 2026-08-21 - the loop can now be told the goal is met, and stops
// for that reason. Which is what the assertion was FOR: it named the absence so that
// closing it would show up here rather than quietly.
//
// It flips rather than being deleted, because the property that actually matters survives
// the change: exactly ONE reason may mean success, and every other must be an ending.
// Two reasons that both read as "done" is how a run that merely ran out of iterations
// comes to look finished.
ok(TERMINAL_REASONS.includes("goal_reached"), "the loop HAS a goal-reached state, so a finished run can say it finished");
const successish = TERMINAL_REASONS.filter((r) => /^(done|completed|complete|success|succeeded|converged|finished|goal_reached)$/.test(r));
ok(
  successish.length === 1 && successish[0] === "goal_reached",
  `and it is the only reason that can mean success - the rest are endings (${JSON.stringify(successish)})`
);
// It must also be classified, not merely listed. A reason in the list that
// classifyRunOutcome does not know falls into the "unrecognised" branch and renders as a
// warning, which for the one success outcome would be exactly backwards.
const reached = classifyRunOutcome({ stoppedReason: "goal_reached", commitCount: 2, branchName: "helm/goal-x" });
ok(reached.status === "done", `a goal-reached run with commits classifies as done (${reached.status})`);
ok(reached.needsCaptain === null, "and raises no alarm - nothing went wrong");
ok(!!reached.awaitingReview, "while still announcing that the commits want review");
const reachedEmpty = classifyRunOutcome({ stoppedReason: "goal_reached", commitCount: 0 });
ok(reachedEmpty.status !== "done", `but a goal-reached run that committed NOTHING is not done (${reachedEmpty.status})`);
ok(!!reachedEmpty.needsCaptain, "and does raise an alarm - claiming success while changing nothing is the case worth checking");

// --- 1b. goal_reached is WIRED, not just listed ---------------------------
// Source-level, because reaching this branch for real needs a live model run (runGoal has
// no test that drives it - see test-dispatch-loop, which does and costs tokens). So these
// assert the wiring the branch depends on: without them, "goal_reached" could sit in the
// list, classify correctly, and never once be assigned.
{
  // The agent has to be ASKED. A reason nothing can report is a reason nothing produces.
  ok(/"goalReached"/.test(loopSrc), "the iteration schema has a goalReached field");
  const required = loopSrc.match(/required:\s*\[([^\]]*)\]/);
  ok(!!required && /goalReached/.test(required[1]), "and it is REQUIRED, so an iteration cannot quietly omit it");
  ok(/goalReached:true ONLY when the WHOLE goal/.test(loopSrc), "the rules tell the agent it means the whole goal, not this step");

  // Only an ACCEPTED iteration may claim it. A success:false iteration has its file
  // changes discarded, so its opinion describes work that no longer exists.
  // Assignments only - the `let ... = false` declaration is not a claim.
  const claims = [...loopSrc.matchAll(/(^|[^t] )goalReachedClaimed = ([^;]+);/gm)].map((m) => m[2].trim()).filter((c) => c !== "false");
  ok(claims.length === 2, `the claim is set in the two success branches and nowhere else (${claims.length})`);
  ok(
    claims.every((c) => c === "outcome.result.goalReached === true"),
    `and only from the agent's own explicit true, never coerced from a truthy value (${JSON.stringify(claims)})`
  );

  // ORDER. A finished run whose last iteration also changed nothing would otherwise be
  // reported as "it stopped making further changes" - the vaguer of two true statements.
  const atGoal = loopSrc.indexOf('stoppedReason = "goal_reached"');
  const atNoOp = loopSrc.indexOf('stoppedReason = "no_op_convergence"');
  ok(atGoal > 0 && atNoOp > 0 && atGoal < atNoOp, "and it is checked BEFORE convergence, so 'done' wins over 'it stopped changing things'");
}

// --- 2. no fixture may invent one ----------------------------------------
/** Strip line and block comments so the scan cannot match an explanation of the bug. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const files = fs.readdirSync(E2E).filter((f) => f.endsWith(".mjs"));
const offences = [];
let scanned = 0;
let literals = 0;
for (const file of files) {
  const src = stripComments(fs.readFileSync(path.join(E2E, file), "utf8"));
  scanned++;
  for (const m of src.matchAll(/stoppedReason\s*:\s*"([a-zA-Z_]+)"/g)) {
    literals++;
    const value = m[1];
    if (!TERMINAL_REASONS.includes(value) && !DELIBERATE_FICTION.has(value)) {
      offences.push(`${file}: "${value}"`);
    }
  }
}

ok(scanned > 50, `scanned the fixture suite (${scanned} files, ${literals} stopped-reason literals)`);
ok(
  offences.length === 0,
  offences.length === 0
    ? "no fixture seeds a stopped-reason the loop cannot produce"
    : `fixtures seed values the app cannot produce: ${offences.join("; ")}`
);

// The scan has to be able to fail, or it is decoration. Prove it against a value that
// is definitely not real, through the same code path the real scan uses.
const probe = stripComments(`// stoppedReason: "completed" in a comment must be ignored\nconst x = { stoppedReason: "totally_made_up" };`);
const probeHits = [...probe.matchAll(/stoppedReason\s*:\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]);
ok(probeHits.length === 1 && probeHits[0] === "totally_made_up", `the scan sees code and ignores comments (saw ${JSON.stringify(probeHits)})`);
ok(!TERMINAL_REASONS.includes("totally_made_up"), "and would reject it");

console.log(
  failures === 0
    ? "\nVERIFY OK: the canonical stopped-reason list matches the loop, and no fixture invents one."
    : `\nVERIFY FAILED (${failures}).`
);
process.exit(failures === 0 ? 0 : 1);

// Keep pathToFileURL referenced so a future dynamic import in here uses the right
// helper rather than a hand-rolled path-to-URL swap (see run-tests.mjs, same day).
void pathToFileURL;
