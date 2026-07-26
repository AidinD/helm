import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Review records (task ce2d19ab).
//
// The bottleneck is not producing work, it is reviewing it - 8 items sat in
// review while the board also carried a card asking for a review flow. What made
// them expensive was that they all looked equally heavy: nothing said which ones
// were settled and which ones actually needed the captain's judgment, and nothing said
// how to check.
//
// So a record per task, written at handoff time, carrying the two things prose
// cannot be parsed for:
//
//   - `verdict`   - "stamp" (verified end to end, read the evidence and move on)
//                   vs "judgment" (a real decision only he can make)
//   - `testSteps` - numbered, checkable steps with an expected result
//
// And the field that keeps it honest: `notVerified`. A record that only lists
// what passed is a sales pitch. Today's worst near-miss was a feature whose tests
// all passed while the feature was broken, because the tests exercised the layer
// that had already been reasoned about - so what was NOT checked is the useful
// half.
//
// Jot stays the source of truth for STATUS (a task is in review because the board
// says so). The record only carries the evidence, so the two cannot disagree
// about what is under review.

const DIR = path.join(".helm", "reviews");

export function reviewsDir(metaHome) {
  return path.join(metaHome, DIR);
}

/** Jot ids are uuids; keep the filename to that shape so nothing can escape. */
function safeId(taskId) {
  const id = String(taskId || "").trim().toLowerCase();
  return /^[a-f0-9-]{8,64}$/.test(id) ? id : null;
}

export function reviewRecordPath(metaHome, taskId) {
  const id = safeId(taskId);
  return id ? path.join(reviewsDir(metaHome), `${id}.json`) : null;
}

export const REVIEW_VERDICTS = ["stamp", "judgment"];

/**
 * What is wrong with a record, as a list of human-readable problems. Empty means
 * complete. Used both to refuse a bad write and to mark a rendered record as
 * incomplete rather than silently showing a hollow card.
 */
export function reviewRecordProblems(rec) {
  const problems = [];
  if (!rec || typeof rec !== "object") {
    return ["not an object"];
  }
  if (!safeId(rec.taskId)) {
    problems.push("taskId is missing or not a Jot id");
  }
  if (!rec.summary || !String(rec.summary).trim()) {
    problems.push("summary is empty - the reader needs to know what changed");
  }
  if (!REVIEW_VERDICTS.includes(rec.verdict)) {
    problems.push(`verdict must be one of ${REVIEW_VERDICTS.join(" | ")}`);
  }
  if (!Array.isArray(rec.testSteps) || rec.testSteps.length === 0) {
    // The whole point is that he can check it, so this is not optional even for
    // a stamp - a stamp with no way to confirm it is just an assertion.
    problems.push("testSteps is empty - a claim with no way to check it is an assertion");
  } else if (rec.testSteps.some((s) => !s || !String(s.step || "").trim() || !String(s.expect || "").trim())) {
    problems.push("every test step needs both a step and an expected result");
  }
  if (rec.verdict === "judgment" && (!rec.ask || !String(rec.ask).trim())) {
    problems.push("a judgment item must state the ask - what decision is needed");
  }
  if (!Array.isArray(rec.evidence)) {
    problems.push("evidence must be an array (use [] if genuinely none)");
  }
  if (!Array.isArray(rec.notVerified)) {
    problems.push("notVerified must be an array - state the gaps, use [] only if there truly are none");
  }
  return problems;
}

export function readReviewRecord(metaHome, taskId) {
  const file = reviewRecordPath(metaHome, taskId);
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function listReviewRecords(metaHome) {
  const dir = reviewsDir(metaHome);
  if (!fs.existsSync(dir)) {
    return [];
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Write (replace) the record for a task. Refuses an incomplete record rather
 * than storing something that renders as a hollow card - the failure this whole
 * feature exists to prevent is a review item that looks reviewed and is not.
 * Atomic temp+rename.
 */
export function writeReviewRecord(metaHome, rec, { now = Date.now() } = {}) {
  const problems = reviewRecordProblems(rec);
  if (problems.length > 0) {
    return { ok: false, error: `Incomplete review record: ${problems.join("; ")}`, problems };
  }
  const file = reviewRecordPath(metaHome, rec.taskId);
  const existing = readReviewRecord(metaHome, rec.taskId);
  const body = {
    ...rec,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return { ok: true, path: file, record: body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function removeReviewRecord(metaHome, taskId) {
  const file = reviewRecordPath(metaHome, taskId);
  if (!file || !fs.existsSync(file)) {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Join the board's review items with their records - the shape the review page
 * renders. Jot decides WHAT is under review; a record only adds evidence.
 *
 * Ordering is the point of the page: judgment items first (they are the only ones
 * that actually need him), then stamps, then anything with no record at all -
 * which is surfaced rather than hidden, because a task in review with no record
 * is a gap in MY process, and hiding it would let it pass as reviewed.
 */
export function buildReviewQueue(reviewTasks, records) {
  const byId = new Map((records || []).map((r) => [String(r.taskId).toLowerCase(), r]));
  const rows = (reviewTasks || []).map((t) => {
    const rec = byId.get(String(t.id).toLowerCase()) || null;
    const problems = rec ? reviewRecordProblems(rec) : ["no review record was written for this task"];
    return {
      taskId: t.id,
      title: t.title || t.text || "(untitled)",
      category: t.category || null,
      priority: typeof t.priority === "number" ? t.priority : null,
      record: rec,
      incomplete: problems.length > 0,
      problems,
      verdict: problems.length === 0 ? rec.verdict : "unrecorded",
    };
  });
  const rank = { judgment: 0, stamp: 1, unrecorded: 2 };
  return rows.sort((a, b) => {
    const d = (rank[a.verdict] ?? 3) - (rank[b.verdict] ?? 3);
    return d !== 0 ? d : (a.priority ?? 99) - (b.priority ?? 99);
  });
}

/** Counts for the page header, so the shape of the queue reads at a glance. */
export function reviewQueueTally(rows) {
  return {
    total: rows.length,
    judgment: rows.filter((r) => r.verdict === "judgment").length,
    stamp: rows.filter((r) => r.verdict === "stamp").length,
    unrecorded: rows.filter((r) => r.verdict === "unrecorded").length,
  };
}
