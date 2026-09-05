// The configured first-mate seat count is READ from the coordinator pool after an assistant
// promotion/demotion, not predicted by a +-1 per call - that arithmetic was wrong twice: once
// for a redundant call that moved no tag, and again for a handoff that swaps the tag onto a
// different seat (the previous holder rejoins the pool in the same write, so its size does not
// move even though a transition happened). mates:setAssistant in main.js now does
// `clampMateSlots(activeMates().length)` after every call instead of branching per transition -
// this drives all four shapes of that call through the real store and asserts the pool size
// (what the configured count becomes) matches reality in each one, including the swap.
//
// Run:  node scripts/pure-checks/test-assistant-slot-count-follows-reality.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-assistant-slot-reality-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

const mates = await import("../../src/lib/mates.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

try {
  const root = path.join(tmp, "meta-home");
  fs.mkdirSync(root, { recursive: true });

  // --- a real promotion shrinks the pool, a real demotion grows it back ------------------
  mates.ensureMates(root, 3);
  ok(mates.activeMates().length === 3, "three coordinators to start");
  const [a, , c] = mates.activeMates();

  const promoted = mates.setSeatAssistant(a.mateId, true);
  ok(promoted.ok, `a coordinator can be promoted (${promoted.error || "ok"})`);
  ok(mates.activeMates().length === 2, "promotion drops the pool by one, read back from reality");

  const demoted = mates.setSeatAssistant(a.mateId, false);
  ok(demoted.ok, `and demoted back (${demoted.error || "ok"})`);
  ok(mates.activeMates().length === 3, "demotion returns the pool to its original size");

  // --- a no-op call leaves the pool exactly where it was ----------------------------------
  const already = mates.activeMates().length;
  const noOpOff = mates.setSeatAssistant(c.mateId, false);
  ok(noOpOff.ok, "turning off a seat that is already not the assistant still reports ok");
  ok(mates.activeMates().length === already, "and the pool size is untouched by that redundant call");

  mates.setSeatAssistant(a.mateId, true);
  const assistantNow = mates.activeMates().length;
  const noOpOn = mates.setSeatAssistant(a.mateId, true);
  ok(noOpOn.ok, "turning on a seat that already is the assistant still reports ok");
  ok(mates.activeMates().length === assistantNow, "and the pool size is untouched by that redundant call either");

  // --- a handoff (swap) leaves the pool size unchanged, even though ITS seat transitioned -
  // Coordinators are now the pool minus the standing assistant (a): whoever is left.
  const [other1, other2] = mates.activeMates();
  ok(mates.activeMates().length === 2, "two coordinators remain while a holds the assistant tag");
  const poolBeforeSwap = mates.activeMates().length;
  const swapped = mates.setSeatAssistant(other1.mateId, true);
  ok(swapped.ok, `promoting a different seat while one already holds the tag swaps it (${swapped.error || "ok"})`);
  ok(
    mates.assistantSeat()?.mateId === other1.mateId,
    "the new seat now holds the assistant tag"
  );
  ok(
    mates.activeMates().some((m) => m.mateId === a.mateId),
    "the previous holder rejoined the pool in the same call"
  );
  ok(
    mates.activeMates().length === poolBeforeSwap,
    `a swap leaves the pool size unchanged, read back from reality (${mates.activeMates().length} vs ${poolBeforeSwap})`
  );
  ok(
    !mates.activeMates().some((m) => m.mateId === other1.mateId),
    "and the newly-promoted seat left the pool"
  );
  ok(other2.mateId !== other1.mateId, "sanity: the two remaining coordinators were distinct before the swap");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - the coordinator pool size after promote/demote/no-op/swap always matches reality.");
