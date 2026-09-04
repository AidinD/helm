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
ok(
  call([{ projectPath: GONE, sessionId: "s1", crew: [] }]).length === 0,
  "a deleted checkout earns nothing - a seat rooted there is a permanently empty row"
);
ok(call([{ sessionId: "s1", crew: [] }]).length === 0, "a node with no project at all is skipped");
ok(call([]).length === 0 && call(null).length === 0, "no nodes, no seats, and no crash on nothing");

// --- one per checkout, however many rows name it ---------------------------------------------
const dupes = call([
  { projectPath: ALPHA, sessionId: "s1", crew: [] },
  { projectPath: ALPHA + "/", sessionId: "s2", crew: [] },
  { projectPath: ALPHA.toUpperCase(), sessionId: null, crew: [{ id: "r1" }] },
]);
ok(dupes.length === 1, `three rows naming one checkout ask for one seat (${dupes.length})`);

// --- the realistic mixture, which is the case that actually runs at startup -------------------
const mixed = call([
  { projectPath: ALPHA, sessionId: "s1", crew: [] },
  { projectPath: BETA, sessionId: null, crew: [{ id: "r2" }] },
  { projectPath: BETA, sessionId: "s3", crew: [], startedBy: "auto" },
  { projectPath: META, sessionId: "s4", crew: [] },
  { projectPath: GONE, sessionId: "s5", crew: [] },
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
