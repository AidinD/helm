// Which helm_* tools a seat gets, and that the split can say what it needs to say.
//
// THE SPLIT EXISTS TO EXPRESS ONE THING that a single shared array could not: two seats that
// share a root may hold different tools. Meta-home seats are named as of 2026-09-05, so the
// assistant and a supervisor will sit in the same folder with different manuals and different
// duties. A rule keyed on the ROOT would hand the supervisor the assistant's tools the moment
// it exists - and that is the 2026-07-15 scar restated, where rooting alone was tried as a
// discriminator and reverted because it mis-framed every ordinary chat kept in that folder.
//
// THE FAILURE THIS GUARDS is quiet in the way tonight's others were: narrowing a seat removes
// a capability from a session that may be open right now, and nothing errors - the tool is
// simply not offered, and the seat behaves as though it never occurred to it. So the checks
// below assert what each seat KEEPS as carefully as what it loses.
//
// Run:  node scripts/pure-checks/test-seat-tools-split.mjs
import fs from "node:fs";
import { helmToolsForSeat, seatToolsDifferBetween, DISPATCH_TOOLS, CROSS_PROJECT_TOOLS } from "../../src/lib/seatTools.js";

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const standing = helmToolsForSeat("standing");
const project = helmToolsForSeat("project");

// --- what each seat KEEPS, asserted first --------------------------------------------------
for (const t of DISPATCH_TOOLS) {
  ok(project.includes(t) && standing.includes(t), `every seat keeps ${t}`);
}
ok(
  project.includes("helm_report_up"),
  "a project seat keeps helm_report_up - it reports to its own seat now, so this is not a tool it stopped needing"
);

// --- what a project seat loses, and why ------------------------------------------------------
for (const t of CROSS_PROJECT_TOOLS) {
  ok(!project.includes(t), `a project seat cannot ${t} - reaching into another project is the removed tier`);
  ok(standing.includes(t), `while a standing seat can ${t}, which is what that seat is for`);
}

// --- THE PROPERTY THE SPLIT EXISTS FOR --------------------------------------------------------
ok(
  seatToolsDifferBetween("standing", "project"),
  "two seat kinds can hold different toolsets - if this ever fails the split has collapsed back into one list"
);
ok(
  !seatToolsDifferBetween("standing", "assistant"),
  "and the assistant is a standing seat today, so it is not a special case of its own"
);

// --- an unclassified seat gets FEWER tools, never the union ------------------------------------
const unknown = helmToolsForSeat("something-nobody-has-defined-yet");
ok(
  JSON.stringify(unknown.slice().sort()) === JSON.stringify(DISPATCH_TOOLS.slice().sort()),
  `an unknown kind gets the dispatch set and nothing more (${unknown.length})`
);
ok(
  !CROSS_PROJECT_TOOLS.some((t) => unknown.includes(t)),
  "so a seat nobody has classified cannot reach into another project by accident"
);
ok(helmToolsForSeat(undefined).length === DISPATCH_TOOLS.length, "and neither can one with no kind at all");

// --- the wiring, read from source with comments stripped ---------------------------------------
//
// WHAT THIS CANNOT PROVE: that a launched seat actually receives these, which needs a running
// app. It proves that no launch path still hands out the single old array.
const mainSrc = fs
  .readFileSync(new URL("../../src/main.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

ok(/helmToolsForSeat\("standing"\)/.test(mainSrc), "the standing set is derived from the shared rule, not retyped");
ok(/helmToolsForSeat\("project"\)/.test(mainSrc), "and so is the project set");
ok(
  /allowedTools = \[\.\.\.PROJECT_SEAT_TOOLS/.test(mainSrc),
  "a project seat's launch uses the project set"
);
ok(/allowedTools: PROJECT_SEAT_TOOLS/.test(mainSrc), "and so does a relay into one");
ok(
  /const ASSISTANT_ALLOWED_TOOLS = \[\.\.\.STANDING_SEAT_TOOLS/.test(mainSrc),
  "the assistant builds on the standing set plus its OWN stores, so a second standing seat does not inherit them by widening this one"
);

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - a project seat dispatches and reports up, only a standing seat reaches across projects, and the split can express both");
