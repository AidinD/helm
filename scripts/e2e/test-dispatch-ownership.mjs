// Unit test (pure node): ownership scoping of dispatch claiming - the fix for
// the cross-instance orphaning bug (two Helm builds sharing one meta-home queue
// but keeping separate mate stores). Run: node scripts/e2e/test-dispatch-ownership.mjs
import { isForeignDispatch } from "../../src/lib/dispatchCaps.js";

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

const owned = new Set(["mate_dc2b1d61", "mate_2f2bf529"]);

// The actual failure: a request dispatched by the OTHER instance's mate.
assert(
  isForeignDispatch({ dispatchedBy: "mate_14fc5bb0" }, owned) === true,
  "a request from a mate NOT in our store is foreign (skip - let the owner run it)"
);
// Our own mate's request must run here.
assert(
  isForeignDispatch({ dispatchedBy: "mate_dc2b1d61" }, owned) === false,
  "a request from one of our mates is ours (claim + run)"
);
// A retired-but-ours mate still counts as owned (we pass its id in the set).
assert(
  isForeignDispatch({ dispatchedBy: "mate_2f2bf529" }, owned) === false,
  "a request from any mate in our store (active or retired) is ours"
);
// No dispatcher id -> not attributable -> treat as ours (preserve prior behavior).
assert(isForeignDispatch({}, owned) === false, "a request with no dispatchedBy is not skipped");
assert(isForeignDispatch({ dispatchedBy: null }, owned) === false, "null dispatchedBy is not skipped");
// Empty ownership set (no mates yet) -> any attributed request is foreign.
assert(
  isForeignDispatch({ dispatchedBy: "mate_x" }, new Set()) === true,
  "with no owned mates, an attributed request is foreign"
);
// Accepts a plain array too, not just a Set.
assert(
  isForeignDispatch({ dispatchedBy: "mate_dc2b1d61" }, ["mate_dc2b1d61"]) === false,
  "ownedMateIds may be passed as an array"
);

console.log(exit === 0 ? "VERIFY OK: dispatch ownership scoping skips foreign mates and runs our own." : "VERIFY FAILED.");
process.exit(exit);
