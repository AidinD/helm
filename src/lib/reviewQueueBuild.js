import fs from "node:fs";
import path from "node:path";
import { reviewTasks, signedOffWithoutRecord, allTaskShortIds } from "./jot.js";
import { listReviewRecords, buildReviewQueue, reviewQueueTally } from "./reviewRecords.js";
import { readAllSessions } from "./sessions.js";
import { resolveTaskCommitsBatch } from "./reviewDiff.js";
import { listUnboundCommits, initialWatermark, makeIsBound, projectKey } from "./commitReview.js";
import { loadGoalRunHistory } from "./goalRunHistory.js";
import { normalizeFsPath } from "./fsPath.js";
import { candidateCommitsByRepo } from "./commitCandidates.js";

/**
 * The whole review queue, computed WITHOUT electron.
 *
 * This was main.js's buildReviewsPayload. It is here because it is the single most
 * expensive thing Helm does - measured at ~1.4s even after the phase-1 git batching, on
 * the captain's real board - and the main process is the one thread that also has to answer
 * every other IPC and keep the window responsive. Code that cannot import electron can
 * run in a utility process (see worker/heavy.mjs), and that is the only way "the app
 * freezes while it thinks" stops being one refactor away from coming back.
 *
 * Two rules make it safe to run off-main:
 *
 *   1. NOTHING here writes. The commit-review watermarks it discovers are RETURNED, not
 *      persisted - main is the single writer of config.json, and two processes writing it
 *      is a corrupted-config race, not a perf trade.
 *   2. metaHome is passed in, because resolving it needs app.isPackaged.
 *
 * @param {object} input
 * @param {string} input.metaHome resolved by the caller (needs electron, so not done here).
 * @param {object} input.config   the loaded Helm config.
 * @returns {{payload: object, watermarks: object|null}} watermarks is non-null ONLY when a
 *          project was seen for the first time and the caller must persist the new baseline.
 */
export function buildReviewQueuePayload({ metaHome, config }) {
  const board = reviewTasks(config.jot || {});
  // metaHome is threaded in so the queue can VERIFY that each check run was stamped
  // by the app rather than written into the record by hand.
  const records = listReviewRecords(metaHome);
  const rows = buildReviewQueue(board.tasks, records, metaHome);
  // Read the session index ONCE and thread it to both consumers (repo-rooting and the
  // unbound-commit scan), rather than each tailing every transcript separately.
  const allSessions = readAllSessions()?.sessions || [];
  const goalRuns = loadGoalRunHistory();
  const roots = repoRootedCategories(records, allSessions, goalRuns);
  // An auto-completed task with no record still knows its project: the goal run that
  // produced it recorded projectPath against its autoTaskId. This is the most reliable
  // repo source for exactly the cards that would otherwise be a dead end (no record, no
  // category binding), so the diff / independent-reviewer actions can still root.
  const autoRunProject = new Map();
  for (const r of goalRuns) {
    if (r?.autoTaskId && r.projectPath && !autoRunProject.has(r.autoTaskId)) {
      autoRunProject.set(r.autoTaskId, r.projectPath);
    }
  }
  for (const row of rows) {
    // Jot's explicit per-board folder binding (Category.repoPath) is authoritative when
    // set; the fuzzy category-name-to-cwd guess is only a fallback. That guess reliably
    // resolved for helm alone - helm is the meta-home and never appears as a session cwd,
    // so it was backfilled from review records - which left every other board's rows with
    // no repoPath and dropped from the default repo-rooted view (task 75a01d5d: "Review
    // verkar bara göra ordentliga reviews för helm").
    row.repoPath = row.categoryRepoPath || roots.repoFor(row.category) || autoRunProject.get(row.taskId) || null;
  }
  // Whether ANY commit is tied to each task - from the record, or (failing that) a log
  // search for its short id. Cards are meant to be bound to commits (the captain: "har ingen
  // commit gjorts så behövs inget kort"); this is the fact the page filters on, computed
  // here rather than the renderer because it needs git.
  //
  // ONE git call per repo, not one per row: a git process costs ~70ms of startup on
  // Windows before doing any work, and 21 rows measured 2193ms that way against 114ms
  // batched. Grouped on the NORMALIZED path so the same repo spelled `D:\Repo\...` by one
  // source and `D:/Repo/...` by another is one group and not two (both were live on his
  // board).
  const searchByRepo = new Map();
  for (const row of rows) {
    if (!row.repoPath || (row.record?.commits || []).length > 0) {
      continue;
    }
    const key = normalizeFsPath(row.repoPath);
    if (searchByRepo.has(key)) {
      searchByRepo.get(key).taskIds.push(row.taskId);
    } else {
      searchByRepo.set(key, { projectPath: row.repoPath, taskIds: [row.taskId] });
    }
  }
  const searchResults = new Map();
  for (const { projectPath, taskIds } of searchByRepo.values()) {
    for (const [taskId, result] of resolveTaskCommitsBatch(projectPath, taskIds)) {
      searchResults.set(taskId, result);
    }
  }
  for (const row of rows) {
    const recCommits = row.record?.commits || [];
    row.hasCommits = recCommits.length > 0 || (searchResults.get(row.taskId)?.commits.length || 0) > 0;
  }

  // For a row that belongs to a repo but names no commits, the commits it is PROBABLY
  // about. Not a binding and never presented as one - see commitCandidates.js for the
  // measurement that made this necessary and for why matching on the words is not an
  // option here. Without it those rows are hidden outright, and on the real board that
  // was five of the six repo-rooted cards.
  const claimed = new Set();
  for (const rec of records) {
    for (const c of rec.commits || []) {
      const sha = typeof c === "string" ? c : c?.sha;
      if (sha) {
        claimed.add(String(sha).trim().split(/\s+/)[0]);
      }
    }
  }
  for (const [, result] of searchResults) {
    for (const c of result?.commits || []) {
      const sha = typeof c === "string" ? c : c?.sha;
      if (sha) {
        claimed.add(sha);
      }
    }
  }
  const candidatesByRepo = new Map();
  for (const row of rows) {
    if (!row.repoPath || row.hasCommits) {
      continue;
    }
    const key = normalizeFsPath(row.repoPath);
    if (!candidatesByRepo.has(key)) {
      candidatesByRepo.set(key, { projectPath: row.repoPath, tasks: [] });
    }
    candidatesByRepo.get(key).tasks.push({ taskId: row.taskId, createdAt: row.createdAt });
  }
  const candidateResults = new Map();
  for (const { projectPath, tasks } of candidatesByRepo.values()) {
    for (const [taskId, result] of candidateCommitsByRepo(projectPath, tasks, { claimed })) {
      candidateResults.set(taskId, result);
    }
  }
  for (const row of rows) {
    const found = candidateResults.get(row.taskId);
    row.candidateCommits = found?.commits || [];
    row.candidateMore = found?.more || 0;
  }
  // The audit half: work that reached done without ever being recorded. A direct
  // board write cannot be prevented from here, only detected - and it has to surface
  // on the page he actually reads.
  const haveRecord = new Set(records.map((r) => String(r.taskId).toLowerCase()));
  // A task counts as "handled" if it has a record OR the captain has acknowledged it. The
  // audit's job is to tell him something bypassed review; once he has SEEN that,
  // repeating it for a fortnight just teaches him to skim the section (his review,
  // 2026-07-28: "när du sett dem en gång blir de bara tjat"). Acknowledging does not
  // create evidence and does not claim the work was reviewed - it only records that he
  // knows, which is the whole purpose of the signal.
  const acked = new Set((config.acknowledgedNoRecord || []).map((id) => String(id).toLowerCase()));
  const unrecordedDone = signedOffWithoutRecord(
    config.jot || {},
    (id) => haveRecord.has(String(id).toLowerCase()) || acked.has(String(id).toLowerCase())
  );
  const unbound = collectUnboundCommits({ records, rows, sessions: allSessions, goalRuns, config });
  return {
    payload: {
      ok: board.ok,
      error: board.error || null,
      rows,
      tally: reviewQueueTally(rows),
      doneWithoutRecord: unrecordedDone.ok ? unrecordedDone.tasks : [],
      // Commits per project not tied to any Jot task, so review works even without a Jot board.
      unboundCommits: unbound.sections,
    },
    watermarks: unbound.watermarks,
  };
}

/**
 * Which Jot categories correspond to an actual code repo, and where it lives.
 *
 * "endast visa saker i review som faktiskt är rootade till ett repo - potentiella
 * kodändringar är de enda som behöver reviewas" (the captain, 2026-08-04). His private
 * board and his life-domain boards were filling the queue with rows that have no
 * code to review.
 *
 * THREE sources, because session cwds alone are not enough and getting this wrong is
 * the expensive direction. Measured against his real board: the "Helm" category came
 * back NOT A REPO, which would have hidden his own Helm work behind the code-only
 * filter by default - because he runs Helm's sessions from the meta-home, so
 * D:\Repo\Tools\helm never appears as a session cwd at all.
 *
 *   1. review records' projectPath - authoritative: a record names its own repo, and
 *      that field is now required whenever the record declares checks.
 *   2. goal-run history projectPaths - every project an autonomous run has touched.
 *   3. session cwds - projects opened by hand.
 *
 * The match is loose in ONE direction on purpose: a board named "Skiff" belongs to the
 * repo folder `nw-skiff`, so a containment test is used rather than equality. Being
 * too generous here shows an extra row; being too strict HIDES work that needed
 * reviewing, and that is the expensive mistake.
 */
export function repoRootedCategories(records = [], sessions = [], goalRuns = null) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const repos = new Map(); // normalized folder name -> absolute path
  const candidates = [
    ...records.map((r) => r.projectPath),
    ...(goalRuns || loadGoalRunHistory()).map((r) => r.projectPath),
    ...sessions.map((s) => s.cwd),
  ];
  for (const cwd of new Set(candidates.filter(Boolean))) {
    try {
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        continue;
      }
    } catch {
      continue;
    }
    const name = norm(path.basename(cwd));
    if (name && !repos.has(name)) {
      repos.set(name, cwd);
    }
  }
  return {
    /** The repo a category belongs to, or null when it is not code work at all. */
    repoFor(category) {
      const c = norm(category);
      if (!c) {
        return null;
      }
      if (repos.has(c)) {
        return repos.get(c);
      }
      for (const [name, cwd] of repos) {
        if (name.includes(c) || c.includes(name)) {
          return cwd;
        }
      }
      return null;
    },
  };
}

/**
 * Commit-centric review source: for every git project Helm knows, the commits NOT bound to
 * a Jot task, so work done in a project without a Jot board (a session against Halyard
 * with a GitHub board) still lands in review. Bound commits (sha in a record's `commits`, or
 * a task short id in the subject) roll up under their task's row and are excluded. Bounded
 * per project by a stored watermark - only commits after it surface - which is initialized
 * to the mainline/upstream baseline on first sight (so un-integrated work shows immediately
 * without flooding the whole history) and advanced by acknowledging a commit.
 *
 * Returns the new watermark map instead of writing it. This function used to call
 * writeConfig itself, which is exactly what stopped the review build from being movable
 * off the main process: config.json has ONE writer, and it is main.
 */
function collectUnboundCommits({ records, rows, sessions, goalRuns, config }) {
  try {
    const stored = config.commitReviewWatermarks || {};
    const watermarks = { ...stored };
    let changed = false;
    // Known git projects: the same sources repo-rooting uses, plus the explicit Jot category
    // bindings already resolved onto the rows. Keyed by projectKey so a repo referenced under
    // two path spellings is ONE project with one watermark (not two duplicate sections).
    // Sessions are passed in (already loaded once by the caller) so this doesn't re-tail every
    // transcript a second time per payload build.
    const byKey = new Map(); // projectKey -> display path (first spelling seen)
    for (const p of [
      ...records.map((r) => r.projectPath),
      ...(goalRuns || []).map((r) => r.projectPath),
      ...(sessions || []).map((s) => s.cwd),
      ...rows.map((r) => r.repoPath),
    ]) {
      if (!p) {
        continue;
      }
      let abs;
      try {
        abs = path.resolve(p);
      } catch {
        continue;
      }
      const key = projectKey(abs);
      if (byKey.has(key)) {
        continue;
      }
      try {
        if (fs.existsSync(path.join(abs, ".git"))) {
          byKey.set(key, abs);
        }
      } catch {
        // unreadable path - skip
      }
    }
    if (byKey.size === 0) {
      return { sections: [], watermarks: null };
    }
    const recordCommitShas = records.flatMap((r) =>
      (r.commits || []).map((c) => (typeof c === "string" ? c : c?.sha)).filter(Boolean)
    );
    // ALL task ids (any status), so a commit naming a task that is still in-progress/open is
    // recognised as bound rather than mislabelled "no task" (ship-review finding).
    const taskShortIds = allTaskShortIds(config.jot || {});
    const isBound = makeIsBound({ recordCommitShas, taskShortIds });
    const out = [];
    for (const [key, projectPath] of byKey) {
      let watermark = watermarks[key];
      if (watermark === undefined) {
        // First sight: stamp the baseline. Stored even when null (a small repo with no
        // mainline) so it is not recomputed on every payload build.
        watermark = initialWatermark(projectPath);
        watermarks[key] = watermark;
        changed = true;
      }
      const acks = (config.commitReviewAcks && config.commitReviewAcks[key]) || [];
      const commits = listUnboundCommits(projectPath, { watermark, acks, isBound });
      if (commits.length > 0) {
        out.push({ projectPath, projectName: path.basename(projectPath), commits });
      }
    }
    return { sections: out, watermarks: changed ? watermarks : null };
  } catch (err) {
    console.error("[helm] collectUnboundCommits failed:", err);
    return { sections: [], watermarks: null };
  }
}
