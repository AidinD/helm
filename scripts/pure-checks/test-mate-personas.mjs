// Unit test (pure node): the persona catalog + how a mate carries a persona.
// Covers personas.js (lookup/overlay/validation) and mates.js (fresh mate has
// null persona; setMatePersona sets/validates; retire resets to null but a
// switch respawns into the chosen persona). Uses the HELM_MATES_PATH seam so it
// never touches the real store.
// Run:  node scripts/e2e/test-mate-personas.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "mate-personas-" + process.pid + ".json");
process.env.HELM_MATES_PATH = tmp;

const personas = await import("../../src/lib/personas.js");
const { ensureMates, setMatePersona, retireAndRespawn, findMateById } = await import("../../src/lib/mates.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

try {
  // ---- personas.js ----
  // Assert the INVARIANTS, not the count: a hardcoded length breaks every time a
  // persona is legitimately added or removed, without catching anything the
  // well-formedness and uniqueness checks below don't.
  assert(personas.PERSONAS.length >= 4, "catalog is populated");
  assert(personas.PERSONAS.every((p) => p.key && p.label && p.blurb && p.overlay), "each persona has key/label/blurb/overlay");
  assert(new Set(personas.PERSONAS.map((p) => p.key)).size === personas.PERSONAS.length, "persona keys are unique");
  assert(personas.getPersona("architect")?.label === "Architect", "getPersona resolves a known key");
  assert(personas.getPersona("researcher")?.label === "Researcher", "getPersona resolves the researcher persona");
  assert(personas.personaOverlay("researcher").includes("Researcher"), "researcher overlay carries its persona text");
  assert(personas.getPersona("nope") === null, "getPersona returns null for unknown key");
  assert(personas.getPersona(null) === null, "getPersona(null) is null (plain coordinator)");
  assert(personas.personaOverlay("architect").includes("Architect"), "personaOverlay returns the overlay text");
  assert(personas.personaOverlay(null) === "", "personaOverlay(null) is empty (no overlay)");
  assert(personas.personaOverlay("nope") === "", "personaOverlay(unknown) is empty");
  assert(personas.isValidPersonaKey("teacher") && personas.isValidPersonaKey(null) && personas.isValidPersonaKey(""), "valid keys + null/empty accepted");
  assert(!personas.isValidPersonaKey("bogus"), "unknown key rejected by isValidPersonaKey");

  // ---- mates.js persona threading ----
  const mates = ensureMates("D:/Sync/claude-home");
  assert(mates.length === 2, "ensureMates yields two active mates");
  assert(mates.every((m) => m.persona === null), "a fresh mate starts with no persona");

  const set = setMatePersona(mates[0].mateId, "architect");
  assert(set && set.persona === "architect", "setMatePersona sets the persona on a fresh mate");
  assert(findMateById(mates[0].mateId).persona === "architect", "the persona persists to the store");

  let threw = false;
  try {
    setMatePersona(mates[0].mateId, "bogus");
  } catch {
    threw = true;
  }
  assert(threw, "setMatePersona rejects an unknown persona");
  assert(findMateById(mates[0].mateId).persona === "architect", "the rejected set left the persona unchanged");

  // An ordinary retire now KEEPS the persona (2026-09-04): a persona decides what a seat is,
  // so a saturation refresh that dropped it returned a different seat. Clearing on purpose is
  // keepPersona: false with no persona, asserted below.
  const keptRespawn = retireAndRespawn(mates[0].mateId, "handoff text");
  assert(keptRespawn.persona === "architect", "an ordinary retire keeps the fresh mate's persona");
  const clearedRespawn = retireAndRespawn(keptRespawn.mateId, "handoff text", null, { keepPersona: false });
  assert(clearedRespawn.persona === null, "and an explicit clear still resets it to the plain coordinator");
  assert(clearedRespawn.pendingHandoff === "handoff text", "the handoff still rides along on the respawn");

  const switched = retireAndRespawn(clearedRespawn.mateId, "carry", "teacher");
  assert(switched.persona === "teacher", "a persona SWITCH respawns into the chosen persona");
  assert(switched.pendingHandoff === "carry", "the switch also carries a handoff");

  // An invalid key never becomes the persona - that is the rule this guards. What it falls
  // back TO changed with the default: the seat keeps what it had, rather than being reset by
  // a typo. Both halves are asserted, because "not bogus" alone would pass on a silent reset.
  const badSwitch = retireAndRespawn(switched.mateId, null, "bogus");
  assert(badSwitch.persona !== "bogus", "an invalid persona on respawn is never adopted as a key");
  assert(badSwitch.persona === "teacher", "and it leaves the seat as it was rather than resetting it");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
} finally {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: persona catalog + mate persona threading." : "VERIFY FAILED.");
process.exit(exit);
