import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseAcceptanceCriteria, acceptanceCoverage } from "./acceptance.js";

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

// Criticality drives what evidence is REQUIRED, not just how carefully to work
// (Aidin 2026-07-27): "störst effort borde ligga på systemkritiska moment. security
// issues borde t.ex aldrig slinka igenom, medans en front end bugg är mer
// acceptabelt."
//
// Uniform rigour is what makes "I don't review code anymore" unsafe: it spends the
// same shallow pass on an auth path as on a misaligned pixel. The gradient is what
// lets him stop reading diffs while keeping the veto where being wrong is expensive.
export const CRITICALITY_TIERS = {
  critical: {
    label: "Critical",
    what: "security, auth, data loss or corruption, money, irreversible or outward-facing actions (release, publish, delete, spend)",
    // The author's own passing tests are not evidence at this tier. Something from
    // OUTSIDE the author has to have looked - that is the whole finding from
    // 2026-07-26/27, where green self-written tests sat on top of broken features.
    requiresIndependentReview: true,
    requiresChecks: true,
  },
  core: {
    label: "Core",
    what: "state, persistence, or behaviour other work depends on",
    requiresIndependentReview: false,
    requiresChecks: true,
  },
  cosmetic: {
    label: "Cosmetic",
    what: "visual or front-end only; a bug here is recoverable and finding it later is acceptable",
    requiresIndependentReview: false,
    requiresChecks: false,
  },
};
export const CRITICALITY_LEVELS = Object.keys(CRITICALITY_TIERS);

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
    } else {
      const dupes = duplicateCheckLabels(rec);
      if (dupes.length > 0) {
        // Runs are keyed by label, so duplicates cannot be scored separately - the
        // second stamp overwrites the first and a failing check disappears.
        problems.push(`check labels must be unique - "${dupes[0]}" appears more than once, so their runs would overwrite each other`);
      }
    }
  }
  problems.push(...criticalityProblems(rec));
  problems.push(...acceptanceRecordProblems(rec));
  return problems;
}

/**
 * The criticality gradient, enforced (Aidin 2026-07-27).
 *
 * Required, with no default. A missing tier is the author declining to say how much
 * it costs to be wrong here - which is precisely the judgement the gradient exists
 * to force, so silence must not resolve to the lenient option.
 */
function criticalityProblems(rec) {
  const problems = [];
  const tier = CRITICALITY_TIERS[rec.criticality];
  if (!tier) {
    return [`criticality must be one of ${CRITICALITY_LEVELS.join(" | ")} - say how much it costs to be wrong here`];
  }
  const checks = Array.isArray(rec.checks) ? rec.checks : [];
  if (tier.requiresChecks && checks.length === 0) {
    problems.push(`a ${rec.criticality} item needs at least one runnable check - "${tier.what}" cannot rest on prose alone`);
  }
  if (tier.requiresIndependentReview) {
    const ind = rec.independentReview;
    if (!ind || !String(ind.by || "").trim() || !String(ind.summary || "").trim()) {
      problems.push(
        "a critical item needs independentReview {by, summary} - at this tier the author's own passing tests are not evidence (2026-07-27: three features shipped broken under green self-written tests)"
      );
    } else if (typeof ind.findings !== "number") {
      problems.push("independentReview.findings must be a number - how many issues the independent pass raised (0 is a real answer)");
    }
  }
  return problems;
}

/**
 * Acceptance criteria, enforced at the review boundary.
 *
 * Copied onto the record rather than read live from the task: a record is a snapshot
 * of a claim, and a task edited afterwards must not retroactively change what was
 * claimed. The cost is that they can drift from the task - surfaced by
 * acceptanceDrift() rather than hidden.
 *
 * Every criterion must be linked to a test step by name or number. This is the half
 * that would have caught the "Jump in" bug: the criterion was "I land in the
 * session", the test COUNTED buttons, and nothing connected the two.
 */
function acceptanceRecordProblems(rec) {
  const raw = Array.isArray(rec.acceptanceCriteria) ? rec.acceptanceCriteria : null;
  // Re-index by POSITION. A record is hand-authored, and duplicated index values let
  // one linked step satisfy several criteria at once (`[{index:1,...},{index:1,...}]`
  // with a single `ac: 1` read as fully covered). The author does not get to decide
  // the numbering that the coverage check keys on.
  const criteria = raw ? raw.map((c, i) => ({ index: i + 1, text: typeof c === "string" ? c : String(c?.text || "") })) : null;
  if (!criteria) {
    // Not every record has criteria yet (they only exist for work taken after this
    // landed), so their ABSENCE is not a refusal - but a present-and-empty array is
    // an explicit claim that the task had none, which is allowed and visible.
    return [];
  }
  const problems = [];
  const { uncovered, dangling } = acceptanceCoverage(criteria, rec.testSteps);
  for (const c of uncovered) {
    problems.push(`acceptance criterion ${c.index} has no test step covering it: "${c.text}" - link one with ac: ${c.index}`);
  }
  for (const ref of dangling) {
    problems.push(`a test step claims to cover "${ref}", which is not one of this task's acceptance criteria`);
  }
  return problems;
}

/**
 * Has the task's acceptance changed since the record snapshotted it? Reported, never
 * auto-resolved: if the criteria moved, either the work needs revisiting or the
 * record does, and only a human knows which.
 */
export function acceptanceDrift(rec, taskDescription) {
  const snapshot = Array.isArray(rec?.acceptanceCriteria) ? rec.acceptanceCriteria : [];
  const live = parseAcceptanceCriteria(taskDescription);
  const key = (list) => list.map((c) => (typeof c === "string" ? c : c.text).trim().toLowerCase()).sort().join("|");
  const drifted = key(snapshot) !== key(live);
  return { drifted, snapshot, live };
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

// --- Run provenance: "the app ran this" vs "someone typed this" -------------
//
// The gauntlet's whole claim is that part of the evidence is not the author's word.
// As first built, that was false: writeReviewRecord (and all its refusals) is not on
// any production path - records are authored by an agent writing JSON directly - and
// gauntletStatus trusted a `ok: true` field without ever looking at the exit code.
// So a hand-written record with
//     checks:    [{ label: "auth e2e (34 assertions)", cmd: "exit 0" }]
//     checkRuns: [{ label: "auth e2e (34 assertions)", ok: true }]
// read as "Checks passing (1/1), ready to stamp" with no command ever executed.
//
// So a check run now carries an HMAC written ONLY by the process that actually
// spawned the command. An unsigned or mis-signed run is not evidence.
//
// HONEST LIMIT, stated because this file is the thing that is supposed to be honest:
// the key sits on disk in the meta-home, so an agent with filesystem access can read
// it and forge a signature. This is tamper-EVIDENT, not tamper-proof. What it
// actually buys is the line between "the app ran this and stamped the result" and
// "the author wrote down an outcome they believed" - and the second one is the
// failure that keeps happening. A real guarantee needs the runner outside the
// author's reach (CI), which is not built.
const RUN_KEY_FILE = path.join(".helm", "run-key");

function runKey(metaHome) {
  if (!metaHome) {
    return null;
  }
  const file = path.join(metaHome, RUN_KEY_FILE);
  try {
    if (fs.existsSync(file)) {
      const key = fs.readFileSync(file, "utf8").trim();
      return key.length >= 32 ? key : null;
    }
    const key = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key + "\n", { encoding: "utf8", mode: 0o600 });
    return key;
  } catch {
    return null;
  }
}

/** The signature a genuine run carries. Covers everything a reader would trust. */
export function signCheckRun(metaHome, taskId, run) {
  const key = runKey(metaHome);
  if (!key) {
    return null;
  }
  const payload = JSON.stringify([
    String(taskId || ""),
    String(run?.label || ""),
    String(run?.cmd || ""),
    typeof run?.exitCode === "number" ? run.exitCode : null,
    typeof run?.ranAt === "number" ? run.ranAt : null,
  ]);
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

/** Did this run actually come from the app? */
export function verifyCheckRun(metaHome, taskId, run) {
  if (!run || typeof run.sig !== "string") {
    return false;
  }
  const expected = signCheckRun(metaHome, taskId, run);
  if (!expected || expected.length !== run.sig.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(run.sig));
}

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
  const stamped = {
    label: String(run.label),
    cmd: run.cmd ? String(run.cmd) : null,
    exitCode: typeof run.exitCode === "number" ? run.exitCode : null,
    ranAt: now,
  };
  runs.push({
    ...stamped,
    // Kept for readability, but gauntletStatus derives pass/fail from exitCode and
    // ignores this - a boolean is trivially wrong in a hand-written record, and it
    // was trusted for exactly that reason before.
    ok: run.exitCode === 0,
    sig: signCheckRun(metaHome, taskId, stamped),
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
export function gauntletStatus(rec, metaHome = null) {
  const checks = Array.isArray(rec?.checks) ? rec.checks : [];
  if (checks.length === 0) {
    return { declared: 0, passed: 0, failed: 0, stale: 0, unrun: 0, unverified: 0, state: "none" };
  }
  const runs = Array.isArray(rec.checkRuns) ? rec.checkRuns : [];
  const updatedAt = typeof rec.contentUpdatedAt === "number" ? rec.contentUpdatedAt : typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
  let passed = 0;
  let failed = 0;
  let stale = 0;
  let unrun = 0;
  let unverified = 0;
  // Two checks sharing a label collapse to one run (runs are keyed by label), so the
  // second stamp silently overwrote the first: a suite with a failing check and a
  // passing one under the same name read as 2/2 passing. Refuse to score duplicates.
  const seenLabels = new Set();
  for (const c of checks) {
    const label = String(c?.label || "");
    if (seenLabels.has(label)) {
      unverified += 1;
      continue;
    }
    seenLabels.add(label);
    const run = runs.find((r) => r.label === label);
    if (!run) {
      unrun += 1;
      continue;
    }
    // Provenance BEFORE outcome. A run the app did not stamp is not a result at all -
    // pass or fail - so it can neither vouch for the work nor condemn it.
    if (typeof run.ranAt !== "number" || typeof run.exitCode !== "number" || !verifyCheckRun(metaHome, rec.taskId, run)) {
      unverified += 1;
    } else if (run.ranAt < updatedAt) {
      stale += 1;
    } else if (run.exitCode === 0) {
      // Derived from the exit code, never from run.ok - a boolean in a file the
      // author writes is worth nothing, and it was trusted for exactly that reason.
      passed += 1;
    } else {
      failed += 1;
    }
  }
  // "passing" requires every declared check to be a verified, fresh, zero-exit run.
  // Anything else is not a pass, and unverified is called out separately from stale
  // so "nobody ran this" can't hide inside "this is a bit out of date".
  const state = failed > 0 ? "failing" : unrun + stale + unverified > 0 ? "incomplete" : "passing";
  return { declared: checks.length, passed, failed, stale, unrun, unverified, state };
}

/** Duplicate check labels are unscoreable, so they are a record-level defect. */
function duplicateCheckLabels(rec) {
  const seen = new Set();
  const dupes = new Set();
  for (const c of Array.isArray(rec?.checks) ? rec.checks : []) {
    const label = String(c?.label || "").trim();
    if (seen.has(label)) {
      dupes.add(label);
    }
    seen.add(label);
  }
  return [...dupes];
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
export function buildReviewQueue(reviewTasks, records, metaHome = null) {
  const byId = new Map((records || []).map((r) => [String(r.taskId).toLowerCase(), r]));
  const rows = (reviewTasks || []).map((t) => {
    const rec = byId.get(String(t.id).toLowerCase()) || null;
    const problems = rec ? reviewRecordProblems(rec) : ["no review record was written for this task"];
    // "incomplete" and "unrecorded" are deliberately DIFFERENT verdicts. Both used
    // to read as "unrecorded", which hid the more alarming case: a record exists,
    // so somebody claimed this was reviewed, but the claim is inadmissible (e.g. a
    // critical item with nothing independent behind it). Nobody-wrote-one and
    // somebody-wrote-a-bad-one need different reactions.
    const verdict = problems.length === 0 ? rec.verdict : rec ? "incomplete" : "unrecorded";
    return {
      taskId: t.id,
      title: t.title || t.text || "(untitled)",
      category: t.category || null,
      priority: typeof t.priority === "number" ? t.priority : null,
      record: rec,
      incomplete: problems.length > 0,
      problems,
      verdict,
      criticality: rec?.criticality || null,
      // Did the task's acceptance criteria move after the record snapshotted them?
      drift: rec ? acceptanceDrift(rec, t.description || "") : { drifted: false, snapshot: [], live: [] },
      gauntlet: rec ? gauntletStatus(rec, metaHome) : { declared: 0, state: "none" },
    };
  });
  // Ordering is an attention model, so it gets stated rather than inherited:
  //
  //   0. things needing a decision (judgment), AND any CRITICAL item that claims to
  //      be reviewed but isn't admissible. The second one belongs at the top even
  //      though the fix is mine, not his: it means something on the expensive tier
  //      is being presented as verified when nothing independent has looked. Sorting
  //      it below a batch of cheap cosmetic stamps buries exactly the alarm the
  //      gradient exists to raise.
  //   1. stamps - cheap, safe, read the evidence and move on.
  //   2. everything else inadmissible or unwritten - informational; it tells him I
  //      have work left, not that he does.
  //
  // Within a band: criticality, then board priority.
  const band = (r) => {
    if (r.verdict === "judgment" || (r.verdict === "incomplete" && r.criticality === "critical")) {
      return 0;
    }
    return r.verdict === "stamp" ? 1 : 2;
  };
  const critRank = { critical: 0, core: 1, cosmetic: 2 };
  return rows.sort((a, b) => {
    const d = band(a) - band(b);
    if (d !== 0) {
      return d;
    }
    const c = (critRank[a.criticality] ?? 3) - (critRank[b.criticality] ?? 3);
    return c !== 0 ? c : (a.priority ?? 99) - (b.priority ?? 99);
  });
}

/** Counts for the page header, so the shape of the queue reads at a glance. */
export function reviewQueueTally(rows) {
  return {
    total: rows.length,
    judgment: rows.filter((r) => r.verdict === "judgment").length,
    stamp: rows.filter((r) => r.verdict === "stamp").length,
    unrecorded: rows.filter((r) => r.verdict === "unrecorded").length,
    // A record that exists but is inadmissible - counted apart from "nobody wrote
    // one", because it needs a different reaction.
    incomplete: rows.filter((r) => r.verdict === "incomplete").length,
    critical: rows.filter((r) => r.criticality === "critical").length,
  };
}
