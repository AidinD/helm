// Unit test: the cron evaluator (cron.js) + the Helm-owned routines store
// (helmRoutines.js). Correctness-critical - this is what fires scheduled runs.
// Uses HELM_ROUTINES_PATH so it never touches the real store.
// Run:  node scripts/e2e/test-cron-routines.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "routines-" + process.pid + ".json");
process.env.HELM_ROUTINES_PATH = tmp;

const cron = await import("../../src/lib/cron.js");
const store = await import("../../src/lib/helmRoutines.js");

let exit = 0;
const assert = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

try {
  // ---- cron.js ----
  assert(cron.validateCron("0 8 * * 1").ok, "valid weekly cron parses");
  assert(!cron.validateCron("0 8 * *").ok, "4-field cron rejected");
  assert(!cron.validateCron("99 8 * * 1").ok, "out-of-range minute rejected");
  assert(!cron.validateCron("0 8 * * 9").ok, "out-of-range dow rejected");

  const from = new Date(2026, 6, 8, 12, 0, 0); // Wed 2026-07-08 12:00 local
  const mon = cron.nextRun("0 8 * * 1", from);
  assert(mon.getDay() === 1 && mon.getHours() === 8 && mon.getMinutes() === 0, "weekly Mon 08:00 -> a Monday at 08:00");
  assert(mon.getTime() > from.getTime(), "next run is strictly after `from`");

  const q = cron.nextRun("*/15 * * * *", new Date(2026, 6, 8, 10, 7, 0));
  assert(q.getMinutes() === 15 && q.getHours() === 10, "*/15 from 10:07 -> 10:15");

  const monthly = cron.nextRun("0 0 1 * *", new Date(2026, 6, 15, 0, 0, 0));
  assert(monthly.getDate() === 1 && monthly.getHours() === 0, "monthly 1st 00:00 -> the 1st");

  const sun0 = cron.nextRun("0 9 * * 0", from);
  const sun7 = cron.nextRun("0 9 * * 7", from);
  assert(sun0.getDay() === 0 && sun7.getDay() === 0 && sun0.getTime() === sun7.getTime(), "dow 0 and 7 both mean Sunday");

  // dom/dow OR-semantics: 13th OR any Friday.
  const orNext = cron.nextRun("0 0 13 * 5", new Date(2026, 6, 1, 0, 0, 0));
  assert(orNext.getDate() === 13 || orNext.getDay() === 5, "dom+dow restricted -> OR (13th or Friday)");

  // ---- helmRoutines.js ----
  let threw = false;
  try {
    store.createRoutine({ name: "bad", prompt: "x", cron: "nope" });
  } catch {
    threw = true;
  }
  assert(threw, "createRoutine rejects an invalid cron");

  const r = store.createRoutine({ name: "Health", prompt: "run health-coach", cron: "0 8 * * 1", cwd: "D:/x" });
  assert(r.id.startsWith("routine_") && typeof r.nextRunAt === "number", "create seeds an id + nextRunAt");
  assert(store.listRoutines().length === 1, "routine persisted");

  // Disabled routines are never due.
  store.updateRoutine(r.id, { enabled: false });
  assert(store.dueRoutines(Date.now() + 1e12).length === 0, "disabled routine is not due even far in the future");
  // Re-enabling recomputes nextRunAt from now (future), so not immediately due.
  store.updateRoutine(r.id, { enabled: true });
  assert(store.dueRoutines(Date.now()).length === 0, "freshly re-enabled routine is not immediately due");

  // Force it due, then fire: lastRunAt set, nextRunAt advances to the future.
  const all = JSON.parse(fs.readFileSync(tmp, "utf8"));
  all[0].nextRunAt = Date.now() - 1000;
  fs.writeFileSync(tmp, JSON.stringify(all));
  assert(store.dueRoutines(Date.now()).length === 1, "a past nextRunAt makes it due");
  const fireAt = Date.now();
  const fired = store.markRoutineFired(r.id, fireAt);
  assert(fired.lastRunAt === fireAt, "markRoutineFired sets lastRunAt");
  assert(fired.nextRunAt > fireAt, "nextRunAt advances to the future (single catch-up, not one per missed slot)");
  assert(store.dueRoutines(Date.now()).length === 0, "not due again right after firing");

  assert(store.removeRoutine(r.id) === true && store.listRoutines().length === 0, "remove works");
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
console.log(exit === 0 ? "VERIFY OK: cron + routines store." : "VERIFY FAILED.");
process.exit(exit);
