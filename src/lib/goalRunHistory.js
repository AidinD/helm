import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicSync } from "./atomicWrite.js";
import { resolveSecondMateId } from "./secondMates.js";
import { classifyRunOutcome } from "./runOutcome.js";

// Persistent index of goal-orchestrator runs (Fas 3 Point 11), so the Goal
// page still shows what happened after a restart — Helm is restarted
// often, and until now `goalRuns` lived only in the renderer's in-memory Map
// (reset on every reload), even though the real artifacts (worktree, branch,
// commits) survive on disk. This stores a COMPACT record per run only —
// never the full iteration transcript, which stays recoverable from the
// worktree's own .helm-goal/notes.md — mirroring config.js's plain
// JSON-file-next-to-config.json pattern rather than inventing a new storage
// location (e.g. Electron's userData dir, which nothing else here uses).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_GOAL_RUN_HISTORY_PATH is a test/packaged-app seam (see main.js's
// packagedPaths.js); production/dev leaves it unset and uses the plain JSON
// file beside the app.
const historyPath = process.env.HELM_GOAL_RUN_HISTORY_PATH || path.join(__dirname, "..", "..", "goal-run-history.json");

const MAX_RECORDS = 200; // compact records are tiny; this is a generous cap, not a rolling window tuned for size

function readAll() {
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(records) {
  // Shared atomic write with the locked-file retry (task efcaf486) - see the note
  // in domains.js for why this one was missed until 2026-08-02.
  const res = writeJsonAtomicSync(historyPath, records);
  if (!res.ok) {
    throw new Error(`Could not write the goal-run history: ${res.error}`);
  }
}

/**
 * The value that stands in for a model label nobody can trust.
 *
 * A short word rather than a sentence because it lands in the same slot a model name does -
 * a badge on the Goal page, the `model` line of the report a mate reads. "unverified" reads
 * correctly there; a paragraph would not, and an empty string would read as "no model",
 * which is a different and equally wrong claim.
 */
export const MODEL_UNVERIFIED = "unverified";

/**
 * Fields this module derives at READ time and that must never reach the file. Listed once so
 * the reader that adds them and the writer that strips them cannot drift.
 */
const DERIVED_FIELDS = Object.freeze(["outcome", "modelTrust", "resolvedModelRecorded"]);

/**
 * Can this record's model label be believed?
 *
 * THE BUG THIS ANSWERS, and why it is answered here rather than migrated away. Until
 * 2026-08-18 `extractUsage` took the FIRST entry of the CLI's modelUsage list and called it
 * the model that ran. The CLI always lists a small internal Haiku call first, so runs that
 * genuinely ran Opus 4.8 recorded Haiku. Measured on the installed store on 2026-09-02: 27
 * of 56 records name a model that disagrees with the one the run asked for, and every one of
 * those 27 asked for Opus and recorded Haiku.
 *
 * The true model is NOT reconstructible from the record - the modelUsage list it was derived
 * from is long gone - so the only honest options are to say nothing or to say "unverified".
 * Saying nothing is worse: it reads as "no model was recorded", when the truth is "one was
 * recorded and it is known to be wrong".
 *
 * THE DISCRIMINATOR IS STRUCTURAL, NOT A DATE. The fixed writer prefers the model the run
 * ASKED for whenever the CLI confirms it ran, so it cannot produce a resolved label that
 * disagrees with the request unless the CLI really did run something else - which is itself
 * worth flagging rather than presenting as fact. So disagreement between `model` and
 * `resolvedModel` is the test, and it is right on both sides of the boundary, which a
 * wall-clock cutoff at the fix commit would not be.
 *
 * The one case with no structural answer is a run that requested NOTHING (every auto-captain
 * run: `model` is null). Both writers INFERRED the label there - the old one by position, the
 * fixed one by which entry did the most work - and the record keeps no trace of which. That
 * is what the date fallback is for, and only that: see MODEL_FIX_COMMIT.
 *
 * @param {object} rec
 * @returns {"verified"|"unverified"|"unrecorded"}
 */
/**
 * The commit that fixed the recording, and when it landed - taken from git, not from prose.
 *
 * `at` is 5a1e1a1's own author timestamp (2026-08-18T10:13:18+02:00), which is why the sha
 * is here beside it: a test can hold the number against `git log -1 --format=%at 5a1e1a1`
 * rather than trusting a comment. A card describing when a fix landed is a recollection; the
 * commit is the record.
 *
 * Used ONLY as the fallback for a run that requested no model, where nothing about the record
 * itself can tell the two writers apart. Every other record is decided structurally.
 */
export const MODEL_FIX_COMMIT = Object.freeze({
  sha: "5a1e1a1b074f80ac54e91ec145315b6107605b43",
  subject: "Report the model that did the work, not the first one in the list",
  at: Date.UTC(2026, 7, 18, 8, 13, 18),
});

export function modelTrustOf(rec) {
  if (!rec?.resolvedModel) {
    return "unrecorded";
  }
  if (rec.model) {
    return rec.resolvedModel === rec.model ? "verified" : "unverified";
  }
  // Nothing was requested, so there is nothing to agree with. Fall back to when the run ran.
  const at = typeof rec.startedAt === "number" ? rec.startedAt : null;
  if (at === null) {
    return "unverified";
  }
  return at >= MODEL_FIX_COMMIT.at ? "verified" : "unverified";
}

/**
 * Attaches what a backward-looking reader needs, and rewrites nothing on disk.
 *
 * Two fixes landed on 2026-08-18 and both were forward-only, so every record written before
 * them keeps repeating the old error to fleet state, the review page, the autopilot history
 * and `helm_collect_reports`. Marking at read time is the alternative to a migration: it
 * changes no bytes, cannot corrupt the store, and - for the status half - makes the old
 * records CORRECT rather than merely flagged.
 *
 * `outcome` is the status half. `stoppedReason` survives on every record, and it is the whole
 * input the outcome depends on, so the outcome is exactly recomputable for every era. It is
 * computed by `classifyRunOutcome`, the module that already owns that rule, rather than
 * spelled out a second time here - a second spelling of one concept is a documented recurring
 * failure in this repo (see scripts/pure-checks/test-one-path-per-stop-reason.mjs).
 *
 * The stored `status` is deliberately left ALONE. It is a lie on 34 of the 48 records that
 * say "done" (measured 2026-09-02), but it is also the app's coarse lifecycle word -
 * "running" gates the resume and reconciliation paths, and the Goal page treats
 * done/error/interrupted as the set of terminal runs. Correcting it in place would change
 * control flow in surfaces this cannot test; `outcome.status` gives every reader the truth
 * without moving that furniture.
 *
 * @param {object} rec
 * @returns {object} the record plus `outcome`, `modelTrust`, and - when the model label
 *   cannot be believed - `resolvedModel` replaced by MODEL_UNVERIFIED with the stored value
 *   preserved on `resolvedModelRecorded`.
 */
export function annotateGoalRunRecord(rec) {
  if (!rec || typeof rec !== "object") {
    return rec;
  }
  const outcome = classifyRunOutcome({
    stoppedReason: rec.stoppedReason,
    commitCount: typeof rec.commitCount === "number" ? rec.commitCount : 0,
    branchName: rec.branchName || null,
    verifyCommand: rec.verifyCommand || null,
    // A record only carries `error` text worth reporting when its own lifecycle says the
    // process failed; a stale `error` on a run that later succeeded would otherwise
    // outrank the stop reason.
    error: rec.status === "error" ? rec.error || "The run errored." : null,
    escalation: rec.escalation || null,
    // Same reading as dispatchReconcile.js: a record still marked "running" by the time
    // anything reads it back is a run whose process is gone.
    interrupted: rec.status === "running",
  });
  const modelTrust = modelTrustOf(rec);
  const annotated = { ...rec, outcome, modelTrust };
  if (modelTrust === "unverified") {
    annotated.resolvedModelRecorded = rec.resolvedModel;
    annotated.resolvedModel = MODEL_UNVERIFIED;
  }
  return annotated;
}

/**
 * Returns all persisted goal-run records, oldest first (same order as stored), each marked
 * up by `annotateGoalRunRecord`. This is the single read path into the store, which is why
 * the marking lives here: every backward-looking surface goes through it, and none of them
 * has to know that two fixes were forward-only.
 *
 * NOT used by the write paths below - they call `readAll` directly, so nothing derived here
 * can be written back.
 */
export function loadGoalRunHistory() {
  return readAll().map(annotateGoalRunRecord);
}

/**
 * Upserts one record by goalRunId. Called at start ("running") and again at
 * each terminal event ("done"/"error"), so an interrupted run (app killed
 * mid-run) is left on disk as "running" rather than silently missing —
 * rehydration on the next load is what turns that into "interrupted".
 *
 * First-mate tier (docs/first-mate-tier-design.md section 3) adds three
 * ADDITIVE fields, written by startGoalRun in main.js when a run was dispatched
 * by a first mate (all null for a direct/captain-initiated Goal-page run):
 *   - dispatchedBy: the mateId that dispatched this run (the mate -> second-mate
 *     edge the Dashboard tree draws from)
 *   - dispatchId: correlates the dispatch request, the run, and the report
 *   - tier: "crew" for a dispatched run (the run IS crew - the autonomous work
 *     a second-mate project session owns; the second mate itself is a derived
 *     per-(firstMate,project) session, see secondMates.js)
 * Because this is a `{...records[idx], ...record}` spread upsert, the fields are
 * purely additive - old records simply have them undefined, and no read path
 * needs to change.
 */
/**
 * Swap a renderer display key for the durable identity it stands for.
 *
 * Returns the record unchanged when there is nothing to translate, and - deliberately - also
 * when the key cannot be resolved: `resolveSecondMateId` needs the project to work out which
 * node a session belongs to, and inventing one at an unknown path would be worse than
 * recording the key. A record with no projectPath keeps what it had.
 *
 * @param {object} record
 * @returns {object}
 */
function normaliseDispatcher(record) {
  const raw = record?.dispatchedBy;
  if (!raw || !record?.projectPath) {
    return record;
  }
  const resolved = resolveSecondMateId(raw, record.projectPath);
  if (!resolved || resolved === raw) {
    return record;
  }
  return { ...record, dispatchedBy: resolved };
}

/**
 * Removes the read-time-only fields from a record on its way to disk, and restores the
 * stored model label if the annotation had replaced it. See DERIVED_FIELDS.
 *
 * @param {object} record
 * @returns {object}
 */
function stripDerivedFields(record) {
  if (!record || typeof record !== "object") {
    return record;
  }
  const touched = DERIVED_FIELDS.some((f) => f in record);
  if (!touched) {
    return record;
  }
  const next = { ...record };
  // Put the real recorded label back before dropping the copy, so a stripped record is the
  // record as it was read from disk rather than one asserting MODEL_UNVERIFIED as a fact.
  if ("resolvedModelRecorded" in next) {
    next.resolvedModel = next.resolvedModelRecorded;
  }
  for (const field of DERIVED_FIELDS) {
    delete next[field];
  }
  return next;
}

export function upsertGoalRunRecord(record) {
  const records = readAll();
  // A display key never reaches durable state.
  //
  // The renderer identifies a captain's own project session by `sess_<id>`, which is a way
  // of naming a node on screen, not an identity. It kept arriving here as `dispatchedBy` and
  // being written down. The fix on 2026-08-17 taught the READ side to route them, which
  // cleared the symptom and made two id namespaces permanent - and left the count growing:
  // measured 2026-08-18 and again on 2026-09-01, eleven runs in the installed store are keyed
  // that way, and fleet-state carried all eleven into the picture other mates read.
  //
  // Here rather than at the three places that build a record, because this is the one writer.
  // Three copies of a translation drift, and the one that drifts is the one still writing the
  // wrong key. Touching an old record normalises it on the way past, so the count can only
  // shrink from here.
  record = normaliseDispatcher(record);
  // Read-time marking must stay read-time. Nothing in the app spreads a loaded record into an
  // upsert today - every caller passes an explicit patch - but "rewrite nothing on disk" is
  // the whole premise of annotateGoalRunRecord, and one future `upsertGoalRunRecord({...rec,
  // ...})` would quietly bake a derived value into the store and make it indistinguishable
  // from a recorded one. Cheaper to close here than to detect later.
  record = stripDerivedFields(record);
  const idx = records.findIndex((r) => r.goalRunId === record.goalRunId);
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...record };
  } else {
    records.push(record);
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }
  }
  writeAll(records);
}

/**
 * Removes one record by goalRunId, e.g. once its worktree has been deleted
 * from the Goal page and there is nothing left on disk worth remembering it
 * by. A no-op (not an error) if the id isn't present.
 */
export function removeGoalRunRecord(goalRunId) {
  const records = readAll();
  const next = records.filter((r) => r.goalRunId !== goalRunId);
  if (next.length !== records.length) {
    writeAll(next);
  }
}
