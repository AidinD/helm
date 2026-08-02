import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Coach signal (vision point 12): how far a project's durable state docs have
// drifted behind the code. Helm's whole thesis is durable-knowledge-in-files so
// an ephemeral session can be archived safely - but nothing enforced keeping
// PLAN.md/DECISIONS.md current, so they went stale under a work flurry. This
// makes the drift VISIBLE (a pane-header nudge) so it gets reconciled on the
// commit cadence, rather than relying on remembering. Read-only; never writes.
//
// Pure git/fs (no electron import) so it's unit-testable in plain node.

export const DOCS_STALE_THRESHOLD = 8; // commits since a doc was last touched before we nudge
const DOC_FILES = ["PLAN.md", "DECISIONS.md"];

function git(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

/**
 * How many commits have landed since PLAN.md/DECISIONS.md were last touched.
 * Returns { hasDocs, stale, commitsSince, threshold }. `stale` is true only
 * when the docs are tracked, clean (uncommitted edits = actively being
 * reconciled, so NOT stale), and commitsSince >= threshold. Any uncertainty
 * (no docs, not a git repo, git missing) resolves to not-stale - a nudge that
 * fires on a false positive is worse than a missed one.
 */
export function docsStaleness(projectPath, { threshold = DOCS_STALE_THRESHOLD } = {}) {
  const result = { hasDocs: false, stale: false, commitsSince: 0, threshold };
  if (!projectPath) {
    return result;
  }
  const resolved = path.resolve(projectPath);
  const docs = DOC_FILES.filter((f) => {
    try {
      return fs.existsSync(path.join(resolved, f));
    } catch {
      return false;
    }
  });
  if (docs.length === 0) {
    return result;
  }
  result.hasDocs = true;
  try {
    git(resolved, ["rev-parse", "--is-inside-work-tree"]);
    // Uncommitted (or untracked) doc edits mean you're reconciling right now -
    // not stale.
    if (git(resolved, ["status", "--porcelain", "--", ...docs])) {
      return result;
    }
    const lastDocCommit = git(resolved, ["log", "-1", "--format=%H", "--", ...docs]);
    const range = lastDocCommit ? `${lastDocCommit}..HEAD` : "HEAD";
    const count = parseInt(git(resolved, ["rev-list", "--count", range]), 10);
    result.commitsSince = Number.isFinite(count) ? count : 0;
    result.stale = result.commitsSince >= threshold;
  } catch {
    return { hasDocs: result.hasDocs, stale: false, commitsSince: 0, threshold };
  }
  return result;
}

/**
 * Async twin of docsStaleness, for the board-wide sweep.
 *
 * The sync version is fine for ONE repo on demand (the pane-header pill), but the
 * board sweep runs over every project you've worked in, and each repo with docs
 * costs four git spawns (rev-parse, status, log, rev-list). Measured at ~1.1s for
 * 13 candidate paths - and execFileSync in the Electron MAIN process blocks the
 * event loop, which means all IPC from all windows, session polling and stream
 * handling stall for that whole time. So the sweep must never be synchronous.
 *
 * Returns the same shape plus `checked`: false means "could not look" (not a git
 * repo, git missing, unreadable) as distinct from "looked, and it's current".
 * Conflating those two is how a nudge ends up silently claiming all-clear.
 */
export async function docsStalenessAsync(projectPath, { threshold = DOCS_STALE_THRESHOLD } = {}) {
  const result = { hasDocs: false, stale: false, commitsSince: 0, threshold, checked: false, versioned: false, reason: null };
  if (!projectPath) {
    return result;
  }
  let resolved;
  try {
    resolved = path.resolve(projectPath);
  } catch {
    return result;
  }
  const docs = [];
  for (const f of DOC_FILES) {
    try {
      if (fs.existsSync(path.join(resolved, f))) {
        docs.push(f);
      }
    } catch {
      // unreadable - treat as absent
    }
  }
  if (docs.length === 0) {
    // Nothing to be stale ABOUT. That is a real answer, not a failed look.
    return { ...result, checked: true };
  }
  result.hasDocs = true;
  const git = async (args) => (await execFileAsync("git", ["-C", resolved, ...args], { windowsHide: true })).stdout.trim();
  try {
    try {
      await git(["rev-parse", "--is-inside-work-tree"]);
    } catch (err) {
      // Two very different situations used to land in the same bucket, and the
      // difference is the whole point of the `checked` flag.
      //
      // "not a git repository" is a complete ANSWER: drift is measured in commits,
      // and a folder with no version control has none, so there is nothing that
      // could be behind. The captain's notes folder was being counted as "couldn't be
      // checked" and showing up as a problem to look into, when the truth is there
      // was never anything to look at (his review, 2026-07-28).
      //
      // Anything else here - git not installed, permission denied, a corrupt repo -
      // IS a failed look and must stay uncertain.
      const text = String(err?.stderr || err?.message || "");
      const notARepo = /not a git repository|does not appear to be a git repository/i.test(text);
      return { ...result, versioned: false, checked: notARepo, reason: notARepo ? "no version control" : firstLine(text) };
    }
    result.versioned = true;
    if (await git(["status", "--porcelain", "--", ...docs])) {
      // Uncommitted doc edits mean you're reconciling right now - not stale. But
      // only if the edit is RECENT: an edit left uncommitted months ago would
      // otherwise silence that project permanently, and a board-level signal with
      // a permanent blind spot is worse than a noisy one.
      if (docsEditedRecently(resolved, docs)) {
        return { ...result, checked: true };
      }
    }
    const lastDocCommit = await git(["log", "-1", "--format=%H", "--", ...docs]);
    const range = lastDocCommit ? `${lastDocCommit}..HEAD` : "HEAD";
    const count = parseInt(await git(["rev-list", "--count", range]), 10);
    result.commitsSince = Number.isFinite(count) ? count : 0;
    result.stale = result.commitsSince >= threshold;
    result.checked = true;
  } catch (err) {
    // Could not look. Deliberately NOT reported as clean.
    return {
      hasDocs: result.hasDocs,
      stale: false,
      commitsSince: 0,
      threshold,
      checked: false,
      versioned: result.versioned,
      reason: firstLine(String(err?.stderr || err?.message || "")),
    };
  }
  return result;
}

/** The first meaningful line of a git error, for naming WHY a project couldn't be read. */
function firstLine(text) {
  const line = (text || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? (line.length > 120 ? line.slice(0, 119) + "…" : line) : "unknown error";
}

const RECENT_DOC_EDIT_MS = 36 * 60 * 60 * 1000; // ~a day and a half: "still on it"

/** Was one of the docs touched recently enough to count as active reconciling? */
function docsEditedRecently(resolved, docs, now = Date.now()) {
  for (const f of docs) {
    try {
      if (now - fs.statSync(path.join(resolved, f)).mtimeMs < RECENT_DOC_EDIT_MS) {
        return true;
      }
    } catch {
      // unreadable mtime - don't let it claim recency
    }
  }
  return false;
}

/**
 * The same signal, but across a whole list of project paths - so the drift can be
 * a dashboard nudge ("these projects need reconciling") instead of only a pill you
 * see once you've already opened the project (task 0831417b).
 *
 * Returns ONLY the stale ones, worst first. Deliberately no auto-reconcile and no
 * writes: this tells you where to jump in, it does not decide to fix anything.
 *
 * @param {string[]} projectPaths - candidate paths; duplicates and unusable entries are dropped.
 * @param {{threshold?: number, limit?: number}} [opts]
 * @returns {{path: string, commitsSince: number, threshold: number}[]}
 */
export function staleProjects(projectPaths, { threshold = DOCS_STALE_THRESHOLD, limit = 0 } = {}) {
  const out = [];
  for (const p of dedupePaths(projectPaths)) {
    let res;
    try {
      res = docsStaleness(p, { threshold });
    } catch {
      continue;
    }
    if (res.stale) {
      out.push({ path: p, commitsSince: res.commitsSince, threshold: res.threshold });
    }
  }
  return sortAndCap(out, limit);
}

/**
 * Async twin of staleProjects, for the board-wide sweep - the version the nudge
 * actually uses, because the sync one blocks the Electron main process.
 *
 * Also reports what could NOT be looked at - and, since the captain's review on
 * 2026-07-28, WHICH ones. "2 of 14 projects couldn't be checked" told him nothing
 * he could act on; a named project with a reason is either fixable or parkable.
 *
 * A folder with no version control is NOT counted here. It is a definite answer
 * (no commits exist, so nothing can be behind), and counting it as a failed look
 * put his notes folder on the board as a permanent unexplained problem.
 *
 * @returns {Promise<{rows: object[], unchecked: number, uncheckedPaths: object[], unversioned: number, considered: number}>}
 */
export async function staleProjectsAsync(projectPaths, { threshold = DOCS_STALE_THRESHOLD, limit = 0 } = {}) {
  const paths = dedupePaths(projectPaths);
  const results = await Promise.all(
    paths.map(async (p) => {
      try {
        return { p, res: await docsStalenessAsync(p, { threshold }) };
      } catch (err) {
        return { p, res: { stale: false, checked: false, reason: firstLine(String(err?.message || err)) } };
      }
    })
  );
  const rows = [];
  const uncheckedPaths = [];
  let unversioned = 0;
  for (const { p, res } of results) {
    if (res.checked && res.hasDocs && !res.versioned) {
      unversioned += 1;
    }
    if (!res.checked) {
      uncheckedPaths.push({ path: p, name: path.basename(p), reason: res.reason || "unknown error" });
    }
    if (res.stale) {
      rows.push({ path: p, commitsSince: res.commitsSince, threshold: res.threshold });
    }
  }
  return {
    rows: sortAndCap(rows, limit),
    unchecked: uncheckedPaths.length,
    uncheckedPaths,
    unversioned,
    considered: paths.length,
  };
}

// How recently you must have worked in a project for its docs drift to be worth a
// nudge. The captain's question, and he was right: "vad händer om jag startar nya projekt
// då och då, då kommer ytterligare en rad per projekt, men gamla projekt försvinner
// aldrig?" The candidate list is every project he has ever had a session in, and an
// ABANDONED project's docs are permanently behind its code - so without this the
// section accumulates a row forever and trains him to stop reading it.
export const DOCS_NUDGE_ACTIVE_DAYS = 60;

/**
 * Decide WHICH projects the sweep should even look at, before spending git calls
 * on them. Separated from main.js so the two rules that decide what he never sees
 * are testable on their own - an invisible filter is the easiest place for a real
 * drifting project to disappear without anyone noticing.
 *
 * @param {{key: string, cwd: string, touchedAt: number}[]} entries - one per project,
 *   `touchedAt` being the newest session activity there (0 = unknown).
 * @param {{parked?: string[], now?: number, activeDays?: number}} [opts] - `parked`
 *   holds lower-cased resolved paths the user has set aside.
 * @returns {{candidates: string[], parked: number, dormant: number}}
 */
export function docsNudgeCandidates(entries, { parked = [], now = Date.now(), activeDays = DOCS_NUDGE_ACTIVE_DAYS } = {}) {
  const parkedSet = new Set((parked || []).map((p) => String(p).toLowerCase()));
  const cutoff = now - activeDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  let dormant = 0;
  // The parked count comes from the PARKED LIST, not from how many parked projects
  // happen to still be candidates. Counting matches would have hidden a parked
  // project whose sessions aged out - and the count is what keeps the footnote, and
  // therefore the only un-park control, on screen (pre-release review).
  const parkedCount = parkedSet.size;
  for (const e of entries || []) {
    if (!e || !e.cwd) {
      continue;
    }
    if (parkedSet.has(String(e.key || e.cwd).toLowerCase())) {
      continue;
    }
    // An UNKNOWN timestamp counts as ACTIVE. A missing lastActivityAt is a gap in
    // the session record, not evidence the project was abandoned, and silently
    // dropping a real drifting project is the worse of the two mistakes.
    if (e.touchedAt && e.touchedAt < cutoff) {
      dormant += 1;
      continue;
    }
    candidates.push(e.cwd);
  }
  return { candidates, parked: parkedCount, dormant };
}

/**
 * Resolve, drop what can't be used, and dedupe case-insensitively: on Windows the
 * same repo shows up as both D:\Repo\... and d:/Repo/... across sessions, and
 * listing one project twice would read as two projects drifting.
 *
 * path.resolve is inside the try because a truthy non-string (a corrupt session
 * record with a numeric cwd) or a NUL byte makes it throw - and one bad entry must
 * not take the whole list with it, which for an attention signal means every
 * drifting project silently disappearing.
 */
function dedupePaths(projectPaths) {
  const seen = new Set();
  const out = [];
  for (const p of projectPaths || []) {
    if (!p || typeof p !== "string") {
      continue;
    }
    let resolved;
    try {
      resolved = path.resolve(p);
    } catch {
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function sortAndCap(rows, limit) {
  rows.sort((a, b) => b.commitsSince - a.commitsSince);
  return limit > 0 ? rows.slice(0, limit) : rows;
}
