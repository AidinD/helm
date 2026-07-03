import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Git worktree automation for Maestro's own future dispatch features
 * (Phase 4 — see PLAN.md's "treehouse" entry and DECISIONS.md's 2026-07-03
 * worktree-note / self-hosting-hazard entries).
 *
 * Every function here takes an EXPLICIT `projectPath` argument and never
 * relies on this process's own cwd — confirmed (2026-07-03 source read) as
 * how both `treehouse get` and gnhf's `createWorktree` (`git.ts`) actually
 * work, and required here for the same reason: a future orchestrator will
 * dispatch work across many different project repos while itself running
 * from wherever the Electron main process happens to live, never "rooted"
 * in any one of them. All git calls use `-C <projectPath>` for this reason,
 * matching `version.js`'s existing `execFileSync("git", [...])` pattern
 * rather than introducing a new way of shelling out.
 *
 * Deliberately does NOT install dependencies (`npm install` or otherwise)
 * into a fresh worktree — see `copyEnvFiles` below for what it does instead,
 * and `createWorktree`'s doc comment for why dependency install is deferred.
 */

/**
 * Where a project's worktrees live: a sibling directory to the repo itself,
 * e.g. `D:\Repo\Tools\maestro` -> `D:\Repo\Tools\maestro-worktrees\<id>`.
 * Mirrors gnhf's own `<repo>-gnhf-worktrees/<runId>` sibling-directory
 * pattern (confirmed in its `git.ts`) rather than nesting worktrees inside
 * the repo itself, which would make them show up as untracked/ignored
 * clutter in the very repo they're isolating work from.
 */
export function worktreesRootFor(projectPath) {
  const resolved = path.resolve(projectPath);
  const parent = path.dirname(resolved);
  const repoName = path.basename(resolved);
  return path.join(parent, `${repoName}-worktrees`);
}

/** Full path for a given project + worktree id, without creating anything. */
export function worktreePathFor(projectPath, id) {
  return path.join(worktreesRootFor(projectPath), id);
}

function runGit(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

/**
 * Lists every worktree path git itself knows about for a project, via
 * `git worktree list --porcelain` (stable machine-readable format, not the
 * human-facing table). The project's own primary working tree is included
 * (git always lists it first) — callers that want only the EXTRA worktrees
 * should filter out `path.resolve(projectPath)` themselves.
 */
export function listWorktreePaths(projectPath) {
  let output;
  try {
    output = runGit(projectPath, ["worktree", "list", "--porcelain"]);
  } catch (err) {
    throw new Error(`Failed to list worktrees for ${projectPath}: ${err.message}`);
  }
  const paths = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

/** True if `worktreePath` is currently a registered worktree of `projectPath`. */
export function worktreeExists(projectPath, worktreePath) {
  const target = path.resolve(worktreePath);
  return listWorktreePaths(projectPath).some((p) => path.resolve(p) === target);
}

/**
 * Copies top-level .env files from the source repo into a freshly created
 * worktree. `git worktree add` only ever populates TRACKED files — anything
 * gitignored (which is exactly where secrets like .env live) is silently
 * absent, a gap gnhf's own git.ts never addresses either (confirmed
 * 2026-07-03 source read: gnhf leaves a new worktree to fail on missing
 * node_modules/.env and relies on the first agent iteration to notice and
 * fix it itself). Doing this one small copy is cheap and removes an
 * immediately-broken-on-arrival failure mode for any project that needs an
 * env file to even boot; returns the list of files actually copied.
 *
 * Deliberately top-level only, not recursive — matches the common case
 * (.env/.env.local at repo root) without guessing at project-specific
 * nested env conventions.
 */
const ENV_FILE_NAMES = [".env", ".env.local"];

export function copyEnvFiles(projectPath, worktreePath) {
  const copied = [];
  for (const name of ENV_FILE_NAMES) {
    const src = path.join(projectPath, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      continue;
    }
    const dest = path.join(worktreePath, name);
    fs.copyFileSync(src, dest);
    copied.push(name);
  }
  return copied;
}

/**
 * Creates a new git worktree for `projectPath` on a new branch, in a sibling
 * `<repo>-worktrees/<id>` directory, then copies across any top-level
 * .env/.env.local files found in the source repo (see `copyEnvFiles`).
 *
 * Does NOT run `npm install` or any other dependency-install step — that's
 * genuinely more complex (registry access, install timing, and picking the
 * right package manager per project) and explicitly deferred past this
 * first pass. A fresh worktree from this function has tracked files + env
 * files, but no node_modules; a future pass should add that, likely as an
 * opt-in step per project rather than unconditional (not every worktree
 * consumer needs it immediately, and it's the slowest part of setup).
 *
 * @param {string} projectPath - absolute path to the source repo. Never the
 *   caller's own cwd — always an explicit argument (see module doc comment).
 * @param {object} [options]
 * @param {string} [options.id] - worktree directory name; defaults to a
 *   timestamp + random suffix so concurrent calls never collide.
 * @param {string} [options.branchName] - new branch name for the worktree;
 *   defaults to `maestro/<id>`.
 * @returns {{ worktreePath: string, branchName: string, envFilesCopied: string[] }}
 */
export function createWorktree(projectPath, options = {}) {
  const resolvedProject = path.resolve(projectPath);
  if (!fs.existsSync(resolvedProject)) {
    throw new Error(`Project path does not exist: ${resolvedProject}`);
  }

  const id = options.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branchName = options.branchName || `maestro/${id}`;
  const worktreesRoot = worktreesRootFor(resolvedProject);
  const worktreePath = path.join(worktreesRoot, id);

  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  fs.mkdirSync(worktreesRoot, { recursive: true });

  try {
    runGit(resolvedProject, ["worktree", "add", worktreePath, "-b", branchName]);
  } catch (err) {
    throw new Error(`git worktree add failed for ${resolvedProject}: ${err.message}`);
  }

  const envFilesCopied = copyEnvFiles(resolvedProject, worktreePath);

  return { worktreePath, branchName, envFilesCopied };
}

/**
 * True if a worktree has uncommitted changes (staged, unstaged, or
 * untracked). Used by `removeWorktree` to fail closed by default — mirrors
 * the fail-closed principle both firstmate and gnhf apply to worktree
 * teardown (confirmed 2026-07-03 source read: gnhf's teardown path and
 * firstmate's `fm-teardown.sh` both refuse destructive git operations
 * rather than silently discarding work).
 */
export function hasUncommittedChanges(worktreePath) {
  const output = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return output.trim().length > 0;
}

/**
 * Removes a worktree and, if it still exists as a branch ref, leaves the
 * branch itself alone (only the worktree checkout is removed — deleting the
 * branch is a separate, more destructive decision left to the caller).
 *
 * Safe by default: refuses to remove a worktree that has uncommitted
 * changes unless `force: true` is explicitly passed, so a caller can never
 * silently lose work through this function. This is the same fail-closed
 * shape as `createWorktree`'s "path already exists" guard — errors are
 * thrown, not swallowed, so a caller always knows whether the removal
 * actually happened.
 *
 * @param {string} projectPath - absolute path to the source repo (the one
 *   the worktree was created FROM, not the worktree path itself).
 * @param {string} worktreePath - absolute path to the worktree to remove.
 * @param {object} [options]
 * @param {boolean} [options.force] - remove even with uncommitted changes.
 */
export function removeWorktree(projectPath, worktreePath, options = {}) {
  const resolvedProject = path.resolve(projectPath);
  const resolvedWorktree = path.resolve(worktreePath);

  if (!worktreeExists(resolvedProject, resolvedWorktree)) {
    throw new Error(`${resolvedWorktree} is not a registered worktree of ${resolvedProject}`);
  }

  if (!options.force && fs.existsSync(resolvedWorktree) && hasUncommittedChanges(resolvedWorktree)) {
    throw new Error(
      `Worktree has uncommitted changes: ${resolvedWorktree}. Pass { force: true } to remove anyway.`
    );
  }

  const args = ["worktree", "remove", resolvedWorktree];
  if (options.force) {
    args.push("--force");
  }
  try {
    runGit(resolvedProject, args);
  } catch (err) {
    throw new Error(`git worktree remove failed for ${resolvedWorktree}: ${err.message}`);
  }
}
