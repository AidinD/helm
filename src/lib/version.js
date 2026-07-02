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
 * time; Maestro has no bundler (plain `electron .`), so this runs once at
 * app startup in the main process instead — same formula, different trigger.
 */
export function computeVersionString() {
  let majorMinor = "0.0";
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    majorMinor = pkg.version.split(".").slice(0, 2).join(".");
  } catch {
    return "v0.0.0";
  }

  try {
    // Trailing "." anchors this to an exact major.minor — without it,
    // searching for "0.1" would also match "0.10", "0.11", "0.1.5", etc.
    // (found in review before this shipped).
    const bumpCommit = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "-S", `"version": "${majorMinor}.`, "--", "package.json"],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();
    if (!bumpCommit) {
      // No commit found that introduced this exact major.minor (e.g. it was
      // hand-edited without a matching commit yet) — patch has no
      // meaningful "since" point, so it's just not shown rather than guessed.
      return `v${majorMinor}`;
    }
    const patch = execFileSync("git", ["rev-list", "--count", `${bumpCommit}..HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return `v${majorMinor}.${patch}`;
  } catch {
    // git not on PATH, not a git repo, or some other failure — the version
    // number is a nice-to-have display, not something worth surfacing an
    // error for.
    return `v${majorMinor}`;
  }
}
