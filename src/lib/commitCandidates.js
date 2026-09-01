/**
 * The commits a review row is PROBABLY about, when nothing says which ones it is about.
 *
 * ## The hole this fills
 *
 * A task's commits are known two ways: a review record lists them, or a commit subject
 * carries the task's 8-character id. Neither happens in practice. Measured on the real
 * board on 2026-09-01:
 *
 *   30 tasks sitting in review
 *    6 of them belong to a repo at all (the rest are job ads, investments, reading -
 *      correctly filtered out; a life-domain board is not code review)
 *    5 of those 6 are HIDDEN, because `hasCommits` is false
 *    1 row is what the page actually shows
 *
 * And the five hidden ones are real work. They all belong to one board whose repo has zero
 * commits mentioning any task id in its entire history - its subjects are conventional-commit
 * prose, "fix(scope): what changed" - so every card on it fails the check and disappears
 * behind a filter that exists to hide noise. Read side by side, a card and its commit are
 * obvious to a person. The page cannot see the thread between them, so it shows nothing.
 *
 * ## Why not match on the words
 *
 * That was the obvious idea and it is dead on arrival here. The house rule is Swedish for
 * tasks and English for anything committed, so a card and its own commit routinely share not
 * one word - the same fact stated twice in two languages, with no token in common. Any
 * lexical score would be noise wearing the costume of a signal, and a wrong pairing shown
 * confidently is worse than no pairing at all: it invites a review of the wrong diff.
 *
 * ## So: a window, minus what is already claimed
 *
 * Commits in the task's own repo, after the task was created, that no OTHER task has a
 * claim on. That is a filter, not a guess: it never asserts which commit belongs to which
 * card, it narrows what a person has to look at and lets their eyes do the matching. The
 * result is called candidates everywhere it is used, and a caller must not turn one into a
 * binding on its own.
 *
 * The cap is deliberate and is reported rather than applied quietly - a list truncated in
 * silence reads as "this is all of it", which is the shape of half the bugs in this repo's
 * own history.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Same runner shape as reviewDiff.js, injectable so a test never needs a real repo. */
function git(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** How many candidates a single row will carry. Beyond this the row says how many more. */
export const CANDIDATE_CAP = 12;

/**
 * A task's window has a start and no end.
 *
 * The start is when the card was created. There is deliberately no end, even though the
 * board has an `updatedAt` that looks like one: it moves on EVERY edit, including a comment
 * added long after the work, so using it would silently cut off the commits of any card
 * that was touched later. An open-ended window is wider and honest; a wrong end is narrow
 * and wrong.
 *
 * @param {{ createdAt?: number }} task
 * @returns {string | null} an ISO timestamp git understands, or null when unknown
 */
export function windowStart(task) {
  const created = Number(task?.createdAt);
  if (!Number.isFinite(created) || created <= 0) {
    return null;
  }
  return new Date(created).toISOString();
}

/**
 * Candidate commits per task, one git call per repo.
 *
 * @param {string} projectPath
 * @param {Array<{ taskId: string, createdAt?: number }>} tasks tasks in THIS repo
 * @param {object} [options]
 * @param {Set<string>} [options.claimed] shas already bound to some task - excluded
 * @param {(p: string, a: string[]) => string} [options.run]
 * @param {number} [options.cap]
 * @returns {Map<string, { commits: Array<{sha: string, shortSha: string, subject: string, at: number}>, more: number, error: string | null }>}
 */
export function candidateCommitsByRepo(projectPath, tasks, { claimed = new Set(), run = git, cap = CANDIDATE_CAP } = {}) {
  const out = new Map();
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) {
    return out;
  }
  if (!projectPath || !fs.existsSync(projectPath)) {
    for (const t of list) {
      out.set(t.taskId, { commits: [], more: 0, error: "That folder does not exist, so there is nothing to look through." });
    }
    return out;
  }

  // The earliest window across every task in this repo, so ONE log covers all of them.
  // A git process costs about 70ms of startup on Windows before it does any work, and the
  // existing per-task search in this file's neighbour measured 2193ms unbatched against
  // 114ms batched on the same rows.
  const starts = list.map((t) => windowStart(t)).filter(Boolean);
  if (starts.length === 0) {
    for (const t of list) {
      out.set(t.taskId, { commits: [], more: 0, error: "That task has no creation time, so there is no window to look in." });
    }
    return out;
  }
  const earliest = starts.sort()[0];

  let raw;
  try {
    // %H %ct %s - sha, commit time, subject. Unit-separated so a subject containing the
    // separator cannot split a record; %x1f is git's own field separator escape.
    raw = run(projectPath, ["log", "--no-merges", `--since=${earliest}`, "--pretty=format:%H%x1f%ct%x1f%s", "--max-count=500"]);
  } catch (err) {
    for (const t of list) {
      out.set(t.taskId, { commits: [], more: 0, error: `git could not list commits there: ${err.message}` });
    }
    return out;
  }

  const all = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [sha, ct, ...rest] = line.split("\x1f");
    if (!sha) {
      continue;
    }
    all.push({ sha, shortSha: sha.slice(0, 8), at: Number(ct) * 1000, subject: rest.join("\x1f") });
  }

  for (const task of list) {
    const start = windowStart(task);
    if (!start) {
      out.set(task.taskId, { commits: [], more: 0, error: "That task has no creation time, so there is no window to look in." });
      continue;
    }
    const from = Date.parse(start);
    const mine = all.filter((c) => c.at >= from && !claimed.has(c.sha) && !claimed.has(c.shortSha));
    out.set(task.taskId, {
      commits: mine.slice(0, cap),
      more: Math.max(0, mine.length - cap),
      error: null,
    });
  }
  return out;
}
