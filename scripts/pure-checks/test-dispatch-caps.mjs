// Focused test: the first-mate width + depth cap predicates
// (src/lib/dispatchCaps.js), enforced at the single dispatch authority in
// main.js. Plain-node - the predicates are pure over a live-run snapshot
// `[{ dispatchedBy }]`, so no Electron is needed.
//
// Run:  node scripts/e2e/test-dispatch-caps.mjs
import { widthCapExceeded, depthCapExceeded, countLiveDispatchesForMate } from "../../src/lib/dispatchCaps.js";

function log(...a) {
  console.log("[dispatch-caps-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const WIDTH = 3;
const MATE = "mate_first";

// --- Width cap (3 concurrent dispatched runs per mate) ---
assert(countLiveDispatchesForMate([], MATE) === 0, "no live runs -> count 0");
assert(!widthCapExceeded([], MATE, WIDTH), "0 runs is under the width cap");

const twoRuns = [{ dispatchedBy: MATE }, { dispatchedBy: MATE }];
assert(countLiveDispatchesForMate(twoRuns, MATE) === 2, "counts this mate's runs only");
assert(!widthCapExceeded(twoRuns, MATE, WIDTH), "2 runs is still under the cap of 3");

const threeRuns = [{ dispatchedBy: MATE }, { dispatchedBy: MATE }, { dispatchedBy: MATE }];
assert(widthCapExceeded(threeRuns, MATE, WIDTH), "3 runs hits the cap -> refuse a 4th");

// Runs by a DIFFERENT mate don't count against this mate's width.
const mixed = [{ dispatchedBy: "mate_other" }, { dispatchedBy: "mate_other" }, { dispatchedBy: "mate_other" }, { dispatchedBy: MATE }];
assert(countLiveDispatchesForMate(mixed, MATE) === 1, "other mates' runs excluded from this mate's count");
assert(!widthCapExceeded(mixed, MATE, WIDTH), "another mate at cap does not block this mate");

// A null mate id (unattributable) is not width-capped here.
assert(!widthCapExceeded(threeRuns, null, WIDTH), "null mate id is not width-blocked (attributed elsewhere)");

// --- Depth cap (2: a dispatched run may not dispatch) ---
// Live runs carry their own goalRunId + the mate that dispatched them.
const liveByMate = [
  { goalRunId: "run_1", dispatchedBy: MATE },
  { goalRunId: "run_2", dispatchedBy: MATE },
];
// A depth-1 request from a first mate: caller is a mateId, never a live run's
// own goalRunId -> allowed, even though this mate already has runs in flight
// (that is the WIDTH cap's job, not depth). This is the case that exposed the
// earlier conflation bug.
assert(!depthCapExceeded(liveByMate, { dispatchedBy: MATE }), "first-mate request (depth 1) is allowed even with the mate's runs already live");

// A request whose caller id IS a live dispatched run's own goalRunId means a
// run is trying to dispatch (depth 3) -> refuse.
assert(depthCapExceeded(liveByMate, { dispatchedBy: "run_1" }), "request whose caller is itself a live dispatched run (by goalRunId) is refused (depth cap)");

// A request with no caller (direct/captain) is never depth-blocked.
assert(!depthCapExceeded(liveByMate, { dispatchedBy: null }), "captain/direct request (no caller) is never depth-blocked");

log(exitCode === 0 ? "VERIFY OK: width + depth caps enforced correctly." : "VERIFY FAILED.");
process.exit(exitCode);
