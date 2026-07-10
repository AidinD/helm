// Unit test (pure node, real git in a temp repo): the branch helpers behind the
// tiered report-back "Done + clean up" gate - primaryBranch / isBranchMerged /
// deleteBranch. The load-bearing property is that isBranchMerged is TRUE only
// for a branch already contained in the primary branch, so cleanup never
// deletes a branch that still holds unmerged commits.
//
// Run:  node scripts/e2e/test-worktree-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { primaryBranch, isBranchMerged, deleteBranch } = await import("../../src/lib/worktree.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-wt-branch-"));
function git(...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
}
function branchExists(name) {
  return git("branch", "--list", name).trim().length > 0;
}

try {
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-m", "init");

  // A branch that gets merged back into main.
  git("checkout", "-b", "feat-merged");
  fs.writeFileSync(path.join(repo, "b.txt"), "2\n");
  git("add", "-A");
  git("commit", "-m", "feat-merged work");
  git("checkout", "main");
  git("merge", "--no-ff", "feat-merged", "-m", "merge feat-merged");

  // A branch with commits NOT merged into main.
  git("checkout", "-b", "feat-unmerged");
  fs.writeFileSync(path.join(repo, "c.txt"), "3\n");
  git("add", "-A");
  git("commit", "-m", "feat-unmerged work");
  git("checkout", "main");

  assert(primaryBranch(repo) === "main", `primaryBranch resolves the local default (main), got "${primaryBranch(repo)}"`);
  assert(isBranchMerged(repo, "feat-merged") === true, "isBranchMerged is TRUE for a branch merged into main");
  assert(isBranchMerged(repo, "feat-unmerged") === false, "isBranchMerged is FALSE for a branch with unmerged commits (the gate)");
  assert(isBranchMerged(repo, "does-not-exist") === false, "isBranchMerged is FALSE (fail-safe) for a missing branch");

  // Deleting the merged branch (default safe -d) works.
  deleteBranch(repo, "feat-merged");
  assert(!branchExists("feat-merged"), "deleteBranch removes a merged branch");

  // The unmerged branch: default -d must REFUSE (git's own safety), force -D removes it.
  let refused = false;
  try {
    deleteBranch(repo, "feat-unmerged");
  } catch {
    refused = true;
  }
  assert(refused && branchExists("feat-unmerged"), "deleteBranch (safe -d) refuses an unmerged branch");
  deleteBranch(repo, "feat-unmerged", { force: true });
  assert(!branchExists("feat-unmerged"), "deleteBranch({force:true}) removes an unmerged branch");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
} finally {
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: branch merged-gate + safe/force delete behave correctly." : "VERIFY FAILED.");
process.exit(exit);
