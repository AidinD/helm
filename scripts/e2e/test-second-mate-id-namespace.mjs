// A second mate has ONE id namespace, and crew dispatched from a jumped-into project
// session lands under the node the captain is looking at.
//
// Aidin, task 99089c59: "den här 2nd maten kör autopilots men den syns inte i trädvy."
// His screenshot showed a working second mate with no expandable crew underneath it.
//
// The cause was an identity leak, not a rendering bug. The Fleet renders a plain project
// session as a node keyed "sess_<sessionId>" (renderer augmentSecondMatesWithSessions).
// That is a display key for a row on a screen. Jumping into the node handed the key on as
// the session's secondMateId, so it was stamped onto every crew run as dispatchedBy and
// written into the bindings file - and deriveSecondMates, which knows only "sm_", hashed
// it into a phantom node that no binding matches. The crew went to the phantom; the real
// node rendered crew.length === 0 and hid its chevron.
//
// Evidence from the real store when this was written: three tgs-crewline runs dispatched
// by sess_3436226e-0d07-4553-b5ca-eb5911211771, a binding for that id whose projectPath was
// undefined, and two id namespaces ("sm_" and "sess_") coexisting in second-mates.json.
//
// What this pins is the fix's SHAPE, not just its symptom: the display key never becomes an
// identity (translated at the boundary, refused by the binding writer), and history written
// before the fix still resolves to the right node. Asserting only "the crew shows up" would
// pass equally well for the patch this deliberately is not - teaching derive to understand
// "sess_" too, which clears the symptom and makes two namespaces permanent.
//
// Pure (no app, no model) - runs in the fast lane.
// Run:  node scripts/e2e/test-second-mate-id-namespace.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-smid-"));
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
fs.writeFileSync(process.env.HELM_SECOND_MATES_PATH, "{}", "utf8");

// Dynamic import AFTER the env seam: secondMates.js resolves its path at import time, so a
// static import would have already bound the REAL bindings file and this test would write to
// the captain's own store (the hoisting trap on the ship-review failure list).
const { deriveSecondMates, secondMateId, resolveSecondMateId, isDisplaySecondMateId, bindSecondMateSession, secondMateIdForSession, DIRECT_FIRST_MATE } = await import(
  "../../src/lib/secondMates.js"
);

const PROJECT = process.platform === "win32" ? "D:\\Repo\\Work\\tgs-crewline" : "/repo/work/tgs-crewline";
const SESSION = "3436226e-0d07-4553-b5ca-eb5911211771";
const DISPLAY_KEY = `sess_${SESSION}`;
const REAL_ID = secondMateId(DIRECT_FIRST_MATE, PROJECT);

// --- 1. the two id shapes are distinguishable, and translation is exact ------------
ok(isDisplaySecondMateId(DISPLAY_KEY), "a session node's key is recognised as a display key");
ok(!isDisplaySecondMateId(REAL_ID), `a real second-mate id is not (${REAL_ID})`);
ok(
  resolveSecondMateId(DISPLAY_KEY, PROJECT) === REAL_ID,
  "a display key translates to exactly the id a registered direct second mate for that project already has - so a jump-in and a registration land on ONE node, not two"
);
ok(resolveSecondMateId(REAL_ID, PROJECT) === REAL_ID, "translating a real id is a no-op");
ok(
  resolveSecondMateId(DISPLAY_KEY, null) === null,
  "a display key with no project resolves to NOTHING rather than a node at an invented path - the five bad records in the real store all had projectPath undefined"
);

// --- 2. the binding writer refuses to mint the second namespace -------------------
let refused = null;
try {
  bindSecondMateSession(DISPLAY_KEY, SESSION);
} catch (err) {
  refused = err?.message || String(err);
}
ok(!!refused, `binding a display key throws instead of writing it (${refused || "IT WAS ACCEPTED"})`);
ok(
  !Object.keys(JSON.parse(fs.readFileSync(process.env.HELM_SECOND_MATES_PATH, "utf8"))).some(isDisplaySecondMateId),
  "and nothing display-keyed reached the file - the throw is not merely cosmetic"
);

// --- 3. a real bind carries the project, so the node exists before any crew -------
bindSecondMateSession(REAL_ID, SESSION, { projectPath: PROJECT });
const bound = deriveSecondMates([]).find((s) => s.secondMateId === REAL_ID);
ok(
  !!bound && bound.projectPath === PROJECT,
  `a bound second mate with no crew yet is still a node (${bound ? bound.projectPath : "MISSING"}) - derive's union loop skips a binding with no projectPath, which is why a jumped-into second mate used to be invisible until its first dispatch`
);

// A later bind with no project must not erase the one already established.
bindSecondMateSession(REAL_ID, SESSION);
ok(
  deriveSecondMates([]).find((s) => s.secondMateId === REAL_ID)?.projectPath === PROJECT,
  "and a later bind without a project does not downgrade it back to null"
);

// --- 4. a resumed session never re-leaks the key onto this turn's dispatches ------
// Simulate the records that already exist: a legacy binding under the display key.
const legacy = { [DISPLAY_KEY]: { sessionId: SESSION, status: "created", projectPath: null } };
ok(
  secondMateIdForSession(SESSION, legacy, { projectPath: PROJECT }) === REAL_ID,
  "resuming a session whose only binding is legacy resolves to the REAL id, so its crew is stamped correctly from now on"
);
ok(
  secondMateIdForSession(SESSION, legacy) === null,
  "and with no project to translate against it reports no second mate rather than handing back the display key"
);

// --- 5. THE REPORTED SYMPTOM: crew written before the fix comes home -------------
const history = [
  { goalRunId: "r1", projectPath: PROJECT, dispatchedBy: DISPLAY_KEY, tier: "crew", status: "done", goal: "Epic 2: currency in USD" },
  { goalRunId: "r2", projectPath: PROJECT, dispatchedBy: DISPLAY_KEY, tier: "crew", status: "done", goal: "Epic 10: capability permissions" },
  { goalRunId: "r3", projectPath: PROJECT, dispatchedBy: REAL_ID, tier: "crew", status: "running", goal: "Epic 1: clients as an entity" },
];
const derived = deriveSecondMates(history);
const node = derived.find((s) => s.secondMateId === REAL_ID);
ok(
  !!node && node.crew.length === 3,
  `all three crew runs land on ONE node (${node ? node.crew.length : 0}/3) - two written under the old display key, one under the new id, and the captain sees a single second mate with three runs rather than an empty node beside a phantom`
);
ok(
  derived.length === 1,
  `and no phantom node is created alongside it (${derived.length} node(s): ${derived.map((s) => s.secondMateId).join(", ")}) - the phantom was the row the crew used to disappear into`
);
ok(
  node?.firstMateId === DIRECT_FIRST_MATE,
  `the node sits under the captain, not under an id that is itself a session (${node?.firstMateId}) - a phantom's parent was the sess_ key, which no widget can render`
);

// The migration must not be a blanket "anything unknown goes to direct": a run genuinely
// dispatched by a FIRST mate still belongs to that first mate's node for the same project.
const mixed = deriveSecondMates([
  ...history,
  { goalRunId: "r4", projectPath: PROJECT, dispatchedBy: "mate_abc", tier: "second-mate", status: "done", goal: "first-mate dispatched" },
]);
ok(
  mixed.length === 2 && mixed.some((s) => s.firstMateId === "mate_abc"),
  `a first-mate-dispatched run keeps its own node (${mixed.length} nodes) - the translation is scoped to the display key, not applied to every dispatcher it does not recognise`
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  exit === 0
    ? "VERIFY OK: one id namespace; the display key is translated at the boundary and refused by the writer; stranded crew resolves back onto the node the captain sees."
    : "VERIFY FAILED."
);
process.exit(exit);
