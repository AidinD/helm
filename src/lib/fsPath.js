import fs from "node:fs";

/**
 * Path canonicalization, and nothing else.
 *
 * Deliberately its own module with no dependency beyond node:fs. The obvious home was
 * paths.js, but that
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
 * This is not cosmetic. Both spellings were live in the same store on 2026-08-12, so
 * every cache keyed on the raw string missed and did its work twice. It
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

/**
 * The same folder, resolved through the filesystem, then canonicalized.
 *
 * `normalizeFsPath` folds separators and case, which is everything a pure string comparison
 * can do. It CANNOT fold the one Windows spelling that matters most in practice: the 8.3
 * short name. Any path component longer than eight characters gets an alias, so
 * C:\Users\longusername\x and C:\Users\LONGUS~1\x are one directory under two names that
 * share no common prefix past C:/Users/. No amount of lowercasing makes them equal.
 *
 * That is not theoretical. It broke two checks on a build machine whose account is
 * `runneradmin`: git answered with the long spelling while the temp directory the caller had
 * been handed used the short one, so a worktree the process had itself registered came back
 * as "not a registered worktree", and a repository came back as not being its own primary
 * work tree. Both read as logic bugs and are string bugs.
 *
 * Use this wherever a path from ONE source is compared against a path from ANOTHER: git
 * output against a caller's argument, a stored path against a live one. Use the pure
 * `normalizeFsPath` for a cache key, where a stable fold matters more than truth and the
 * path may not exist.
 *
 * Costs a filesystem call, which is why it is a separate function: worktreeSweep.js and
 * jot.js compare strings in loops and must not pay for I/O per comparison.
 *
 * Falls back to the pure fold when the path does not exist, because a comparison must still
 * be possible for a path that has been deleted or not yet created - and that is exactly when
 * a caller is asking "is this the one I remember".
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalFsPath(p) {
  const s = String(p || "").trim();
  if (!s) {
    return "";
  }
  try {
    // `.native` is what resolves the short name. The JS implementation does not.
    return normalizeFsPath(fs.realpathSync.native(s));
  } catch {
    return normalizeFsPath(s);
  }
}

/**
 * Do these two paths name the same folder, allowing for every spelling Windows permits?
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameFsPath(a, b) {
  const ca = canonicalFsPath(a);
  return ca !== "" && ca === canonicalFsPath(b);
}
