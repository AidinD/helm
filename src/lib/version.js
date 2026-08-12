import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");

/**
 * Same scheme as Skiff: major.minor from package.json (bumped by hand),
 * a trailing "patch" number that's actually a commit count since whichever
 * commit last changed that major.minor — so it resets to 0 on every bump
 * instead of accumulating forever. Skiff computes this at Vite build
 * time; Helm has no bundler (plain `electron .`), so this runs once at
 * app startup in the main process instead — same formula, different trigger.
 */
function majorMinorFromPkg() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return pkg.version.split(".").slice(0, 2).join(".");
  } catch {
    return null;
  }
}

// The full "vX.Y.Z" from git (dev checkout), or null if git can't give us a
// definitive answer (not on PATH, not a repo, or no commit introduced this
// exact major.minor). Returning null - rather than a partial "vX.Y" - lets the
// caller fall back to the build-stamped version in a packaged build.
function versionFromGit(majorMinor) {
  try {
    // Trailing "." anchors this to an exact major.minor — without it,
    // searching for "0.1" would also match "0.10", "0.11", "0.1.5", etc.
    const bumpCommit = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "-S", `"version": "${majorMinor}.`, "--", "package.json"],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();
    if (!bumpCommit) {
      return null;
    }
    const patch = execFileSync("git", ["rev-list", "--count", `${bumpCommit}..HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return `v${majorMinor}.${patch}`;
  } catch {
    return null;
  }
}

// The version stamped into the build at package time (scripts/build.mjs writes
// src/lib/build-version.json). Only present in a packaged build - the SAME
// major.minor.commitcount computed from git at build time, so a packaged app
// and its installer report the exact version dev showed when it was built
// (fixing "installer version doesn't match the app's"). Absent in a dev
// checkout, where git is authoritative.
function readBuildVersion() {
  try {
    const baked = JSON.parse(readFileSync(path.join(__dirname, "build-version.json"), "utf8"));
    return typeof baked.version === "string" ? baked.version : null;
  } catch {
    return null;
  }
}

// The LIVE git-derived version (major.minor.commitcount). Used by
// scripts/build.mjs to compute what to STAMP at build time. Kept separate from
// computeVersionString (below) on purpose: the display path reads the stamp, so
// if build.mjs also read the stamp it would re-stamp its own old value forever
// and never advance.
export function gitVersionString() {
  const majorMinor = majorMinorFromPkg();
  if (!majorMinor) {
    return "v0.0.0";
  }
  return versionFromGit(majorMinor) || `v${majorMinor}`;
}

// The version the APP DISPLAYS. Reads the build stamp FIRST so the running app
// (dev AND packaged) always reports the version of the last build - i.e. it
// equals the installer, always, and only changes when you rebuild (the captain's ask:
// "de borde alltid vara synkade"). It deliberately does NOT track live git in
// dev (that drifted ahead of the installer on every commit). git is only a
// fallback for a checkout that has never been built; the stale-build pill (see
// checkForNewerBuild) is what tells you dev code has moved past the running
// build.
export function computeVersionString() {
  const baked = readBuildVersion();
  if (baked) {
    return `v${baked}`;
  }
  const majorMinor = majorMinorFromPkg();
  if (!majorMinor) {
    return "v0.0.0";
  }
  return versionFromGit(majorMinor) || `v${majorMinor}`;
}

/**
 * A cheap "could HEAD have moved since last time?" stamp, or null when it cannot be
 * determined without git.
 *
 * This exists because readGitHeadShort below runs on a 45-second timer for the life of
 * the app, and starting a git process costs about 70ms on Windows before it does any
 * work at all (measured 2026-08-12) - paid forever, by every user, to answer a question
 * whose answer almost never changes. In a PACKAGED build it was worse than pointless:
 * there is no .git there, so every tick started git only to have it fail.
 *
 * Deliberately a change DETECTOR, not a resolver. The reasoning in readGitHeadShort's
 * own comment still stands - hand-parsing refs gets complicated fast - so git remains the
 * authority for what HEAD actually is; these reads only decide whether it is worth asking.
 * Being wrong in the "changed" direction costs one extra git call; the stamp therefore
 * errs that way whenever it is unsure.
 *
 *   - .git missing entirely  -> "none", and the caller skips git completely.
 *   - .git is a FILE (worktree/submodule) -> null, meaning "cannot tell", so the caller
 *     falls back to asking git every time. Correctness over speed for the rare shape.
 *   - otherwise the content of .git/HEAD (catches a branch switch and a detached HEAD),
 *     the content+mtime of the ref it names (catches a new commit on the current branch),
 *     and packed-refs' mtime (catches a repack).
 *
 * Exported, and taking the root as a parameter, ONLY so the test can drive it against
 * throwaway repos in every one of those shapes. A change detector that silently stopped
 * detecting would make the stale-build pill quietly wrong, which is worse than the cost
 * it was added to remove - so it is tested by mutation (make a commit, switch branch,
 * detach, repack) rather than by argument. Callers in this file pass nothing.
 */
export function gitHeadStamp(root = repoRoot) {
  const gitPath = path.join(root, ".git");
  let gitStat;
  try {
    gitStat = statSync(gitPath);
  } catch {
    return "none"; // not a checkout at all - a packaged build
  }
  if (!gitStat.isDirectory()) {
    return null; // a .git FILE: let git resolve it, every time
  }
  const parts = [];
  let head;
  try {
    head = readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
  } catch {
    return null; // a .git dir with no readable HEAD is odd enough to hand to git
  }
  parts.push(head);
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
  if (ref) {
    // The loose ref, when it exists. Absent means the ref is packed, which packed-refs'
    // own stamp below covers.
    try {
      const refPath = path.join(gitPath, ...ref.split("/"));
      parts.push(readFileSync(refPath, "utf8").trim());
    } catch {
      parts.push("-");
    }
  }
  try {
    const st = statSync(path.join(gitPath, "packed-refs"));
    parts.push(`${st.mtimeMs}`);
  } catch {
    parts.push("-");
  }
  return parts.join("|");
}

let headShortCache = null; // { stamp, sha }

/**
 * Reads the current on-disk git HEAD short hash. Shells out to `git`
 * (same pattern as computeVersionString above) rather than hand-parsing
 * .git/HEAD / refs / packed-refs — those get complicated fast (detached
 * HEAD, packed refs, worktrees with a .git FILE instead of a folder), and
 * `git rev-parse` already handles all of that correctly. Returns null if
 * git isn't available or this isn't a git checkout (e.g. a packaged build
 * with no .git folder at all) — callers treat null as "can't tell, skip
 * the stale-build check."
 *
 * The git call is skipped when gitHeadStamp says nothing that could move HEAD has
 * changed since the last answer, which is what makes this safe to leave on a timer.
 */
function readGitHeadShort() {
  const stamp = gitHeadStamp();
  if (stamp === "none") {
    return null; // no repo: nothing to ask git about
  }
  if (stamp !== null && headShortCache && headShortCache.stamp === stamp) {
    return headShortCache.sha;
  }
  let sha;
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    sha = null;
  }
  if (stamp !== null) {
    headShortCache = { stamp, sha };
  }
  return sha;
}

/**
 * Captures the identity of the build that is CURRENTLY RUNNING. Call this
 * exactly ONCE, at app startup — the whole point is a fixed snapshot to
 * later compare the live on-disk state against, so the running instance can
 * tell "I am now stale" even though nothing about its own already-loaded
 * code changed.
 */
export function captureRunningBuildIdentity() {
  return {
    version: computeVersionString(),
    commit: readGitHeadShort(), // null when not a git checkout (packaged build)
  };
}

/**
 * Compares the identity captured at boot against the CURRENT on-disk state.
 * Cheap (one git subprocess) — safe to call on a periodic timer. Returns
 * { stale: boolean, current: {version, commit} }. When there is no git
 * checkout to read (packaged build, or git missing), `stale` is always
 * false — there is nothing on disk to compare against, so silence is more
 * honest than guessing.
 */
export function checkForNewerBuild(bootIdentity) {
  const currentCommit = readGitHeadShort();
  if (currentCommit === null) {
    return { stale: false, current: { version: computeVersionString(), commit: null } };
  }
  const stale = bootIdentity.commit !== null && currentCommit !== bootIdentity.commit;
  return { stale, current: { version: computeVersionString(), commit: currentCommit } };
}
