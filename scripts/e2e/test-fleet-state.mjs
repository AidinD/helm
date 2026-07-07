// Unit test: assembleFleetState builds the compact cross-mate view a first mate
// surveys (active mates + every mate's dispatched work + rollups).
//
// Run:  node scripts/e2e/test-fleet-state.mjs
import { assembleFleetState } from "../../src/lib/fleetState.js";

function log(...a) {
  console.log("[fleet-state-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const mates = [
  { mateId: "mate_A", name: "Captain Nemo", slot: 0 },
  { mateId: "mate_B", name: "Hector Barbossa", slot: 1 },
];
const history = [
  { dispatchedBy: "mate_A", projectPath: "D:/Repo/nw-skiff", status: "running", updatedAt: 300 },
  { dispatchedBy: "mate_A", projectPath: "D:/Repo/nw-halyard", status: "done", commitCount: 3, branchName: "b1", updatedAt: 200 },
  { dispatchedBy: "mate_B", projectPath: "D:/Repo/jot", status: "error", updatedAt: 250 },
  { dispatchedBy: null, projectPath: "D:/Repo/x", status: "running", updatedAt: 999 }, // direct, no mate -> excluded
  { dispatchedBy: "mate_A", projectPath: null, status: "running", updatedAt: 100 }, // no project -> excluded
];

const fs = assembleFleetState(mates, history, 12345);

assert(fs.updatedAt === 12345, "carries the snapshot timestamp");
assert(fs.mates.length === 2 && fs.mates[0].name === "Captain Nemo", "lists the active mates");
assert(fs.dispatched.length === 3, "only mate-dispatched runs with a project are included (got " + fs.dispatched.length + ")");
assert(fs.dispatched[0].project === "nw-skiff" && fs.dispatched[0].updatedAt === 300, "dispatched runs are newest-first");
assert(fs.dispatched.every((d) => typeof d.project === "string" && !d.project.includes("/")), "project is the basename, not a full path");
const rein = fs.dispatched.find((d) => d.project === "nw-halyard");
assert(rein.needsCaptain === true && rein.commits === 3, "a done run with commits is flagged needsCaptain with its commit count");
const err = fs.dispatched.find((d) => d.project === "jot");
assert(err.needsCaptain === true && err.mate === "mate_B", "an errored run is needsCaptain, attributed to its mate (the OTHER mate is visible)");
assert(fs.liveByProject["nw-skiff"] === 1 && !fs.liveByProject["nw-halyard"], "liveByProject rolls up only running runs");
assert(fs.needsCaptainByProject["jot"] === 1 && fs.needsCaptainByProject["nw-halyard"] === 1, "needsCaptainByProject rolls up runs awaiting the captain");

log(exitCode === 0 ? "VERIFY OK: compact cross-mate fleet state." : "VERIFY FAILED.");
process.exit(exitCode);
