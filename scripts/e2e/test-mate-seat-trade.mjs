/**
 * The focus mechanism is a trade, not a cap - so the trade has to be honest.
 *
 * Decided 2026-08-31, after the week-long behaviour test was cancelled: a hard limit is
 * the wrong shape for this user, because a limit he would fight is a limit he routes
 * around, and a routed-around constraint hides the problem instead of solving it. What
 * replaces it is a cost he feels: one widget per first mate, and a dashboard that gets
 * busier and longer to scroll the more of them there are. He decides; the decision
 * answers back immediately.
 *
 * Three things have to hold for that to be a real trade, and each is easy to break by
 * accident:
 *
 *   1. Nothing artificial stops him first. The ceiling exists only so a garbled config
 *      cannot spawn a hundred coordinators - it must never be what he runs into.
 *   2. It goes BOTH ways. Adding a seat and giving one back must be equally reachable,
 *      or clutter accumulates with no way to act on the feeling.
 *   3. The widget cannot hide the cost. Removing just the widget leaves the mate on
 *      watch: the board gets calmer while the sessions stay. That is the mechanism
 *      upside down, so it has to be said out loud.
 */
import fs from "node:fs";
import { MATE_SLOT_MAX, MATE_SLOT_COUNT, clampMateSlots } from "../../src/lib/mates.js";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

// --- 1. the ceiling must not be the thing he hits ---------------------------------
{
  ok(MATE_SLOT_MAX >= 16, `the ceiling is high enough to never argue first (${MATE_SLOT_MAX})`);
  ok(MATE_SLOT_COUNT === 2, "but the DEFAULT stays small - the trade starts from calm", `${MATE_SLOT_COUNT}`);
  ok(clampMateSlots(MATE_SLOT_MAX + 50) === MATE_SLOT_MAX, "a garbled value is still caught");
  ok(clampMateSlots("nonsense") === MATE_SLOT_COUNT, "and an unusable one falls back to the default");
  ok(clampMateSlots(0) === MATE_SLOT_COUNT, "zero is not a seat count");
  ok(clampMateSlots(9) === 9, "a number he could plausibly choose passes through untouched");
}

const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");

// --- 2. both directions, from the same place ---------------------------------------
{
  ok(/label: "New first mate…"/.test(src), "a seat can be added from the widget menu");
  ok(/window\.helm\.addMate\(\)/.test(src), "and adding one really adds to the fleet");
  ok(/saveWidgetLayout\(\[\.\.\.layout, \{ id: `w-mate-\$\{added\.mateId\}`/.test(src), "the widget appears with it - one action, not two");

  ok(/Dismiss \$\{mate\?\.name \|\| "this first mate"\} from the fleet/.test(src), "and a seat can be given back from the same menu");
  ok(/window\.helm\.removeMate\(widget\.mateId\)/.test(src), "which removes the mate, not only its widget");
  ok(/firstMateSlots: current \+ 1/.test(main), "adding raises the configured seat count");
  ok(/retireMateSlot\(mate\.slot\)/.test(main), "and dismissing lowers it, so the count follows reality");
}

// --- 3. removing the widget must not hide the seat ---------------------------------
{
  const at = src.indexOf('label: "Remove widget"');
  ok(at > 0, "the remove-widget item exists");
  const body = src.slice(at, at + 1400);
  ok(/is still on watch/.test(body), "removing just the widget says the mate is still on watch");
  ok(/Dismiss/.test(body), "and names the thing that actually frees the seat");
  // It must stay a statement, never a refusal: prohibition is the shape that was
  // rejected, and re-introducing it here would be the same mistake in a smaller place.
  ok(!/customConfirm|return;/.test(body.slice(0, body.indexOf("renderDashboardPage"))), "but nothing is blocked or confirmed - it is said, not prevented");
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: the seat trade is reachable both ways, unblocked, and cannot be hidden by tidying the board.");
