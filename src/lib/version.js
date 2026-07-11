import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");

/**
 * Same scheme as Crewline: major.minor from package.json (bumped by hand),
 * a trailing "patch" number that's actually a commit count since whichever
 * commit last changed that major.minor — so it resets to 0 on every bump
 * instead of accumulating forever. Crewline computes this at Vite build
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

export function computeVersionString() {
  const majorMinor = majorMinorFromPkg();
  if (!majorMinor) {
    return "v0.0.0";
  }
  // Dev: live from git (commit count moves as you work).
  const fromGit = versionFromGit(majorMinor);
  if (fromGit) {
    return fromGit;
  }
  // Packaged (no .git): the version baked in at build time.
  const baked = readBuildVersion();
  if (baked) {
    return `v${baked}`;
  }
  return `v${majorMinor}`;
}

/**
 * Reads the current on-disk git HEAD short hash. Shells out to `git`
 * (same pattern as computeVersionString above) rather than hand-parsing
 * .git/HEAD / refs / packed-refs — those get complicated fast (detached
 * HEAD, packed refs, worktrees with a .git FILE instead of a folder), and
 * `git rev-parse` already handles all of that correctly. Returns null if
 * git isn't available or this isn't a git checkout (e.g. a packaged build
 * with no .git folder at all) — callers treat null as "can't tell, skip
 * the stale-build check."
 */
function readGitHeadShort() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
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
