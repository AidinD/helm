/**
 * Is this the repository, or somebody else's working copy of it?
 *
 * ## The hole this closes
 *
 * A crew run's isolation is the whole reason it works in a worktree. Twice, a second mate
 * dispatched a run whose PROJECT was another run's worktree - so the boundary took itself as
 * input, and `<worktree>-worktrees/<id>` appeared beside it.
 *
 * Two guards let it through, and both were asking a slightly different question from the one
 * that mattered:
 *
 *   - the dispatch resolver accepted any absolute path that exists, and a worktree exists;
 *   - runGoal validated with `git rev-parse --is-inside-work-tree`, and a worktree IS a work
 *     tree, so the answer was yes. It asked whether the path is A work tree, not whether it
 *     is the repository's PRIMARY one.
 *
 * The difference is readable, which is the whole reason this is a check and not a heuristic:
 * inside a linked worktree `--git-dir` and `--git-common-dir` differ, and the common one
 * points at the primary repository's own `.git`. So the primary can be NAMED, not just
 * detected - which is what lets the refusal say where the caller should have pointed instead.
 *
 * ## Damage, measured rather than assumed: none
 *
 * Both continuations built on their parents' branches, nothing was redone, and removing a
 * parent worktree with the non-forcing variant left the child intact with git's bookkeeping
 * consistent. It happened to work. A boundary that accepts itself as input is not a boundary,
 * it is a coincidence, and this one cost 1.85 million tokens of fresh input re-attempting
 * work that was already paid for.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    // A non-repo is an answer this function returns, not noise for the main process log.
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * What kind of git location a path is, and where its primary repository lives.
 *
 * @param {string} dir
 * @param {{ run?: (cwd: string, args: string[]) => string }} [options]
 * @returns {{ kind: "primary" | "worktree" | "not-git" | "missing",
 *   primaryPath: string | null, why: string }}
 */
export function classifyWorkTree(dir, { run = git } = {}) {
  if (!dir || !fs.existsSync(dir)) {
    return { kind: "missing", primaryPath: null, why: `there is no directory at ${dir}` };
  }
  let gitDir;
  let commonDir;
  try {
    gitDir = run(dir, ["rev-parse", "--absolute-git-dir"]);
    commonDir = run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch (err) {
    return { kind: "not-git", primaryPath: null, why: `${dir} is not inside a git repository (${err.message.split("\n")[0]})` };
  }
  const same = path.resolve(gitDir).toLowerCase() === path.resolve(commonDir).toLowerCase();
  if (same) {
    // The work tree's ROOT, not the directory that was handed in. Returning the input meant
    // `<repo>/src` came back as its own "primary path" - a subdirectory reported as a
    // repository, which is the same shape of wrong answer this whole module exists to stop.
    let top;
    try {
      top = run(dir, ["rev-parse", "--show-toplevel"]);
    } catch {
      top = dir;
    }
    return { kind: "primary", primaryPath: path.resolve(top), why: "" };
  }
  // A linked worktree. The common dir is the primary repository's own .git, so its parent is
  // the primary work tree - which is the path the caller should have named.
  const primaryPath = path.dirname(path.resolve(commonDir));
  return {
    kind: "worktree",
    primaryPath,
    why: `${dir} is a git worktree of ${primaryPath}, not a repository of its own`,
  };
}

/**
 * The refusal a caller can print, or null when the path is fine.
 *
 * Written as a sentence that names the repository to use instead, because the caller that hit
 * this was doing something reasonable - trying to continue a capped run on its own branch -
 * and a refusal with no route is how a dead end gets routed around rather than obeyed.
 *
 * @param {string} dir
 * @param {{ run?: (cwd: string, args: string[]) => string, what?: string }} [options]
 * @returns {string | null}
 */
export function refuseIfNotPrimary(dir, { run = git, what = "A run" } = {}) {
  const seen = classifyWorkTree(dir, { run });
  if (seen.kind === "primary") {
    return null;
  }
  if (seen.kind === "worktree") {
    return [
      `${what} cannot be rooted in ${dir}: that is another run's worktree, not a repository.`,
      "",
      `Point it at ${seen.primaryPath} instead - the repository the worktree belongs to.`,
      "",
      "If what you actually want is to carry on work that is already on a branch in that",
      "worktree, resume that run rather than starting a new one against its files: a fresh run",
      "here would work inside somebody else's isolation, and the isolation is the point.",
    ].join("\n");
  }
  return `${what} cannot be rooted in ${dir}: ${seen.why}.`;
}
