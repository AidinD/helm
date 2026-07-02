import fs from "node:fs";

const DEFAULT_JOT_PATH = "D:\\Dropbox\\jot\\todos.json";

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
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jotPath, "utf8"));
  } catch {
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

function emptyIndex(path) {
  return {
    ok: false,
    path,
    categories: [],
    matchByTitle: () => null,
  };
}

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9åäö]/g, "");
}
