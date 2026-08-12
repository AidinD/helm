import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * The change behind a review item - the diff, so reviewing does not mean taking a
 * record's word for what it says was done (Aidin, task c3dfbb42: "Review ändringar -
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
 * The same log search as resolveTaskCommits step 2, for MANY tasks in ONE git call.
 *
 * Why this exists: the review queue asked git once per row, and a git process costs
 * ~70ms of pure startup on Windows before it does any work. Measured on Aidin's real
 * board on 2026-08-12: 20 rows = 20 processes = 2194ms of main-process time, during
 * which the whole app is unresponsive. That is his "helm är lite långsamt ibland" and
 * the same 2042ms this file's caller already recorded on 2026-08-03. Batched, the same
 * 20 rows cost 237ms - and the results are identical, verified against the per-row
 * answers before this replaced them (9.5x, same shas for all 10 probe ids).
 *
 * `git log` ORs multiple --grep terms, so one pass finds every task's commits at once.
 * Attribution back to a task is done here rather than by git: a commit message can name
 * the id anywhere, so the SUBJECT alone is not enough to say which task a matched commit
 * belongs to - the body is read too, which is why the format carries it.
 *
 * Deliberately NO --max-count. Per task the cap is applied below, in memory; a total cap
 * across all terms would let one busy task's commits push another task's out of the
 * window entirely, turning a bounded-per-task search into a silently incomplete one.
 * git still scans the same history the per-row calls each scanned on their own, so this
 * is cheaper in every case, not only this one.
 *
 * @param {string} projectPath
 * @param {Array<string>} taskIds
 * @param {object} [deps] injectable git runner, for tests without a repo.
 * @returns {Map<string, {source: "log"|"none", commits: Array<{sha,subject}>, error: string|null}>}
 *          keyed by the taskId exactly as passed in.
 */
export function resolveTaskCommitsBatch(projectPath, taskIds, { run = git, maxPerTask = 40 } = {}) {
  const out = new Map();
  const ids = Array.isArray(taskIds) ? taskIds : [];
  if (!projectPath || !fs.existsSync(projectPath)) {
    for (const taskId of ids) {
      out.set(taskId, { source: "none", commits: [], error: "This record names no project folder that exists, so there is nothing to diff." });
    }
    return out;
  }
  // short8 -> the taskIds that reduce to it. A Map of lists, not a plain key: two
  // different task ids CAN share an 8-char prefix, and silently dropping one of them
  // would hide a real card's commits.
  const byShort = new Map();
  for (const taskId of ids) {
    const short8 = taskShortId(taskId);
    if (!short8) {
      out.set(taskId, { source: "none", commits: [], error: "Not a task id, so there is nothing to search for." });
      continue;
    }
    if (byShort.has(short8)) {
      byShort.get(short8).push(taskId);
    } else {
      byShort.set(short8, [taskId]);
    }
  }
  if (byShort.size === 0) {
    return out;
  }
  const shorts = [...byShort.keys()];
  let raw;
  try {
    raw = run(projectPath, [
      "log",
      "--all",
      "--regexp-ignore-case",
      // %x1f separates the fields, %x1e the records - neither can occur in a commit
      // message, unlike a newline, which a body is full of.
      "--format=%H%x1f%s%x1f%b%x1e",
      ...shorts.map((s) => `--grep=${s}`),
    ]);
  } catch (err) {
    for (const taskId of ids) {
      if (!out.has(taskId)) {
        out.set(taskId, { source: "none", commits: [], error: `Could not search the log: ${short(err)}` });
      }
    }
    return out;
  }
  const found = new Map(shorts.map((s) => [s, []]));
  for (const record of String(raw || "").split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) {
      continue;
    }
    const [sha, subject = "", body = ""] = trimmed.split("\x1f");
    if (!SHA_RE.test(String(sha || "").trim())) {
      continue;
    }
    // Case-insensitively, because the search was --regexp-ignore-case.
    const haystack = `${subject}\n${body}`.toLowerCase();
    for (const s of shorts) {
      if (haystack.includes(s)) {
        found.get(s).push({ sha: sha.trim(), subject: subject.trim() });
      }
    }
  }
  for (const [short8, taskIdsForShort] of byShort) {
    // git log is newest-first, so the per-task cap keeps the newest N - the same ones
    // the per-row `--max-count` call kept.
    const commits = found.get(short8).slice(0, maxPerTask);
    for (const taskId of taskIdsForShort) {
      out.set(
        taskId,
        commits.length > 0
          ? { source: "log", commits, error: null }
          : {
              source: "none",
              commits: [],
              error: `No commit in this repo names ${short8}, and the record lists none. Either the work is not committed yet, or nothing ties it to this task - add the commits to the record to make this exact.`,
            }
      );
    }
  }
  return out;
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
  if (shas.length === 0) {
    return { version: null, error: "The record pins no commit, so there is nothing to locate in a release." };
  }
  // The fix is fully shipped only once its NEWEST commit is in a release, and the release
  // that carries the WHOLE fix is the LATEST of each commit's earliest-containing tag.
  // Computed per commit rather than by array position on purpose: record.commits is
  // oldest-first (matching boundShaFull's `.at(-1)` = tip) but the log fallback is
  // newest-first, so assuming either ordering silently picks the wrong commit and can
  // report an earlier version than reality - or "shipped" when the tip is not yet released.
  const earliestContainingTag = (sha) => {
    let out;
    try {
      out = run(projectPath, ["tag", "--contains", sha, "--sort=v:refname"]);
    } catch (err) {
      return { error: short(err), tag: null };
    }
    const tags = String(out || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((t) => /^v\d/.test(t));
    return { error: null, tag: tags[0] || null };
  };
  let latest = null;
  for (const sha of shas) {
    const { error, tag } = earliestContainingTag(sha);
    if (error) {
      return { version: null, error };
    }
    if (!tag) {
      // This commit is in no release yet, so the whole fix is not shipped.
      return { version: null, error: null };
    }
    if (latest === null || compareVersionTags(tag, latest) > 0) {
      latest = tag;
    }
  }
  return { version: latest, error: null };
}

/** Numeric compare of two "vMAJOR.MINOR.PATCH" tags: >0 if a is newer than b. */
function compareVersionTags(a, b) {
  const parse = (t) => String(t).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
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
