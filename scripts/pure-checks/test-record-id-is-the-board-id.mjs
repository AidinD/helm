// A review record must be filed under the id the Review page asks for.
//
// THE FAILURE, and it is the quietest kind this project has.
// A review row carries the FULL Jot uuid, and the page reads its record by that. A record
// filed under the eight-character prefix everybody quotes in conversation - "card ba3138af" -
// lands in a filename nothing ever asks for. The page then says "No review record: treat it as
// unreviewed", which is indistinguishable from nobody having written one. The work was
// reviewed, the evidence exists on disk, and the board says it does not.
//
// Six such records were on disk when this was written. Three had been written that same day,
// by an agent that had read the convention and used the short form anyway; three were older.
// That count is the argument for a control rather than a note: the convention was documented
// and it did not hold.
//
// It is also the shape reliability direction 2 names - an id translation on the READ path
// (allTaskShortIds, and every human who quotes eight characters) with no counterpart on the
// write path, drifting until the writer could produce something the reader cannot find.
//
// WHY REFUSE RATHER THAN RESOLVE, asserted below because it is a decision and not an
// oversight: expanding a prefix means reading the board, a prefix can match more than one
// card, and a writer that guesses which card it meant is worse than one that stops. The caller
// already has the full id - it came off the board a moment earlier.
//
// Run:  node scripts/pure-checks/test-record-id-is-the-board-id.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewRecordProblems, writeReviewRecord, readReviewRecord, reviewRecordPath } from "../../src/lib/reviewRecords.js";

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const FULL = "abcdef12-3456-4789-8abc-def012345678";
const PREFIX = "abcdef12";

const base = (taskId) => ({
  taskId,
  title: "a fixture task",
  verdict: "stamp",
  criticality: "cosmetic",
  whyNotCritical: "a fixture record, so being wrong about it costs nothing at all.",
  intent: { text: "prove a record is filed where the page looks for it", source: "captain" },
  summary: "a fixture record used to prove the id rule",
  projectPath: "D:/Repo/Tools/helm",
  evidence: [{ claim: "the fixture exists", detail: "written by this check into a temp meta home." }],
  notVerified: [{ claim: "nothing real was verified", detail: "this is a fixture and asserts only the id rule." }],
  testSteps: [{ step: "read the card", expect: "the record is on it" }],
  checks: [],
});

// --- the rule, before any file is written -------------------------------------------------
const prefixProblems = reviewRecordProblems(base(PREFIX));
ok(
  prefixProblems.some((p) => /PREFIX/.test(p)),
  `a prefix id is a stated problem, not a silent one (${JSON.stringify(prefixProblems)})`
);
ok(
  prefixProblems.some((p) => /whole board id|full uuid/i.test(p)),
  "and the message says which id to use, so the fix is obvious without reading the code"
);
ok(
  reviewRecordProblems(base(FULL)).length === 0,
  `the whole board id is accepted (${JSON.stringify(reviewRecordProblems(base(FULL)))})`
);

// --- and the write path really refuses it, not just the validator --------------------------
// Asserted separately because a validator nobody calls is the other half of this same family
// of defect: the rule exists, the path does not use it.
const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-recordid-"));
try {
  const refused = writeReviewRecord(metaHome, base(PREFIX));
  ok(refused?.ok !== true, `writeReviewRecord refuses it (${JSON.stringify(refused?.error || refused)})`);
  ok(
    !fs.existsSync(reviewRecordPath(metaHome, PREFIX)),
    "and nothing was written - a refused record must not half-exist"
  );

  const wrote = writeReviewRecord(metaHome, base(FULL));
  ok(wrote?.ok === true, `the same record with the full id is written (${JSON.stringify(wrote?.error || "ok")})`);

  // THE POINT OF THE WHOLE RULE: the reader finds it. Asserted through readReviewRecord rather
  // than by checking the filename, because the filename is the mechanism and being found is
  // the property - and it was the property that failed six times.
  const read = readReviewRecord(metaHome, FULL);
  ok(read?.taskId === FULL, `and the reader finds it by the id a review row carries (${JSON.stringify(read?.taskId)})`);
  ok(
    readReviewRecord(metaHome, PREFIX) === null || readReviewRecord(metaHome, PREFIX)?.taskId !== FULL,
    "while the prefix finds nothing, which is exactly what made the old failure invisible"
  );
} finally {
  fs.rmSync(metaHome, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - a record can only be filed under the id the Review page reads, and the refusal says which id to use");
