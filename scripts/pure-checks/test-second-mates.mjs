// Unit test: second-mate identity (derived per (firstMate, project) from run
// history) + sessionId/name binding. Uses HELM_SECOND_MATES_PATH so it never
// touches the real store.
//
// Run:  node scripts/e2e/test-second-mates.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "second-mates-test-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");

const { secondMateId, deriveSecondMates, bindSecondMateSession, renameSecondMate, readBindings, proposeSecondMate, DIRECT_FIRST_MATE, PROJECT_LANE, AUTO_LANE } =
  await import("../../src/lib/secondMates.js");

function log(...a) {
  console.log("[second-mates-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

// --- deterministic identity -------------------------------------------------
// The first argument became a LANE rather than a dispatcher on 2026-09-04: with the tier above
// a project seat removed, a project's node stopped depending on who dispatched to it. The
// assertion that two first mates get two nodes for one project was the OLD rule and is now the
// defect, so it is replaced rather than relaxed - see the pair below.
const a1 = secondMateId(PROJECT_LANE, "D:/Repo/nw-skiff");
const a2 = secondMateId(PROJECT_LANE, "D:/Repo/nw-skiff/"); // trailing sep
const a3 = secondMateId(PROJECT_LANE, "d:/repo/NW-Skiff"); // case
assert(a1 === a2 && a1 === a3, "secondMateId is stable across trailing-sep + case differences");
assert(
  secondMateId(PROJECT_LANE, "D:/Repo/x") !== secondMateId(PROJECT_LANE, "D:/Repo/y"),
  "different projects -> different nodes"
);
assert(
  secondMateId(PROJECT_LANE, "D:/Repo/x") !== secondMateId(AUTO_LANE, "D:/Repo/x"),
  "the two LANES of one project are two nodes - which is what keeps an auto run out of the manual row"
);
// The invariant that stops the removed tier growing back through the surviving parameter. A
// reader who takes the first argument for a dispatcher gets an error, not a node nothing else
// can find.
let refusedDispatcher = false;
try {
  secondMateId("mate_A", "D:/Repo/x");
} catch {
  refusedDispatcher = true;
}
assert(refusedDispatcher, "passing a dispatcher is refused outright rather than minting an unreachable node");

// --- derive from run history ------------------------------------------------
const history = [
  { goalRunId: "r1", dispatchedBy: "mate_A", projectPath: "D:/Repo/nw-skiff", status: "done" },
  { goalRunId: "r2", dispatchedBy: "mate_A", projectPath: "D:/Repo/nw-skiff", status: "running" }, // same second mate, 2nd crew
  { goalRunId: "r3", dispatchedBy: "mate_A", projectPath: "D:/Repo/nw-halyard", status: "running" }, // another second mate
  { goalRunId: "r4", dispatchedBy: "mate_B", projectPath: "D:/Repo/nw-skiff", status: "done" }, // different first mate
  { goalRunId: "r5", dispatchedBy: null, projectPath: "D:/Repo/helm", status: "running" }, // direct
  { goalRunId: "r6", dispatchedBy: "mate_A", projectPath: null, status: "running" }, // no project -> skipped
];
// THREE, NOT FOUR, and the missing one is the whole change. Runs r1, r2 and r4 are all in
// nw-skiff; two were dispatched by mate_A and one by mate_B, and before 2026-09-04 that made
// two rows for one repository. A project has one node per lane now, so they share it.
//
// The fixture deliberately keeps the two different dispatchers rather than simplifying them
// away: the property being asserted is that the dispatcher no longer separates them, and a
// fixture with one dispatcher could not tell that from a fixture that never tested it.
const sms = deriveSecondMates(history, {});
assert(
  sms.length === 3,
  "three nodes derived - one per project (skiff, halyard, helm), not one per dispatcher - got " + sms.length
);
const aCrew = sms.find((s) => s.projectPath === "D:/Repo/nw-skiff");
assert(aCrew && aCrew.crew.length === 3, "the skiff node owns all three of its runs, whoever dispatched them");
assert(
  !sms.some((s) => s.firstMateId === "mate_A" || s.firstMateId === "mate_B"),
  "and no node names a dispatcher as its parent - that is the project's seat's job, or the lane's"
);
assert(aCrew.name === "nw-skiff", "the node's name defaults to the project basename");
const direct = sms.find((s) => s.projectPath === "D:/Repo/helm");
assert(direct && direct.firstMateId === DIRECT_FIRST_MATE, "with no seat opened for it, a node's parent is the lane");
assert(!sms.some((s) => s.crew.some((c) => c.goalRunId === "r6")), "a run with no projectPath is skipped");

// --- session binding --------------------------------------------------------
bindSecondMateSession(aCrew.secondMateId, "sess-A");
assert(readBindings()[aCrew.secondMateId].sessionId === "sess-A", "bindSecondMateSession persists the sessionId");
const rebound = deriveSecondMates(history);
assert(rebound.find((s) => s.secondMateId === aCrew.secondMateId).sessionId === "sess-A", "derived second mate carries its bound sessionId");
// moving the same session to another second mate clears it from the first
bindSecondMateSession(sms.find((s) => s.projectPath === "D:/Repo/nw-halyard").secondMateId, "sess-A");
assert(readBindings()[aCrew.secondMateId].sessionId === null, "binding a session elsewhere clears it from the previous second mate");

// --- rename -----------------------------------------------------------------
renameSecondMate(aCrew.secondMateId, "  Skiff lane  ");
assert(readBindings()[aCrew.secondMateId].name === "Skiff lane", "renameSecondMate trims + persists a custom name");
assert(deriveSecondMates(history).find((s) => s.secondMateId === aCrew.secondMateId).name === "Skiff lane", "derived second mate reflects the custom name over the project basename");

// --- Phase 2: a second mate that dispatches its OWN crew (ship-review phantom
// fix). A crew run whose dispatchedBy is a SECOND MATE id must attach to that
// second mate, NOT mint a phantom node hashed from the second-mate id.
const smC = proposeSecondMate("mate_C", "D:/Repo/proj-c", { brief: "c work" });
assert(smC.secondMateId.startsWith("sm_"), "proposeSecondMate returns an sm_ id");
const crewHistory = [
  { goalRunId: "cr1", dispatchedBy: smC.secondMateId, projectPath: "D:/Repo/proj-c", status: "running" },
  { goalRunId: "cr2", dispatchedBy: smC.secondMateId, projectPath: "D:/Repo/proj-c", status: "done" },
];
const derivedC = deriveSecondMates(crewHistory);
const cNode = derivedC.find((s) => s.secondMateId === smC.secondMateId);
assert(cNode && cNode.crew.length === 2, "crew dispatched by a second mate attaches to THAT second mate (both runs)");
assert(cNode && cNode.firstMateId === "mate_C", "the second mate keeps its real first-mate parent from the binding (not a phantom)");
assert(!derivedC.some((s) => s.firstMateId && s.firstMateId.startsWith("sm_")), "no phantom node whose firstMateId is itself a second mate");
// The phantom this used to guard against can no longer be CONSTRUCTED: secondMateId refuses
// anything that is not a lane, so hashing a node id into a second node id throws rather than
// producing one. The property is therefore asserted directly - every derived node for this
// project is the project lane node - which is stronger than the old negative and does not
// depend on being able to build the bad value in order to look for it.
assert(
  derivedC.every((s) => s.secondMateId === secondMateId(PROJECT_LANE, "D:/Repo/proj-c")),
  "every node for the project IS the project lane node - a re-hashed phantom cannot even be minted now"
);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
log(exitCode === 0 ? "VERIFY OK: deterministic identity, derivation, crew grouping, session binding, rename." : "VERIFY FAILED.");
process.exit(exitCode);
