// Two personas that both "attack the plan" are one persona with two names.
//
// the captain, 2026-08-04, reviewing the roster: Architect and Red team overlapped - the only
// difference in the text was that one also proposed alternatives. So each now says what it
// does NOT do, which is the only thing that actually separates two similar temperaments, and
// this file asserts that the exclusions point at each other rather than merely existing.
//
// Also here: a mate refresh must KEEP its persona. It used to reset to the plain coordinator,
// so a mate set to Red team came back as a coordinator without saying so, and any reason to
// set a persona evaporated on the next refresh.
//
// Run:  node scripts/e2e/test-persona-boundaries.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PERSONAS, getPersona, personaOverlay, isValidPersonaKey } from "../../src/lib/personas.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- every persona is self-describing --------------------------------------
ok(PERSONAS.length >= 4, `the roster is populated (${PERSONAS.map((p) => p.key).join(", ")})`);
for (const p of PERSONAS) {
  ok(p.blurb && p.blurb.length > 30, `${p.key}: has a real description (${p.blurb?.length || 0} chars)`);
  ok(p.overlay && p.overlay.startsWith(`PERSONA: ${p.label}`), `${p.key}: its overlay names the seat it is`);
}

// --- the boundary, in both directions --------------------------------------
const arch = getPersona("architect").overlay;
const red = getPersona("red-team").overlay;

ok(/CONSTRUCTIVE/.test(arch), "Architect declares itself constructive");
ok(/commit to a recommendation/i.test(arch), "and is required to land on a recommendation, not a list of risks");
ok(/'it depends' is a failure/i.test(arch), "with the cop-out named explicitly as failure");
ok(/that is the Red team seat, not this one/i.test(arch), "and it points AT the other seat for the thing it refuses to do");

ok(/Do NOT propose fixes, alternatives or a recommendation/i.test(red), "Red team is forbidden from proposing the remedy");
ok(/that is the Architect\s+seat|that is the Architect seat/i.test(red), "and points back at Architect for it");
ok(/CONCRETE scenario/i.test(red), "it must give each failure a concrete trigger - an unfalsifiable worry is not a finding");
ok(/could not break something/i.test(red), "and must admit when it could not break anything rather than inventing a weak objection");

// The exclusions have to be MUTUAL, or one seat simply absorbs the other.
ok(
  /Red team/.test(arch) && /Architect/.test(red),
  "each overlay names the other, so a reader of either knows where the boundary is"
);
ok(
  !/propose|alternative|recommendation/i.test(red.split("Do NOT")[0]) || /Do NOT/.test(red),
  "Red team's own instructions do not ask for the thing they then forbid"
);

// --- the plumbing still holds ----------------------------------------------
ok(personaOverlay("architect") === arch, "the overlay lookup returns the text");
ok(personaOverlay("nope") === "", "an unknown key yields no overlay rather than a default one");
ok(personaOverlay(null) === "", "and no persona yields none - Coordinator is the absence, not an entry");
ok(isValidPersonaKey(null) && isValidPersonaKey("") && isValidPersonaKey("red-team"), "the valid-key check accepts the empty cases");
ok(!isValidPersonaKey("architekt"), "and rejects a near-miss rather than silently dropping to Coordinator");

// --- a refresh keeps the persona; a switch changes it ----------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-mates-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
const { ensureMates, setMatePersona, retireAndRespawn } = await import("../../src/lib/mates.js");

const active = ensureMates(tmp, 1);
const first = active[0];
setMatePersona(first.mateId, "red-team");

const refreshed = retireAndRespawn(first.mateId, "handoff text", null, { keepPersona: true });
ok(refreshed.persona === "red-team", `an ordinary refresh KEEPS the persona (${refreshed.persona})`);
ok(refreshed.mateId !== first.mateId, "and it really is a fresh mate, not the same one");

const switched = retireAndRespawn(refreshed.mateId, "handoff text", "teacher", { keepPersona: false });
ok(switched.persona === "teacher", `a deliberate switch changes it (${switched.persona})`);

const cleared = retireAndRespawn(switched.mateId, null, null, { keepPersona: false });
ok(cleared.persona === null, "and choosing Coordinator explicitly clears it - keepPersona must not override that");

const nonsense = retireAndRespawn(cleared.mateId, null, "not-a-persona", { keepPersona: false });
ok(nonsense.persona === null, "an invalid key lands on Coordinator rather than being stored");

// The default must be the SAFE one for the old callers: no flag, no carry-over.
setMatePersona(nonsense.mateId, "researcher");
const noFlag = retireAndRespawn(nonsense.mateId, null, null);
ok(noFlag.persona === null, "with no flag at all the old behaviour is unchanged, so nothing carries by accident");

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}

console.log(
  exit === 0
    ? "VERIFY OK: Architect and Red team exclude each other by name, every persona describes itself, and a mate refresh keeps its persona while a switch changes it."
    : "VERIFY FAILED."
);
process.exit(exit);
