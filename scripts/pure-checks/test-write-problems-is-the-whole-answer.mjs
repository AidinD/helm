// If a record passes the check an author runs, the writer must accept it.
//
// THE FAILURE, hit twice in one evening by the author of both calls: `reviewRecordProblems`
// returned [], and `writeReviewRecord` then refused the same record - once for six evidence
// entries against a limit of five, once for a claim 122 characters long against a limit of
// 120. Neither refusal was wrong. The validator simply answers a NARROWER question than its
// name implies: admissibility, not "can this be written".
//
// WHAT IS DELIBERATELY NOT FIXED, because collapsing it would break something measured: the
// writer applies the gates in TIERS. A pure check stamp gets past presentation on purpose - 89
// of 96 existing records fail the readability limits, and `recordCheckRun` rewrites the whole
// record, so enforcing them there dropped real passing checks on 89 records. Admissibility is
// never bypassed. That structure stays; what changes is that one function now composes it, and
// the writer is implemented in terms of that function so the two cannot drift.
//
// Run:  node scripts/pure-checks/test-write-problems-is-the-whole-answer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reviewRecordProblems,
  reviewRecordWriteProblems,
  writeReviewRecord,
  readReviewRecord,
} from "../../src/lib/reviewRecords.js";

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const FULL = "abcdef12-3456-4789-8abc-def012345678";
const base = () => ({
  taskId: FULL,
  title: "a fixture task",
  verdict: "stamp",
  criticality: "cosmetic",
  whyNotCritical: "a fixture record, so being wrong about it costs nothing at all.",
  intent: { text: "prove the author-facing check agrees with the writer", source: "captain" },
  summary: "a fixture record used to prove one question has one answer",
  projectPath: "D:/Repo/Tools/helm",
  evidence: [{ claim: "the fixture exists", detail: "written by this check into a temp meta home." }],
  notVerified: [{ claim: "nothing real was verified", detail: "this is a fixture and asserts only the agreement." }],
  testSteps: [{ step: "read the card", expect: "it is there" }],
  checks: [],
});

// THE TWO RECORDS THAT ACTUALLY CAUSED THIS. Both were accepted by reviewRecordProblems and
// refused by the writer; they are the fixture rather than an invented one, so the check is
// about what happened.
const sixEvidence = base();
sixEvidence.evidence = Array.from({ length: 6 }, (_, i) => ({
  claim: `evidence entry number ${i + 1}`,
  detail: "one of six, which is one more than the limit.",
}));

const longClaim = base();
longClaim.evidence = [
  {
    claim: "x".repeat(122),
    detail: "a claim past the limit, which is what shows before anything is clicked.",
  },
];

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-writeproblems-"));
try {
  for (const [name, rec] of [
    ["six evidence entries", sixEvidence],
    ["a claim past the length limit", longClaim],
  ]) {
    // The old question still answers the old way - this is not a regression in it.
    ok(reviewRecordProblems(rec).length === 0, `${name}: still ADMISSIBLE, which was never in doubt`);

    const gates = reviewRecordWriteProblems(rec);
    ok(gates.problems.length > 0, `${name}: but the write question says no, which is the point`);
    ok(gates.admissibility.length === 0, `${name}: and it says WHICH gate - not admissibility`);
    ok(gates.readability.length > 0, `${name}: it is readability`);

    // THE AGREEMENT, asserted against the writer itself rather than against a copy of its
    // rules. A check that re-implemented the tiers would pass while they drifted.
    const wrote = writeReviewRecord(metaHome, rec);
    ok(wrote.ok === false, `${name}: the writer refuses it too`);
    ok(
      JSON.stringify(wrote.problems) === JSON.stringify(gates.readability),
      `${name}: with exactly the problems the author was told about`
    );
  }

  // AND THE OTHER DIRECTION, which is the one that matters day to day: clean by the composed
  // question means the write succeeds.
  const good = base();
  ok(reviewRecordWriteProblems(good).problems.length === 0, "a good record has nothing against it");
  const wroteGood = writeReviewRecord(metaHome, good);
  ok(wroteGood.ok === true, `and the writer accepts it (${JSON.stringify(wroteGood.error || "ok")})`);
  ok(readReviewRecord(metaHome, FULL)?.taskId === FULL, "and it can be read back");

  // THE TIERING SURVIVES. A stamp skips presentation and never skips admissibility - if this
  // ever flips, a real passing check starts being dropped for how a record is written.
  ok(
    reviewRecordWriteProblems(sixEvidence, { stampOnly: true }).problems.length === 0,
    "a pure evidence stamp is not judged on presentation - that bypass is measured and stays"
  );
  const inadmissible = base();
  inadmissible.taskId = "abcdef12";
  ok(
    reviewRecordWriteProblems(inadmissible, { stampOnly: true }).admissibility.length > 0,
    "but a stamp is still judged on ADMISSIBILITY, or a record that may claim nothing collects green ticks"
  );
} finally {
  fs.rmSync(metaHome, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - one question has one answer, and the writer is the thing that answers it");
