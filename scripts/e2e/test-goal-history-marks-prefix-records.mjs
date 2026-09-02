// Old run records stop repeating two fixed mistakes, without a byte being rewritten.
//
// TWO FIXES LANDED ON 2026-08-18 AND BOTH WERE FORWARD-ONLY. Everything already on disk kept
// its wrong answers, and every backward-looking surface - fleet state, the review page, the
// autopilot history, the report a mate pulls with helm_collect_reports - kept reading them
// out. Measured on the installed store on 2026-09-02, 56 records:
//
//   - 27 name a model that disagrees with the one the run asked for. Every one of the 27
//     asked for Opus 4.8 and recorded Haiku, because the old extractUsage took the FIRST
//     entry of the CLI's model list and the CLI always lists a small internal Haiku call
//     first. 24 more have no model recorded at all. 5 are trustworthy.
//   - 48 say status "done". Only 14 of those 56 runs actually stopped cleanly with work to
//     show, so 34 of the 48 "done" records describe a run that did not finish. (The card
//     that opened this counted 22 of 23 on 2026-08-18; the file has grown since.)
//
// THE DECISION: mark at read time, migrate nothing. The two halves are not symmetrical, and
// that asymmetry is the whole design:
//
//   MODEL is not reconstructible - the CLI's model list the label came from is long gone - so
//   it can only be surfaced as unverified. Never blanked, because "no model recorded" is a
//   different claim from "recorded, and known wrong".
//   STATUS is exactly recomputable, because `stoppedReason` survives on every record and is
//   the entire input the outcome depends on. So the read path DERIVES it, which makes the old
//   records correct rather than merely flagged - and derives it through runOutcome.js, which
//   already owns that rule, rather than spelling the classification out a second time.
//
// THE DISCRIMINATOR IS STRUCTURAL, NOT A DATE. A wall-clock cutoff is a guess about when a
// fix landed and is wrong at the boundary in both directions. See the model-trust cases below.
//
// Run:  node scripts/e2e/test-goal-history-marks-prefix-records.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-history-mark-"));
const storePath = path.join(tmpDir, "goal-run-history.json");
// Never the real store: this test writes, and the seam exists so it can write somewhere else.
process.env.HELM_GOAL_RUN_HISTORY_PATH = storePath;

const { loadGoalRunHistory, upsertGoalRunRecord, annotateGoalRunRecord, modelTrustOf, MODEL_UNVERIFIED, MODEL_FIX_COMMIT } =
  await import("../../src/lib/goalRunHistory.js");
const { classifyRunOutcome, OUTCOME_DONE } = await import("../../src/lib/runOutcome.js");

// --- the date fallback comes from the commit, not from a memory of it -------
// The only place a date is used at all is a run that requested no model, where nothing about
// the record can tell the two writers apart. Holding the constant against git is what keeps
// it from drifting into folklore.
try {
  const at = parseInt(
    execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%at", MODEL_FIX_COMMIT.sha], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
    10
  );
  ok(at * 1000 === MODEL_FIX_COMMIT.at, `the fallback date is ${MODEL_FIX_COMMIT.sha.slice(0, 7)}'s own commit time (git says ${at * 1000}, we hold ${MODEL_FIX_COMMIT.at})`);
} catch {
  console.log("note - could not read the fix commit from git (shallow clone?); skipping the date-provenance check");
}

// --- model trust: structural first, date only where nothing else can decide --
const CASES = [
  [{ model: "claude-opus-4-8", resolvedModel: "claude-haiku-4-5-20251001" }, "unverified", "a resolved model that disagrees with the request cannot be believed"],
  [{ model: "claude-sonnet-5", resolvedModel: "claude-sonnet-5" }, "verified", "one that agrees with the request was confirmed by the CLI"],
  [{ model: "claude-opus-4-8", resolvedModel: null }, "unrecorded", "no resolved model is genuinely no label, not a wrong one"],
  [{ model: null, resolvedModel: null }, "unrecorded", "and neither field set is the same answer"],
  // The agreement test is right on BOTH sides of the fix, which a date is not. A record
  // written by the OLD writer whose first-listed entry happened to be the requested model
  // recorded the truth, and is trusted; a record written by the NEW one can only disagree
  // with the request when the CLI really ran something else, which is worth flagging too.
  [{ model: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", startedAt: MODEL_FIX_COMMIT.at - 86400000 }, "verified", "agreement is trusted even for a run that predates the fix"],
  [{ model: "claude-sonnet-5", resolvedModel: "claude-haiku-4-5-20251001", startedAt: MODEL_FIX_COMMIT.at + 86400000 }, "unverified", "and disagreement is flagged even for a run written after it"],
  // The one case with no structural answer: nothing was requested, so both writers inferred.
  [{ model: null, resolvedModel: "claude-opus-4-8", startedAt: MODEL_FIX_COMMIT.at - 1 }, "unverified", "an inferred label from one millisecond before the fix is unverified"],
  [{ model: null, resolvedModel: "claude-opus-4-8", startedAt: MODEL_FIX_COMMIT.at }, "verified", "and one from the fix commit's own instant is verified"],
  [{ model: null, resolvedModel: "claude-opus-4-8" }, "unverified", "an inferred label with no timestamp at all fails closed"],
];
for (const [rec, want, why] of CASES) {
  ok(modelTrustOf(rec) === want, `${why} (${want})`);
}

// The value that replaces an untrusted label has to read correctly in the slot a model name
// occupies. Blanking it would claim nothing was recorded; leaving it would assert a lie.
{
  const marked = annotateGoalRunRecord({ model: "claude-opus-4-8", resolvedModel: "claude-haiku-4-5-20251001", status: "done", stoppedReason: "no_op_convergence", commitCount: 4 });
  ok(marked.resolvedModel === MODEL_UNVERIFIED, `an untrusted label is surfaced as "${MODEL_UNVERIFIED}"`);
  ok(marked.resolvedModel !== null && marked.resolvedModel !== "", "and never as an empty value that would read as no model");
  ok(marked.resolvedModelRecorded === "claude-haiku-4-5-20251001", "the stored value is kept beside it, so nothing is guessed and nothing is lost");
  ok(marked.model === "claude-opus-4-8", "and the model the run ASKED for is untouched - that field was never wrong");
  const trusted = annotateGoalRunRecord({ model: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", status: "done", stoppedReason: "goal_reached", commitCount: 2 });
  ok(trusted.resolvedModel === "claude-sonnet-5" && !("resolvedModelRecorded" in trusted), "a trustworthy label is passed through untouched");
}

// --- status: derived, never trusted ----------------------------------------
{
  const rec = { status: "done", stoppedReason: "two_consecutive_failures", commitCount: 6, branchName: "helm/goal-x" };
  const marked = annotateGoalRunRecord(rec);
  ok(marked.outcome.status === "failed", `a stored "done" on a run that failed twice reads as "${marked.outcome.status}"`);
  ok(!!marked.outcome.needsCaptain, "and it assigns itself back to a human");
  ok(marked.status === "done", "while the stored status is left exactly as it is - the derivation changes no bytes");
  ok(
    marked.outcome.headline === classifyRunOutcome({ stoppedReason: rec.stoppedReason, commitCount: rec.commitCount, branchName: rec.branchName }).headline,
    "the wording comes from runOutcome.js rather than a second copy of the classification"
  );
}
// The lifecycle words the app needs are preserved through the derivation, because control
// flow elsewhere reads them: "running" gates resume and reconciliation, "error" gates the
// error branch.
ok(annotateGoalRunRecord({ status: "running", stoppedReason: null }).outcome.status === "interrupted", "a record still marked running is derived as interrupted");
ok(annotateGoalRunRecord({ status: "error", error: "spawn failed", stoppedReason: null }).outcome.status === "error", "an errored run stays an error");
ok(annotateGoalRunRecord({ status: "done", stoppedReason: "escalated", escalation: { detail: "needs a decision" } }).outcome.status === "escalated", "an escalated stop is named, even though the stored status says done");

// --- replay the REAL store -------------------------------------------------
// A verbatim census of the installed goal-run history on 2026-09-02, as
// [count, [status, stoppedReason, commitCount, model, resolvedModel, hasVerifyCommand]].
// Nothing identifying is carried: no ids, goals, paths or timestamps. Real data because a
// hand-written case list would have matched the author's own assumptions, which is how the
// one-entry-per-model test stayed green through the model bug it was supposed to catch.
const REAL = [
  [2, ["done", "max_iterations_reached", 5, null, null, 0]],
  [1, ["done", "no_op_convergence", 5, null, null, 0]],
  [4, ["done", "two_consecutive_failures", 2, null, null, 0]],
  [4, ["error", null, null, null, null, 0]],
  [1, ["error", null, null, "claude-haiku-4-5-20251001", null, 0]],
  [1, ["done", "max_iterations_reached", 3, "claude-opus-4-8", null, 1]],
  [1, ["interrupted", null, null, null, null, 0]],
  [3, ["done", "no_op_convergence", 0, null, null, 0]],
  [1, ["done", "two_consecutive_failures", 9, "claude-opus-4-8", null, 0]],
  [1, ["done", "max_iterations_reached", 4, null, null, 0]],
  [2, ["done", "two_consecutive_failures", 0, null, null, 0]],
  [1, ["done", "no_op_convergence", 7, "claude-opus-4-8", null, 0]],
  [2, ["interrupted", null, null, "claude-opus-4-8", null, 0]],
  [3, ["done", "no_op_convergence", 7, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [2, ["done", "max_iterations_reached", 15, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "two_consecutive_failures", 3, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [2, ["done", "two_consecutive_failures", 0, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "two_consecutive_failures", 2, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "no_op_convergence", 9, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "two_consecutive_failures", 11, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "two_consecutive_failures", 8, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "two_consecutive_failures", 6, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [4, ["done", "no_op_convergence", 1, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "no_op_convergence", 5, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "max_iterations_reached", 9, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "two_consecutive_failures", 1, "claude-opus-4-8", "claude-haiku-4-5-20251001", 0]],
  [2, ["done", "no_op_convergence", 0, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "max_iterations_reached", 0, "claude-opus-4-8", "claude-haiku-4-5-20251001", 0]],
  [3, ["done", "max_iterations_reached", 0, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "no_op_convergence", 8, "claude-opus-4-8", "claude-haiku-4-5-20251001", 1]],
  [1, ["done", "goal_reached", 3, "claude-sonnet-5", "claude-sonnet-5", 0]],
  [2, ["done", "max_iterations_reached", 5, "claude-sonnet-5", "claude-sonnet-5", 0]],
  [1, ["done", "goal_reached", 5, "claude-sonnet-5", "claude-sonnet-5", 0]],
  [1, ["done", "two_consecutive_failures", 5, "claude-sonnet-5", "claude-sonnet-5", 0]],
];

const realRecords = [];
let seq = 0;
for (const [count, [status, stoppedReason, commitCount, model, resolvedModel, hasVerify]] of REAL) {
  for (let i = 0; i < count; i++) {
    realRecords.push({
      goalRunId: `replay-${++seq}`,
      projectPath: path.join(tmpDir, "invented-project"),
      goal: "an invented goal",
      status,
      stoppedReason,
      commitCount,
      branchName: commitCount ? "helm/goal-replay" : null,
      worktreePath: null,
      escalation: null,
      error: status === "error" ? "the run errored" : null,
      model,
      resolvedModel,
      verifyCommand: hasVerify ? "npm test" : null,
      startedAt: MODEL_FIX_COMMIT.at - 1000,
      updatedAt: MODEL_FIX_COMMIT.at - 1000,
    });
  }
}
fs.writeFileSync(storePath, JSON.stringify(realRecords, null, 2), "utf8");
const before = fs.readFileSync(storePath);

const loaded = loadGoalRunHistory();
ok(loaded.length === 56, `the replayed store holds all 56 records (${loaded.length})`);

const trust = { verified: 0, unverified: 0, unrecorded: 0 };
for (const r of loaded) {
  trust[r.modelTrust] += 1;
}
ok(trust.unverified === 27, `27 records carry a model label that cannot be believed (${trust.unverified})`);
ok(trust.verified === 5, `5 carry one that can (${trust.verified})`);
ok(trust.unrecorded === 24, `24 never recorded one at all (${trust.unrecorded})`);
ok(
  loaded.filter((r) => r.resolvedModel === "claude-haiku-4-5-20251001").length === 0,
  "and NOT ONE record still names Haiku as the model that did the work"
);

const derived = {};
for (const r of loaded) {
  derived[r.outcome.status] = (derived[r.outcome.status] || 0) + 1;
}
const storedDone = loaded.filter((r) => r.status === OUTCOME_DONE);
const lying = storedDone.filter((r) => r.outcome.status !== OUTCOME_DONE);
ok(storedDone.length === 48, `48 records are stored as "done" (${storedDone.length})`);
ok(lying.length === 34, `34 of them describe a run that did not finish, and now say so (${lying.length})`);
ok(derived[OUTCOME_DONE] === 14, `only 14 of the 56 runs really stopped cleanly with work to show (${derived[OUTCOME_DONE]})`);
ok(loaded.every((r) => r.outcome && typeof r.outcome.status === "string"), "every record gets an outcome, none is left unnamed");
ok(
  lying.every((r) => !!r.outcome.needsCaptain || r.outcome.awaitingReview),
  "and every newly-honest record either alarms or says its work is waiting - none goes quiet"
);
console.log(`     derived outcomes across the real store: ${JSON.stringify(derived)}`);

// --- nothing was rewritten -------------------------------------------------
ok(Buffer.compare(before, fs.readFileSync(storePath)) === 0, "reading the store changed not one byte on disk");

// A future `upsertGoalRunRecord({ ...loadedRecord, ... })` must not bake a derived value into
// the file. Nothing does that today; this is the guard that keeps it that way, because a
// marked record written back would be indistinguishable from a recorded one.
{
  const marked = loaded.find((r) => r.modelTrust === "unverified");
  upsertGoalRunRecord({ ...marked, commitCount: 99 });
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8")).find((r) => r.goalRunId === marked.goalRunId);
  ok(raw.commitCount === 99, "an upsert built by spreading a marked record still writes the real change");
  ok(!("outcome" in raw) && !("modelTrust" in raw) && !("resolvedModelRecorded" in raw), "but none of the derived fields reach the file");
  ok(raw.resolvedModel === "claude-haiku-4-5-20251001", `and the stored model label is restored to what was really recorded ("${raw.resolvedModel}"), not frozen as "${MODEL_UNVERIFIED}"`);
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
} catch (err) {
  console.log(`note - could not remove ${tmpDir}: ${err.message}`);
}

console.log(
  exit === 0
    ? "VERIFY OK: pre-fix records are marked at read time - the outcome derived from stoppedReason through the one module that owns that rule, the model surfaced as unverified rather than as a wrong name - and the file on disk is untouched."
    : "VERIFY FAILED."
);
process.exit(exit);
