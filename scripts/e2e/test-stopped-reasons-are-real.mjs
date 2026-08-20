// No fixture may invent a stopped-reason the goal loop cannot produce.
//
// WHY. On 2026-08-18 a test was found asserting against `stoppedReason: "completed"`,
// which nothing in the app can emit. It was fixed in that one file. Two days later the
// same fiction was still in eleven others - "completed" six times, "converged" four,
// "done" twice - and three of those tests were failing because of it while the rest
// passed for the wrong reason, describing a world the app cannot enter. That is failure
// 12 on ship-review's own list, verbatim: one instance fixed, the class left open.
//
// So this closes the class in two steps, and the first matters more than the second:
//
//   1. The canonical list in runOutcome.js is pinned against goalOrchestrator.js's OWN
//      SOURCE. A list maintained by hand beside the loop is just a second place to be
//      wrong; this fails if the loop gains or loses a terminal reason and nobody
//      updates the list.
//   2. Every fixture in scripts/e2e is scanned against that list.
//
// Comments are stripped before scanning. A source-scan check that matches its own
// explanatory comment is failure 2 on the same list, and this file's own header names
// the fictional values - so without stripping, this test would fail on itself.
//
// A value that is deliberately NOT real - there is one, testing the branch for an
// outcome nobody can name - has to be declared below. That keeps the escape hatch
// explicit and countable instead of being whatever slipped through.
//
// Run:  node scripts/e2e/test-stopped-reasons-are-real.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TERMINAL_REASONS } from "../../src/lib/runOutcome.js";

const E2E = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(E2E, "..", "..");

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    failures++;
  }
};

// Values a fixture is allowed to invent, each because it is testing what happens with a
// reason the app does NOT recognise. Adding to this list is a deliberate act.
const DELIBERATE_FICTION = new Set(["some_reason_nobody_wrote_yet"]);

// --- 1. the list must match the loop --------------------------------------
const loopSrc = fs.readFileSync(path.join(REPO, "src", "lib", "goalOrchestrator.js"), "utf8");
const emitted = new Set([...loopSrc.matchAll(/stoppedReason\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]));

ok(emitted.size > 0, `found the loop's own assignments to read (${emitted.size})`);
const missingFromList = [...emitted].filter((r) => !TERMINAL_REASONS.includes(r));
const notEmitted = TERMINAL_REASONS.filter((r) => !emitted.has(r));
ok(
  missingFromList.length === 0,
  `every reason the loop assigns is in TERMINAL_REASONS${missingFromList.length ? ` - MISSING: ${missingFromList.join(", ")}` : ""}`
);
ok(
  notEmitted.length === 0,
  `and nothing in TERMINAL_REASONS is stale${notEmitted.length ? ` - the loop never assigns: ${notEmitted.join(", ")}` : ""}`
);
// The absence that the whole outcome design rests on. If a goal-reached state is ever
// added, classifyRunOutcome has to learn it and this assertion is where that surfaces.
ok(
  !TERMINAL_REASONS.some((r) => /^(done|completed|complete|success|succeeded|converged|finished|goal_reached)$/.test(r)),
  "the loop still has NO goal-reached state - which is why 'it stopped' must never render as 'it succeeded'"
);

// --- 2. no fixture may invent one ----------------------------------------
/** Strip line and block comments so the scan cannot match an explanation of the bug. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const files = fs.readdirSync(E2E).filter((f) => f.endsWith(".mjs"));
const offences = [];
let scanned = 0;
let literals = 0;
for (const file of files) {
  const src = stripComments(fs.readFileSync(path.join(E2E, file), "utf8"));
  scanned++;
  for (const m of src.matchAll(/stoppedReason\s*:\s*"([a-zA-Z_]+)"/g)) {
    literals++;
    const value = m[1];
    if (!TERMINAL_REASONS.includes(value) && !DELIBERATE_FICTION.has(value)) {
      offences.push(`${file}: "${value}"`);
    }
  }
}

ok(scanned > 50, `scanned the fixture suite (${scanned} files, ${literals} stopped-reason literals)`);
ok(
  offences.length === 0,
  offences.length === 0
    ? "no fixture seeds a stopped-reason the loop cannot produce"
    : `fixtures seed values the app cannot produce: ${offences.join("; ")}`
);

// The scan has to be able to fail, or it is decoration. Prove it against a value that
// is definitely not real, through the same code path the real scan uses.
const probe = stripComments(`// stoppedReason: "completed" in a comment must be ignored\nconst x = { stoppedReason: "totally_made_up" };`);
const probeHits = [...probe.matchAll(/stoppedReason\s*:\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]);
ok(probeHits.length === 1 && probeHits[0] === "totally_made_up", `the scan sees code and ignores comments (saw ${JSON.stringify(probeHits)})`);
ok(!TERMINAL_REASONS.includes("totally_made_up"), "and would reject it");

console.log(
  failures === 0
    ? "\nVERIFY OK: the canonical stopped-reason list matches the loop, and no fixture invents one."
    : `\nVERIFY FAILED (${failures}).`
);
process.exit(failures === 0 ? 0 : 1);

// Keep pathToFileURL referenced so a future dynamic import in here uses the right
// helper rather than a hand-rolled path-to-URL swap (see run-tests.mjs, same day).
void pathToFileURL;
