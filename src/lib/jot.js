import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_JOT_PATH = "D:\\Dropbox\\jot\\todos.json";

/**
 * Reads and parses Jot's todos.json, tolerating a leading UTF-8 BOM.
 *
 * The on-disk file can carry a BOM (EF BB BF) from having been written by an
 * editor or a legacy external tool, even though Jot's own app writes it
 * without one (see jot's INTEGRATION.md — "UTF-8 without a BOM"). A raw
 * JSON.parse throws on a leading BOM, which previously made loadJot silently
 * fall through to its empty index and disable Maestro's whole Jot integration.
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
  const jotPath = jotConfig.path || DEFAULT_JOT_PATH;
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
      open: 0,
      inProgress: 0,
      review: 0,
      done: 0,
      total: 0,
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

  function matchByTitle(title, sessionId) {
    if (sessionId && overrides[sessionId]) {
      return findByName(overrides[sessionId]);
    }
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

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9åäö]/g, "");
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
  const jotPath = jotConfig.path || DEFAULT_JOT_PATH;
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
 * confirmed in jot's storage.ts) — so the file Maestro leaves behind is
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
  const jotPath = jotConfig.path || DEFAULT_JOT_PATH;

  // Re-read the freshest version RIGHT before writing — never trust an earlier
  // in-memory snapshot. This is the whole point of the safe-write flow: the
  // Jot app may have flushed its own edit since Maestro last read the file.
  const data = readJotFile(jotPath);
  if (!data || !Array.isArray(data.todos)) {
    return { ok: false, error: "Could not read Jot data." };
  }
  const parent = data.todos.find((t) => t.id === parentId);
  if (!parent) {
    return { ok: false, error: "Parent goal not found." };
  }
  if (parent.parentId) {
    // Jot nests exactly one level; refuse to create a grandchild.
    return { ok: false, error: "Cannot add a subtask under a subtask." };
  }

  const newTodo = {
    id: crypto.randomUUID(),
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
  };
  data.todos.push(newTodo);

  const dir = path.dirname(jotPath);
  const base = path.basename(jotPath);
  const tmpPath = path.join(dir, `.${base}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    // No BOM, 2-space, LF — exactly Jot's own writer's output.
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, jotPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup; the write already failed
    }
    return { ok: false, error: `Failed to write Jot data: ${err.message}` };
  }
  return { ok: true, id: newTodo.id };
}
