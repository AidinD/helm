import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveJotTodosPath } from "./jotDataDir.js";
import { writeFileAtomicSync } from "./atomicWrite.js";

/**
 * Reads and parses Jot's todos.json, tolerating a leading UTF-8 BOM.
 *
 * The on-disk file can carry a BOM (EF BB BF) from having been written by an
 * editor or a legacy external tool, even though Jot's own app writes it
 * without one (see jot's INTEGRATION.md — "UTF-8 without a BOM"). A raw
 * JSON.parse throws on a leading BOM, which previously made loadJot silently
 * fall through to its empty index and disable Helm's whole Jot integration.
 * Stripping the BOM here is the single, shared parse path for every reader in
 * this module. Returns the parsed object, or null on any read/parse failure.
 */
function readJotFile(jotPath) {
  try {
    let raw = fs.readFileSync(jotPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Loads Jot data and builds a per-category work index plus a matcher that
 * associates a session (by title) with a Jot category. All read-only.
 *
 * Returns { ok, path, categories, matchByTitle } where matchByTitle(title)
 * yields the best-matching category work object or null.
 */
export function loadJot(jotConfig = {}) {
  if (jotConfig.enabled === false) {
    return emptyIndex(null);
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  const data = readJotFile(jotPath);
  if (!data) {
    return emptyIndex(jotPath);
  }
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const todos = Array.isArray(data.todos) ? data.todos : [];

  const byId = new Map();
  for (const cat of categories) {
    byId.set(cat.id, {
      id: cat.id,
      name: cat.name,
      color: cat.color || null,
      // Optional absolute folder this list is bound to (Jot's Category.repoPath).
      // When set, it drives a deterministic path match that beats name-matching.
      repoPath: typeof cat.repoPath === "string" && cat.repoPath.trim() ? cat.repoPath.trim() : null,
      // Optional work/private classification set by the user in Jot (1.5.14+
      // W/P chip on the category). Unset on older or never-classified lists,
      // in which case it's neutral, not "unknown" or an error.
      domain: cat.domain === "work" || cat.domain === "private" ? cat.domain : null,
      open: 0,
      inProgress: 0,
      review: 0,
      done: 0,
      total: 0,
      // Lowest priority number among still-active (open/in-progress) work -
      // LOWER = more urgent in Jot's convention. null when nothing is active.
      // Drives the Fleet retire nudge's "critical work still queued" dampening.
      minActivePriority: null,
      // Earliest deadline among this category's still-open work (null if
      // none). Drives deadline-aware attention sorting in sessions.js.
      nearestDeadline: null,
    });
  }
  for (const todo of todos) {
    const entry = byId.get(todo.categoryId);
    if (!entry) {
      continue;
    }
    if (todo.status === "in-progress") {
      entry.inProgress += 1;
    } else if (todo.status === "review") {
      entry.review += 1;
    } else if (todo.status === "open") {
      entry.open += 1;
    } else if (todo.status === "done") {
      entry.done += 1;
    }
    if (todo.status === "open" || todo.status === "in-progress") {
      const pr = typeof todo.priority === "number" ? todo.priority : 0;
      if (entry.minActivePriority === null || pr < entry.minActivePriority) {
        entry.minActivePriority = pr;
      }
    }
    if (todo.status !== "done") {
      entry.total += 1;
      // Only unfinished work's deadline matters — a done task's deadline is
      // history. Track the soonest such deadline (including overdue ones,
      // which are the most urgent, not filtered out).
      if (typeof todo.deadline === "number" && (entry.nearestDeadline === null || todo.deadline < entry.nearestDeadline)) {
        entry.nearestDeadline = todo.deadline;
      }
    }
  }

  const cats = [...byId.values()];
  const overrides = jotConfig.overrides || {}; // { "local_<sessionId>": "CategoryName" }

  function findByName(name) {
    return cats.find((c) => c.name === name) || null;
  }

  // Deterministic path match: a session whose working directory is a
  // category's repoPath — OR sits inside it — belongs to that category, full
  // stop. This is the whole point of Category.repoPath: an explicit, unambiguous
  // binding that doesn't depend on the session title happening to contain the
  // list name. When several categories' repoPaths all contain the cwd (nested
  // repos), the LONGEST (most specific) wins.
  function matchByPath(cwd) {
    const normCwd = normalizePath(cwd);
    if (!normCwd) {
      return null;
    }
    let best = null;
    let bestLen = 0;
    for (const cat of cats) {
      if (!cat.repoPath) {
        continue;
      }
      const normRepo = normalizePath(cat.repoPath);
      if (!normRepo) {
        continue;
      }
      // Exact match, or cwd is a subfolder of repoPath (guard against a prefix
      // that isn't a real path boundary, e.g. ".../foo" vs ".../foobar").
      const isMatch = normCwd === normRepo || normCwd.startsWith(normRepo + "/");
      if (isMatch && normRepo.length > bestLen) {
        best = cat;
        bestLen = normRepo.length;
      }
    }
    return best;
  }

  function matchByName(title) {
    const normTitle = normalize(title);
    if (!normTitle) {
      return null;
    }
    let best = null;
    let bestLen = 0;
    for (const cat of cats) {
      const normCat = normalize(cat.name);
      if (!normCat) {
        continue;
      }
      const hit = normTitle.includes(normCat) || normCat.includes(normTitle);
      // Require a match of at least 3 chars to avoid noise from tiny names.
      if (hit && normCat.length >= 3 && normCat.length > bestLen) {
        best = cat;
        bestLen = normCat.length;
      }
    }
    return best;
  }

  // Precedence: an explicit title override wins, then a deterministic repoPath
  // match against the session's working directory, then the fuzzy name match as
  // a fallback for categories with no repoPath set. `cwd` is optional so older
  // callers (and sessions with no known folder) still get name-based matching.
  function matchByTitle(title, sessionId, cwd) {
    if (sessionId && overrides[sessionId]) {
      return findByName(overrides[sessionId]);
    }
    const byPath = matchByPath(cwd);
    if (byPath) {
      return byPath;
    }
    return matchByName(title);
  }

  return { ok: true, path: jotPath, categories: cats, matchByTitle };
}

function emptyIndex(jotPath) {
  return {
    ok: false,
    path: jotPath,
    categories: [],
    matchByTitle: () => null,
  };
}

// ============================ Context projection ============================
// Helpers that shrink Jot data down to the minimal fields a model/agent
// context actually needs. todos.json carries fields no consumer of model
// context needs at all (images, createdAt, completedAt) and some that are
// only needed by specific consumers (a long description body). Every place
// that turns Jot data into text a model will read should go through one of
// these rather than serializing a raw todo or category object, so adding a
// field to todos.json in the future doesn't silently balloon prompt size.
//
// This is purely about what's READ INTO CONTEXT — it never affects what's
// matched (matchByTitle/matchByPath/matchByName), ranked (loadGoals), or
// written back (addSubtask), which all keep working against the full parsed
// data as before.

// Kept for model context: enough to identify the todo, act on it, and place
// it in the task hierarchy. Dropped: description (can be long free text; a
// consumer that genuinely needs it should read it explicitly, not get it by
// default), images, createdAt, completedAt (irrelevant to "what should I do
// / how is this session's linked work doing").
export function projectTodoForContext(todo) {
  if (!todo) {
    return null;
  }
  return {
    id: todo.id,
    text: todo.text || "",
    status: todo.status || "open",
    priority: typeof todo.priority === "number" ? todo.priority : null,
    categoryId: todo.categoryId ?? null,
    parentId: todo.parentId ?? null,
  };
}

/**
 * Every top-level task currently sitting in "review", with its category name -
 * the input to Helm's review queue (task ce2d19ab).
 *
 * Deliberately DOES carry the task text, unlike the classifier summary above:
 * this feeds a page Aidin reads himself, where the whole point is knowing which
 * item is which. Descriptions are still left out - they hold long free-text notes,
 * and the structured evidence lives in a review record instead (reviewRecords.js).
 *
 * Subtasks are excluded: a subtask in review is part of its parent's story, not a
 * separate thing to sign off.
 */
/**
 * Read-modify-write the Jot board under the same compare-before-swap discipline
 * addSubtask established: both Helm and the Jot app do whole-file writes with no
 * lock, so a naive rename can silently REVERT the other's edit. Stat at read
 * time, re-stat immediately before the atomic rename, and retry from a fresh read
 * if the file moved in our window.
 *
 * Extracted rather than copied (task ce2d19ab needed a second writer, for review
 * actions): a second hand-rolled copy of this loop is exactly how the two writers
 * drift and one of them loses the guard.
 *
 * `mutate(data)` may return { ok: false, error } to abort, or mutate `data` in
 * place and return { ok: true, result }.
 */
export function mutateJotFile(jotPath, mutate) {
  // A CONTENT HASH, not size+mtime. The old guard could not see a same-size edit made
  // inside the read->write window, and that is the common shape of a real concurrent
  // edit from the Jot app: a drag-reorder is a pure array permutation (byte-identical
  // size) and a subtask "open"->"done" is the same length. Windows' ~15.6ms clock tick
  // is also coarser than the window, so mtime often matched too - measured at 250 of
  // 400 same-size writes being invisible. Helm would then rename over the user's edit
  // and report success.
  //
  // The Dropbox-lock retry now lives in atomicWrite.js, shared with the six other
  // durable stores that had the same unprotected rename. This function keeps only what
  // is specific to Jot: read, mutate, and re-check the hash immediately before the
  // rename (the onBeforeRename hook).
  let hashBefore;
  try {
    hashBefore = fileHash(jotPath);
  } catch (err) {
    return { ok: false, error: `Could not read Jot data: ${err.message}` };
  }
  const data = readJotFile(jotPath);
  if (!data || !Array.isArray(data.todos)) {
    return { ok: false, error: "Could not read Jot data." };
  }
  const verdict = mutate(data);
  if (!verdict || verdict.ok === false) {
    return verdict || { ok: false, error: "Refused by the mutator." };
  }
  // No BOM, 2-space, LF - exactly Jot's own writer's output.
  const res = writeFileAtomicSync(jotPath, JSON.stringify(data, null, 2), {
    onBeforeRename: () => (fileHash(jotPath) !== hashBefore ? "the Jot file changed during the write (concurrent edit)" : null),
  });
  if (!res.ok) {
    return { ok: false, error: `Could not write to Jot: ${res.error}` };
  }
  return { ok: true, ...(verdict.result !== undefined ? { result: verdict.result } : {}) };
}

/** Hash of the file's raw bytes - the only reliable "did this change" signal here. */
function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}


const JOT_STATUSES = ["open", "in-progress", "review", "done"];

/**
 * Move a task to another status - the review page's actions (task ce2d19ab).
 *
 * "done" also stamps completedAt, matching what the Jot app itself writes, so a
 * task finished from Helm is indistinguishable from one finished in Jot.
 *
 * `note` is appended to the task's description when given, because a task sent
 * BACK from review without a reason is the thing that wastes the next session
 * (Aidin's own convention: write the reason in the description when parking or
 * bouncing a task).
 */
/**
 * The board exactly as it is on disk - todos, tags and categories, unindexed.
 *
 * loadJot() returns a per-category work INDEX, which is the right shape for the
 * dashboard but throws away the two things the auto-captain needs: each task's tag
 * ids, and each category's folder binding. Returns empty arrays rather than null so
 * a missing or unreadable board reads as "nothing queued", never as an error that
 * would make the loop retry against a file that isn't there.
 */
export function readJotState(jotConfig = {}) {
  if (jotConfig.enabled === false) {
    return { ok: false, todos: [], tags: [], categories: [] };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  const data = readJotFile(jotPath);
  if (!data) {
    return { ok: false, path: jotPath, todos: [], tags: [], categories: [] };
  }
  return {
    ok: true,
    path: jotPath,
    todos: Array.isArray(data.todos) ? data.todos : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    categories: Array.isArray(data.categories) ? data.categories : [],
  };
}

/**
 * Add and/or remove tags on a task, creating any tag that doesn't exist yet.
 *
 * The auto-captain's whole state lives in tags (`auto` is the trigger the user
 * sets; `needs-clarification` and `auto-running` are what Helm writes back), so
 * this is how the board learns what the automation did. Tags are matched by NAME,
 * case-insensitively, which is what lets Helm and Jot agree without a schema change.
 *
 * `note` is appended to the description, because a tag alone tells the user that
 * something was refused but not what to do about it.
 *
 * @param {{path?: string}} jotConfig
 * @param {string} taskId
 * @param {{add?: string[], remove?: string[], note?: string, status?: string}} changes
 */
/**
 * Make sure the auto-captain's tags exist on the board, with a colour and a
 * description like every tag Aidin made by hand.
 *
 * Without this the feature is unreachable: `auto` is the tag HE applies, and it
 * was never created by anything, so there was nothing to pick in Jot (Aidin,
 * 2026-08-02: "det finns ingen auto tag"). setTaskTags creates a missing tag on
 * the fly, but only for the two Helm writes back - and it creates them bare,
 * with no colour and no description, which reads as junk next to his own.
 *
 * Idempotent and name-matched case-insensitively, so it can run every startup:
 * an existing tag is left exactly as it is, including a colour he changed.
 * Returns { ok, added: [names] }.
 */
export function ensureTagsExist(jotConfig = {}, specs = []) {
  if (jotConfig.enabled === false || specs.length === 0) {
    return { ok: true, added: [] };
  }
  const state = readJotState(jotConfig);
  if (!state.ok) {
    return { ok: false, added: [], error: "No Jot board to add tags to." };
  }
  const has = (name) => state.tags.some((t) => (t.name || "").toLowerCase() === String(name).toLowerCase());
  const missing = specs.filter((s) => !has(s.name));
  if (missing.length === 0) {
    // Nothing to add. Return WITHOUT writing: this runs at every startup, and
    // rewriting a file the Jot app may have open, to change nothing, is how you
    // lose someone else's concurrent edit for no reason at all.
    return { ok: true, added: [] };
  }
  const res = mutateJotFile(state.path, (data) => {
    if (!Array.isArray(data.tags)) {
      data.tags = [];
    }
    for (const spec of missing) {
      // Re-check inside the mutation: the board was re-read here, and Jot may
      // have created the tag in between.
      if (data.tags.some((t) => (t.name || "").toLowerCase() === String(spec.name).toLowerCase())) {
        continue;
      }
      data.tags.push({
        id: crypto.randomUUID(),
        name: spec.name,
        color: spec.color,
        description: spec.description,
        // Jot's own field (TagEmphasis): "stripe" marks the whole row/card, not
        // just the chip. Written only on CREATE - re-asserting it every launch
        // would undo a choice made in Jot's tag manager, which is the
        // can-create-but-cannot-reverse shape we keep getting wrong.
        emphasis: spec.emphasis || null,
      });
    }
    return { ok: true, result: {} };
  });
  return res.ok
    ? { ok: true, added: missing.map((s) => s.name) }
    : { ok: false, added: [], error: res.error };
}

export function setTaskTags(jotConfig, taskId, { add = [], remove = [], note = "", status = null } = {}) {
  if (!taskId) {
    return { ok: false, error: "Missing task id." };
  }
  if (status && !JOT_STATUSES.includes(status)) {
    return { ok: false, error: `Unknown status "${status}".` };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  return mutateJotFile(jotPath, (data) => {
    const todo = data.todos.find((t) => t.id === taskId);
    if (!todo) {
      return { ok: false, error: "Task not found on the board." };
    }
    if (!Array.isArray(data.tags)) {
      data.tags = [];
    }
    const idFor = (name) => {
      const lower = String(name).toLowerCase();
      const found = data.tags.find((t) => (t.name || "").toLowerCase() === lower);
      if (found) {
        return found.id;
      }
      const created = { id: crypto.randomUUID(), name: String(name) };
      data.tags.push(created);
      return created.id;
    };
    const removeIds = new Set(
      remove
        .map((n) => {
          const lower = String(n).toLowerCase();
          const found = data.tags.find((t) => (t.name || "").toLowerCase() === lower);
          return found ? found.id : null;
        })
        .filter(Boolean)
    );
    const next = new Set((todo.tags || []).filter((id) => !removeIds.has(id)));
    for (const name of add) {
      next.add(idFor(name));
    }
    todo.tags = [...next];
    if (status) {
      todo.status = status;
      todo.completedAt = status === "done" ? Date.now() : null;
    }
    const trimmed = String(note || "").trim();
    if (trimmed) {
      todo.description = `${todo.description || ""}${todo.description ? "\n\n" : ""}${trimmed}`;
    }
    todo.updatedAt = Date.now();
    return { ok: true, result: { tags: todo.tags, status: todo.status } };
  });
}

export function setTaskStatus(jotConfig, taskId, status, note = "") {
  if (!taskId) {
    return { ok: false, error: "Missing task id." };
  }
  if (!JOT_STATUSES.includes(status)) {
    return { ok: false, error: `Unknown status "${status}".` };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  return mutateJotFile(jotPath, (data) => {
    const todo = data.todos.find((t) => t.id === taskId);
    if (!todo) {
      return { ok: false, error: "Task not found on the board." };
    }
    const from = todo.status;
    todo.status = status;
    todo.updatedAt = Date.now();
    todo.completedAt = status === "done" ? Date.now() : null;
    const trimmed = String(note || "").trim();
    if (trimmed) {
      todo.description = `${todo.description || ""}${todo.description ? "\n\n" : ""}${trimmed}`;
    }
    return { ok: true, result: { from, to: status } };
  });
}

/**
 * Tasks that reached `done` recently with NO review record - the audit half.
 *
 * The Review page is not the only writer of the board: agents write todos.json
 * directly (a documented workflow), the embedded Jot tab and the Jot app can drag a
 * card straight to done, and setTaskStatus validates only the status string. So "I
 * only look at the Review page" is safe only while every agent voluntarily stops at
 * `review`. Under time pressure, "I'll just mark it done, it's trivial" is the
 * cheapest escape and it left no trace anywhere.
 *
 * A direct write cannot be PREVENTED from here, only DETECTED - which is why this
 * matters more than any additional gate.
 *
 * @param {(taskId: string) => boolean} hasRecord
 */
export function signedOffWithoutRecord(jotConfig = {}, hasRecord, { withinMs = 14 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  if (jotConfig.enabled === false) {
    return { ok: false, error: "Jot is disabled in config", tasks: [] };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  const data = readJotFile(jotPath);
  if (!data) {
    return { ok: false, error: `Couldn't read the Jot board at ${jotPath}`, tasks: [] };
  }
  const catName = new Map((Array.isArray(data.categories) ? data.categories : []).map((c) => [c.id, c.name]));
  const tasks = (Array.isArray(data.todos) ? data.todos : [])
    .filter((t) => {
      if (!t || t.status !== "done") {
        return false;
      }
      // Only recent ones: the whole history would be noise, and this is a signal about
      // current practice. A done task with no completedAt is included - a missing
      // timestamp is itself a sign it was not moved through the flow.
      const at = typeof t.completedAt === "number" ? t.completedAt : null;
      if (at !== null && now - at > withinMs) {
        return false;
      }
      return !hasRecord(t.id);
    })
    .map((t) => ({
      id: t.id,
      title: t.text || "",
      category: catName.get(t.categoryId) || null,
      completedAt: typeof t.completedAt === "number" ? t.completedAt : null,
    }))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return { ok: true, path: jotPath, tasks };
}

export function reviewTasks(jotConfig = {}) {
  // Reads the board file directly, the same way loadGoals does. NOTE: loadJot()
  // is a category INDEX (ok/path/categories/matchByTitle) and carries no todos -
  // going through it silently returned an empty queue.
  if (jotConfig.enabled === false) {
    return { ok: false, error: "Jot is disabled in config", tasks: [] };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  const data = readJotFile(jotPath);
  if (!data) {
    return { ok: false, error: `Couldn't read the Jot board at ${jotPath}`, tasks: [] };
  }
  const catName = new Map((Array.isArray(data.categories) ? data.categories : []).map((c) => [c.id, c.name]));
  const byId = new Map((Array.isArray(data.todos) ? data.todos : []).map((t) => [t.id, t]));
  // Subtasks in review are INCLUDED. They used to be filtered out (`!t.parentId`), so
  // a subtask sitting in review was invisible to the Review page, needed no record and
  // raised no badge - and Aidin's own convention uses epics with subtasks, so that hole
  // opens itself the first time an epic is worked. The parent's title comes along so a
  // subtask row still reads as belonging somewhere.
  const tasks = (Array.isArray(data.todos) ? data.todos : [])
    .filter((t) => t && t.status === "review")
    .map((t) => ({
      id: t.id,
      title: t.text || "",
      priority: typeof t.priority === "number" ? t.priority : null,
      category: catName.get(t.categoryId) || null,
      // Carried so the review queue can compare the record's snapshotted
      // acceptance criteria against the ones on the task RIGHT NOW - a criterion
      // edited after the work must be surfaced, not silently ignored.
      description: t.description || "",
      parentTitle: t.parentId ? byId.get(t.parentId)?.text || "(unknown parent)" : null,
    }));
  return { ok: true, path: jotPath, tasks };
}

/**
 * Builds the one-line Jot summary the orchestrator helper's classifier prompt
 * embeds for a session (see orchestratorHelper.js's classifySessionStatus).
 * Takes the small per-session aggregate enrichWithJot already computed
 * (session.jot: { category, open, inProgress, review, ... }), not raw todos —
 * the classifier only ever needs "which list, how much open/in-progress/
 * review work," never individual todo text or descriptions. Returns null when
 * the session has no matched Jot category.
 */
export function formatJotSummaryForClassifier(sessionJot) {
  if (!sessionJot) {
    return null;
  }
  const parts = [
    sessionJot.review > 0 ? `${sessionJot.review} review` : null,
    sessionJot.inProgress > 0 ? `${sessionJot.inProgress} in progress` : null,
    sessionJot.open > 0 ? `${sessionJot.open} open` : null,
  ].filter(Boolean);
  return `${sessionJot.category} (${parts.join(", ") || "no open items"})`;
}

/**
 * Per-project Jot board summary for the Fleet's retire nudge (trigger layer 3).
 * Maps each project path to its Jot category (deterministic repoPath match) and
 * reports the active work there: open/in-progress counts + the lowest active
 * priority (LOWER = more urgent). The renderer uses this to strengthen the
 * "work wrapped" nudge when a mate's boards are clear, and to DAMPEN it (not
 * suggest retiring) when an urgent task is still queued. A path with no matching
 * category is { matched: false } - neutral, not an error.
 */
export function projectBoardSummary(projectPaths, jotConfig = {}) {
  const idx = loadJot(jotConfig);
  const out = {};
  for (const p of projectPaths || []) {
    const cat = idx.ok ? idx.matchByTitle("", null, p) : null;
    out[p] = cat
      ? { matched: true, category: cat.name, open: cat.open, inProgress: cat.inProgress, minActivePriority: cat.minActivePriority }
      : { matched: false, open: 0, inProgress: 0, minActivePriority: null };
  }
  return out;
}

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9åäö]/g, "");
}

// Canonicalizes a filesystem path for comparison: forward slashes, no trailing
// slash, lowercased. Windows paths are case-insensitive and mix separators
// (D:\Repo vs D:/repo), so both must fold to one form before comparing a
// session's cwd against a category's repoPath. Returns "" for empty input.
function normalizePath(p) {
  const s = String(p || "").trim();
  if (!s) {
    return "";
  }
  return s
    .replace(/[\\/]+/g, "/") // backslashes and doubled slashes -> single forward slash
    .replace(/\/+$/, "") // drop any trailing slash
    .toLowerCase();
}

// ============================ Goal focus (Point 8) ============================
// A goal-to-tasks focus view, backed by Jot (not a second task system). This
// reads the SAME todos.json the rest of this module reads and ranks the user's
// active GOALS — top-level todos (parentId === null) that are open or
// in-progress — by an attention/priority score, so the question "of my several
// active goals, which should I work on now?" has an answer. Read-only.

// Default scoring weights for goal ranking. Kept in the same spirit as
// sessions.js's DEFAULT_WEIGHTS (which scores SESSIONS): a deadline bearing
// down and in-progress work are the strongest "look at this" signals. These
// are goal-level analogues, not the same numbers, because a goal has no
// conversation status to blend in — only its own status, priority, deadline,
// and subtask progress.
const GOAL_WEIGHTS = {
  inProgress: 60, // the goal itself is in-progress — actively being worked
  deadline: 80, // MAX deadline boost, scaled by urgency (mirrors sessions.js)
  priorityMax: 40, // MAX boost from Jot priority (lower number = more urgent)
  hasSubtasks: 10, // an epic (a goal broken into subtasks) is a real, scoped plan
  reviewSubtask: 12, // per subtask sitting in "review" — awaiting the user's check
};

// Urgency boost from how soon (or how overdue) a goal's deadline is. Byte-for-
// byte the same tiering sessions.js's deadlineBoost uses, replicated here
// rather than imported so this Point 8 addition stays isolated to jot.js and
// doesn't have to change sessions.js's export surface (which other in-flight
// work also edits). If these ever need to diverge, they can; today they agree
// on purpose.
function goalDeadlineBoost(deadline, maxWeight, now) {
  if (typeof deadline !== "number") {
    return 0;
  }
  const msLeft = deadline - now;
  const DAY = 24 * 60 * 60 * 1000;
  if (msLeft < 0) {
    return maxWeight; // overdue — most urgent
  }
  if (msLeft < DAY) {
    return maxWeight * 0.75;
  }
  if (msLeft < 3 * DAY) {
    return maxWeight * 0.45;
  }
  if (msLeft < 7 * DAY) {
    return maxWeight * 0.2;
  }
  return 0;
}

// Jot priority: LOWER number = more urgent (negative/0 before higher). Map it
// to a bounded boost so a very urgent goal (priority <= 0) scores highest and
// a low-priority backlog goal (large number) scores near zero, without letting
// an extreme priority value dominate every other signal.
function priorityBoost(priority, maxWeight) {
  if (typeof priority !== "number") {
    return 0;
  }
  if (priority <= 0) {
    return maxWeight;
  }
  // Decay: 1 -> ~0.8x, 3 -> 0.5x, 7 -> ~0.3x, large -> ~0. Smooth, bounded.
  return maxWeight * (2 / (2 + priority));
}

/**
 * Loads Jot and returns the user's active GOALS, ranked by attention/priority
 * score (highest first). A "goal" is a top-level todo (parentId === null) whose
 * status is open or in-progress — the things actually worth choosing between
 * right now. Each goal carries its category, priority, deadline, and subtask
 * progress (done / total), plus its own subtasks so the breakdown view can show
 * them without a second read.
 *
 * Read-only. Returns { ok, path, goals } where goals is the ranked array; on a
 * missing/unparseable file returns { ok:false, path, goals: [] }.
 */
export function loadGoals(jotConfig = {}) {
  if (jotConfig.enabled === false) {
    return { ok: false, path: null, goals: [] };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  const data = readJotFile(jotPath);
  if (!data) {
    return { ok: false, path: jotPath, goals: [] };
  }
  const todos = Array.isArray(data.todos) ? data.todos : [];
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const catById = new Map(categories.map((c) => [c.id, c]));

  // Group subtasks by their parentId (Jot nests exactly one level deep — a
  // subtask has a parentId; nothing has a grandparent).
  const subtasksByParent = new Map();
  for (const todo of todos) {
    if (todo.parentId) {
      const list = subtasksByParent.get(todo.parentId) || [];
      list.push(todo);
      subtasksByParent.set(todo.parentId, list);
    }
  }

  const now = Date.now();
  const goals = [];
  for (const todo of todos) {
    if (todo.parentId) {
      continue; // subtasks are shown UNDER their goal, never as goals themselves
    }
    if (todo.status !== "open" && todo.status !== "in-progress") {
      continue; // only active goals compete for focus (review/done are not "work on now")
    }
    const rawSubtasks = subtasksByParent.get(todo.id) || [];
    const subtasks = rawSubtasks
      .map((s) => ({
        id: s.id,
        text: s.text || "",
        status: s.status || "open",
        priority: typeof s.priority === "number" ? s.priority : null,
        deadline: typeof s.deadline === "number" ? s.deadline : null,
      }))
      // Show a stable, sensible order: by priority (lower first), then creation.
      .sort((a, b) => {
        const ap = a.priority ?? Number.POSITIVE_INFINITY;
        const bp = b.priority ?? Number.POSITIVE_INFINITY;
        return ap - bp;
      });
    const subtaskTotal = subtasks.length;
    const subtaskDone = subtasks.filter((s) => s.status === "done").length;
    const subtaskReview = subtasks.filter((s) => s.status === "review").length;
    const cat = catById.get(todo.categoryId) || null;

    let score = 0;
    if (todo.status === "in-progress") {
      score += GOAL_WEIGHTS.inProgress;
    }
    score += goalDeadlineBoost(typeof todo.deadline === "number" ? todo.deadline : null, GOAL_WEIGHTS.deadline, now);
    score += priorityBoost(typeof todo.priority === "number" ? todo.priority : null, GOAL_WEIGHTS.priorityMax);
    if (subtaskTotal > 0) {
      score += GOAL_WEIGHTS.hasSubtasks;
      score += subtaskReview * GOAL_WEIGHTS.reviewSubtask;
    }

    goals.push({
      id: todo.id,
      text: todo.text || "",
      status: todo.status,
      description: todo.description || "",
      priority: typeof todo.priority === "number" ? todo.priority : null,
      deadline: typeof todo.deadline === "number" ? todo.deadline : null,
      category: cat ? cat.name : null,
      color: cat ? cat.color || null : null,
      // Real work/private classification from the owning category (Jot's
      // Category.domain), not a guess. null when the category has none set,
      // which is a neutral goal - shown in both Focus modes, never dimmed.
      domain: cat && (cat.domain === "work" || cat.domain === "private") ? cat.domain : null,
      isEpic: subtaskTotal > 0,
      subtaskDone,
      subtaskTotal,
      subtaskReview,
      subtasks,
      attentionScore: Math.round(score),
    });
  }

  goals.sort((a, b) => {
    if (b.attentionScore !== a.attentionScore) {
      return b.attentionScore - a.attentionScore;
    }
    // Tie-break: lower priority number is more urgent, then in-progress first.
    const ap = a.priority ?? Number.POSITIVE_INFINITY;
    const bp = b.priority ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) {
      return ap - bp;
    }
    if (a.status !== b.status) {
      return a.status === "in-progress" ? -1 : 1;
    }
    return 0;
  });

  return { ok: true, path: jotPath, goals };
}

/**
 * Adds a new subtask under an existing top-level goal, writing back to
 * todos.json. This is the ONE write this module performs, and it follows the
 * exact discipline the rest of the codebase uses for editing files another app
 * live-owns (see sessions.js's patchSessionMeta and jot's own INTEGRATION.md
 * "Safe write flow"): re-read the FRESHEST file immediately before writing (so
 * a concurrent edit from the Jot app itself isn't clobbered by a stale
 * in-memory copy), apply a minimal targeted change (append one todo — never a
 * blind whole-file overwrite of remembered state), then write via a temp file
 * + atomic rename so an interrupted write can never leave todos.json torn.
 *
 * Writes UTF-8 WITHOUT a BOM and standard 2-space JSON — byte-for-byte the same
 * shape Jot's own app writer produces (JSON.stringify(state, null, 2), utf-8;
 * confirmed in jot's storage.ts) — so the file Helm leaves behind is
 * indistinguishable from one Jot wrote itself. Jot reloads on any content
 * change and compares parsed JSON, so whitespace normalization is safe.
 *
 * Guards: refuses if the file can't be read/parsed, if parentId doesn't match
 * an existing TOP-LEVEL todo (won't nest under a subtask — Jot is one level
 * deep), or if text is empty. Returns { ok, id? } | { ok:false, error }.
 */
export function addSubtask(jotConfig, parentId, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Subtask text is empty." };
  }
  if (!parentId) {
    return { ok: false, error: "Missing parent goal id." };
  }
  const jotPath = jotConfig.path || resolveJotTodosPath();
  let newId = null;
  const res = mutateJotFile(jotPath, (data) => {
    const parent = data.todos.find((t) => t.id === parentId);
    if (!parent) {
      return { ok: false, error: "Parent goal not found." };
    }
    if (parent.parentId) {
      // Jot nests exactly one level; refuse to create a grandchild.
      return { ok: false, error: "Cannot add a subtask under a subtask." };
    }
    newId = crypto.randomUUID();
    data.todos.push({
      id: newId,
      text: trimmed,
      status: "open",
      description: "",
      images: [],
      // Subtasks inherit the parent's category (verified data-model behavior).
      categoryId: parent.categoryId ?? null,
      tags: [],
      // Sensible default priority so it neither jumps the queue nor sinks; the
      // user can reprioritize in Jot. 0 matches Jot's own "no explicit priority"
      // baseline for a freshly added item.
      priority: 0,
      deadline: null,
      parentId: parentId,
      createdAt: Date.now(),
      completedAt: null,
    });
    return { ok: true };
  });
  return res.ok ? { ok: true, id: newId } : res;
}
