/**
 * Path canonicalization, and nothing else.
 *
 * Deliberately its own module with NO imports. The obvious home was paths.js, but that
 * module resolves the Claude install root at load time (an fs.readdirSync over
 * %LOCALAPPDATA%\Packages), and two of the callers here - jot.js and the deliberately
 * PURE worktreeSweep.js - must not pick up a filesystem scan just to compare two strings.
 */

/**
 * Canonicalizes a filesystem path so two spellings of the same folder compare equal:
 * forward slashes, no trailing slash, lowercased.
 *
 * Windows paths are case-insensitive and mix separators, so `D:\Repo\Tools\helm` and
 * `D:/Repo/Tools/helm` are the same folder and must fold to one form before being used
 * as a cache key or compared against a stored path.
 *
 * This is not cosmetic. Both spellings were live in the captain's own review records on
 * 2026-08-12, so every cache keyed on the raw string missed and did its work twice. It
 * had also already been written privately, and identically, in jot.js AND
 * worktreeSweep.js; a third caller (the review queue's per-repo git batching) made one
 * shared copy the only way to stop the three drifting on what "the same folder" means.
 *
 * Returns "" for empty input, so a missing path never collides with a real one.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeFsPath(p) {
  const s = String(p || "").trim();
  if (!s) {
    return "";
  }
  return s
    .replace(/[\\/]+/g, "/") // backslashes and doubled slashes -> single forward slash
    .replace(/\/+$/, "") // drop any trailing slash
    .toLowerCase();
}
