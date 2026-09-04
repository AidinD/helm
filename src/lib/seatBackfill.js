import { isProjectPick } from "./mates.js";
import { normalizeFsPath } from "./fsPath.js";

/**
 * Which checkouts should have a project seat opened for them, given the nodes the board would
 * draw today.
 *
 * WHY THIS EXISTS AS A PURE FUNCTION. It is the safety step that makes removing the Captain
 * widget honest: a project only gets a seat when the captain picks it in "+ Session", so every
 * project he worked in before that existed has a node parented to the lane, and the Captain
 * widget was the only surface that rendered one. Getting this list wrong either leaves live
 * work with nowhere to appear, or puts rows on the board for projects nobody opened - and the
 * board's crowding is the governor on concurrency, so inflating it breaks the mechanism the
 * whole slot decision rests on. Both failures are quiet, which is why the rule is a unit with
 * its own checks rather than a loop inside a startup handler.
 *
 * @param {Array} nodes            derived project nodes (deriveSecondMates output)
 * @param {string} metaHomeRoot    the coordinator root, which is never a project
 * @param {(p: string) => boolean} exists  does this folder still exist
 * @returns {string[]} checkout paths, de-duplicated, in the order first seen
 */
export function projectsNeedingSeats(nodes, { metaHomeRoot, exists } = {}) {
  const out = [];
  const seen = new Set();
  for (const node of nodes || []) {
    const project = node?.projectPath;
    if (!project) {
      continue;
    }
    // AUTO NODES ARE EXCLUDED DELIBERATELY. They have their own lane and their own widget,
    // which is not being removed. Opening a seat because an unattended run touched a repo
    // would put a row on the board for work the captain never opened.
    if (node.startedBy === "auto") {
      continue;
    }
    // Work means a bound session or crew underneath - the same pair the board already uses to
    // decide whether a row is worth showing. A node with neither is a proposal nobody engaged,
    // and it needs no seat until somebody does.
    const hasWork = !!node.sessionId || (Array.isArray(node.crew) && node.crew.length > 0);
    if (!hasWork) {
      continue;
    }
    if (!isProjectPick(project, metaHomeRoot)) {
      continue;
    }
    // normalizeFsPath, not a hand-rolled fold. The first version of this line lowercased and
    // stripped a trailing separator and left the SEPARATORS alone, so one repo spelled with
    // backslashes and again with forward slashes counted twice - measured on the real history,
    // which asked for "helm" two times. ensureSeatForProject would have refused the second, so
    // no duplicate seat could be created; what was wrong was the number this function reports,
    // and a count nobody can trust is the wrong thing to be measuring the board's crowding by.
    const key = normalizeFsPath(project);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // A DELETED CHECKOUT still gets a seat when a session is live in it, and that exception is
    // the whole reason this is not a one-line existence test.
    //
    // The rule without it is defensible - a seat rooted at a folder nobody can open is a
    // permanently empty row. But hiding a RUNNING session is the failure this entire pass
    // exists to prevent, and it is not hypothetical: the real history has a node with a live
    // session whose worktree has since been removed. Turning it away left work in flight with
    // no surface anywhere, which is worse than a row that explains itself.
    //
    // Finished crew in a folder that is gone is a different case and stays excluded: nothing
    // is running, so there is nothing to lose sight of.
    const stillThere = typeof exists === "function" ? exists(project) : true;
    if (!stillThere && !node.sessionId) {
      continue;
    }
    out.push(project);
  }
  return out;
}
