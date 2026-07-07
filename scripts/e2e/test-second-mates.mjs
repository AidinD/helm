// Unit test: second-mate identity (derived per (firstMate, project) from run
// history) + sessionId/name binding. Uses MAESTRO_SECOND_MATES_PATH so it never
// touches the real store.
//
// Run:  node scripts/e2e/test-second-mates.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "second-mates-test-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.MAESTRO_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");

const { secondMateId, deriveSecondMates, bindSecondMateSession, renameSecondMate, readBindings, DIRECT_FIRST_MATE } =
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
const a1 = secondMateId("mate_A", "D:/Repo/tgs-crewline");
const a2 = secondMateId("mate_A", "D:/Repo/tgs-crewline/"); // trailing sep
const a3 = secondMateId("mate_A", "d:/repo/TGS-Crewline"); // case
assert(a1 === a2 && a1 === a3, "secondMateId is stable across trailing-sep + case differences");
assert(secondMateId("mate_A", "D:/Repo/x") !== secondMateId("mate_B", "D:/Repo/x"), "different first mates -> different second mates for the same project");
assert(secondMateId("mate_A", "D:/Repo/x") !== secondMateId("mate_A", "D:/Repo/y"), "different projects -> different second mates for the same first mate");

// --- derive from run history ------------------------------------------------
const history = [
  { goalRunId: "r1", dispatchedBy: "mate_A", projectPath: "D:/Repo/tgs-crewline", status: "done" },
  { goalRunId: "r2", dispatchedBy: "mate_A", projectPath: "D:/Repo/tgs-crewline", status: "running" }, // same second mate, 2nd crew
  { goalRunId: "r3", dispatchedBy: "mate_A", projectPath: "D:/Repo/tgs-reinmaker", status: "running" }, // another second mate
  { goalRunId: "r4", dispatchedBy: "mate_B", projectPath: "D:/Repo/tgs-crewline", status: "done" }, // different first mate
  { goalRunId: "r5", dispatchedBy: null, projectPath: "D:/Repo/maestro", status: "running" }, // direct
  { goalRunId: "r6", dispatchedBy: "mate_A", projectPath: null, status: "running" }, // no project -> skipped
];
const sms = deriveSecondMates(history, {});
assert(sms.length === 4, "four distinct second mates derived (A/crewline, A/reinmaker, B/crewline, direct/maestro) - got " + sms.length);
const aCrew = sms.find((s) => s.firstMateId === "mate_A" && s.projectPath === "D:/Repo/tgs-crewline");
assert(aCrew && aCrew.crew.length === 2, "the A/crewline second mate owns both its crew runs");
assert(aCrew.name === "tgs-crewline", "second-mate name defaults to the project basename");
const direct = sms.find((s) => s.firstMateId === DIRECT_FIRST_MATE);
assert(direct && direct.projectPath === "D:/Repo/maestro", "a run with no first mate becomes a DIRECT second mate");
assert(!sms.some((s) => s.crew.some((c) => c.goalRunId === "r6")), "a run with no projectPath is skipped");

// --- session binding --------------------------------------------------------
bindSecondMateSession(aCrew.secondMateId, "sess-A");
assert(readBindings()[aCrew.secondMateId].sessionId === "sess-A", "bindSecondMateSession persists the sessionId");
const rebound = deriveSecondMates(history);
assert(rebound.find((s) => s.secondMateId === aCrew.secondMateId).sessionId === "sess-A", "derived second mate carries its bound sessionId");
// moving the same session to another second mate clears it from the first
bindSecondMateSession(sms.find((s) => s.projectPath === "D:/Repo/tgs-reinmaker").secondMateId, "sess-A");
assert(readBindings()[aCrew.secondMateId].sessionId === null, "binding a session elsewhere clears it from the previous second mate");

// --- rename -----------------------------------------------------------------
renameSecondMate(aCrew.secondMateId, "  Crewline lane  ");
assert(readBindings()[aCrew.secondMateId].name === "Crewline lane", "renameSecondMate trims + persists a custom name");
assert(deriveSecondMates(history).find((s) => s.secondMateId === aCrew.secondMateId).name === "Crewline lane", "derived second mate reflects the custom name over the project basename");

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
log(exitCode === 0 ? "VERIFY OK: deterministic identity, derivation, crew grouping, session binding, rename." : "VERIFY FAILED.");
process.exit(exitCode);
