// Which projects get a seat opened for them when the Captain widget goes.
//
// THIS IS THE SAFETY STEP OF THE REMOVAL, not a tidy-up. A project only gets a seat when the
// captain picks it in "+ Session", so every project he worked in before that existed has a
// node parented to the lane - and the Captain widget was the only surface that rendered one.
// Remove the widget without this pass and a live session leaves the board while it keeps
// running, which is precisely what the decision forbids: a seat with live work always has a
// widget, because the board's crowding is the governor on concurrency and a seat that can run
// hidden makes the board stop showing the cost.
//
// BOTH FAILURES ARE QUIET, which is why the rule is a unit rather than a loop inside a startup
// handler. Too few, and live work has nowhere to appear. Too many, and the board fills with
// rows for projects nobody opened - inflating the very count the governor is measured by.
//
// Run:  node scripts/pure-checks/test-seat-backfill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-backfill-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

const { projectsNeedingSeats } = await import("../../src/lib/seatBackfill.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const META = "D:/Dropbox/Claude";
const ALPHA = "D:/Repo/alpha";
const BETA = "D:/Repo/beta";
const GONE = "D:/Repo/deleted";

// Everything but GONE exists. Passed in rather than touching the disk, so the rule is checked
// and not the filesystem.
const exists = (p) => p !== GONE;
const call = (nodes) => projectsNeedingSeats(nodes, { metaHomeRoot: META, exists });

// --- what earns a seat ---------------------------------------------------------------------
ok(
  call([{ projectPath: ALPHA, sessionId: "s1", crew: [] }]).length === 1,
  "a node with a live session earns a seat"
);
ok(
  call([{ projectPath: ALPHA, sessionId: null, crew: [{ id: "r1" }] }]).length === 1,
  "and so does one with crew but no session - an autopilot run under it is work"
);

// --- what does not -------------------------------------------------------------------------
ok(
  call([{ projectPath: ALPHA, sessionId: null, crew: [] }]).length === 0,
  "a proposal nobody engaged earns nothing - it needs no surface until somebody uses it"
);
ok(
  call([{ projectPath: ALPHA, sessionId: "s1", crew: [], startedBy: "auto" }]).length === 0,
  "an AUTO node earns nothing: it has its own lane and its own widget, which is not being removed"
);
ok(
  call([{ projectPath: META, sessionId: "s1", crew: [] }]).length === 0,
  "the meta-home is not a project, so a chat kept there never becomes a seat"
);
// A DELETED CHECKOUT: it depends on whether anything is still running in it, and this pair is
// the answer to "what happens to a node the backfill cannot open a folder for". Found in the
// real history rather than imagined - a node with a live session whose worktree had been
// removed, which the first version of this rule turned away and thereby hid.
ok(
  call([{ projectPath: GONE, sessionId: "s1", crew: [] }]).length === 1,
  "a deleted checkout with a LIVE SESSION still earns a seat - hiding running work is worse than a row that explains itself"
);
ok(
  call([{ projectPath: GONE, sessionId: null, crew: [{ id: "r1" }] }]).length === 0,
  "but finished crew in a folder that is gone earns nothing - there is nothing left to lose sight of"
);
// A NODE WITH NO PROJECT cannot reach here from the app: deriveSecondMates skips a run with no
// projectPath, and the union that adds proposal-only nodes requires one on the binding. The
// guard stays anyway and is asserted, because "cannot happen" is a claim about today's callers
// and this function is now imported by a startup path that will grow more of them.
ok(call([{ sessionId: "s1", crew: [] }]).length === 0, "a node with no project at all is skipped rather than crashing");
ok(call([]).length === 0 && call(null).length === 0, "no nodes, no seats, and no crash on nothing");

// --- AN ARCHIVED SESSION IS NOT WORK ----------------------------------------------------------
// The first run of this rule opened eight seats, and one of them was earned by a session the
// captain had archived 53 days earlier. A binding records the session that LAST embodied a
// node; archiving is him saying he is done with it. The rule asked "is there a sessionId"
// where it meant "is anything happening here" - the same mistake as asking whether a folder
// exists when the question was whether work is in flight.
const archivedCall = (nodes) =>
  projectsNeedingSeats(nodes, { metaHomeRoot: META, exists, isArchived: (id) => id === "gone-session" });
ok(
  archivedCall([{ projectPath: ALPHA, sessionId: "gone-session", crew: [] }]).length === 0,
  "a node whose only claim is an ARCHIVED session earns no seat",
);
ok(
  archivedCall([{ projectPath: ALPHA, sessionId: "gone-session", crew: [{ id: "r1" }] }]).length === 1,
  "but crew underneath still earns one - the run happened whatever became of the session",
);
ok(
  archivedCall([{ projectPath: ALPHA, sessionId: "other-session", crew: [] }]).length === 1,
  "and an UNKNOWN session still counts: unjudgeable is not archived, and a seat too many is a row he can remove",
);
ok(
  archivedCall([{ projectPath: GONE, sessionId: "gone-session", crew: [] }]).length === 0,
  "a deleted checkout whose session is archived earns nothing either - both halves of that exception are gone",
);

// --- one per checkout, however many rows name it ---------------------------------------------
// EVERY SPELLING, including the separators. The first version of this de-duplication folded
// case and a trailing slash and left the separators alone, so one repo written with backslashes
// and again with forward slashes counted twice. The fixture below did not catch it because it
// only varied case and a trailing slash; the real history did, asking for "helm" two times.
// ensureSeatForProject would have refused the second seat, so nothing duplicate could be
// created - what was wrong was the COUNT, which is the number the board's crowding is judged by.
const dupes = call([
  { projectPath: ALPHA, sessionId: "s1", crew: [] },
  { projectPath: ALPHA + "/", sessionId: "s2", crew: [] },
  { projectPath: ALPHA.toUpperCase(), sessionId: null, crew: [{ id: "r1" }] },
  { projectPath: ALPHA.replace(/\//g, "\\"), sessionId: "s3", crew: [] },
  { projectPath: ALPHA.replace(/\//g, "\\") + "\\", sessionId: "s4", crew: [] },
]);
ok(dupes.length === 1, `five spellings of one checkout ask for one seat (${dupes.length})`);

// --- the realistic mixture, which is the case that actually runs at startup -------------------
const mixed = call([
  { projectPath: ALPHA, sessionId: "s1", crew: [] },
  { projectPath: BETA, sessionId: null, crew: [{ id: "r2" }] },
  { projectPath: BETA, sessionId: "s3", crew: [], startedBy: "auto" },
  { projectPath: META, sessionId: "s4", crew: [] },
  { projectPath: GONE, sessionId: null, crew: [{ id: "r5" }] },
  { projectPath: ALPHA, sessionId: null, crew: [] },
]);
ok(
  JSON.stringify(mixed) === JSON.stringify([ALPHA, BETA]),
  `a mixed board asks for exactly the two projects with real work, in the order first seen (${JSON.stringify(mixed)})`
);

// A project whose ONLY node is auto must not sneak in through a second, workless row.
const autoOnly = call([
  { projectPath: BETA, sessionId: "s1", crew: [], startedBy: "auto" },
  { projectPath: BETA, sessionId: null, crew: [] },
]);
ok(autoOnly.length === 0, "a project whose only work is auto stays off the board");

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - exactly the checkouts with real, non-auto, still-existing work get a seat");
