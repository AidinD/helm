// The housekeeping sweep against a REAL git repo with REAL worktrees, including
// the one hazard that has bitten this project four times: a `node_modules`
// junction inside a worktree, which a plain `git worktree remove` follows into
// the SHARED package folder and empties.
//
// test-worktree-sweep.mjs proves the decision table. This proves the decisions
// survive contact with git: that `listWorktrees` reports the branch and the main
// checkout correctly (the sweep's two most load-bearing inputs), that a merged
// branch really does disappear and an unmerged one really does survive, and that
// removing a junctioned worktree leaves the junction's TARGET untouched.
//
// Run:  node scripts/e2e/test-worktree-sweep-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  listWorktrees,
  listLocalBranches,
  isBranchMerged,
  deleteBranch,
  removeWorktree,
  hasUncommittedChanges,
  hasUncommittedWork,
} from "../../src/lib/worktree.js";
import { planSweep } from "../../src/lib/worktreeSweep.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sweep-live-"));
const repo = path.join(tmp, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

try {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-m", "init");

  // The shared package folder a worktree junction would point at. Its survival
  // is the single most important assertion in this file.
  const sharedModules = path.join(repo, "node_modules");
  fs.mkdirSync(path.join(sharedModules, "some-package"), { recursive: true });
  fs.writeFileSync(path.join(sharedModules, "some-package", "index.js"), "module.exports = 1;\n");
  const sharedFileCount = () => fs.readdirSync(sharedModules).length;
  ok(sharedFileCount() === 1, "the shared package folder starts populated");

  // Worktree 1: a finished run whose branch was merged into main.
  const wt1 = path.join(tmp, "repo-worktrees", "goal-merged");
  git("worktree", "add", "-b", "helm/goal-merged", wt1);
  fs.writeFileSync(path.join(wt1, "b.txt"), "2\n");
  execFileSync("git", ["-C", wt1, "add", "-A"], { windowsHide: true });
  execFileSync("git", ["-C", wt1, "commit", "-m", "work"], { windowsHide: true });
  git("merge", "--no-ff", "-m", "merge", "helm/goal-merged");

  // Worktree 2: a finished run whose work was NEVER merged.
  const wt2 = path.join(tmp, "repo-worktrees", "goal-unmerged");
  git("worktree", "add", "-b", "helm/goal-unmerged", wt2);
  fs.writeFileSync(path.join(wt2, "c.txt"), "3\n");
  execFileSync("git", ["-C", wt2, "add", "-A"], { windowsHide: true });
  execFileSync("git", ["-C", wt2, "commit", "-m", "unmerged work"], { windowsHide: true });

  // Worktree 3: dirty - uncommitted changes that exist nowhere else.
  const wt3 = path.join(tmp, "repo-worktrees", "goal-dirty");
  git("worktree", "add", "-b", "helm/goal-dirty", wt3);
  fs.writeFileSync(path.join(wt3, "scratch.txt"), "not committed\n");

  // A branch of the user's own, merged, with no worktree. Must be untouched.
  git("branch", "my-own-merged", "main");

  // The junction, inside worktree 1 - exactly how createWorktree provisions deps.
  fs.symlinkSync(sharedModules, path.join(wt1, "node_modules"), "junction");
  ok(fs.existsSync(path.join(wt1, "node_modules", "some-package")), "worktree 1 reaches the shared packages through the junction");

  // --- what git tells the sweep ---------------------------------------------
  const worktrees = listWorktrees(repo);
  ok(worktrees.length === 4, `git reports the main checkout plus three worktrees (${worktrees.length})`);
  ok(worktrees[0].isMain === true && worktrees.filter((w) => w.isMain).length === 1, "exactly one entry is flagged as the main checkout");
  ok(worktrees[0].branch === "main", `the main checkout's branch is read correctly (${worktrees[0].branch})`);
  const byName = Object.fromEntries(worktrees.map((w) => [path.basename(w.path), w.branch]));
  ok(byName["goal-merged"] === "helm/goal-merged", `each worktree's branch is read correctly (${JSON.stringify(byName)})`);

  const branches = listLocalBranches(repo);
  ok(branches.includes("my-own-merged") && branches.includes("helm/goal-unmerged"), `local branches are listed (${branches.join(", ")})`);
  ok(!branches.some((b) => b.includes("/") && b.startsWith("origin")), "and remotes are not among them");

  // --- the plan --------------------------------------------------------------
  const plan = planSweep({
    projectPath: repo,
    worktrees,
    branches,
    runs: [
      { goalRunId: "r1", status: "done", worktreePath: wt1, branchName: "helm/goal-merged" },
      { goalRunId: "r2", status: "done", worktreePath: wt2, branchName: "helm/goal-unmerged" },
      { goalRunId: "r3", status: "done", worktreePath: wt3, branchName: "helm/goal-dirty" },
    ],
    isMerged: (b) => isBranchMerged(repo, b, "main"),
    isDirty: (p) => hasUncommittedWork(p),
  });
  // The distinction that makes the sweep work at all. Worktree 1 holds ONLY the
  // dependency junction as an untracked path, so the plain check calls it dirty
  // and it would be kept forever - in this repo AND in any project that has not
  // gitignored .helm-goal/ or node_modules.
  ok(hasUncommittedChanges(wt1) === true, "the plain uncommitted-changes check sees the junction as a change");
  ok(hasUncommittedWork(wt1) === false, "but the work check ignores Helm's own bookkeeping - so a finished worktree is cleanable");
  ok(hasUncommittedWork(wt3) === true, "while a genuinely dirty worktree still reports work");
  const removeWts = plan.remove.filter((r) => r.kind === "worktree").map((r) => path.basename(r.target));
  ok(removeWts.includes("goal-merged") && removeWts.includes("goal-unmerged"), `both clean worktrees are planned for removal (${removeWts.join(",")})`);
  ok(!removeWts.includes("goal-dirty"), "the dirty one is not - real git status, not a stub");
  ok(
    plan.keep.some((k) => k.kind === "worktree" && path.basename(k.target) === "goal-dirty"),
    "and it is reported as kept"
  );

  // --- execute, worktrees first --------------------------------------------
  for (const action of plan.remove.filter((a) => a.kind === "worktree")) {
    removeWorktree(repo, action.target, { ignoreBookkeeping: true });
  }
  // ignoreBookkeeping must NOT be a rename of force: a worktree with real
  // uncommitted work still has to be refused, or the sweep could discard it.
  let refused = false;
  try {
    removeWorktree(repo, wt3, { ignoreBookkeeping: true });
  } catch (err) {
    refused = /uncommitted changes/i.test(err.message);
  }
  ok(refused && fs.existsSync(wt3), "ignoreBookkeeping still REFUSES a worktree holding real uncommitted work");
  ok(!fs.existsSync(wt1), "the junctioned worktree is gone from disk");
  ok(fs.existsSync(wt3), "the dirty worktree is still there");

  // THE assertion this file exists for.
  ok(fs.existsSync(sharedModules), "the SHARED package folder still exists after removing a junctioned worktree");
  ok(sharedFileCount() === 1, `and still has its contents (${sharedFileCount()} entries) - the junction was unlinked, not walked`);
  ok(
    fs.existsSync(path.join(sharedModules, "some-package", "index.js")),
    "including the file inside it - this is the exact damage that hit the real repo on 2026-08-03"
  );

  // Branches, after the checkouts are gone.
  const plan2 = planSweep({
    projectPath: repo,
    worktrees: listWorktrees(repo),
    branches: listLocalBranches(repo),
    runs: [],
    isMerged: (b) => isBranchMerged(repo, b, "main"),
    isDirty: () => true,
  });
  for (const action of plan2.remove.filter((a) => a.kind === "branch")) {
    deleteBranch(repo, action.target);
  }
  const after = listLocalBranches(repo);
  ok(!after.includes("helm/goal-merged"), `the merged Helm branch is deleted (${after.join(", ")})`);
  ok(after.includes("helm/goal-unmerged"), "the UNMERGED Helm branch survives - its commits are still reachable");
  ok(after.includes("my-own-merged"), "a merged branch of your OWN is untouched, because it is not Helm's to delete");
  ok(after.includes("helm/goal-dirty"), "and the dirty worktree's branch stays while the worktree does");
  ok(after.includes("main"), "main is obviously still there");

  // The unmerged branch's commit is genuinely still reachable, not just named.
  const reachable = execFileSync("git", ["-C", repo, "log", "--format=%s", "-1", "helm/goal-unmerged"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  ok(reachable === "unmerged work", `and its commit is still readable (${JSON.stringify(reachable)})`);
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  // Unlink any junction FIRST, then remove the tree - the pre-flight this whole
  // test is about. Never let the cleanup of a test about this hazard cause it.
  try {
    for (const dir of fs.existsSync(path.join(tmp, "repo-worktrees")) ? fs.readdirSync(path.join(tmp, "repo-worktrees")) : []) {
      const nm = path.join(tmp, "repo-worktrees", dir, "node_modules");
      try {
        if (fs.lstatSync(nm).isSymbolicLink()) {
          fs.rmSync(nm, { recursive: true, force: true });
        }
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: against real git, the sweep deletes only merged Helm branches, keeps unmerged work and uncommitted changes, and leaves a junction's shared target intact."
    : "VERIFY FAILED."
);
process.exit(exit);
