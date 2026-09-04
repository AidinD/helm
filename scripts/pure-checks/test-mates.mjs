// Unit test: named-mate identity store (two fixed slots, name pool, rename,
// retire/respawn, legacy migration). Uses HELM_MATES_PATH to point at a temp
// file so it never touches the real mates.json.
//
// Run:  node scripts/e2e/test-mates.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "mates-test-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

const { ensureMates, activeMates, findMateById, renameMate, retireAndRespawn, bindMateSession, loadMates, MATE_SLOT_COUNT } =
  await import("../../src/lib/mates.js");

function log(...a) {
  console.log("[mates-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const ROOT = "D:/Repo/Tools/helm";

// --- ensureMates: always exactly two, each named + slotted ------------------
const two = ensureMates(ROOT);
assert(two.length === MATE_SLOT_COUNT && MATE_SLOT_COUNT === 2, "ensureMates yields exactly two mates");
assert(two[0].slot === 0 && two[1].slot === 1, "the two mates hold slots 0 and 1");
assert(!!two[0].name && !!two[1].name && two[0].name !== two[1].name, "both mates get distinct non-empty names");
assert(two.every((m) => m.status === "active" && m.mateId.startsWith("mate_")), "both are active with a mate_ id");

// idempotent
const again = ensureMates(ROOT);
assert(again.length === 2 && again[0].mateId === two[0].mateId && again[1].mateId === two[1].mateId, "ensureMates is idempotent (same two ids)");

// --- rename -----------------------------------------------------------------
const renamed = renameMate(two[0].mateId, "  Barnacle Bill  ");
assert(renamed && renamed.name === "Barnacle Bill", "renameMate trims + sets the name");
assert(findMateById(two[0].mateId).name === "Barnacle Bill", "the rename persisted");
assert(renameMate("mate_does_not_exist", "X") === null, "renaming an unknown mate returns null");

// --- retire + respawn: same slot, new id, fresh name, old kept as retired ---
const outgoingId = two[0].mateId;
const outgoingSlot = findMateById(outgoingId).slot;
const fresh = retireAndRespawn(outgoingId);
assert(fresh.mateId !== outgoingId, "respawn produces a NEW mate id");
assert(fresh.slot === outgoingSlot, "the fresh mate takes the retired mate's slot");
assert(fresh.status === "active" && !!fresh.name, "the fresh mate is active with a name");
const retired = findMateById(outgoingId);
assert(retired && retired.status === "retired" && retired.slot === null, "the outgoing mate is kept as a retired record (so its historical runs stay named) with no slot");
assert(findMateById(outgoingId).name === "Barnacle Bill", "the retired mate keeps its old name for historical grouping");

// still exactly two active, still slots 0 + 1
const active = activeMates();
assert(active.length === 2 && active[0].slot === 0 && active[1].slot === 1, "after respawn there are still exactly two active mates in slots 0 + 1");
assert(loadMates().length === 3, "loadMates returns all records incl. the retired one (2 active + 1 retired)");

// fresh name differs from the surviving active mate's name
assert(fresh.name !== active.find((m) => m.slot === 1).name, "the respawned name differs from the other active mate");

// --- bindMateSession: durable mate <-> its current session ------------------
const [a, b] = activeMates();
bindMateSession(a.mateId, "sess-1");
assert(findMateById(a.mateId).sessionId === "sess-1", "bindMateSession links a session to a mate");
// re-binding the SAME session to the other mate moves it (a session has one mate)
bindMateSession(b.mateId, "sess-1");
assert(findMateById(b.mateId).sessionId === "sess-1", "binding a session to another mate moves it there");
assert(findMateById(a.mateId).sessionId === null, "the session is cleared from the mate that no longer holds it");
// retiring a mate freezes its sessionId on the retired record; the fresh one has none
bindMateSession(b.mateId, "sess-2");
const bId = b.mateId;
const respawned = retireAndRespawn(bId);
assert(findMateById(bId).sessionId === "sess-2", "a retired mate keeps its sessionId (frozen with its history)");
assert(!respawned.sessionId, "the freshly respawned mate starts with no session");

// --- legacy migration: a flat-array file becomes retired records ------------
fs.writeFileSync(process.env.HELM_MATES_PATH, JSON.stringify([{ mateId: "mate_legacy", root: ROOT, name: "Old Salt", createdAt: 1 }]), "utf8");
const migrated = ensureMates(ROOT);
assert(migrated.length === 2, "after migrating a legacy flat array, ensureMates still yields two active mates");
assert(findMateById("mate_legacy") && findMateById("mate_legacy").status === "retired", "the legacy mate is preserved as a retired record (keeps its name for old runs)");
assert(findMateById("mate_legacy").name === "Old Salt", "the migrated legacy mate keeps its name");

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
log(exitCode === 0 ? "VERIFY OK: two fixed slots, naming, rename, retire/respawn, legacy migration." : "VERIFY FAILED.");
process.exit(exitCode);
