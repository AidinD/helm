/**
 * Housekeeping for the worktrees and branches an autonomous goal run leaves
 * behind.
 *
 * Why this exists. `goal:cleanupRun` already removes a run's worktree and its
 * branch correctly, gated on "fully merged" so no commit can be lost. But it
 * only ever runs when the captain presses "Done + clean up" on that run's
 * report row. Nothing sweeps the ones he never pressed, and nothing at all
 * notices a branch whose run record has since aged out of the 200-record
 * history - so those become invisible: not on the Goal page, not in any report,
 * just refs accumulating in the repo. Aidin found three of them by hand on
 * 2026-08-03, one of which pointed at work that had been merged in July.
 *
 * The sweep is deliberately SMALLER than "clean up everything". It acts only
 * where the action provably cannot lose anything:
 *
 *   - a branch is deleted only when its tip is already an ancestor of the
 *     repo's primary branch (every commit on it is also on main/master) and it
 *     is not checked out anywhere;
 *   - a worktree checkout is removed only when git reports no uncommitted
 *     changes in it and no run is still using it. The branch survives that, so
 *     even an unmerged worktree's commits stay reachable.
 *
 * Everything else is KEPT and reported with the reason, because the failure
 * mode to avoid is not "a stale branch survived" - it is "work disappeared
 * quietly". Under-cleaning is recoverable by hand; over-cleaning is not.
 *
 * Blast radius. Only branches whose names match a prefix Helm itself creates
 * (`helm/`, `maestro/`) are ever considered. A branch you made is never a
 * candidate, however merged or stale it looks - the sweep has no opinion about
 * your own branches, and that limit is what makes it safe to run unattended in
 * a work repo with other contributors.
 *
 * This module is PURE: it decides, it does not act. `planSweep` takes the repo
 * facts as plain data plus two probe callbacks, so the decision table can be
 * tested exhaustively without a git repo, and the caller (main.js) performs the
 * removals through worktree.js's junction-safe helpers.
 */

/** Branch-name prefixes Helm creates for its own autonomous runs. */
export const HELM_BRANCH_PREFIXES = ["helm/", "maestro/"];

/** Run statuses that mean a run may still be USING its worktree. */
const LIVE_STATUSES = new Set(["running", "live", "starting"]);

/**
 * A run whose worktree must survive because the run is meant to CONTINUE.
 *
 * A run paused on quota or escalated to the captain is persisted as
 * `status: "done", resumable: true` - finished as a process, unfinished as a piece
 * of work. Its worktree is fully committed, so it looked clean and got removed,
 * and `goal:resume` then fails outright with "the run's worktree is no longer on
 * disk". The commits survive on the branch, but the one path the escalation flow
 * exists to serve is gone (found by independent review, 2026-08-03). Status alone
 * cannot answer this question - `resumable` can.
 */
function isResumable(run) {
  if (!run) {
    return false;
  }
  return (
    run.resumable === true ||
    Boolean(run.escalation) ||
    run.stoppedReason === "escalated" ||
    run.stoppedReason === "quota_exhausted"
  );
}

/** True for a branch Helm created, i.e. one the sweep is allowed to consider. */
export function isHelmBranch(branchName) {
  const name = String(branchName || "");
  return HELM_BRANCH_PREFIXES.some((p) => name.startsWith(p));
}

// NOTE: there was briefly a special rule here for "auto run branches", when an auto
// task ran in a worktree of its own making. It does not need one: an auto task is
// now dispatched as an autopilot run, so it has a run record like any other and the
// rules below already cover it. A second set of cleanup rules keyed on a branch-name
// convention was a duplicate to keep in sync.

function normalizePath(p) {
  // Windows gives back a mix of separators and cases between `git worktree
  // list` and a stored record; comparing raw strings silently fails to match a
  // worktree with its own run, which would make a LIVE run look orphaned.
  return String(p || "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Decide what to clean in one repo.
 *
 * @param {object} input
 * @param {string} input.projectPath - the repo being swept.
 * @param {Array<{path:string, branch:string|null, isMain:boolean}>} input.worktrees
 *   registered worktrees, as reported by git.
 * @param {string[]} input.branches - local branch names in the repo.
 * @param {Array<{goalRunId:string, status:string, worktreePath:string|null, branchName:string|null}>} input.runs
 *   goal-run records for this repo.
 * @param {(branchName:string) => boolean} input.isMerged - true when every
 *   commit on the branch is already on the primary branch.
 * @param {(worktreePath:string) => boolean} input.isDirty - true when the
 *   worktree has uncommitted changes. Should fail SAFE (return true) if it
 *   cannot tell, so an unreadable worktree is kept rather than removed.
 * @returns {{remove: Array, keep: Array}} `remove` is ordered worktrees-first,
 *   because git refuses to delete a branch that is still checked out.
 */
export function planSweep({
  projectPath,
  worktrees = [],
  branches = [],
  runs = [],
  isMerged,
  isDirty,
  // Whether the worktree directory is still on disk. Injected like the other two
  // probes so the decision table stays testable without a filesystem; defaults to
  // "it is there", which is the conservative reading (removal rather than prune).
  exists = () => true,
}) {
  const remove = [];
  const keep = [];

  const runByWorktree = new Map();
  for (const run of runs) {
    if (run?.worktreePath) {
      runByWorktree.set(normalizePath(run.worktreePath), run);
    }
  }

  // Branches currently checked out somewhere - deleting one is impossible while
  // it is, so it is not a candidate this pass (the next sweep gets it, once
  // this pass has removed the checkout).
  const checkedOut = new Set();

  for (const wt of worktrees) {
    // BEFORE the isMain skip. The main checkout's own branch is checked out too,
    // and registering it only for non-main worktrees meant the branch loop kept
    // trying to delete whatever the repo had checked out - git refused, and the
    // sweep logged the same failure on every start (independent review,
    // 2026-08-03). A branch cannot be deleted while it is checked out anywhere,
    // main worktree included.
    if (wt.branch) {
      checkedOut.add(wt.branch);
    }
    if (wt.isMain) {
      continue; // the repo itself is never a candidate for removal
    }
    // Only worktrees on a Helm-created branch. A worktree you made yourself, even
    // under the same parent folder, is left completely alone.
    //
    // `!wt.branch` is the load-bearing half. A DETACHED worktree (`git worktree
    // add --detach`) has no branch line in git's output at all, so `branch` is
    // null - and the old `wt.branch && !isHelmBranch(...)` short-circuited to
    // false for it, skipping this guard entirely. It then had no run record, so it
    // was removed as an "orphan": an independent review reproduced the deletion of
    // a detached worktree whose commit was reachable from no ref, leaving it
    // dangling and its files gone (2026-08-03). A worktree we cannot ATTRIBUTE to
    // Helm is not ours to remove, and "no branch" means exactly that.
    if (!wt.branch || !isHelmBranch(wt.branch)) {
      keep.push({
        kind: "worktree",
        target: wt.path,
        branch: wt.branch,
        reason: wt.branch ? "not a Helm run's worktree" : "detached - nothing identifies it as a Helm run",
      });
      continue;
    }
    const run = runByWorktree.get(normalizePath(wt.path));
    if (run && LIVE_STATUSES.has(String(run.status))) {
      keep.push({ kind: "worktree", target: wt.path, branch: wt.branch, reason: "a run is still using it" });
      continue;
    }
    if (isResumable(run)) {
      keep.push({
        kind: "worktree",
        target: wt.path,
        branch: wt.branch,
        reason: "the run is paused and can be resumed - resuming needs this worktree",
      });
      continue;
    }
    let dirty = true;
    try {
      dirty = isDirty(wt.path);
    } catch {
      dirty = true; // unreadable counts as dirty: keep it
    }
    if (dirty) {
      keep.push({
        kind: "worktree",
        target: wt.path,
        branch: wt.branch,
        reason: "uncommitted changes - nothing here is committed anywhere else",
      });
      continue;
    }
    remove.push({
      kind: "worktree",
      target: wt.path,
      branch: wt.branch,
      projectPath,
      // A worktree still registered with git but GONE from disk needs
      // `git worktree prune`, not `git worktree remove` - the old code planned a
      // removal, skipped it because the path did not exist, and reported it as
      // removed anyway. It stayed registered, so the next sweep reported the same
      // removal again, forever, and the UI counted work that never happened
      // (independent review, 2026-08-03).
      prune: !exists(wt.path),
      reason: !exists(wt.path)
        ? "already gone from disk - git still lists it"
        : run
          ? `run finished (${run.status})`
          : "no run record - orphaned checkout",
    });
  }

  for (const branchName of branches) {
    if (!isHelmBranch(branchName)) {
      continue; // silent: your own branches are not the sweep's business
    }
    if (checkedOut.has(branchName)) {
      keep.push({
        kind: "branch",
        target: branchName,
        reason: "still checked out in a worktree - next sweep can take it",
      });
      continue;
    }
    let merged = false;
    try {
      merged = isMerged(branchName);
    } catch {
      merged = false; // cannot tell -> keep
    }
    if (!merged) {
      keep.push({
        kind: "branch",
        target: branchName,
        reason: "has commits that are not on the primary branch",
      });
      continue;
    }
    remove.push({
      kind: "branch",
      target: branchName,
      projectPath,
      reason: "fully merged - deleting it loses no commit",
    });
  }

  return { remove, keep };
}

/**
 * Make a sweep's two lists tell one story: deduped, and disjoint.
 *
 * The sweep plans in two passes. In the first, a branch still checked out in a
 * worktree it is about to remove is recorded as kept, "next sweep can take it" - and
 * then the second pass, after the worktree is gone, takes it in this same sweep. The
 * report then listed the same branch as BOTH deleted and kept-with-a-reason-it-
 * survived, and inflated the kept count by exactly the number of branches deleted
 * (independent review, 2026-08-03). This is the one report that says what an
 * unattended deleter did to your repos, so a contradiction in it is not cosmetic.
 *
 * What was actually REMOVED wins: it is an observed outcome, where a keep is only a
 * plan. Pure and exported so the invariant can be asserted directly - it lived inline
 * in the Electron main process, where no test could reach it.
 */
export function reconcileSweepReport({ removed = [], kept = [] } = {}) {
  const key = (x) => `${x.kind}:${x.target}`;
  const removedKeys = new Set(removed.map(key));
  const seen = new Set();
  const outKept = kept.filter((k) => {
    const id = key(k);
    if (seen.has(id) || removedKeys.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
  return { removed, kept: outKept };
}

/**
 * A one-line, plain-language summary of a sweep. Used for the startup log and
 * the Goal page's housekeeping line.
 *
 * Says what was KEPT as prominently as what was cleaned: a sweep that silently
 * reported only its successes would read as "everything is tidy" while an
 * unmerged branch sat there forever.
 */
export function describeSweep({ removed = [], kept = [], failed = [] } = {}) {
  const wt = removed.filter((r) => r.kind === "worktree").length;
  const br = removed.filter((r) => r.kind === "branch").length;
  const parts = [];
  if (wt) {
    parts.push(`removed ${wt} finished worktree${wt === 1 ? "" : "s"}`);
  }
  if (br) {
    parts.push(`deleted ${br} merged branch${br === 1 ? "" : "es"}`);
  }
  if (!parts.length) {
    parts.push("nothing to clean");
  }
  if (kept.length) {
    parts.push(`kept ${kept.length} (${kept.length === 1 ? "reason" : "reasons"} listed)`);
  }
  if (failed.length) {
    parts.push(`${failed.length} could not be removed`);
  }
  return parts.join(", ");
}
