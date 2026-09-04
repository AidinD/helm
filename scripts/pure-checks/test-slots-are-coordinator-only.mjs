// A slot belongs to a coordinator, and the assistant seat must never hold one.
//
// THE FAILURE, which was live on main from the day the assistant seat shipped.
// `retireMateSlot` renumbered every ACTIVE mate, not every coordinator. The assistant seat
// carries `slot: null` on purpose - a 0 would collide with a coordinator's - and every
// slot-ordered reader normalises that with `?? 0`, so the seat sorted to the front and was
// assigned slot 0. `ensureMates` then asked "is anyone active holding this slot", got the
// assistant, and treated the slot as filled. The coordinator pool lost one slot per retire,
// with no error anywhere: `activeMates()` filters by kind, so the seat never APPEARED in the
// pool it was blocking.
//
// Measured before the fix, and this is the assertion that matters rather than the field value:
//   ensureMates(root, 2) returned 1 coordinator after a single retire.
//
// WHY THE FIX IS A SHARED HELPER AND NOT TWO FILTERS. Both sites had already written
// "active" where they meant "holds a slot", and the two are the same set only while every
// active mate is a coordinator - an assumption that stopped being true and nothing announced
// it. `activeMatesFrom` is the one place that knows which seats are pooled, so both sites now
// ask it instead of re-deriving the rule. A third slot-toucher gets the answer for free.
//
// Run:  node scripts/pure-checks/test-slots-are-coordinator-only.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-slot-kind-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

// Dynamic, and AFTER the env var: mates.js resolves its path at import time, so a static
// import would have read the real store (the hoisting trap this project has hit before).
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

  mates.ensureMates(root, 2);
  const seat = mates.ensureAssistantSeat(root);
  ok(seat.slot === null, `the assistant seat starts slotless (${JSON.stringify(seat.slot)})`);
  ok(mates.activeMates().length === 2, "and two coordinators hold the two slots");

  const retired = mates.retireMateSlot(0);
  ok(retired?.status === "retired", "retiring slot 0 retires a coordinator");

  // THE BUG, asserted on the seat itself.
  ok(
    mates.assistantSeat()?.slot === null,
    `the assistant seat is still slotless after a retire (${JSON.stringify(mates.assistantSeat()?.slot)})`
  );

  // THE CONSEQUENCE, asserted through the pool rather than the field - this is the property
  // that actually broke, and a fix that kept the field tidy while the pool stayed short would
  // pass a field-only check.
  const refilled = mates.ensureMates(root, 2);
  ok(refilled.length === 2, `the pool refills to two coordinators (${refilled.length})`);
  ok(
    JSON.stringify(refilled.map((m) => m.slot)) === "[0,1]",
    `and they hold slots 0 and 1 with no gap (${JSON.stringify(refilled.map((m) => m.slot))})`
  );

  // No coordinator may share a slot with anything, and the seat may not appear in the pool.
  const active = mates.loadMates().filter((m) => m.status === "active");
  const slots = active.filter((m) => (m.kind || "coordinator") === "coordinator").map((m) => m.slot);
  ok(new Set(slots).size === slots.length, `no two coordinators share a slot (${JSON.stringify(slots)})`);
  ok(
    !mates.activeMates().some((m) => (m.kind || "coordinator") === "assistant"),
    "and the assistant seat is still absent from the coordinator pool"
  );

  // Retire again, down to one, and check the invariant holds a second time - the original
  // defect compounded per retire rather than firing once.
  mates.retireMateSlot(0);
  ok(mates.assistantSeat()?.slot === null, "a second retire also leaves the seat slotless");
  ok(mates.ensureMates(root, 2).length === 2, "and the pool still refills to two");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - slots are a coordinator concept, and retiring one never parks the assistant seat in the pool");
