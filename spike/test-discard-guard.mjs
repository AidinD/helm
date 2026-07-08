// Spike: does the `isOwnWorktreeRoot` safety guard actually block the exact
// dangerous scenario from the goalOrchestrator ship-review (git-safety
// Finding 1)? A destructive `git reset --hard` / `git clean -fd` must ONLY
// ever run against the isolated throwaway worktree, never a parent checkout.
// The one narrow way that could break: the worktree gets deregistered/pruned
// mid-run but its directory still exists, AND some ancestor of it is itself a
// git repo — then git's repo-discovery walks UP and `--show-toplevel` resolves
// to that ancestor, so a raw reset there would wipe unrelated work.
//
// This proves the guard returns FALSE in that scenario (so discardWorktreeChanges
// refuses) and TRUE for a real registered worktree. Real git, no claude calls.
//
// Runs entirely under a fresh scratch dir in the OS temp dir; removed at the end.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOwnWorktreeRoot } from "../src/lib/goalOrchestrator.js";
import { createWorktree, removeWorktree } from "../src/lib/worktree.js";

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

// The dangerous layout: an ANCESTOR that is itself a git repo, containing the
// primary project repo as a subdir. This mirrors e.g. a monorepo checked out
// at D:\Repo with projects beneath it.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "helm-discard-guard-spike-"));
const ancestorRepo = path.join(scratchRoot, "ancestor-monorepo");
const projectPath = path.join(ancestorRepo, "project");
let worktreeToTearDown = null;

function cleanup() {
  if (worktreeToTearDown) {
    try {
      removeWorktree(projectPath, worktreeToTearDown, { force: true });
    } catch (err) {
      log(`teardown removeWorktree non-fatal: ${err.message}`);
    }
  }
  log(`cleaning up scratch dir: ${scratchRoot}`);
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

try {
  // --- ancestor IS a git repo, with precious uncommitted work in it ---
  fs.mkdirSync(ancestorRepo, { recursive: true });
  git(ancestorRepo, ["init", "-q", "-b", "main"]);
  git(ancestorRepo, ["config", "user.email", "spike@example.com"]);
  git(ancestorRepo, ["config", "user.name", "Helm Spike"]);
  fs.writeFileSync(path.join(ancestorRepo, "PRECIOUS.md"), "unrelated work that must NEVER be reset\n");
  git(ancestorRepo, ["add", "PRECIOUS.md"]);
  git(ancestorRepo, ["commit", "-q", "-m", "ancestor initial"]);
  // leave the ancestor with dirty, uncommitted work — this is what a rogue
  // reset --hard / clean -fd would destroy.
  fs.writeFileSync(path.join(ancestorRepo, "PRECIOUS.md"), "unrelated work + UNSAVED EDITS\n");
  fs.writeFileSync(path.join(ancestorRepo, "untracked-precious.txt"), "would be deleted by clean -fd\n");
  log("ancestor repo has dirty uncommitted + untracked work");

  // --- the actual project repo, nested inside the ancestor ---
  fs.mkdirSync(projectPath, { recursive: true });
  git(projectPath, ["init", "-q", "-b", "main"]);
  git(projectPath, ["config", "user.email", "spike@example.com"]);
  git(projectPath, ["config", "user.name", "Helm Spike"]);
  fs.writeFileSync(path.join(projectPath, "README.md"), "the real project\n");
  git(projectPath, ["add", "README.md"]);
  git(projectPath, ["commit", "-q", "-m", "project initial"]);

  // --- 1. a REAL registered worktree -> guard must ALLOW ---
  const { worktreePath } = createWorktree(projectPath, { id: "guard-wt-1" });
  worktreeToTearDown = worktreePath;
  assert(isOwnWorktreeRoot(worktreePath), "guard returns TRUE for a real registered worktree root");

  // --- 2. simulate the danger: a plain dir (NOT a registered worktree) that
  // sits inside the ancestor repo. git repo-discovery from here walks UP to
  // the ancestor. This is the deregistered-worktree-still-on-disk shape. ---
  const fakeWorktree = path.join(ancestorRepo, "orphaned-worktree-dir");
  fs.mkdirSync(fakeWorktree, { recursive: true });
  const discoveredTop = git(fakeWorktree, ["rev-parse", "--show-toplevel"]).trim();
  log(`git rev-parse --show-toplevel from the orphaned dir resolves to: ${discoveredTop}`);
  assert(
    path.resolve(discoveredTop).toLowerCase() === path.resolve(ancestorRepo).toLowerCase(),
    "confirmed: git DOES walk up to the ancestor repo from an orphaned dir (the danger is real)"
  );
  assert(
    !isOwnWorktreeRoot(fakeWorktree),
    "guard returns FALSE for the orphaned dir -> discardWorktreeChanges would REFUSE to reset/clean"
  );

  // --- 3. the ancestor's precious work is provably still intact (nothing ran
  // a reset/clean against it) ---
  const ancestorStatus = git(ancestorRepo, ["status", "--porcelain"]).trim();
  assert(ancestorStatus.length > 0, "ancestor repo still has its dirty/untracked work (never reset)");
  assert(
    fs.existsSync(path.join(ancestorRepo, "untracked-precious.txt")),
    "ancestor's untracked file still exists (never clean -fd'd)"
  );

  // --- 4. a totally non-git path -> guard must refuse (rev-parse fails) ---
  const plainDir = path.join(scratchRoot, "not-a-repo-at-all");
  fs.mkdirSync(plainDir, { recursive: true });
  // Note: this dir's parent (scratchRoot) is not a repo, so rev-parse fails outright.
  assert(!isOwnWorktreeRoot(plainDir), "guard returns FALSE for a path with no git repo at all");

  log("ALL CHECKS PASSED");
} finally {
  cleanup();
  assert(!fs.existsSync(scratchRoot), "scratch dir fully removed after cleanup");
}
