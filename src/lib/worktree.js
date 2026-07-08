import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Git worktree automation for Helm's own future dispatch features
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
 * Dependency provisioning (`node_modules` in a fresh worktree) is OPT-IN via
 * `createWorktree`'s `deps` option - see `provisionDeps` below. Default stays
 * the previous cheap behavior (no node_modules at all) so callers that don't
 * need to build/test in the worktree pay no extra cost.
 */

/**
 * Where a project's worktrees live: a sibling directory to the repo itself,
 * e.g. `D:\Repo\Tools\helm` -> `D:\Repo\Tools\helm-worktrees\<id>`.
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
 * The `node_modules` directory name, factored out because both provisioning
 * and removal need to agree on exactly which path is a junction vs a real
 * install.
 */
const NODE_MODULES_DIR = "node_modules";

/**
 * True if `dirPath` is a Windows directory junction / symlink (a reparse
 * point), as opposed to a real directory. Used by `removeWorktree` to decide
 * whether `node_modules` needs the junction-safe removal path.
 *
 * `fs.lstatSync` (unlike `statSync`) does NOT follow the link, so
 * `isSymbolicLink()` here correctly reports true for a junction without
 * ever touching whatever it points at.
 */
function isJunctionOrSymlink(dirPath) {
  try {
    return fs.lstatSync(dirPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Provisions `node_modules` into a freshly created worktree so an agent
 * iteration running there can actually build/test, closing the gap this
 * module's doc comment used to just document-and-defer.
 *
 * Two strategies, chosen via `deps`:
 *
 *   - `"junction"` (recommended default when opted in): creates a Windows
 *     directory junction at `<worktreePath>/node_modules` pointing at the
 *     SAME `node_modules` the source repo already has installed. Near-
 *     instant (no copy, no network) because it's just a reparse point, not
 *     a real directory. Caveat: this means the worktree shares the exact
 *     same installed packages - including any native (.node) addons built
 *     for the source repo's Node/Electron ABI - with the main checkout.
 *     That is fine and in fact desirable for Helm's own case (a single
 *     JS/Electron app, one Node/Electron version, no per-worktree native
 *     rebuild needed), but would NOT be safe for a project that needs a
 *     genuinely isolated install (e.g. testing a dependency version bump in
 *     the worktree without affecting the main checkout's node_modules).
 *     Uses `fs.symlinkSync(target, path, "junction")`, which on Windows
 *     creates a directory junction (not a symlink) and - unlike a real
 *     symlink - does not require elevated privileges.
 *   - `"install"` (slower, isolated): runs `npm ci` in the worktree if a
 *     `package-lock.json` is present there (reproducible, matches what CI
 *     would do), falling back to `npm install` otherwise. Fully independent
 *     copy of node_modules, safe for the version-bump case above, but pays
 *     the full registry/install cost per worktree.
 *
 * Best-effort by design (see `createWorktree`'s fail-safe note): any error
 * here is caught by the caller, never left to fail worktree creation itself.
 *
 * @param {string} projectPath - absolute path to the source repo.
 * @param {string} worktreePath - absolute path to the target worktree.
 * @param {"junction"|"install"} strategy
 * @returns {{ strategy: string, path: string }}
 */
function provisionDeps(projectPath, worktreePath, strategy) {
  const sourceNodeModules = path.join(projectPath, NODE_MODULES_DIR);
  const targetNodeModules = path.join(worktreePath, NODE_MODULES_DIR);

  if (strategy === "junction") {
    if (!fs.existsSync(sourceNodeModules)) {
      throw new Error(`Source repo has no node_modules to junction: ${sourceNodeModules}`);
    }
    if (fs.existsSync(targetNodeModules)) {
      throw new Error(`Worktree already has a node_modules: ${targetNodeModules}`);
    }
    // "junction" (not "dir") is the Windows-specific link type that needs no
    // elevated privileges, unlike a real symlink.
    fs.symlinkSync(sourceNodeModules, targetNodeModules, "junction");
    return { strategy, path: targetNodeModules };
  }

  if (strategy === "install") {
    const hasLockfile = fs.existsSync(path.join(worktreePath, "package-lock.json"));
    const installArgs = hasLockfile ? ["ci"] : ["install"];
    execFileSync("npm", installArgs, {
      cwd: worktreePath,
      encoding: "utf8",
      windowsHide: true,
      shell: true, // npm is a .cmd shim on Windows; needs a shell to resolve
    });
    return { strategy, path: targetNodeModules };
  }

  throw new Error(`Unknown deps strategy: ${strategy}`);
}

/**
 * Creates a new git worktree for `projectPath` on a new branch, in a sibling
 * `<repo>-worktrees/<id>` directory, then copies across any top-level
 * .env/.env.local files found in the source repo (see `copyEnvFiles`), and
 * optionally provisions `node_modules` (see `provisionDeps`).
 *
 * @param {string} projectPath - absolute path to the source repo. Never the
 *   caller's own cwd — always an explicit argument (see module doc comment).
 * @param {object} [options]
 * @param {string} [options.id] - worktree directory name; defaults to a
 *   timestamp + random suffix so concurrent calls never collide.
 * @param {string} [options.branchName] - new branch name for the worktree;
 *   defaults to `helm/<id>`.
 * @param {"junction"|"install"|"none"} [options.deps="none"] - dependency
 *   provisioning strategy. Defaults to `"none"` (the original behavior: no
 *   node_modules at all) so callers that don't need to build/test in the
 *   worktree keep the cheap, fast path. Pass `"junction"` for the fast
 *   shared-install default, or `"install"` for a fully isolated install.
 * @returns {{ worktreePath: string, branchName: string, envFilesCopied: string[],
 *   depsProvisioned: { strategy: string, path: string }|null, depsError: string|null }}
 */
export function createWorktree(projectPath, options = {}) {
  const resolvedProject = path.resolve(projectPath);
  if (!fs.existsSync(resolvedProject)) {
    throw new Error(`Project path does not exist: ${resolvedProject}`);
  }

  const id = options.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branchName = options.branchName || `helm/${id}`;
  const worktreesRoot = worktreesRootFor(resolvedProject);
  const worktreePath = path.join(worktreesRoot, id);
  const deps = options.deps || "none";

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

  // Fail-safe: a provisioning failure (missing node_modules to junction, npm
  // registry hiccup, etc.) must never leave the caller with no worktree at
  // all - the worktree itself is already valid and usable (just without
  // deps), so we log-and-continue rather than throwing. Callers that need to
  // know can inspect `depsError` on the returned object.
  let depsProvisioned = null;
  let depsError = null;
  if (deps !== "none") {
    try {
      depsProvisioned = provisionDeps(resolvedProject, worktreePath, deps);
    } catch (err) {
      depsError = err.message;
      console.error(
        `[worktree] Dependency provisioning ("${deps}") failed for ${worktreePath}: ${err.message}`
      );
    }
  }

  return { worktreePath, branchName, envFilesCopied, depsProvisioned, depsError };
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
 * CRITICAL junction safety (verified empirically, not assumed): if
 * `createWorktree` was called with `deps: "junction"`, the worktree's
 * `node_modules` is a reparse point pointing at the SOURCE repo's real
 * `node_modules`. `git worktree remove` (even with `--force`) does NOT
 * treat that specially - it follows the junction like a normal directory
 * and deletes everything inside it, which would silently wipe out the main
 * repo's real `node_modules` (confirmed by direct test: a junctioned
 * `node_modules` left in place for `git worktree remove --force` to handle
 * emptied the shared target directory completely). So this function ALWAYS
 * removes a junctioned `node_modules` itself first, using `fs.rmSync` on
 * the junction path directly - `fs.rmSync`/`rmdir` on a Windows reparse
 * point removes only the link/reparse entry itself, never the target's
 * contents (also confirmed by direct test). Only after that pre-removal
 * does `git worktree remove` run, by which point there is no junction left
 * for it to walk into.
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

  // Junction-safety step - see doc comment above. Must run BEFORE `git
  // worktree remove`, and must only ever unlink (never recurse through) the
  // junction. `isJunctionOrSymlink` uses `lstat`, which never follows the
  // link, so this can never mistake a real (non-junctioned) node_modules
  // directory for a junction and is safe to run unconditionally.
  const nodeModulesPath = path.join(resolvedWorktree, NODE_MODULES_DIR);
  if (isJunctionOrSymlink(nodeModulesPath)) {
    try {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `Failed to remove node_modules junction before worktree removal: ${nodeModulesPath}: ${err.message}`
      );
    }
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
