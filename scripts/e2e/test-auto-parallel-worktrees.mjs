// Two auto tasks in the SAME repo must be able to run at the same time.
//
// They could not, for two compounding reasons. A second mate's identity is hashed
// from (first mate, path), so two tasks in one repo produced the SAME id and the
// second dispatch was refused as "busy with a turn". And even if it had started,
// both agents would have been editing the same working tree at once, which
// corrupts work rather than parallelising it.
//
// Aidin, 2026-08-03: "jag vill kunna jobba parallellt med auto tasks i samma
// projekt. därför vi har agenter och worktrees".
//
// The fix gives each task its own worktree, which makes the paths distinct and
// therefore the identities distinct too - one change, both problems. This test
// holds that property against real git, plus the sweep rules that keep such a
// worktree from being cleaned away while it is in use or awaiting review.
//
// Run: node scripts/e2e/test-auto-parallel-worktrees.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { autoWorktreeFor, isAutoBranch, AUTO_BRANCH_PREFIX } from "../../src/lib/autoCaptain.js";
import { secondMateId } from "../../src/lib/secondMates.js";
import { createWorktree, listWorktrees, worktreePathFor, isBranchMerged } from "../../src/lib/worktree.js";
import { planSweep, isAutoRunBranch } from "../../src/lib/worktreeSweep.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-autopar-"));
const repo = path.join(tmp, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

const TASK_A = "aaaaaaaa-1111-4111-8111-111111111111";
const TASK_B = "bbbbbbbb-2222-4222-8222-222222222222";

try {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "app.js"), "// shared file both tasks would have edited\n");
  git("add", "-A");
  git("commit", "-m", "init");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "1\n");

  // --- the identity collision, before and after -----------------------------
  ok(
    secondMateId("direct", repo) === secondMateId("direct", repo),
    "sanity: the same path always hashes to the same second mate"
  );
  const a = autoWorktreeFor(TASK_A);
  const b = autoWorktreeFor(TASK_B);
  ok(a.id !== b.id && a.branchName !== b.branchName, `two tasks get different worktrees (${a.id} vs ${b.id})`);
  ok(autoWorktreeFor(TASK_A).id === a.id, "and the same task always gets the SAME one, so re-running a card returns to its work");
  ok(isAutoBranch(a.branchName) && a.branchName.startsWith(AUTO_BRANCH_PREFIX), `the branch is marked as an auto run's (${a.branchName})`);

  const pathA = worktreePathFor(repo, a.id);
  const pathB = worktreePathFor(repo, b.id);
  ok(
    secondMateId("direct", pathA) !== secondMateId("direct", pathB),
    "so the two runs are DIFFERENT second mates - which is what unblocks the second dispatch"
  );
  ok(
    secondMateId("direct", pathA) !== secondMateId("direct", repo),
    "and neither collides with the project-level identity"
  );

  // --- both really exist at once, isolated ----------------------------------
  const madeA = createWorktree(repo, { id: a.id, branchName: a.branchName, deps: "junction" });
  const madeB = createWorktree(repo, { id: b.id, branchName: b.branchName, deps: "junction" });
  ok(fs.existsSync(madeA.worktreePath) && fs.existsSync(madeB.worktreePath), "both worktrees exist on disk simultaneously");
  ok(madeA.worktreePath !== madeB.worktreePath, "in different folders");
  ok(!madeA.depsError && !madeB.depsError, `both got their dependencies (${madeA.depsError || "ok"} / ${madeB.depsError || "ok"})`);

  // The isolation that matters: editing the same file in both, at once.
  fs.writeFileSync(path.join(madeA.worktreePath, "app.js"), "// task A's version\n");
  fs.writeFileSync(path.join(madeB.worktreePath, "app.js"), "// task B's version\n");
  ok(
    fs.readFileSync(path.join(madeA.worktreePath, "app.js"), "utf8").includes("task A") &&
      fs.readFileSync(path.join(madeB.worktreePath, "app.js"), "utf8").includes("task B"),
    "each run's edit to the SAME file stands on its own - this is the whole point"
  );
  ok(
    fs.readFileSync(path.join(repo, "app.js"), "utf8").includes("shared file"),
    "and the project's own checkout is untouched by either"
  );
  execFileSync("git", ["-C", madeA.worktreePath, "commit", "-am", "task A work"], { windowsHide: true });
  execFileSync("git", ["-C", madeB.worktreePath, "commit", "-am", "task B work"], { windowsHide: true });
  ok(
    execFileSync("git", ["-C", repo, "log", "--format=%s", "-1", a.branchName], { encoding: "utf8", windowsHide: true }).trim() ===
      "task A work",
    "each commits to its own branch"
  );

  // --- the sweep must not clean these away ----------------------------------
  const worktrees = listWorktrees(repo);
  ok(worktrees.length === 3, `git sees the repo plus both auto worktrees (${worktrees.length})`);
  ok(isAutoRunBranch(a.branchName), "the sweep recognises an auto branch");

  // Unmerged: the card is in review pointing at this folder, so it stays - even
  // though it is clean and has no goal-run record, which is the shape that would
  // otherwise be swept as an "orphan".
  const unmergedPlan = planSweep({
    projectPath: repo,
    worktrees,
    branches: [],
    runs: [],
    isMerged: (br) => isBranchMerged(repo, br, "main"),
    isDirty: () => false,
    exists: () => true,
  });
  ok(
    unmergedPlan.remove.filter((r) => r.kind === "worktree").length === 0,
    `neither auto worktree is removed while unmerged (${JSON.stringify(unmergedPlan.remove.map((r) => r.target))})`
  );
  ok(
    unmergedPlan.keep.filter((k) => /auto run's work/.test(k.reason)).length === 2,
    "both are kept for the stated reason - the card points at them"
  );

  // A LIVE run is protected even before that rule, via the in-flight record the
  // app passes in (an auto run has no goal-run history entry at all).
  const livePlan = planSweep({
    projectPath: repo,
    worktrees,
    branches: [],
    runs: [{ goalRunId: `auto:${TASK_A}`, status: "running", worktreePath: madeA.worktreePath, branchName: a.branchName }],
    isMerged: () => true, // even if merged, a running run keeps its folder
    isDirty: () => false,
    exists: () => true,
  });
  // Compared by folder name: git reports a worktree path in its own form
  // (separators and drive-letter case), which need not match the string
  // createWorktree returned - and comparing the raw strings made an assertion pass
  // for the wrong reason.
  const isA = (p) => path.basename(String(p)) === a.id;
  ok(!livePlan.remove.some((r) => isA(r.target)), "a RUNNING auto run keeps its worktree even when the branch is merged");
  ok(
    /still using it/.test(livePlan.keep.find((k) => isA(k.target))?.reason || ""),
    `and says a run still has it (${livePlan.keep.find((k) => isA(k.target))?.reason})`
  );

  // Once merged and finished, it IS cleanable - otherwise these accumulate forever.
  git("merge", "--no-ff", "-m", "merge A", a.branchName);
  const mergedPlan = planSweep({
    projectPath: repo,
    worktrees: listWorktrees(repo),
    branches: [],
    runs: [],
    isMerged: (br) => isBranchMerged(repo, br, "main"),
    isDirty: () => false,
    exists: () => true,
  });
  const removable = mergedPlan.remove.filter((r) => r.kind === "worktree").map((r) => path.basename(r.target));
  ok(removable.includes(a.id), `a merged auto run's worktree becomes cleanable (${JSON.stringify(removable)})`);
  ok(!removable.includes(b.id), "while the still-unmerged one is left alone");

  // --- the app's wiring ------------------------------------------------------
  const stripComments = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  const mainSrc = stripComments(fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8"));
  ok(/ensureAutoWorktree\(where\.projectPath, todo\.id\)/.test(mainSrc), "the auto dispatch asks for an isolated worktree");
  ok(/secondMateId\("direct", runCwd\)/.test(mainSrc), "and derives the second mate from the ISOLATED path, not the project");
  ok(/projectPath: runCwd/.test(mainSrc), "and runs the turn there");
  ok(
    /if \(!isolated\.ok\) \{[\s\S]{0,400}?continue;/.test(mainSrc),
    "a failure to isolate SKIPS the task rather than falling back to the shared checkout"
  );
  ok(/worktreePath: r\.worktreePath/.test(mainSrc), "and in-flight auto runs are handed to the sweep so their folders are protected");
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  // Unlink the junctions BEFORE removing anything - the pre-flight that exists
  // because a removal once followed one into the shared package folder.
  try {
    const root = path.join(tmp, "repo-worktrees");
    for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const nm = path.join(root, dir, "node_modules");
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
    ? "VERIFY OK: two auto tasks in one repo get separate worktrees and separate identities, edit the same file without touching each other, and are not swept away while running or awaiting review."
    : "VERIFY FAILED."
);
process.exit(exit);
