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
 * just refs accumulating in the repo. The captain found three of them by hand on
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

/** True for a branch Helm created, i.e. one the sweep is allowed to consider. */
export function isHelmBranch(branchName) {
  const name = String(branchName || "");
  return HELM_BRANCH_PREFIXES.some((p) => name.startsWith(p));
}

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
export function planSweep({ projectPath, worktrees = [], branches = [], runs = [], isMerged, isDirty }) {
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
    if (wt.isMain) {
      continue; // the repo itself is never a candidate
    }
    if (wt.branch) {
      checkedOut.add(wt.branch);
    }
    // Only worktrees on a Helm-created branch. A worktree you made yourself,
    // even under the same parent folder, is left completely alone.
    if (wt.branch && !isHelmBranch(wt.branch)) {
      keep.push({ kind: "worktree", target: wt.path, branch: wt.branch, reason: "not a Helm run's worktree" });
      continue;
    }
    const run = runByWorktree.get(normalizePath(wt.path));
    if (run && LIVE_STATUSES.has(String(run.status))) {
      keep.push({ kind: "worktree", target: wt.path, branch: wt.branch, reason: "a run is still using it" });
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
      reason: run ? `run finished (${run.status})` : "no run record - orphaned checkout",
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
