// Spike: does src/lib/goalOrchestrator.js actually run a real autonomous
// goal to completion — real worktree, real fresh `claude -p` subprocess
// iterations, a real git commit with real file changes, and a real notes.md
// — not a mocked/stubbed run? This feature's entire value proposition is
// real autonomous iteration, so it has to be proven against a real `claude`
// invocation (this WILL make real API calls against the captain's subscription).
//
// Runs against a SCRATCH git repo created fresh under the OS temp dir, never
// against Maestro's own working tree — createWorktree's own worktrees-dir
// convention (a sibling of the scratch repo) keeps everything self-contained
// under one throwaway root. The scratch root is removed at the end
// (including on failure).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGoal } from "../src/lib/goalOrchestrator.js";
import { removeWorktree } from "../src/lib/worktree.js";

function log(msg) {
  console.log(`[spike] ${msg}`);
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`OK - ${msg}`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-goal-orchestrator-spike-"));
const projectPath = path.join(scratchRoot, "scratch-repo");
let worktreePathToTearDown = null;

function cleanup() {
  // Proper teardown FIRST: `git worktree remove` releases git's own internal
  // `.git/worktrees/<id>` registration for this worktree — skipping this and
  // going straight to a raw directory delete (as an earlier version of this
  // spike did) left git's bookkeeping pointing at a half-deleted directory
  // and Windows refusing to release the directory handle even seconds later
  // (confirmed live: `test-worktree-lifecycle.mjs`, which DOES call
  // removeWorktree before cleanup, never hits this; this spike did, until
  // this fix). force:true because the run may have left the worktree on a
  // branch with commits (expected — that's the whole point), which
  // removeWorktree's own uncommitted-changes guard doesn't care about, but
  // git's own worktree-remove has a separate "has commits not on any other
  // branch" caution we deliberately override since this is a throwaway
  // scratch repo being fully deleted anyway.
  if (worktreePathToTearDown) {
    try {
      removeWorktree(projectPath, worktreePathToTearDown, { force: true });
      log(`removeWorktree() cleanly tore down ${worktreePathToTearDown}`);
    } catch (err) {
      log(`removeWorktree() during cleanup failed (non-fatal, falling back to raw delete): ${err.message}`);
    }
  }
  log(`cleaning up scratch dir: ${scratchRoot}`);
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

try {
  // --- Set up a real, minimal git repo to run the goal against ---
  fs.mkdirSync(projectPath, { recursive: true });
  git(projectPath, ["init", "-q", "-b", "main"]);
  git(projectPath, ["config", "user.email", "spike@example.com"]);
  git(projectPath, ["config", "user.name", "Maestro Spike"]);
  fs.writeFileSync(path.join(projectPath, "README.md"), "scratch repo for goal-orchestrator spike\n");
  git(projectPath, ["add", "README.md"]);
  git(projectPath, ["commit", "-q", "-m", "initial commit"]);
  log(`scratch repo created at ${projectPath}`);

  // --- Run a real, trivially-verifiable goal against a real claude call ---
  const goal =
    "Create a new file called hello.txt in the repo root containing exactly " +
    "the single word 'hello' (lowercase, no extra punctuation), then stop. " +
    "This is the entire goal — once hello.txt exists with that content, " +
    "report success and do not make any further changes.";

  log("Calling runGoal() — this makes REAL claude -p subprocess calls, may take a minute or two...");
  const iterationLog = [];
  const result = await runGoal({
    projectPath,
    goal,
    maxIterations: 3,
    effort: "low",
    onIteration: (record) => {
      iterationLog.push(record);
      log(
        `onIteration fired: #${record.iteration} ok=${record.ok} ` +
          `success=${record.result?.success} committed=${record.committed} ` +
          `summary=${JSON.stringify(record.result?.summary || record.error)}`
      );
    },
  });

  log(`runGoal returned: ${JSON.stringify({ ...result, notes: `<${result.notes.length} chars>` }, null, 2)}`);
  worktreePathToTearDown = result.worktreePath;

  // --- Assertions: worktree, branch, commits, notes, and real file content ---
  assert(fs.existsSync(result.worktreePath), "worktree directory actually exists on disk");
  assert(result.branchName.startsWith("maestro/goal-"), "branch name follows the goal-run naming convention");
  assert(iterationLog.length > 0, "onIteration fired at least once");
  assert(iterationLog.length === result.iterations.length, "onIteration fired once per iteration in the returned log");

  const branchInWorktree = git(result.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  assert(branchInWorktree === result.branchName, `worktree is actually checked out on ${result.branchName}`);

  assert(result.commitCount >= 1, `at least one real commit landed on the branch (got ${result.commitCount})`);

  const log_ = git(result.worktreePath, ["log", "--oneline", `main..${result.branchName}`]);
  log(`git log main..${result.branchName}:\n${log_}`);
  assert(log_.trim().length > 0, "`git log main..branch` shows real commit(s), independently of our own commitCount");
  assert(
    /\[goal-orchestrator\] iteration \d+:/.test(log_),
    "commit message follows the orchestrator's own '[goal-orchestrator] iteration N: <summary>' convention"
  );

  const helloPath = path.join(result.worktreePath, "hello.txt");
  assert(fs.existsSync(helloPath), "hello.txt actually exists in the worktree (the real, verifiable goal outcome)");
  const helloContent = fs.readFileSync(helloPath, "utf8").trim().toLowerCase();
  assert(helloContent === "hello", `hello.txt contains exactly "hello" (got: ${JSON.stringify(helloContent)})`);

  // hello.txt must be part of a real commit, not just left uncommitted in
  // the working tree — confirms the orchestrator's own commit, not the
  // agent accidentally leaving stray uncommitted output.
  const showHello = git(result.worktreePath, ["show", `${result.branchName}:hello.txt`]).trim().toLowerCase();
  assert(showHello === "hello", "hello.txt content is part of a real git commit on the branch, not just an uncommitted file");

  const statusAfter = git(result.worktreePath, ["status", "--porcelain"]).trim();
  assert(statusAfter === "", "worktree has a clean working tree after the run (no stray uncommitted junk left behind)");

  assert(result.notes.length > 0, "notes.md has real content");
  assert(result.notes.includes("Iteration 1"), "notes.md documents at least iteration 1");
  const notesOnDisk = fs.readFileSync(path.join(result.worktreePath, ".maestro-goal", "notes.md"), "utf8");
  assert(notesOnDisk === result.notes, "returned notes content matches notes.md as actually written on disk");

  assert(
    ["max_iterations_reached", "two_consecutive_failures", "cancelled"].includes(result.stoppedReason),
    `stoppedReason is one of the documented values (got: ${result.stoppedReason})`
  );

  // --- Confirm the primary checkout was never touched ---
  const primaryStatus = git(projectPath, ["status", "--porcelain"]).trim();
  assert(primaryStatus === "", "primary repo checkout (main) is completely untouched — still clean");
  const primaryBranch = git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  assert(primaryBranch === "main", "primary repo checkout is still on main, never switched");

  // --- Confirm this never pushed/merged/opened a PR anywhere ---
  const remotes = git(projectPath, ["remote"]).trim();
  assert(remotes === "", "scratch repo has no remotes at all — push was never even possible, let alone attempted");

  log("ALL CHECKS PASSED");
} finally {
  cleanup();
  assert(!fs.existsSync(scratchRoot), "scratch dir fully removed after cleanup");
}
