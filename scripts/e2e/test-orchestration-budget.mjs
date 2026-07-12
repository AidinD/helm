// Unit test: the Phase-2 orchestration budget + kill switch (Slice 0).
// Run: node scripts/e2e/test-orchestration-budget.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isOver,
  readBudget,
  addSpend,
  setCeiling,
  isOverBudget,
  setKilled,
  isKilled,
  resetBudget,
  budgetPath,
  DEFAULT_CEILING_USD,
} from "../../src/lib/orchestrationBudget.js";

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

// Pure isOver
assert(isOver({ spentUsd: 5, ceilingUsd: 10 }) === false, "isOver: under ceiling -> false");
assert(isOver({ spentUsd: 10, ceilingUsd: 10 }) === true, "isOver: at ceiling -> true");
assert(isOver({ spentUsd: 99, ceilingUsd: null }) === false, "isOver: null ceiling -> never over");
assert(isOver(null) === false, "isOver: null state -> false");

// I/O against a throwaway meta-home
const home = fs.mkdtempSync(path.join(os.tmpdir(), "helm-budget-"));
try {
  const fresh = readBudget(home);
  assert(fresh.spentUsd === 0 && fresh.killed === false, "fresh budget: zero spend, not killed");
  assert(fresh.ceilingUsd === DEFAULT_CEILING_USD, "fresh budget uses the default ceiling");
  assert(!fs.existsSync(budgetPath(home)), "reading a fresh budget doesn't create the file");

  setCeiling(home, 2);
  addSpend(home, 0.5);
  addSpend(home, 1.0);
  assert(readBudget(home).spentUsd === 1.5, "addSpend accumulates (0.5 + 1.0)");
  assert(isOverBudget(home) === false, "1.5 spent of 2.0 ceiling -> not over");
  addSpend(home, 0.6);
  assert(isOverBudget(home) === true, "2.1 spent of 2.0 ceiling -> over budget");
  assert(fs.existsSync(budgetPath(home)), "spending persists a budget.json");

  assert(isKilled(home) === false, "not killed by default");
  setKilled(home, true);
  assert(isKilled(home) === true, "kill switch flips");

  // Persistence: a fresh read (new module state simulated by re-reading disk)
  assert(readBudget(home).spentUsd === 2.1 && readBudget(home).killed === true, "spend + killed persist to disk");

  resetBudget(home);
  assert(readBudget(home).spentUsd === 0 && isKilled(home) === false, "resetBudget clears spend + un-kills");
  assert(readBudget(home).ceilingUsd === 2, "resetBudget keeps the ceiling");

  addSpend(home, -5);
  assert(readBudget(home).spentUsd === 0, "a non-positive cost is ignored");

  // setCeiling fail-closed on bad input (ship-review): only an explicit null
  // removes the cap; a non-numeric / NaN / negative value must NOT silently
  // disable the ceiling - it keeps the current one.
  setCeiling(home, 3);
  assert(readBudget(home).ceilingUsd === 3, "setCeiling(3) sets a numeric ceiling");
  setCeiling(home, "not a number");
  assert(readBudget(home).ceilingUsd === 3, "setCeiling(garbage) keeps the current ceiling (fail-closed)");
  setCeiling(home, -1);
  assert(readBudget(home).ceilingUsd === 3, "setCeiling(negative) keeps the current ceiling (fail-closed)");
  setCeiling(home, "5");
  assert(readBudget(home).ceilingUsd === 5, "setCeiling(\"5\") coerces a numeric string");
  setCeiling(home, null);
  assert(readBudget(home).ceilingUsd === null, "setCeiling(null) explicitly removes the cap");

  // Fail-closed on a CORRUPT budget file (ship-review): a damaged file must not
  // silently un-kill a stopped fleet. A MISSING file still reads as not-killed.
  const corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-budget-corrupt-"));
  try {
    assert(isKilled(corruptHome) === false, "a missing budget file reads as not-killed (nothing configured)");
    fs.mkdirSync(path.dirname(budgetPath(corruptHome)), { recursive: true });
    fs.writeFileSync(budgetPath(corruptHome), "{ this is not json", "utf8");
    assert(isKilled(corruptHome) === true, "a corrupt budget file fails CLOSED (reads as killed)");
    assert(readBudget(corruptHome).corrupt === true, "the corrupt read is flagged");
    resetBudget(corruptHome);
    assert(isKilled(corruptHome) === false, "resetBudget (Resume) recovers from a corrupt file");
  } finally {
    fs.rmSync(corruptHome, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(exit === 0 ? "VERIFY OK: orchestration budget + kill switch behave." : "VERIFY FAILED.");
process.exit(exit);
