// The folder a check sits in must be true about what running it does.
//
// WHY THIS EXISTS AT ALL
// Until 2026-09-03 the lane split was derived from the source on every run: a check was
// app-lane if it imported the CDP harness. That was right about refusing a hand-maintained
// list and wrong about where the fact should live. Every check lived in one folder called
// `e2e`, 162 of them never started the app, and so a reader - and a counting script, and an
// agent asked to measure the suite - read the whole thing as end-to-end. A measurement built
// on that reported "0 unit tests" for a suite whose fast layer holds most of its assertions.
//
// So the folder is the classifier now, and this is the reason that is safe rather than a
// second list waiting to disagree with the first: the folder decides, and this check proves
// the folder is telling the truth. One list plus a proof.
//
// THE FAILURE IT PREVENTS, in both directions and they cost different things:
//   a check in pure-checks/ that DOES start the app - the pure lane silently grows an
//     Electron launch, its 45 seconds quietly become minutes, and the lane that is supposed
//     to be runnable anywhere stops being runnable on a machine with no display.
//   a check in app-checks/ that does NOT start the app - it pays a ~4.6 second Electron
//     launch on every run for nothing. Cheap per check and the reason the lane is eleven
//     minutes long in aggregate.
//
// The import pattern is imported from ci-fast-lane rather than written again here. A copy
// would make this a check that agrees with itself.
//
// Run:  node scripts/pure-checks/test-lane-folders-tell-the-truth.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_APP } from "../ci-fast-lane.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(scripts, "app-checks");
const PURE_DIR = path.join(scripts, "pure-checks");
const LIB_DIR = path.join(scripts, "checks-lib");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const checksIn = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
    .sort();

const app = checksIn(APP_DIR);
const pure = checksIn(PURE_DIR);
const launches = (dir, f) => LAUNCHES_APP.test(fs.readFileSync(path.join(dir, f), "utf8"));

// --- the two directions ---------------------------------------------------------------
const quietLaunchers = pure.filter((f) => launches(PURE_DIR, f));
ok(
  quietLaunchers.length === 0,
  `nothing in pure-checks/ starts the app${
    quietLaunchers.length ? ` - move these to app-checks/: ${quietLaunchers.join(", ")}` : ""
  }`
);

const idleLaunchers = app.filter((f) => !launches(APP_DIR, f));
ok(
  idleLaunchers.length === 0,
  `nothing in app-checks/ sits there without starting the app${
    idleLaunchers.length ? ` - each pays ~4.6s per run for nothing: ${idleLaunchers.join(", ")}` : ""
  }`
);

// --- and nothing is stranded ------------------------------------------------------------
// A check outside both folders runs in NO lane. That is worse than being in the wrong one,
// because a wrong lane is slow or noisy while a missing lane is silent: the file still looks
// like a test, still passes review, and is never executed by anything.
const legacy = path.join(scripts, "e2e");
ok(!fs.existsSync(legacy), "the old scripts/e2e folder is gone rather than lingering half-emptied");

const strays = fs
  .readdirSync(scripts, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.startsWith("test-") && e.name.endsWith(".mjs"))
  .map((e) => e.name);
ok(strays.length === 0, `no check sits loose in scripts/ where no lane would run it${strays.length ? `: ${strays.join(", ")}` : ""}`);

const libChecks = fs.existsSync(LIB_DIR) ? checksIn(LIB_DIR) : [];
ok(
  libChecks.length === 0,
  `no check hides in checks-lib/, which holds shared machinery and is not a lane${libChecks.length ? `: ${libChecks.join(", ")}` : ""}`
);

// --- the shared machinery is reachable from both -----------------------------------------
// The whole point of a third folder. If the harness moved into one of the lanes, the other
// lane's imports would break, and the guard should say so before 156 checks do.
for (const helper of ["harness.mjs", "live-gate.mjs", "mutate.mjs"]) {
  ok(fs.existsSync(path.join(LIB_DIR, helper)), `checks-lib/ holds ${helper}, reachable from either lane as ../checks-lib/${helper}`);
}

// --- both lanes are non-trivial -----------------------------------------------------------
// A split that quietly emptied one side would pass every assertion above. This is the
// sanity floor, not a coverage target: the numbers only have to be plausible.
ok(app.length > 50, `app-checks/ holds a real lane (${app.length})`);
ok(pure.length > 50, `pure-checks/ holds a real lane (${pure.length})`);

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`VERIFY OK - ${pure.length} pure and ${app.length} app checks, each in the folder its behaviour earns`);
