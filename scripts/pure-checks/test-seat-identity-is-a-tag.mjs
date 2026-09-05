// What a seat IS comes from a tag it carries, and every lookup reads that one thing.
//
// WHY A TAG AND NOT A PERSONA, which is the field it looks like it should be: putting identity
// in the persona list makes "assistant" mutually exclusive with "red team". That collision is
// the exact thing the two-axes decision was written to remove - temperament is how a seat
// behaves, identity is what it is, and they are chosen separately.
//
// WHY NOT A KIND, which is what it replaces: a kind allowed exactly one standing seat BY
// CONSTRUCTION, so nothing ever had to check. Meta-home seats are named now, so that guarantee
// is gone - and `find()` does not fail when a question stops having one answer. It returns the
// first and looks like it worked. That failure has appeared three times in a week in this
// file's neighbourhood: a persona default, a missing kind, a slot filter. This is the fourth,
// caught before it shipped rather than after.
//
// Run:  node scripts/pure-checks/test-seat-identity-is-a-tag.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seat-tag-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

const mates = await import("../../src/lib/mates.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const root = path.join(tmp, "meta-home");
const projectA = path.join(tmp, "Repo", "Alpha");
for (const d of [root, projectA]) {
  fs.mkdirSync(d, { recursive: true });
}

// --- the tag is written, and it is what the accessors read -----------------------------------
mates.ensureMates(root, 2);
const seat = mates.ensureAssistantSeat(root);
ok(Array.isArray(seat.tags) && seat.tags.includes("assistant"), `the standing seat carries its tag (${JSON.stringify(seat.tags)})`);
const proj = mates.ensureSeatForProject(projectA);
ok(Array.isArray(proj.tags) && proj.tags.includes("project"), `and a project seat carries its own (${JSON.stringify(proj.tags)})`);

ok(mates.assistantSeat()?.mateId === seat.mateId, "the standing seat is found by what it IS");
ok(mates.projectSeats().length === 1, "and so are the project seats");
ok(mates.activeMates().length === 2, "while the pool is the seats that carry NO identity tag");
ok(
  !mates.activeMates().some((m) => (m.tags || []).length > 0),
  "so a tagged seat is never in it, whatever its kind field says"
);

// --- IDENTITY SURVIVES A REFRESH, which is the third field to need that sentence --------------
// WHAT THIS CHECK CANNOT ISOLATE YET, said rather than implied: `kind` is still on every
// record and seatTags falls back to it, so identity currently has TWO sources during the
// transition. Removing the explicit tags from a successor fails only the assertion below -
// the others stay green because the kind still carries the answer. That is a property of the
// transition and the argument for finishing it: three fields have now each needed the
// sentence "a refresh must not change what a seat IS".
const successor = mates.retireAndRespawn(proj.mateId, null);
ok(
  (successor.tags || []).includes("project"),
  `a refreshed seat is still what it was (${JSON.stringify(successor.tags)})`
);
ok(mates.projectSeats().length === 1, "and it is still the only project seat, not a second one");
ok(mates.activeMates().length === 2, "and it did not fall into the pool");

// --- A RECORD WRITTEN BEFORE TAGS EXISTED, read through its kind ------------------------------
// Derived, not migrated - the same choice `kind` itself made. An existing store keeps working
// and nothing has to rewrite it to be read.
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seat-tag-legacy-"));
  process.env.HELM_MATES_PATH = path.join(tmp2, "mates.json");
  fs.writeFileSync(
    path.join(tmp2, "mates.json"),
    JSON.stringify({
      mates: [
        { mateId: "mate_c", status: "active", slot: 0, name: "Coordinator", root },
        { mateId: "mate_a", status: "active", slot: null, kind: "assistant", name: "Assistent", root },
        { mateId: "mate_p", status: "active", slot: null, kind: "project", name: "Project", root: projectA },
      ],
    })
  );
  const legacy = await import(`../../src/lib/mates.js?legacy=${Date.now()}`);
  ok(legacy.assistantSeat()?.mateId === "mate_a", "a pre-tag assistant record is still found");
  ok(legacy.projectSeats().length === 1, "and a pre-tag project record still is too");
  ok(legacy.activeMates().length === 1, "and the untagged one is still the only coordinator");
  ok(
    JSON.parse(fs.readFileSync(path.join(tmp2, "mates.json"), "utf8")).mates.every((m) => m.tags === undefined),
    "and reading it wrote nothing back - derived, not migrated"
  );
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// --- TWO SEATS WITH ONE TAG IS LOUD, which is the whole cost of leaving `kind` -----------------
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seat-tag-two-"));
  process.env.HELM_MATES_PATH = path.join(tmp3, "mates.json");
  fs.writeFileSync(
    path.join(tmp3, "mates.json"),
    JSON.stringify({
      mates: [
        { mateId: "mate_1", status: "active", slot: null, tags: ["assistant"], name: "Alpha", root },
        { mateId: "mate_2", status: "active", slot: null, tags: ["assistant"], name: "Beta", root },
      ],
    })
  );
  const two = await import(`../../src/lib/mates.js?two=${Date.now()}`);
  let threw = null;
  try {
    two.assistantSeat();
  } catch (err) {
    threw = err;
  }
  ok(threw !== null, "asking for THE standing seat when two exist refuses instead of picking one");
  ok(
    threw && /Alpha/.test(threw.message) && /Beta/.test(threw.message),
    `and names them, so the fix is obvious without reading the store (${threw ? threw.message.slice(0, 80) : ""})`
  );
  // The plural question still answers, because plural is legal - it is the singular lookup
  // that has to say so.
  ok(two.projectSeats().length === 0, "while a plural lookup on another tag answers normally");
  fs.rmSync(tmp3, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - identity is a tag, every lookup reads it, a refresh keeps it, and two of one tag is loud");
