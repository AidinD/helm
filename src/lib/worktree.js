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
  return listWorktrees(projectPath).map((w) => w.path);
}

/**
 * The same `git worktree list --porcelain` output, but WITH each worktree's
 * checked-out branch and whether it is the repo's own primary working tree.
 *
 * The housekeeping sweep (worktreeSweep.js) needs the branch to decide whether
 * a worktree is even one of Helm's, and needs to know which entry is the main
 * checkout so it can never be a candidate for removal. `listWorktreePaths`
 * delegates here rather than parsing the same output a second time - two
 * parsers for one command is how they drift apart.
 *
 * A detached worktree has no `branch` line, so `branch` is null there; git
 * always lists the primary working tree first, which is what `isMain` marks.
 */
export function listWorktrees(projectPath) {
  let output;
  try {
    output = runGit(projectPath, ["worktree", "list", "--porcelain"]);
  } catch (err) {
    throw new Error(`Failed to list worktrees for ${projectPath}: ${err.message}`);
  }
  const list = [];
  let current = null;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), branch: null, isMain: list.length === 0 };
      list.push(current);
    } else if (line.startsWith("branch ") && current) {
      // "branch refs/heads/foo" -> "foo"
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return list;
}

/**
 * Drop git's registration of worktrees whose directories are gone.
 *
 * `git worktree remove` cannot do this - there is nothing on disk to remove - so
 * without a prune the entry survived every sweep, and the sweep reported the same
 * phantom removal on every app start (independent review, 2026-08-03).
 */
export function pruneWorktrees(projectPath, { onlyIfAllMatch = null } = {}) {
  const resolved = path.resolve(projectPath);
  // `git worktree prune` is REPO-GLOBAL - it deregisters every absent worktree,
  // not just the one we decided about. That matters because a detached worktree's
  // HEAD is a reachability root: deregistering one makes its commit collectable,
  // which is the very hazard the detached-worktree guard exists to prevent, reached
  // from the side (independent review, 2026-08-03). It also silently deregisters a
  // worktree that is merely absent for an unrelated reason, e.g. an offline drive.
  //
  // So: look first (--dry-run names what it WOULD prune), and only proceed when
  // every one of those is a path the caller vouched for.
  if (onlyIfAllMatch) {
    let planned;
    try {
      planned = runGit(resolved, ["worktree", "prune", "--dry-run", "--verbose"]);
    } catch (err) {
      throw new Error(`git worktree prune --dry-run failed for ${resolved}: ${err.message}`);
    }
    const mentioned = [...planned.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const strays = mentioned.filter((p) => !onlyIfAllMatch(p));
    if (strays.length > 0) {
      return { pruned: false, skipped: strays };
    }
  }
  try {
    runGit(resolved, ["worktree", "prune"]);
  } catch (err) {
    throw new Error(`git worktree prune failed for ${projectPath}: ${err.message}`);
  }
  return { pruned: true, skipped: [] };
}

/** Local branch names in the repo (no remotes), for the housekeeping sweep. */
export function listLocalBranches(projectPath) {
  try {
    return runGit(projectPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to list branches for ${projectPath}: ${err.message}`);
  }
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
 * Paths inside a worktree that are Helm's own bookkeeping, not the run's work:
 * the orchestrator's scratch folder and the provisioned dependencies.
 */
const SWEEP_IGNORED_PREFIXES = [".helm-goal/", "node_modules/"];

/**
 * True when the worktree has uncommitted changes that are actually WORK -
 * anything outside Helm's own bookkeeping.
 *
 * `hasUncommittedChanges` alone cannot answer the housekeeping question. A
 * finished run's worktree is essentially always "dirty" by that measure: the
 * dependency junction shows up as an untracked `node_modules/`, and the
 * orchestrator's `.helm-goal/` notes are untracked in every repo that has not
 * gitignored them (Helm's own repo has since 2026-08-03; a work repo it runs a
 * goal in has not). So a sweep keyed on the plain check would keep every
 * junctioned worktree forever and quietly never clean anything - which is how
 * this was caught: the live test's junctioned worktree was skipped.
 *
 * Same distinction goalOrchestrator's `producedRealChanges` already draws for
 * deciding whether an iteration did real work; this is the cleanup-side twin.
 *
 * Fails SAFE: any git error returns true, so an unreadable worktree is treated
 * as holding work and is kept.
 */
export function hasUncommittedWork(worktreePath) {
  let output;
  try {
    output = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    return true;
  }
  return output
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .some((line) => {
      // Porcelain v1 is COLUMN-oriented: two status characters, a space, then the
      // path ("XY path", or "XY old -> new" for a rename). Trimming first would
      // lose the leading space that distinguishes " M" (tracked, modified) from
      // "?? " (untracked), which is the whole distinction below.
      const status = line.slice(0, 2);
      const raw = line.slice(3).trim().split(" -> ").pop() || "";
      // Not `.replace(/\\/g, "/")`: git C-quotes odd paths, and rewriting
      // backslashes corrupts those escapes - goalOrchestrator's producedRealChanges
      // documents the same trap and deliberately omits it.
      const rel = raw.replace(/^"|"$/g, "");
      // The trailing slash is required, so only the DIRECTORY (or something inside
      // it) is bookkeeping. Accepting the bare name too meant a FILE literally
      // called `.helm-goal` or `node_modules` was ignored - untracked content that
      // exists nowhere else, which --force would then have deleted.
      const isBookkeeping = SWEEP_IGNORED_PREFIXES.some((p) => rel.startsWith(p));
      // ONLY an UNTRACKED bookkeeping path is ignorable. This used to ignore the
      // path whatever its status, and once `ignoreBookkeeping` started passing
      // --force to git, that turned into unattended data loss: in any repo that has
      // not gitignored `.helm-goal/`, the run's own `git add -A` COMMITS those
      // notes, so on the next run a modification to them is tracked - invisible to
      // this check, and no longer refused by git either. An independent review
      // reproduced the worktree being deleted with the work in it (2026-08-03).
      // A tracked change is work, wherever it lives.
      return !(isBookkeeping && status === "??");
    });
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

  // `ignoreBookkeeping` narrows what counts as "uncommitted changes" to actual
  // WORK, i.e. anything outside `.helm-goal/` and `node_modules/`. The
  // housekeeping sweep needs it: a finished run's worktree always shows the
  // dependency junction (and, in a repo that hasn't ignored it, the
  // orchestrator's notes) as untracked, so the plain check would refuse to
  // remove every single one. Deliberately NOT the same thing as `force` - this
  // still refuses when there is real uncommitted work, so the sweep can never
  // discard anything, whereas `force` discards regardless. The interactive
  // per-run delete keeps the plain check and its explicit force-discard confirm.
  // Evaluated lazily, AFTER the existence check: hasUncommittedChanges throws on
  // a path that is already gone, which used to be short-circuited away.
  const isDirty = () =>
    options.ignoreBookkeeping ? hasUncommittedWork(resolvedWorktree) : hasUncommittedChanges(resolvedWorktree);
  if (!options.force && fs.existsSync(resolvedWorktree) && isDirty()) {
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
  let junctionTarget = null;
  if (isJunctionOrSymlink(nodeModulesPath)) {
    try {
      // Remember where it pointed, so a FAILED removal can put it back. Unlinking
      // first is mandatory (see above), but it used to be unconditional and
      // one-way: when git then refused to remove the worktree, the worktree was
      // left without its dependencies - unbuildable, and unusable for a later
      // resume (found by independent review, 2026-08-03).
      junctionTarget = fs.readlinkSync(nodeModulesPath);
    } catch {
      junctionTarget = null;
    }
    try {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `Failed to remove node_modules junction before worktree removal: ${nodeModulesPath}: ${err.message}`
      );
    }
  }

  const args = ["worktree", "remove", resolvedWorktree];
  // git applies its OWN untracked-files check and refuses without --force. That
  // check does not know about Helm's bookkeeping: the orchestrator's `.helm-goal/`
  // notes are untracked in every repo that has not gitignored them (which is every
  // repo except Helm's own), and a provisioned `node_modules` is untracked too. So
  // a caller that has already established there is no real WORK here - the
  // `isDirty()` gate above, which is the whole point of ignoreBookkeeping - would
  // otherwise be refused by git forever, cleaning nothing anywhere (independent
  // review, 2026-08-03: "the feature does not work in any repo except Helm's own").
  //
  // Passing --force here is therefore NOT the same as the caller passing `force`:
  // it is only reached after our own stricter check said the worktree holds no
  // work, and a worktree that DOES hold work has already thrown above.
  if (options.force || options.ignoreBookkeeping) {
    args.push("--force");
  }
  try {
    runGit(resolvedProject, args);
  } catch (err) {
    // Put the dependency link back, so a worktree we failed to remove is left
    // exactly as we found it rather than subtly broken.
    if (junctionTarget && fs.existsSync(resolvedWorktree) && !fs.existsSync(nodeModulesPath)) {
      try {
        fs.symlinkSync(junctionTarget, nodeModulesPath, "junction");
      } catch {
        // best effort - the removal error below is the one that matters
      }
    }
    throw new Error(`git worktree remove failed for ${resolvedWorktree}: ${err.message}`);
  }
}

/**
 * The repo's primary/integration branch name. Prefers origin/HEAD's target
 * (the remote's default branch), then a local `main`/`master` if present,
 * falling back to "main". Used by `isBranchMerged` so the merged-check gates
 * on the branch a Helm goal branch would actually be integrated into, without
 * assuming which of main/master a given repo uses.
 */
export function primaryBranch(projectPath) {
  const resolved = path.resolve(projectPath);
  try {
    const ref = runGit(resolved, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) {
      return m[1];
    }
  } catch {
    // no origin/HEAD configured - fall through to local-branch probing
  }
  for (const cand of ["main", "master"]) {
    try {
      // rev-parse --verify --quiet exits non-zero (throws here) when absent.
      runGit(resolved, ["rev-parse", "--verify", "--quiet", `refs/heads/${cand}`]);
      return cand;
    } catch {
      // not this one
    }
  }
  return "main";
}

/**
 * True when `branchName`'s tip is already contained in `base` (fully merged),
 * so deleting the branch would lose no commits. This is the GATE for automatic
 * branch deletion on run cleanup - an unmerged branch is kept, never dropped.
 * `base` defaults to `primaryBranch(projectPath)`.
 *
 * Uses `git merge-base --is-ancestor <branch> <base>` (exit 0 = ancestor =
 * merged). Returns false on any error (missing ref, etc.) so the caller
 * fails safe toward KEEPING the branch.
 */
export function isBranchMerged(projectPath, branchName, base) {
  const resolved = path.resolve(projectPath);
  const target = base || primaryBranch(resolved);
  try {
    // FULLY QUALIFIED. A bare "helm/x" is ambiguous, and git prefers a TAG of that
    // name - so a tag pointing at main could answer "yes, merged" while the BRANCH
    // of the same name held unmerged commits, which `git branch -D` would then
    // delete. Found by independent review, 2026-08-03. The base stays as given: a
    // caller naming "main" means the branch, and refs/heads/ would break a caller
    // passing a remote or a commit.
    execFileSync("git", ["-C", resolved, "merge-base", "--is-ancestor", `refs/heads/${branchName}`, target], {
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a local branch. Defaults to git's own safe delete (`-d`), which
 * refuses to drop a branch that isn't merged; pass `{ force: true }` for `-D`.
 *
 * `mergedInto: "<base>"` is the third option, and the one automated cleanup
 * should use. git's `-d` asks "is this contained in HEAD or its upstream", which
 * is NOT the question the caller asked - so with the main checkout sitting on any
 * other branch, `-d` refused to delete branches that were fully merged into
 * master, and the sweep produced a permanent failure on every app start while
 * cleaning nothing (independent review, 2026-08-03).
 *
 * Rather than let the caller reach for `force` to work around that - which would
 * throw away git's refusal for every other case too - this verifies the ancestry
 * ITSELF, right here, immediately before deleting. The check and the deletion
 * cannot drift apart, and a caller cannot get the forceful behaviour without
 * naming a base that the branch genuinely descends into.
 */
export function deleteBranch(projectPath, branchName, options = {}) {
  const resolved = path.resolve(projectPath);
  let flag = options.force ? "-D" : "-d";
  if (!options.force && options.mergedInto) {
    // A branch is its own ancestor, so `mergedInto` naming the branch itself would
    // pass trivially and hand out the forceful delete for nothing. Not reachable
    // from the sweep (it always passes the primary branch), but an API that can be
    // held that way eventually is.
    if (options.mergedInto === branchName || options.mergedInto === `refs/heads/${branchName}`) {
      throw new Error(`Refusing to delete ${branchName}: "mergedInto" names the branch itself.`);
    }
    if (!isBranchMerged(resolved, branchName, options.mergedInto)) {
      throw new Error(
        `Refusing to delete ${branchName}: it is not fully merged into ${options.mergedInto}.`
      );
    }
    // Every commit on it is also on the base - verified one line ago.
    flag = "-D";
  }
  try {
    runGit(resolved, ["branch", flag, branchName]);
  } catch (err) {
    throw new Error(`git branch ${flag} failed for ${branchName}: ${err.message}`);
  }
}
