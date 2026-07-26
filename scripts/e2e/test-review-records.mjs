// Unit test: review records (task ce2d19ab). The point of the feature is that a
// review item says which ones actually need the captain's judgment and HOW to check
// them - so the rules worth testing are the refusals: an item with no way to
// check it, or a judgment item with no stated ask, must not render as reviewed.
// Run:  node scripts/e2e/test-review-records.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  reviewsDir,
  reviewRecordPath,
  reviewRecordProblems,
  readReviewRecord,
  listReviewRecords,
  writeReviewRecord,
  removeReviewRecord,
  buildReviewQueue,
  reviewQueueTally,
} from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rev-"));
const ID_A = "7d9d2188-277e-4365-82d6-071da5669262";
const ID_B = "4bf2421c-cb41-4673-a87a-516be7f30d8e";

const complete = (over = {}) => ({
  taskId: ID_A,
  title: "Scheduled prompts",
  verdict: "stamp",
  summary: "A caret by the send button queues a prompt for the quota reset.",
  commits: ["bf30f42"],
  evidence: [{ claim: "31 unit assertions on the queue", kind: "test" }],
  notVerified: [],
  testSteps: [{ step: "Type a prompt, click the caret, pick 'Send when quota resets'", expect: "A queued bar appears naming the wait" }],
  release: "0.1.456",
  ...over,
});

try {
  // --- path safety ---
  ok(reviewRecordPath(metaHome, ID_A).startsWith(reviewsDir(metaHome)), "a record lands inside .helm/reviews");
  ok(reviewRecordPath(metaHome, "../../etc/passwd") === null, "a traversal id is refused outright");
  ok(reviewRecordPath(metaHome, "") === null, "an empty id is refused");
  ok(reviewRecordPath(metaHome, "short") === null, "a too-short id is refused");

  // --- completeness rules (the refusals are the feature) ---
  ok(reviewRecordProblems(complete()).length === 0, "a complete record has no problems");
  ok(reviewRecordProblems(null).length > 0, "null is not a record");

  const noSteps = reviewRecordProblems(complete({ testSteps: [] }));
  ok(noSteps.some((p) => /assertion/.test(p)), `no test steps is a problem even for a stamp (${noSteps[0]})`);

  const halfStep = reviewRecordProblems(complete({ testSteps: [{ step: "click it" }] }));
  ok(halfStep.some((p) => /expected result/.test(p)), "a step without an expected result is incomplete");

  const judgmentNoAsk = reviewRecordProblems(complete({ verdict: "judgment", ask: "" }));
  ok(judgmentNoAsk.some((p) => /ask/.test(p)), "a judgment item with no ask is incomplete");
  ok(reviewRecordProblems(complete({ verdict: "judgment", ask: "Confirm the layout" })).length === 0, "a judgment item WITH an ask is fine");

  ok(reviewRecordProblems(complete({ verdict: "looks-fine" })).some((p) => /verdict/.test(p)), "an invented verdict is refused");
  ok(reviewRecordProblems(complete({ summary: "  " })).some((p) => /summary/.test(p)), "an empty summary is refused");
  ok(reviewRecordProblems(complete({ notVerified: undefined })).some((p) => /notVerified/.test(p)), "notVerified must be present - the gaps are the useful half");

  // --- write refuses incomplete, accepts complete ---
  const bad = writeReviewRecord(metaHome, complete({ testSteps: [] }));
  ok(bad.ok === false && Array.isArray(bad.problems), `write REFUSES an incomplete record (${bad.error?.slice(0, 60)})`);
  ok(readReviewRecord(metaHome, ID_A) === null, "nothing was written for the refused record");

  const good = writeReviewRecord(metaHome, complete(), { now: 1000 });
  ok(good.ok === true && good.record.createdAt === 1000, "a complete record is written with a createdAt");
  ok(fs.existsSync(good.path), "the file exists on disk");

  // --- rewrite keeps createdAt, bumps updatedAt ---
  const again = writeReviewRecord(metaHome, complete({ summary: "revised summary" }), { now: 2000 });
  ok(again.record.createdAt === 1000 && again.record.updatedAt === 2000, "a rewrite keeps createdAt and bumps updatedAt");
  ok(readReviewRecord(metaHome, ID_A).summary === "revised summary", "the rewrite replaced the content");

  // --- listing + remove ---
  writeReviewRecord(metaHome, complete({ taskId: ID_B, title: "Widget dashboard", verdict: "judgment", ask: "Confirm the layout" }), { now: 3000 });
  ok(listReviewRecords(metaHome).length === 2, "both records list");
  ok(listReviewRecords(path.join(metaHome, "nope")).length === 0, "a missing dir lists nothing, no throw");

  // --- the queue: judgment first, unrecorded surfaced not hidden ---
  const tasks = [
    { id: ID_A, text: "Scheduled prompts", priority: 0, category: "Helm" },
    { id: ID_B, text: "Widget dashboard", priority: 0, category: "Helm" },
    { id: "cbd60642-0000-4000-8000-000000000000", text: "Double-firing routine", priority: 1, category: "Helm" },
  ];
  const rows = buildReviewQueue(tasks, listReviewRecords(metaHome));
  ok(rows.length === 3, "every board item appears, with or without a record");
  ok(rows[0].verdict === "judgment", `judgment items sort FIRST (got ${rows[0].verdict})`);
  ok(rows[1].verdict === "stamp", "then stamps");
  ok(rows[2].verdict === "unrecorded", "then anything with no record");
  ok(rows[2].incomplete === true && /no review record/.test(rows[2].problems[0]), "an unrecorded task is flagged, NOT hidden - hiding it would let it pass as reviewed");
  ok(rows[0].title === "Widget dashboard", "the title comes through");

  const tally = reviewQueueTally(rows);
  ok(tally.total === 3 && tally.judgment === 1 && tally.stamp === 1 && tally.unrecorded === 1, `the tally reads at a glance (${JSON.stringify(tally)})`);

  ok(buildReviewQueue([], []).length === 0, "an empty board is an empty queue");
  ok(buildReviewQueue(null, null).length === 0, "null inputs do not throw");

  ok(removeReviewRecord(metaHome, ID_A) === true, "remove works");
  ok(removeReviewRecord(metaHome, ID_A) === false, "removing twice is a no-op");

  const leftovers = fs.readdirSync(reviewsDir(metaHome)).filter((f) => f.includes(".tmp"));
  ok(leftovers.length === 0, "atomic write leaves no .tmp files");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(metaHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: review records - refusals hold, queue puts judgment first, unrecorded tasks are surfaced." : "VERIFY FAILED.");
process.exit(exit);
