import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * The change behind a review item - the diff, so reviewing does not mean taking a
 * record's word for what it says was done (the captain, task c3dfbb42: "Review ändringar -
 * kunna se diff. Kunna skicka oberoende agent på granskning").
 *
 * The hard part is not the diff, it is knowing WHICH commits belong to a task. Two
 * sources, in order, and the answer says which one was used - a diff attributed by
 * guesswork must not look like one attributed by record:
 *
 *   1. `record.commits` - what the author wrote down. Authoritative when present.
 *   2. The log, searched for the task's short id. Commit messages in this repo
 *      routinely say "task 3d0fe057", which is a real signal, but it is a SEARCH: a
 *      commit that never mentions the id is invisible to it, and an unrelated commit
 *      that quotes the id would be included.
 *
 * Everything here shells out to git with argument arrays (never a shell string), and
 * every sha is validated as 40 hex characters before it reaches a command.
 */

const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Enough to review by, small enough that the renderer stays responsive. */
export const DIFF_MAX_BYTES = 400 * 1024;

function git(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The 8-char prefix a commit message would refer to the task by. */
export function taskShortId(taskId) {
  const id = String(taskId || "").trim().toLowerCase();
  return /^[a-f0-9-]{8,64}$/.test(id) ? id.slice(0, 8) : null;
}

/**
 * Commits belonging to a task.
 *
 * @param {string} projectPath
 * @param {string} taskId
 * @param {Array<string>} recorded `record.commits`, shas or "sha subject" strings.
 * @param {object} [deps] injectable git runner, for tests without a repo.
 * @returns {{ source: "record"|"log"|"none", commits: Array<{sha: string, subject: string}>, error: string|null }}
 */
export function resolveTaskCommits(projectPath, taskId, recorded = [], { run = git } = {}) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { source: "none", commits: [], error: "This record names no project folder that exists, so there is nothing to diff." };
  }
  // 1. What the record claims. Validated, because it is hand-written.
  const fromRecord = [];
  for (const entry of Array.isArray(recorded) ? recorded : []) {
    const sha = String(entry || "").trim().split(/\s+/)[0];
    if (SHA_RE.test(sha)) {
      fromRecord.push(sha);
    }
  }
  if (fromRecord.length > 0) {
    try {
      const out = run(projectPath, ["show", "--no-patch", "--format=%H%x09%s", ...fromRecord]);
      return { source: "record", commits: parseCommitLines(out), error: null };
    } catch (err) {
      return { source: "record", commits: [], error: `The record names commits this repo does not have: ${short(err)}` };
    }
  }
  // 2. The log, by the task's short id. A search, and reported as one.
  const short8 = taskShortId(taskId);
  if (!short8) {
    return { source: "none", commits: [], error: "Not a task id, so there is nothing to search for." };
  }
  try {
    const out = run(projectPath, ["log", "--all", "--regexp-ignore-case", `--grep=${short8}`, "--format=%H%x09%s", "--max-count=40"]);
    const commits = parseCommitLines(out);
    return commits.length > 0
      ? { source: "log", commits, error: null }
      : {
          source: "none",
          commits: [],
          error: `No commit in this repo names ${short8}, and the record lists none. Either the work is not committed yet, or nothing ties it to this task - add the commits to the record to make this exact.`,
        };
  } catch (err) {
    return { source: "none", commits: [], error: `Could not search the log: ${short(err)}` };
  }
}

/**
 * The released app version a task's fix is out in, or null if it is not in any
 * released tag yet (task 860b4661: "review - borde visa vilken version fixen finns ute
 * i om versionerad").
 *
 * Uses `git tag --contains <sha>` on the fix's LAST commit - the same commit the review
 * record pins its checks to (boundShaFull's `.at(-1)`): once the newest commit of a fix
 * is in a release, the whole fix is. `--sort=v:refname` lists the containing tags
 * ascending, so the first `v*` is the EARLIEST release that carries the fix. This works
 * per-project off the record's own repo, so a fix in any tagged repo resolves, and a repo
 * that does not tag releases simply returns null ("if versioned").
 *
 * Caller is responsible for making recent tags visible first (a release tag created on the
 * remote by the publisher is not local until fetched); this stays a pure tag read so it is
 * testable without a network.
 *
 * @param {string} projectPath
 * @param {Array<string|{sha:string}>} commits record.commits (shas or "sha subject" strings)
 * @param {object} [deps] injectable git runner, for tests without a repo.
 * @returns {{ version: string|null, error: string|null }}
 */
export function shippedVersionForCommits(projectPath, commits, { run = git } = {}) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { version: null, error: "This record names no project folder that exists." };
  }
  const shas = (Array.isArray(commits) ? commits : [])
    .map((c) => (typeof c === "string" ? c : c?.sha))
    .map((s) => String(s || "").trim().split(/\s+/)[0])
    .filter((s) => SHA_RE.test(s));
  const lastSha = shas.at(-1);
  if (!lastSha) {
    return { version: null, error: "The record pins no commit, so there is nothing to locate in a release." };
  }
  let out;
  try {
    out = run(projectPath, ["tag", "--contains", lastSha, "--sort=v:refname"]);
  } catch (err) {
    return { version: null, error: short(err) };
  }
  const tags = String(out || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((t) => /^v\d/.test(t));
  return { version: tags[0] || null, error: null };
}

function parseCommitLines(out) {
  return String(out || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha: sha.trim(), subject: rest.join("\t").trim() };
    })
    .filter((c) => SHA_RE.test(c.sha));
}

/**
 * The patch for a set of commits, oldest first, capped.
 *
 * Per commit rather than one range: a task's commits are not always contiguous, and a
 * range would silently include somebody else's work that landed between them.
 */
export function diffForCommits(projectPath, commits, { run = git, maxBytes = DIFF_MAX_BYTES } = {}) {
  const shas = (commits || []).map((c) => (typeof c === "string" ? c : c?.sha)).filter((s) => SHA_RE.test(String(s || "")));
  if (shas.length === 0) {
    return { ok: false, error: "No commits to diff." };
  }
  const parts = [];
  let bytes = 0;
  let truncated = false;
  for (const sha of [...shas].reverse()) {
    let text;
    try {
      text = run(projectPath, ["show", "--stat", "--patch", "--format=commit %H%n%s%n%n%b", sha]);
    } catch (err) {
      parts.push(`commit ${sha}\n(could not be read: ${short(err)})\n`);
      continue;
    }
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      // Cut at a commit boundary rather than mid-hunk: half a hunk reads as a diff and
      // is not one.
      truncated = true;
      break;
    }
    parts.push(text);
  }
  return {
    ok: true,
    text: parts.join("\n"),
    truncated,
    shown: parts.length,
    total: shas.length,
  };
}

function short(err) {
  return String(err?.stderr || err?.message || err)
    .split(/\r?\n/)[0]
    .slice(0, 200);
}
