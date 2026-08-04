// A failed triage must not cost a model call every minute, forever.
//
// the captain, task 1f8cca7b: "auto kollar kön för ofta (tar det tokens?)". The pass itself does
// not: it reads the Jot board off disk and remembers every card it has already judged, so a
// steady board costs nothing. One path did, though, and it was invisible - a card whose
// triage CALL failed (timed out, would not spawn, unparseable output) is deliberately left
// untouched so it can be retried rather than blamed for our own failure, and "retried" meant
// on every 60-second pass with no limit.
//
// So a failure now doubles the wait, capped at an hour, and the card is SKIPPED before the
// folder lookup and the model call - a backoff checked after paying for the call would be
// decorative.
//
// Tested over the real functions, lifted out of main.js rather than reimplemented: main.js
// cannot be imported (it boots Electron), and a second copy of the arithmetic would be a
// test of the copy.
//
// Run:  node scripts/e2e/test-auto-triage-backoff.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");
const grab = (name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`main.js no longer defines ${name}`);
  }
  return src.slice(at, src.indexOf("\n}", at) + 2);
};
const constOf = (name) => {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!m) {
    throw new Error(`main.js no longer defines ${name}`);
  }
  return m[1];
};

const BASE = Number(new Function(`return ${constOf("AUTO_TRIAGE_RETRY_BASE_MS")}`)());
const MAX = Number(new Function(`return ${constOf("AUTO_TRIAGE_RETRY_MAX_MS")}`)());
const api = new Function(
  `const AUTO_TRIAGE_RETRY_BASE_MS = ${BASE}, AUTO_TRIAGE_RETRY_MAX_MS = ${MAX};
   const triageRetry = new Map();
   ${grab("triageBackoffMs")}
   ${grab("noteTriageFailure")}
   return { triageBackoffMs, noteTriageFailure, triageRetry };`
)();

ok(BASE >= 60_000, `the first wait is at least a minute longer than the pass itself (${BASE / 1000}s)`);
ok(MAX <= 60 * 60_000 && MAX > BASE, `and the cap is an hour or less, above the base (${MAX / 60_000}m)`);

// The doubling, and that it settles rather than growing forever.
const waits = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => api.triageBackoffMs(n) / 60_000);
ok(waits[0] === BASE / 60_000, `the first retry waits the base (${waits[0]}m)`);
ok(waits[1] === waits[0] * 2 && waits[2] === waits[1] * 2, `each failure doubles the wait (${waits.slice(0, 4).join(", ")} minutes)`);
ok(waits[waits.length - 1] === MAX / 60_000, `and it stops at the cap instead of growing without bound (${waits[waits.length - 1]}m at 20 attempts)`);
ok(
  waits.every((w, i) => i === 0 || w >= waits[i - 1]),
  `the sequence never goes backwards (${waits.join(", ")})`
);
ok(api.triageBackoffMs(0) === BASE, "a zeroth attempt is treated as the first rather than producing a fraction of the base");

// The bookkeeping the tick relies on.
const now = 1_000_000;
const first = api.noteTriageFailure("card-a", now);
ok(first.attempts === 1 && first.waitMs === BASE, `a first failure records one attempt and the base wait (${first.attempts}, ${first.waitMs / 60_000}m)`);
ok(api.triageRetry.get("card-a").nextAt === now + BASE, "and stamps when the card may be tried again");
const second = api.noteTriageFailure("card-a", now + BASE);
ok(second.attempts === 2 && second.waitMs === BASE * 2, `a second failure escalates (${second.attempts} attempts, ${second.waitMs / 60_000}m)`);
ok(api.noteTriageFailure("card-b", now).attempts === 1, "each card backs off on its own - one failing card does not delay another");

// The tick's own use of it: skip BEFORE the model call, and forget on success.
const tick = src.slice(src.indexOf("async function autoCaptainTick"), src.indexOf("\n}\n", src.indexOf("async function autoCaptainTick")));
// Backed-off cards are removed before the board is PLANNED, which is stronger than skipping them
// inside the loop - and the difference was a real defect. Skipping them later let three failing
// cards occupy the concurrency cap while a healthy fourth was told "3 auto runs already in flight"
// with zero running, so nothing started for up to an hour (demonstrated by an independent review,
// 2026-08-04). Asserted by ORDER: the exclusion has to come before planAutoTick, which itself comes
// before the model call and the folder lookup.
const excludeAt = tick.indexOf("const backedOff = new Set(");
const planAt = tick.indexOf("planAutoTick(plannableState");
const callAt = tick.indexOf("await triageAutoTask(");
const folderAt = tick.indexOf("resolveTaskProject(todo");
ok(excludeAt > 0 && planAt > excludeAt, "backed-off cards are excluded BEFORE the pass is planned, so they cannot occupy the concurrency cap");
ok(callAt > excludeAt, "which is also before the model call, so waiting actually saves the call");
ok(folderAt > excludeAt, "and before the folder lookup, which spawns git per project");
ok(
  /planAutoTick\(plannableState/.test(tick),
  "and the planner is handed the filtered board rather than being asked to know about backoffs"
);
// The other spend path: a card whose DISPATCH throws has already paid for its verdict, so retrying
// it every pass pays a fresh one every minute. That branch was uncovered when the backoff landed.
// Sliced from the catch's OPENING, not from its log line - the backoff call sits above that line,
// so anchoring on the message searched the wrong half of the block and the assertion failed for a
// reason that had nothing to do with the code.
const dispatchCatchAt = tick.indexOf("// Leave the card alone entirely so the next pass retries");
const dispatchCatch = dispatchCatchAt > 0 ? tick.slice(dispatchCatchAt, dispatchCatchAt + 1800) : "";
ok(
  /noteTriageFailure\(todo\.id\)/.test(dispatchCatch) && /could not dispatch/.test(dispatchCatch),
  "a card whose dispatch fails is backed off too, not retried every minute - it has already paid for its verdict"
);
ok(/triageRetry\.delete\(todo\.id\)/.test(tick), "a card that answers is forgotten, so a later failure starts from the base wait again");
ok(/waiting \d* more minute|waiting \$\{mins\} more minute/.test(tick), "and the wait is reported rather than looking like the card was ignored");

console.log(
  exit === 0
    ? "VERIFY OK: a failed triage backs off with doubling waits up to an hour, per card, checked before anything is spent - and a card that answers forgets its history."
    : "VERIFY FAILED."
);
process.exit(exit);
