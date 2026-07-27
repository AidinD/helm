import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Review records (task ce2d19ab).
//
// The bottleneck is not producing work, it is reviewing it - 8 items sat in
// review while the board also carried a card asking for a review flow. What made
// them expensive was that they all looked equally heavy: nothing said which ones
// were settled and which ones actually needed Aidin's judgment, and nothing said
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
  if (rec.checks !== undefined) {
    if (!Array.isArray(rec.checks)) {
      problems.push("checks must be an array");
    } else if (rec.checks.some((c) => !c || !String(c.label || "").trim() || !String(c.cmd || "").trim())) {
      problems.push("every check needs a label and a cmd");
    }
  }
  return problems;
}

// --- The gauntlet (Uncle Bob, task bd5d7b4b) -------------------------------
// `evidence` is what the agent CLAIMS. `checks` are commands, and `checkRuns`
// are what actually happened when they ran - exit code, when, and the tail of
// the output. Kept as separate fields on purpose: the whole reason review is
// cheap-but-trustworthy is that some of the evidence is not the author's word.
//
// The failure this guards is real and recent: a feature shipped whose tests all
// passed while the feature was broken, because the tests exercised the layer the
// author had already reasoned about. A stored exit code cannot be talked around.

/** Stamp the outcome of one executed check onto a record. */
export function recordCheckRun(metaHome, taskId, run, { now = Date.now() } = {}) {
  const rec = readReviewRecord(metaHome, taskId);
  if (!rec) {
    return { ok: false, error: "No review record for that task." };
  }
  if (!run || !String(run.label || "").trim()) {
    return { ok: false, error: "A check run needs the label it ran for." };
  }
  const runs = Array.isArray(rec.checkRuns) ? rec.checkRuns.filter((r) => r.label !== run.label) : [];
  runs.push({
    label: String(run.label),
    cmd: run.cmd ? String(run.cmd) : null,
    exitCode: typeof run.exitCode === "number" ? run.exitCode : null,
    ok: run.exitCode === 0,
    ranAt: now,
    tail: run.tail ? String(run.tail).slice(-1200) : null,
  });
  // isRunStamp: recording an outcome must not move the staleness baseline.
  return writeReviewRecord(metaHome, { ...rec, checkRuns: runs }, { now, isRunStamp: true });
}

/**
 * How the gauntlet stands for a record: has every declared check been run since
 * the record was last written, and did they pass?
 *
 * A run from BEFORE the record's last update is treated as stale, not as a pass -
 * otherwise a green tick from an older version of the work keeps vouching for
 * code that has since changed.
 */
export function gauntletStatus(rec) {
  const checks = Array.isArray(rec?.checks) ? rec.checks : [];
  if (checks.length === 0) {
    return { declared: 0, passed: 0, failed: 0, stale: 0, unrun: 0, state: "none" };
  }
  const runs = Array.isArray(rec.checkRuns) ? rec.checkRuns : [];
  const updatedAt = typeof rec.contentUpdatedAt === "number" ? rec.contentUpdatedAt : typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
  let passed = 0;
  let failed = 0;
  let stale = 0;
  let unrun = 0;
  for (const c of checks) {
    const run = runs.find((r) => r.label === c.label);
    if (!run) {
      unrun += 1;
    } else if ((run.ranAt || 0) < updatedAt) {
      stale += 1;
    } else if (run.ok) {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  const state = failed > 0 ? "failing" : unrun + stale > 0 ? "incomplete" : "passing";
  return { declared: checks.length, passed, failed, stale, unrun, state };
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
export function writeReviewRecord(metaHome, rec, { now = Date.now(), isRunStamp = false } = {}) {
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
    // Staleness is measured against when the CLAIM last changed, not against the
    // last write - because stamping a check run is itself a write. With one
    // baseline for both, running N checks made the first N-1 read as stale (each
    // later stamp moved the baseline past the earlier runs), so a multi-check
    // gauntlet could never reach "passing" however green the checks were.
    //
    // Only recordCheckRun passes isRunStamp, and it is an explicit ARGUMENT rather
    // than a field on the record: if preserving it were data-driven, an ordinary
    // edit that spread the previous record would silently carry the old baseline
    // forward too, and a green tick would keep vouching for changed work - the
    // exact failure the staleness rule exists to prevent.
    contentUpdatedAt: isRunStamp && typeof existing?.contentUpdatedAt === "number" ? existing.contentUpdatedAt : now,
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
      gauntlet: rec ? gauntletStatus(rec) : { declared: 0, state: "none" },
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
