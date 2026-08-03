// Every crew row must have a way out: either a Done button, or already gone.
//
// A row could reach a state with neither. The filter that drops acknowledged terminal
// runs read the PERSISTED record; the row rendered the LIVE/rehydrated view. Those
// differ for exactly one case - an INTERRUPTED run, where no process ever wrote a
// terminal status, so the record still says "running" while the view has already
// reclassified it as "interrupted". Result: the filter kept it (not terminal, said the
// record) and the row offered no Done button (already acknowledged, said the view).
// the captain, on the last row he could not clear: "vet inte hur jag ska göra med den".
//
// The comment in fleetSecondMateEl already described this dead end in its OTHER shape,
// fixed at the time for the record's own statuses. One instance closed, the class left
// open - which is the failure mode this repo keeps hitting, so the invariant is
// asserted here directly rather than the two call sites being spot-checked.
//
// Run:  node scripts/e2e/test-crew-row-clearable.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const code = stripComments(rSrc);

// --- the invariant, driven through the real predicates ----------------------
const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};
const env = new Function(
  "acknowledged",
  `${grab("isTerminalRun")}
   const isGoalRunAcknowledged = (id) => acknowledged.includes(id);
   const keepCrew = (r) => !(isTerminalRun(r) && isGoalRunAcknowledged(r.goalRunId));
   const hasDoneButton = (r) => !r.isSubAgent && isTerminalRun(r) && !isGoalRunAcknowledged(r.goalRunId);
   return { keepCrew, hasDoneButton, isTerminalRun };`
);

// The four shapes a run can be in, as the ROW sees them (i.e. after crewLiveRun).
const CASES = [
  { name: "running, unacknowledged", run: { goalRunId: "a", status: "running" }, ack: [] },
  { name: "done, unacknowledged", run: { goalRunId: "b", status: "done" }, ack: [] },
  { name: "done, acknowledged", run: { goalRunId: "c", status: "done" }, ack: ["c"] },
  { name: "interrupted, unacknowledged", run: { goalRunId: "d", status: "interrupted" }, ack: [] },
  { name: "interrupted, ACKNOWLEDGED - the stuck one", run: { goalRunId: "e", status: "interrupted" }, ack: ["e"] },
  { name: "error, acknowledged", run: { goalRunId: "f", status: "error" }, ack: ["f"] },
];

for (const c of CASES) {
  const { keepCrew, hasDoneButton } = env(c.ack);
  const shown = keepCrew(c.run);
  const clearable = hasDoneButton(c.run);
  const live = c.run.status === "running";
  // THE INVARIANT: a row that is shown must be either still live, or clearable.
  ok(
    !shown || live || clearable,
    `${c.name}: shown=${shown} clearable=${clearable} live=${live} - no dead end`
  );
}

// --- and the ordering that made it possible ---------------------------------
// The filter must judge the run the row will SHOW. Both crew lists map first.
const sites = [...code.matchAll(/\.crew[\s\n]*\.(map|filter)\(/g)].map((m) => m[1]);
ok(sites.length >= 2, `both crew lists were found (${sites.join(", ")})`);
ok(
  sites.every((first) => first === "map"),
  `every crew list maps to the live view BEFORE filtering (${sites.join(", ")})`
);
ok(
  !/\.crew[\s\n]*\.filter\(/.test(code),
  "no crew list filters the raw persisted records any more"
);

// A row's own status text and its Done button must come from the same object, or the
// two can disagree again by a different route.
const rowAt = code.indexOf("function fleetCrewItemEl(");
ok(rowAt >= 0, "the crew-row builder is where this expects it");
const rowFn = code.slice(rowAt, code.indexOf("\n}", rowAt));
ok(
  /isTerminalRun\(run\)/.test(rowFn) && /crewRunHeadline\(run\.goal\)/.test(rowFn),
  "the Done button and the row's own label are both derived from the same `run` object"
);
ok(
  !/isTerminalRun\(rec\)|isTerminalRun\(record\)/.test(rowFn),
  "and never from the raw record alongside it"
);

// --- and the NODE itself must have a way off the board ----------------------
// The Archive control was rendered only for a second mate backed by a real session.
// The auto lane's project row never has one - it is a grouping row for its autopilot
// runs - so it had no controls at all, and "hur arkiverar jag 2nd maten (helm) fran
// auto?" had no answer (the captain, 2026-08-03). Same shape as the crew-row dead end one
// level up: something visible with no way to act on it.
{
  const at = code.indexOf("function fleetSecondMateEl(");
  const nextFn = code.indexOf("\nasync function", at);
  const fn = code.slice(at, nextFn > at ? nextFn : at + 20000);
  const guard = fn.indexOf("if (backingSession) {");
  ok(guard >= 0, "the session-backed branch is still there");
  const elseAt = fn.indexOf("} else {", guard);
  ok(elseAt > guard, "and a session-LESS node now has its own branch");
  const elseBranch = fn.slice(elseAt, elseAt + 1800);
  ok(/archiveSecondMate\(sm\.secondMateId\)/.test(elseBranch), "which offers Archive, parking the row via the second-mate channel");
  ok(/fleet-archive-btn/.test(elseBranch), "styled as the same Archive control as everywhere else, not a new-looking button");
  // One request, not two: calling finishSecondMateArchive here would repeat it.
  ok(
    (elseBranch.match(/archiveSecondMate\(/g) || []).length === 1,
    "and sends the archive request exactly once"
  );
  ok(/refreshDashboardIfVisible\(\)/.test(elseBranch), "then repaints, so the row goes without waiting for a poll");
}

console.log(
  exit === 0
    ? "VERIFY OK: no crew row can be shown without either being live or offering a way to clear it, and both crew lists judge the run the user is looking at."
    : "VERIFY FAILED."
);
process.exit(exit);
