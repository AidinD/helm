// LIVE-EXEMPT: it drives real runGoal calls, but every iteration comes from an injected
// scripted runner (runIterationFn) instead of the CLI, so no model is ever reached and no
// subprocess is spawned except git and one deliberately-failing node one-liner.
//
// The one stop that asks instead of guessing, actually run.
//
// THE HOLE THIS CLOSES, measured on the installed run store 2026-09-02: 56 goal runs, 0 with
// an escalation config, 0 that ever stopped with `stoppedReason: "escalated"`. Escalation was
// gated on `Boolean(escalationConfig)` and neither the dispatch path nor the autopilot path
// passed one - and the dispatch tool's input schema had no field for it at all, so a second
// mate could not switch it on even deliberately. A lever with no handle.
//
// So the `escalated` reason, `resumable`, the escalation record, and the "keep the worktree
// even with zero commits" override had never executed once. Flipping the default is the
// small half; this is the half that shows the path works.
//
// HOW IT IS EXERCISED. A real temp git repository, and the real `runGoal` - real worktree
// creation, real notes.md, real `git commit`, real `producedRealChanges`, real phase
// advance, real record building, real escalation detection, real cleanup decision. Only the
// claude subprocess is replaced, via the same kind of injected seam `reviewer` already uses.
// Hand-written iteration records were the alternative and are how this suite has fooled
// itself before: a record missing a field the real writer always sets passes a test the app
// would fail.
//
// Run:  node scripts/e2e/test-escalation-on-by-default.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runGoal,
  resolveEscalationConfig,
  detectEscalationSignal,
  detectNoNetProgress,
} from "../../src/lib/goalOrchestrator.js";
import { classifyRunOutcome } from "../../src/lib/runOutcome.js";
import { buildReportFromRecord } from "../../src/lib/dispatchReconcile.js";
import { annotateGoalRunRecord } from "../../src/lib/goalRunHistory.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- part 1: the switch itself ---------------------------------------------
// `Boolean(escalationConfig)` read "nobody said anything" as "no", and nobody ever said
// anything. Silence has to mean ON, and OFF has to be sayable.
ok(resolveEscalationConfig(undefined) !== null, "an absent config enables escalation (it used to disable it)");
ok(resolveEscalationConfig(null) !== null, "so does an explicit null - the shape every existing run record stores");
ok(JSON.stringify(resolveEscalationConfig({})) === "{}", "an empty object still means all defaults");
ok(resolveEscalationConfig(false) === null, "`false` is the deliberate off switch");
ok(resolveEscalationConfig({ enabled: false }) === null, "and so is { enabled: false }, for a caller already passing thresholds");
const tuned = resolveEscalationConfig({ maxCostPerIterationUsd: 9 });
ok(tuned && tuned.maxCostPerIterationUsd === 9, "a tuned threshold survives resolution unchanged");

// The signal that must NOT fire on defaults. `detectNoNetProgress(iterations, 2)` is the same
// condition at the same threshold as the default no_op_convergence stop, and escalation is
// checked first - so a default of 2 renames an existing ending rather than adding a signal.
// Replayed against the real store: it would have paused 17 of 56 runs, 12 of them finished.
const noopIterations = [1, 2].map((n) => ({
  iteration: n,
  phase: "implement",
  ok: true,
  result: { success: true, summary: "tidied up", keyLearnings: [] },
  producedChanges: false,
}));
ok(
  detectEscalationSignal(noopIterations, noopIterations[1], {}) === null,
  "two no-op implement iterations do NOT escalate on defaults - that ending belongs to no_op_convergence"
);
ok(detectNoNetProgress(noopIterations, null) === null, "a null streak is off, not a streak of zero that fires instantly");
ok(detectNoNetProgress(noopIterations, 0) === null, "and neither is 0");
ok(
  detectEscalationSignal(noopIterations, noopIterations[1], { noProgressStreak: 2 })?.signal === "no_net_progress",
  "but a caller that explicitly asks for it still gets it"
);

// --- the temp repository ----------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "helm-escalation-"));
const projectPath = path.join(tmpRoot, "repo");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function makeRepo() {
  fs.mkdirSync(projectPath, { recursive: true });
  git(projectPath, ["init", "-q", "-b", "main"]);
  git(projectPath, ["config", "user.email", "crew@example.invalid"]);
  git(projectPath, ["config", "user.name", "Crew Test"]);
  git(projectPath, ["config", "commit.gpgsign", "false"]);
  // Matches production: the orchestrator's own bookkeeping dir is ignored, so a research or
  // plan iteration legitimately has nothing to commit and only real work shows up as a commit.
  fs.writeFileSync(path.join(projectPath, ".gitignore"), ".helm-goal/\n", "utf8");
  fs.writeFileSync(path.join(projectPath, "README.md"), "# invented fixture repo\n", "utf8");
  git(projectPath, ["add", "-A"]);
  git(projectPath, ["commit", "-q", "-m", "initial"]);
}

/**
 * A stand-in for one claude iteration, built from a script of per-iteration instructions.
 *
 * It does what a real iteration does to the tree - writes notes.md in research, writes
 * plan.md in plan, writes a real source file in implement - so everything downstream of the
 * subprocess (producedRealChanges, commitIteration, phase advance) is exercised for real.
 */
function scriptedRunner(script) {
  let n = 0;
  return async ({ worktreePath, phase }) => {
    const step = script[n] || script[script.length - 1];
    n += 1;
    if (phase === "research") {
      fs.appendFileSync(path.join(worktreePath, ".helm-goal", "notes.md"), "\nResearch findings: the fixture has one file.\n", "utf8");
    } else if (phase === "plan") {
      fs.writeFileSync(
        path.join(worktreePath, ".helm-goal", "plan.md"),
        "## Step 1 - add the feature file\n\n## Step 2 - check it\n",
        "utf8"
      );
    } else if (step.writesFile !== false) {
      fs.writeFileSync(path.join(worktreePath, `feature-${n}.txt`), `work from iteration ${n}\n`, "utf8");
    }
    return {
      ok: true,
      result: {
        success: true,
        goalReached: false,
        summary: step.summary || `iteration ${n} did some work`,
        keyChanges: [`touched feature-${n}.txt`],
        keyLearnings: step.keyLearnings || [],
      },
      costUsd: typeof step.costUsd === "number" ? step.costUsd : 0.05,
      usage: { totalTokens: 1000, contextWindow: 1000000, fillPct: 0.001, resolvedModel: "claude-sonnet-5", modelsSeen: ["claude-sonnet-5"] },
      contract: "(scripted iteration)",
    };
  };
}

const CLEAN = { summary: "made a small, unremarkable step" };

/** Everything a paused run must be able to say about itself, checked in one place. */
function assertPausedCleanly(label, result, expectedSignal, expectedIteration) {
  ok(result.stoppedReason === "escalated", `${label}: stoppedReason is "escalated" (got "${result.stoppedReason}")`);
  ok(result.escalation?.signal === expectedSignal, `${label}: the signal that fired is ${expectedSignal} (got ${result.escalation?.signal})`);
  ok(result.escalation?.iteration === expectedIteration, `${label}: it paused at iteration ${expectedIteration} (got ${result.escalation?.iteration})`);
  ok(!!result.escalation?.detail, `${label}: it carries a sentence a human can act on`);
  ok(result.escalation?.worktreePath === result.worktreePath, `${label}: the escalation points at the run's own worktree`);
  ok(result.escalation?.branchName === result.branchName, `${label}: and at its branch`);
  ok(result.resumable === true, `${label}: the run is marked resumable`);
  ok(result.cleanedUp === false, `${label}: the worktree was NOT auto-cleaned`);
  ok(fs.existsSync(result.worktreePath), `${label}: and it is still on disk`);
  // Commits survive, and the count is the tree's own answer rather than the run's claim.
  const onDisk = parseInt(git(result.worktreePath, ["rev-list", "--count", `${result.baseCommit}..HEAD`]).trim(), 10);
  ok(onDisk === result.commitCount, `${label}: the ${onDisk} commit(s) it reports are really on the branch`);
  ok(git(projectPath, ["branch", "--list", result.branchName]).trim().length > 0, `${label}: the branch still exists in the repo`);

  // Whatever reads this state must not choke on a shape it has never been handed before.
  const live = classifyRunOutcome({
    stoppedReason: result.stoppedReason,
    commitCount: result.commitCount,
    branchName: result.branchName,
    escalation: result.escalation,
  });
  ok(live.status === "escalated", `${label}: classifyRunOutcome calls it escalated`);
  ok(live.needsCaptain === result.escalation.detail, `${label}: and hands the captain the escalation's own words`);

  // The persisted record, shaped exactly the way main.js writes one on a terminal event -
  // including the "status stays done even for an escalated stop" quirk that surprises readers.
  const record = {
    goalRunId: "run-escalated",
    dispatchId: "dispatch-escalated",
    dispatchedBy: "mate-1",
    projectPath,
    goal: "an invented goal",
    status: "done",
    stoppedReason: result.stoppedReason,
    escalation: result.escalation,
    commitCount: result.commitCount,
    branchName: result.branchName,
    worktreePath: result.worktreePath,
    resumable: result.resumable,
    verifyCommand: null,
    model: "claude-sonnet-5",
    resolvedModel: result.resolvedModel,
    startedAt: Date.now(),
  };
  const report = buildReportFromRecord(record, Date.now());
  ok(report.status === "escalated", `${label}: the report a mate collects says escalated, not done`);
  ok(!!report.needsCaptain, `${label}: and assigns it back`);
  const annotated = annotateGoalRunRecord(record);
  ok(annotated.outcome.status === "escalated", `${label}: the history read path derives escalated too`);
  ok(annotated.status === "done", `${label}: while leaving the stored status byte-identical`);
}

async function run(opts) {
  return runGoal({
    projectPath,
    goal: "an invented goal for the fixture repo",
    maxIterations: 6,
    ...opts,
  });
}

try {
  makeRepo();

  // --- trigger (b): the iteration says, in its own words, that it is stuck ----
  {
    const result = await run({
      runIterationFn: scriptedRunner([
        CLEAN,
        CLEAN,
        { summary: "the requirement is ambiguous and I cannot pick between two readings" },
      ]),
    });
    assertPausedCleanly("ambiguity", result, "ambiguity_reported", 3);
    ok(result.commitCount === 1, `ambiguity: the implement iteration's real work was committed before the pause (${result.commitCount})`);
    ok(fs.existsSync(path.join(result.worktreePath, "feature-3.txt")), "ambiguity: and the file it wrote is still in the worktree");
  }

  // A keyword buried in keyLearnings counts too - the summary is not the only place a model
  // says it hit a fork.
  {
    const result = await run({
      runIterationFn: scriptedRunner([CLEAN, CLEAN, { summary: "wrote the file", keyLearnings: ["This needs a decision from a human."] }]),
    });
    ok(result.stoppedReason === "escalated" && result.escalation.signal === "ambiguity_reported", "a keyLearnings phrase escalates as well as a summary one");
  }

  // --- trigger (c): one iteration cost more than the soft cap ----------------
  {
    const result = await run({
      runIterationFn: scriptedRunner([CLEAN, CLEAN, { summary: "one very expensive step", costUsd: 5.5 }]),
    });
    assertPausedCleanly("cost cap", result, "cost_soft_cap", 3);
    ok(/\$5\.50/.test(result.escalation.detail), `cost cap: the detail names the real spend (${result.escalation.detail})`);
  }

  // --- trigger (a): the same verify failure twice running --------------------
  // The verify command really runs in the worktree, and really fails the same way twice.
  {
    const result = await run({
      verifyCommand: `node -e "console.error('boom: cannot resolve the fixture module'); process.exit(1)"`,
      runIterationFn: scriptedRunner([CLEAN, CLEAN, CLEAN, CLEAN]),
    });
    assertPausedCleanly("repeated verify failure", result, "repeated_verify_failure", 4);
    // Both verify-failed iterations were rolled back, so this run pauses with NOTHING
    // committed - the case where the zero-commit auto-clean would have deleted the evidence.
    ok(result.commitCount === 0, "repeated verify failure: it paused with zero commits, the hardest case for keeping the worktree");
    ok(result.iterations.filter((r) => r.verified === false).length === 2, "repeated verify failure: two iterations really failed the gate");
  }

  // --- trigger (d): off by default, available on request ---------------------
  {
    const noop = await run({ runIterationFn: scriptedRunner([CLEAN, CLEAN, { writesFile: false }, { writesFile: false }]) });
    ok(
      noop.stoppedReason === "no_op_convergence",
      `no-op run still ends as no_op_convergence, not escalated (got "${noop.stoppedReason}")`
    );
    const asked = await run({
      escalationConfig: { noProgressStreak: 1 },
      runIterationFn: scriptedRunner([CLEAN, CLEAN, { writesFile: false }]),
    });
    assertPausedCleanly("no net progress (opted in)", asked, "no_net_progress", 3);
  }

  // --- the off switch has to actually switch it off --------------------------
  for (const [label, cfg] of [["false", false], ["{ enabled: false }", { enabled: false }]]) {
    const result = await run({
      escalationConfig: cfg,
      runIterationFn: scriptedRunner([CLEAN, CLEAN, { summary: "this step is ambiguous", costUsd: 9 }, CLEAN, CLEAN, CLEAN]),
    });
    ok(
      result.stoppedReason !== "escalated" && result.escalation === null,
      `escalationConfig ${label} runs to a normal ending instead (got "${result.stoppedReason}")`
    );
  }
} finally {
  // The worktrees live in a sibling dir of the repo, both inside tmpRoot. Nothing junctioned
  // node_modules into them (the fixture repo has none), so there is no link to follow.
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  } catch (err) {
    console.log(`note - could not remove ${tmpRoot}: ${err.message}`);
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: escalation is on by default, every signal really pauses a real run on a clean state, the worktree and its commits survive, the run is resumable, and every reader of that state names it correctly."
    : "VERIFY FAILED."
);
process.exit(exit);
