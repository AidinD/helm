// The housekeeping sweep's decision table (pure - no repo, no app), plus the
// two structural facts it depends on.
//
// Why this exists: the captain found three leftover branches by hand on 2026-08-03,
// one pointing at work merged in July. `goal:cleanupRun` had always been able to
// clean them, but only when he pressed a per-run button; nothing swept, and a
// branch whose run record aged out of the 200-record history was visible
// NOWHERE. So the sweep exists to notice - and its whole safety argument is the
// decision table below, which is why every branch of it is asserted here rather
// than reasoned about in a comment.
//
// The load-bearing property is asymmetric: a stale branch surviving is an
// inconvenience, work disappearing is not recoverable. So every uncertain case
// must land in `keep`.
//
// Run:  node scripts/e2e/test-worktree-sweep.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planSweep, describeSweep, isHelmBranch } from "../../src/lib/worktreeSweep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};

const PROJ = "D:/Repo/Tools/helm";
const wt = (id, branch, isMain = false) => ({ path: `D:/Repo/Tools/helm-worktrees/${id}`, branch, isMain });

// Defaults: nothing is dirty, everything is merged. Each case overrides the one
// thing it is about, so a failure names exactly one cause.
const plan = (over = {}) =>
  planSweep({
    projectPath: PROJ,
    worktrees: [],
    branches: [],
    runs: [],
    isMerged: () => true,
    isDirty: () => false,
    ...over,
  });

const targets = (list) => list.map((x) => `${x.kind}:${String(x.target).split("/").pop()}`).sort();

// --- which branches are even in scope ----------------------------------------
ok(isHelmBranch("helm/goal-abc") && isHelmBranch("maestro/goal-abc"), "Helm's own branch prefixes are in scope");
ok(!isHelmBranch("master") && !isHelmBranch("main"), "the primary branch is never in scope");
ok(!isHelmBranch("feature/my-thing") && !isHelmBranch("helmet/x"), "a branch you made is never in scope, however similar the name");

const mine = plan({ branches: ["master", "main", "feature/x", "trellis-3d-track"] });
ok(mine.remove.length === 0, "a repo of only your own branches yields no action at all");
ok(mine.keep.length === 0, "and they are not even reported - the sweep has no opinion about them");

// --- branches ----------------------------------------------------------------
const merged = plan({ branches: ["helm/goal-a"] });
ok(
  merged.remove.length === 1 && merged.remove[0].kind === "branch" && merged.remove[0].target === "helm/goal-a",
  `a merged Helm branch with no worktree is deleted (${JSON.stringify(targets(merged.remove))})`
);
ok(merged.remove[0]?.kind === "branch" && /loses no commit/.test(merged.remove[0].reason), "and the reason says why that is safe");

const unmerged = plan({ branches: ["helm/goal-a"], isMerged: () => false });
ok(unmerged.remove.length === 0, "an UNMERGED Helm branch is never deleted - this is the whole safety gate");
ok(/not on the primary branch/.test(unmerged.keep[0]?.reason || ""), "and it is reported, with the reason, so it cannot rot unseen");

const cannotTell = plan({
  branches: ["helm/goal-a"],
  isMerged: () => {
    throw new Error("git exploded");
  },
});
ok(cannotTell.remove.length === 0, "if git cannot say whether it is merged, the branch is KEPT (fails safe)");

const checkedOut = plan({ branches: ["helm/goal-a"], worktrees: [wt("goal-a", "helm/goal-a")], isDirty: () => true });
ok(
  !checkedOut.remove.some((r) => r.kind === "branch"),
  "a branch still checked out somewhere is not deleted (git would refuse anyway)"
);
ok(/next sweep/.test(checkedOut.keep.find((k) => k.kind === "branch")?.reason || ""), "and it says it will be taken next time");

// --- worktrees ---------------------------------------------------------------
const clean = plan({ worktrees: [wt("goal-a", "helm/goal-a")] });
ok(clean.remove.some((r) => r.kind === "worktree"), "a clean worktree with no run record is removed as an orphan");
ok(/orphan/.test(clean.remove.find((r) => r.kind === "worktree")?.reason || ""), "and says it was orphaned, not that a run finished");

const dirty = plan({ worktrees: [wt("goal-a", "helm/goal-a")], isDirty: () => true });
ok(!dirty.remove.some((r) => r.kind === "worktree"), "a worktree with uncommitted changes is NEVER removed");
ok(
  /nothing here is committed anywhere else/.test(dirty.keep.find((k) => k.kind === "worktree")?.reason || ""),
  "and the reason says what would be lost"
);

const unreadable = plan({
  worktrees: [wt("goal-a", "helm/goal-a")],
  isDirty: () => {
    throw new Error("cannot stat");
  },
});
ok(!unreadable.remove.some((r) => r.kind === "worktree"), "an unreadable worktree counts as dirty and is kept");

const live = plan({
  worktrees: [wt("goal-a", "helm/goal-a")],
  runs: [{ goalRunId: "r1", status: "running", worktreePath: "D:\\Repo\\Tools\\helm-worktrees\\goal-a", branchName: "helm/goal-a" }],
});
ok(!live.remove.some((r) => r.kind === "worktree"), "a worktree a RUNNING run is using is never removed");
ok(/still using it/.test(live.keep.find((k) => k.kind === "worktree")?.reason || ""), "and says a run still has it");
// The record above uses backslashes and the worktree list forward slashes - the
// real mix on Windows. If matching were literal, the live run would look like an
// orphan and its worktree would be deleted out from under it.
ok(live.keep.length === 1, "path matching survives mixed separators - a live run is not mistaken for an orphan");

const finished = plan({
  worktrees: [wt("goal-a", "helm/goal-a")],
  runs: [{ goalRunId: "r1", status: "done", worktreePath: "D:/Repo/Tools/helm-worktrees/goal-a", branchName: "helm/goal-a" }],
});
ok(finished.remove.some((r) => r.kind === "worktree"), "a FINISHED run's clean worktree is removed");
ok(/run finished \(done\)/.test(finished.remove.find((r) => r.kind === "worktree")?.reason || ""), "and says which state it finished in");

const mainCheckout = plan({ worktrees: [{ path: PROJ, branch: "master", isMain: true }] });
ok(mainCheckout.remove.length === 0 && mainCheckout.keep.length === 0, "the repo's OWN checkout is never a candidate, silently");

// A DETACHED worktree has no branch at all, and that used to skip the Helm-prefix
// guard entirely: the condition was `wt.branch && !isHelmBranch(...)`, false for a
// null branch, so the worktree fell through to "orphaned" and was deleted. An
// independent review reproduced it destroying a commit reachable from no ref.
const detached = plan({ worktrees: [{ path: "D:/Repo/Tools/helm-worktrees/review", branch: null, isMain: false }] });
ok(detached.remove.length === 0, "a DETACHED worktree is never removed - nothing identifies it as Helm's");
ok(/detached/.test(detached.keep[0]?.reason || ""), `and the reason says why (${detached.keep[0]?.reason})`);

// A paused run is finished as a process and unfinished as work; resuming needs its
// worktree, and removing it makes goal:resume fail outright.
for (const run of [
  { status: "done", resumable: true },
  { status: "done", escalation: { signal: "ambiguity_reported" } },
  { status: "done", stoppedReason: "quota_exhausted" },
  { status: "done", stoppedReason: "escalated" },
]) {
  const p = plan({
    worktrees: [wt("goal-a", "helm/goal-a")],
    runs: [{ goalRunId: "r", worktreePath: "D:/Repo/Tools/helm-worktrees/goal-a", branchName: "helm/goal-a", ...run }],
  });
  ok(
    !p.remove.some((r) => r.kind === "worktree"),
    `a paused/resumable run keeps its worktree (${JSON.stringify(run.resumable ?? run.stoppedReason ?? "escalation")})`
  );
}
ok(
  /resumed/.test(
    plan({
      worktrees: [wt("goal-a", "helm/goal-a")],
      runs: [{ goalRunId: "r", status: "done", resumable: true, worktreePath: "D:/Repo/Tools/helm-worktrees/goal-a" }],
    }).keep.find((k) => k.kind === "worktree")?.reason || ""
  ),
  "and says resuming is what needs it"
);

// Registered with git but gone from disk needs `prune`, not `remove` - reporting it
// as removed while it stayed registered made the sweep re-report it every start.
const vanished = plan({ worktrees: [wt("goal-a", "helm/goal-a")], exists: () => false });
const vanishedAction = vanished.remove.find((r) => r.kind === "worktree");
ok(vanishedAction?.prune === true, "a worktree gone from disk is marked for prune, not removal");
ok(/already gone from disk/.test(vanishedAction?.reason || ""), "and says so plainly");
ok(plan({ worktrees: [wt("goal-a", "helm/goal-a")] }).remove[0]?.prune === false, "one that IS on disk is not");

// A branch checked out in the MAIN worktree cannot be deleted either. Registering
// checked-out branches only for non-main worktrees made the sweep try it on every
// start and log a permanent failure.
const mainBranchHelm = plan({ worktrees: [{ path: PROJ, branch: "helm/goal-a", isMain: true }], branches: ["helm/goal-a"] });
ok(
  !mainBranchHelm.remove.some((r) => r.kind === "branch"),
  "a Helm branch checked out in the MAIN worktree is not deleted"
);

const foreignWorktree = plan({ worktrees: [wt("my-experiment", "feature/x")] });
ok(!foreignWorktree.remove.length, "a worktree of your own on a non-Helm branch is left alone");
ok(/not a Helm run/.test(foreignWorktree.keep[0]?.reason || ""), "and reported as such rather than silently skipped");

// --- ordering ----------------------------------------------------------------
// git refuses to delete a branch that is checked out, so the worktree must go
// first. If this ever flips, branch deletion silently starts failing.
const both = plan({ branches: ["helm/goal-a"], worktrees: [wt("goal-b", "helm/goal-b")] });
const kinds = both.remove.map((r) => r.kind);
ok(kinds.indexOf("worktree") < kinds.indexOf("branch"), `worktrees are removed before branches (${kinds.join(",")})`);

// --- the summary line --------------------------------------------------------
ok(/nothing to clean/.test(describeSweep({})), "an empty sweep says so plainly");
const desc = describeSweep({
  removed: [{ kind: "worktree" }, { kind: "branch" }, { kind: "branch" }],
  kept: [{ kind: "branch" }],
});
ok(/removed 1 finished worktree/.test(desc) && /deleted 2 merged branches/.test(desc), `the summary counts both kinds (${desc})`);
ok(/kept 1/.test(desc), "and never reports only its successes - what it kept is in the same sentence");

// --- the structural facts the sweep depends on -------------------------------
// 1. The orchestrator's scratch folder must be gitignored, or a research-only
// run commits its own notes, gets commitCount 1, and therefore does NOT hit
// runGoal's zero-commit auto-cleanup - which is how two of the captain's three
// leftover branches came to exist in the first place.
const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
ok(/^\.helm-goal\/$/m.test(gitignore), ".helm-goal/ is gitignored, so a notes-only run really does end with zero commits");

// 2. Removal must go through worktree.js's junction-safe path. A plain `git
// worktree remove` follows a node_modules junction into the SHARED package
// folder and empties it - it did exactly that to this repo on 2026-08-03, and
// cascaded into another repo's build output through a second link.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const mainSrc = stripComments(fs.readFileSync(path.join(REPO_ROOT, "src", "main.js"), "utf8"));
const sweepFn = mainSrc.slice(mainSrc.indexOf("function sweepFinishedGoalWorktrees"));
const sweepBody = sweepFn.slice(0, sweepFn.indexOf("\n}\n") + 2);
ok(sweepBody.length > 0, "the sweep is wired into the app at all");
ok(/removeWorktree\(/.test(sweepBody), "and removes worktrees through the junction-safe helper");
ok(!/worktree",\s*"remove"/.test(sweepBody) && !/git.*worktree remove/.test(sweepBody), "never by calling git worktree remove itself");
// The OPTIONS matter as much as the call. Two mutations survived the first version
// of this suite, and they were the two worst regressions possible: swapping
// `ignoreBookkeeping` for `force` (which would let the unattended startup sweep
// discard real uncommitted work), and flipping deleteBranch's default to `-D`
// (which removes git's own last refusal to drop an unmerged branch, leaving
// isBranchMerged as a single point of failure). Both went unnoticed because the
// checks only looked at the function NAMES.
ok(
  /removeWorktree\(projectPath, action\.target, \{ ignoreBookkeeping: true \}\)/.test(sweepBody),
  "the sweep removes with ignoreBookkeeping - narrowing what counts as work, NOT forcing past it"
);
ok(!/removeWorktree\([^)]*force:\s*true/.test(sweepBody), "and never passes force, which would discard uncommitted work unattended");
ok(
  /deleteBranch\(projectPath, action\.target, \{ mergedInto: primary \}\)/.test(sweepBody),
  "and deletes branches with an explicit base, so deleteBranch re-verifies the ancestry itself"
);
ok(!/deleteBranch\([^)]*force:\s*true/.test(sweepBody), "never with force - that would drop an unmerged branch");
ok(/sweepFinishedGoalWorktrees\(\);/.test(mainSrc), "it actually runs at startup, not just on demand");
ok(/pruneWorktrees\(projectPath\)/.test(sweepBody), "and prunes registrations whose directory is gone, so they cannot be re-reported forever");
// Deferred off the startup path: every git call in the sweep is synchronous, and a
// repo with many kept branches froze the main thread for seconds before first paint.
ok(
  /setTimeout\(\(\) => \{\s*try \{\s*sweepFinishedGoalWorktrees\(\);/.test(mainSrc),
  "the startup sweep is deferred, not run inline before the first render"
);
// One primary-branch resolution per repo, not one per branch (it costs up to three
// git spawns each).
ok(
  /primary = primaryBranch\(projectPath\)/.test(sweepBody) && /isBranchMerged\(projectPath, branchName, primary\)/.test(sweepBody),
  "the primary branch is resolved once per repo and reused"
);

console.log(
  code === 0
    ? "VERIFY OK: the sweep removes only what provably loses nothing, keeps everything uncertain with a reason, and never touches a branch you made."
    : "VERIFY FAILED."
);
process.exit(code);
