// A binding written under the old dispatcher-keyed id still finds its node.
//
// WHY IT EXISTS WHEN NOTHING NEEDS IT YET. Before 2026-09-04 a project node's id was hashed
// from (dispatcher, project), so a project could have one node per dispatcher. It is hashed
// from (lane, project) now. Both real stores were measured before the change and every binding
// in them was already lane-keyed, so this migrates nothing today - but proposeSecondMate could
// write a dispatcher-keyed one, and the installed app keeps a store at a path neither session
// has read. "Not needed here" is not "not needed".
//
// ROUTED AT READ TIME, REWRITING NOTHING, which is the shape the two migrations already in
// deriveSecondMates use. The old key is recomputable rather than reversible: a binding carries
// the firstMateId and projectPath it was written with, so the hash can be reproduced and
// compared. A key that does not reproduce is left alone - an unattributable id is not evidence
// of anything, and inventing an attribution for it would be worse than leaving it where it is.
//
// THE PRECEDENCE RULE, asserted because getting it backwards loses live state: a binding
// already sitting on the lane id WINS. A historical row that happens to hash into the same
// place must never replace the node the captain is actually using.
//
// Run:  node scripts/pure-checks/test-dispatcher-keyed-bindings-migrate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-bindmigrate-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");

const { deriveSecondMates, secondMateId, PROJECT_LANE } = await import("../../src/lib/secondMates.js");
const crypto = await import("node:crypto");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const PROJECT = "D:/Repo/fixture-alpha";
const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
// The OLD id, built the way the old code built it. Deliberately hand-rolled rather than
// obtained from the code under test: asking the code for the value it should be migrating from
// is how a mutation to the hash makes this pass for free.
const oldId = (dispatcher, project) =>
  "sm_" + crypto.createHash("sha1").update(`${dispatcher}::${norm(project)}`).digest("hex").slice(0, 12);

try {
  const laneId = secondMateId(PROJECT_LANE, PROJECT);
  const dispatcherId = oldId("mate_old", PROJECT);
  ok(dispatcherId !== laneId, "the old dispatcher-keyed id really is a different id, so there is something to migrate");

  // A binding under the old key, carrying the two fields that make it recomputable.
  const bindings = {
    [dispatcherId]: { sessionId: "sess-old", name: "Alpha", firstMateId: "mate_old", projectPath: PROJECT, status: "created" },
  };
  const nodes = deriveSecondMates([{ id: "r1", projectPath: PROJECT, status: "done" }], bindings);
  ok(nodes.length === 1, `one node for the project, not one per key (${nodes.length})`);
  ok(nodes[0].secondMateId === laneId, "and it is the lane node");
  ok(nodes[0].sessionId === "sess-old", `whose session came across from the old key (${JSON.stringify(nodes[0].sessionId)})`);
  ok(nodes[0].name === "Alpha", "along with its name, so the row does not silently rename itself");

  // PRECEDENCE. Both keys present; the lane one is the live node and must win.
  const both = {
    [dispatcherId]: { sessionId: "sess-old", firstMateId: "mate_old", projectPath: PROJECT, status: "created" },
    [laneId]: { sessionId: "sess-live", firstMateId: PROJECT_LANE, projectPath: PROJECT, status: "created" },
  };
  const merged = deriveSecondMates([{ id: "r2", projectPath: PROJECT, status: "done" }], both);
  ok(merged.length === 1, `still one node when both keys exist (${merged.length})`);
  ok(
    merged[0].sessionId === "sess-live",
    `and the LIVE binding wins - a historical row must not replace the session in use (${JSON.stringify(merged[0].sessionId)})`
  );

  // AN UNATTRIBUTABLE KEY IS LEFT ALONE. Same shape, but the recorded firstMateId does not
  // reproduce the key, so nothing can be concluded about what it was. Two such ids exist in
  // the real run history and match no known mate.
  const stranger = {
    sm_deadbeef0000: { sessionId: "sess-x", firstMateId: "mate_other", projectPath: PROJECT, status: "created" },
  };
  const kept = deriveSecondMates([], stranger);
  ok(
    kept.some((n) => n.secondMateId === "sm_deadbeef0000" && n.sessionId === "sess-x"),
    "a key that does not reproduce from its own fields is kept where it is, not guessed at"
  );

  // A LANE-KEYED BINDING IS NOT TOUCHED, which is the case that covers both real stores.
  const already = {
    [laneId]: { sessionId: "sess-plain", firstMateId: PROJECT_LANE, projectPath: PROJECT, status: "created" },
  };
  const untouched = deriveSecondMates([{ id: "r3", projectPath: PROJECT, status: "done" }], already);
  ok(untouched.length === 1 && untouched[0].sessionId === "sess-plain", "a lane-keyed binding passes through unchanged");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - a dispatcher-keyed binding finds its lane node, the live one wins, and an unattributable key is left alone");
