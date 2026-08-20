// When an autopilot finishes a task with commits, finishAutoRun writes a review
// record so the card is not a blank "no record" dead end (the captain, 2026-08-12: "varfor
// dessa inte har en beskrivning over vad som gjorts?"). The load-bearing risk: if the
// record does NOT pass reviewRecordProblems, writeReviewRecord REFUSES it and the card
// stays blank - the exact failure this fix exists to prevent. So this pins that the
// record buildAutoReviewRecord produces is VALID and honest, both with and without a
// run verify gate.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-auto-review-record.mjs
import { buildAutoReviewRecord, reviewRecordProblems } from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const base = {
  taskId: "1234abcd-0000-0000-0000-000000000000",
  projectPath: "D:/Repo/PomPom",
  outcome: "Finished with 3 commits",
  where: "in D:/Repo/PomPom-worktrees/goal-x on branch helm/goal-x (an isolated worktree, not merged)",
  branch: "helm/goal-x",
  worktreePath: "D:/Repo/PomPom-worktrees/goal-x",
  commits: 3,
  lastSummary: "Wired the icon and set it on the header.",
  stoppedReason: "max_iterations_reached",
};

// --- with a verify gate: the check IS the run's own gate --------------------
{
  const rec = buildAutoReviewRecord({ ...base, verifyCommand: "npm test" });
  const problems = reviewRecordProblems(rec);
  ok(problems.length === 0, `a run WITH a verify gate produces a VALID record (writeReviewRecord would accept it) - problems: ${JSON.stringify(problems)}`);
  ok(rec.verdict === "judgment", "verdict is judgment, never a stamp - autonomous output is not verified");
  ok(rec.criticality === "core" && rec.checks[0].cmd === "npm test", "the check is the run's own verify gate");
  ok(/Wired the icon/.test(rec.summary) && /Finished with 3 commits/.test(rec.summary), "the summary carries what the run did");
  // The entry is now {claim, detail} - short line, long half behind "explain" - so read
  // both halves. Asserted as the MEANING plus the length, because the point of the split
  // is that the honest sentence survives while the line stays readable.
  const gapText = (n) => (typeof n === "string" ? n : `${n?.claim || ""} ${n?.detail || ""}`);
  ok(
    (rec.notVerified || []).some((n) => /nobody has checked it/i.test(gapText(n)) && /not a verified result/i.test(gapText(n))),
    "notVerified still states plainly that nothing is verified"
  );
  ok(
    (rec.notVerified || []).every((n) => String(typeof n === "string" ? n : n?.claim || "").length <= 120),
    "and every visible line is short enough to read before clicking anything"
  );
  ok(!!rec.ask && /decide/i.test(rec.ask), "a judgment record states the ask (the decision the human must make)");
}

// --- without a verify gate: an honest commits-present check -----------------
{
  const rec = buildAutoReviewRecord({ ...base, verifyCommand: null });
  const problems = reviewRecordProblems(rec);
  ok(problems.length === 0, `a run WITHOUT a verify gate STILL produces a valid record - problems: ${JSON.stringify(problems)}`);
  ok(/no verify gate was configured/i.test(rec.checks[0].label), "the check label is honest that no verify gate existed");
  ok(rec.checks[0].cwd === base.worktreePath, "the check runs in the run's worktree (where the commits live)");
  // The Unix-env-prefix guard reviewRecordProblems enforces must not trip on our cmd.
  ok(!/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(rec.checks[0].cmd), "the check command has no Unix env-var prefix (would fail on cmd.exe)");
}

console.log(
  exit === 0
    ? "VERIFY OK: an autopilot-finished task writes a valid, honest 'judgment' review record so the card is never a blank dead end."
    : "VERIFY FAILED."
);
process.exit(exit);
