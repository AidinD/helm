// Commit-centric review source (task: "få alla commits att hamna i review oavsett
// projekt"). The Review page was built only from Jot tasks in `review`, so work done in a
// project that doesn't use a Jot board (the captain ran a session against Halyard with a GitHub
// board) never surfaced - nothing to stamp, no evidence to read.
//
// This lists commits per project that are NOT already bound to a Jot task, so they can be
// shown as their own review rows with a "no task" chip. A commit bound to a task (its sha is
// in a review record's `commits`, or its message names a task's short id) rolls up under
// that task's existing row and is deliberately excluded here.
//
// The window is bounded by a per-project WATERMARK so the page never floods with a repo's
// whole history: only commits after the watermark surface, and acknowledging a commit
// advances the watermark past it. Everything shells out to git with argument arrays (never a
// shell string); every sha is validated as hex before it reaches a command.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_LIMIT = 50;

/**
 * Canonical key for a project path, used for de-duplication AND as the watermark/ack key so
 * the same repo referenced under different spellings resolves to ONE entry. On Windows the
 * filesystem is case-insensitive but path.resolve does not normalize drive-letter case or
 * spelling, so "d:\Repo\X" and "D:\Repo\X" would otherwise become two projects with
 * independent watermarks - two identical review sections, and acknowledging in one leaves the
 * other showing the commit (ship-review finding, 2026-08-10).
 */
export function projectKey(p) {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function git(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    // Swallow stderr: a missing ref (the whole point of the fallback ladder below) otherwise
    // prints "fatal: ..." to the main process on every payload build.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** rev-parse a ref to a full commit sha, or null if it doesn't resolve. */
function revParse(projectPath, ref, run) {
  try {
    const out = run(projectPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
    return SHA_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The baseline commit for a project the FIRST time it is seen - the point the review window
 * starts from. Chosen so work not yet integrated into the mainline surfaces immediately
 * (the Halyard case: a session's commits are ahead of the pushed branch), while a repo's
 * long pushed history does not flood the page.
 *
 * Ladder: the current branch's upstream, then origin's default/main/master, then local
 * main/master - the first that exists AND is behind HEAD. If none is behind HEAD (a repo
 * with no mainline, or HEAD already at it), cap the window to the last `cap` commits so it
 * is still bounded. Returns null only when even HEAD~cap doesn't resolve (a repo with fewer
 * than `cap` commits and no baseline) - the caller then lists from the root, still capped by
 * the listing limit.
 */
export function initialWatermark(projectPath, { run = git, cap = 30 } = {}) {
  const head = revParse(projectPath, "HEAD", run);
  if (!head) {
    return null;
  }
  for (const ref of ["@{upstream}", "origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const sha = revParse(projectPath, ref, run);
    if (sha && sha !== head) {
      return sha;
    }
  }
  return revParse(projectPath, `HEAD~${cap}`, run);
}

/**
 * Commits on HEAD after `watermark` that are NOT bound to a task, newest first.
 *
 * @param {string} projectPath
 * @param {object} opts
 * @param {string|null} opts.watermark  the review floor (exclusive); null = from the root.
 * @param {(sha:string, subject:string)=>boolean} [opts.isBound]  true to EXCLUDE a commit
 *        (it belongs to a task and rolls up there). Injected so the binding sources (review
 *        records, the Jot board) stay in the caller and this stays pure/testable.
 * @param {number} [opts.limit]
 * @param {Function} [opts.run]  injectable git runner (tests).
 * @returns {Array<{sha:string, shortSha:string, subject:string}>}
 */
export function listUnboundCommits(projectPath, { watermark = null, isBound = null, limit = DEFAULT_LIMIT, run = git } = {}) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return [];
  }
  const range = watermark && SHA_RE.test(watermark) ? `${watermark}..HEAD` : "HEAD";
  let out;
  try {
    // --no-merges: a merge commit is not a unit of work to review on its own. Cap at
    // limit+1 so the caller could tell the window was truncated (kept internal for now).
    out = run(projectPath, ["log", range, "--no-merges", `--max-count=${limit + 1}`, "--format=%H%x09%s"]);
  } catch {
    return [];
  }
  const commits = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const tab = trimmed.indexOf("\t");
    const sha = tab >= 0 ? trimmed.slice(0, tab) : trimmed;
    const subject = tab >= 0 ? trimmed.slice(tab + 1).trim() : "";
    if (!SHA_RE.test(sha)) {
      continue;
    }
    if (isBound && isBound(sha, subject)) {
      continue;
    }
    commits.push({ sha, shortSha: sha.slice(0, 8), subject });
    if (commits.length >= limit) {
      break;
    }
  }
  return commits;
}

/**
 * Builds an `isBound` predicate from the two authoritative binding sources:
 *  - `recordCommitShas`: every sha listed in any review record's `commits` (short or full).
 *    A commit is bound when its sha shares a common prefix with one of these (either is a
 *    prefix of the other), so a record's short "8b75619" matches the full 40-char sha.
 *  - `taskShortIds`: the 8-char ids of Jot tasks. A commit is bound when its subject names
 *    one (this repo's messages routinely say "task 07cd4fc9").
 */
export function makeIsBound({ recordCommitShas = [], taskShortIds = [] } = {}) {
  const shas = (recordCommitShas || [])
    .map((s) => String(s || "").trim().split(/\s+/)[0].toLowerCase())
    .filter((s) => SHA_RE.test(s));
  const ids = (taskShortIds || []).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
  return (sha, subject) => {
    const full = String(sha || "").toLowerCase();
    for (const s of shas) {
      if (full.startsWith(s) || s.startsWith(full)) {
        return true;
      }
    }
    const subj = String(subject || "").toLowerCase();
    for (const id of ids) {
      if (id.length >= 6 && subj.includes(id)) {
        return true;
      }
    }
    return false;
  };
}
