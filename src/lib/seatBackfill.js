import { isProjectPick } from "./mates.js";

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
    const key = project.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // A folder that is gone cannot be opened, and a seat rooted at a deleted checkout is a
    // permanently empty row nothing can clear.
    if (typeof exists === "function" && !exists(project)) {
      continue;
    }
    out.push(project);
  }
  return out;
}
