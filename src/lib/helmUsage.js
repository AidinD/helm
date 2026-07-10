import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Helm's OWN usage analytics - which VIEWS Aidin visits and the navigation
// PATHS he takes (A->B->C), logged locally. This is deliberately distinct from
// usage-log.jsonl (that tracks per-prompt model/effort/cost, shown on the
// Analysis page already). Content-free by construction: only view names /
// action ids and timestamps are stored, never any session content. Single-user,
// local, on D:\ beside the app's other stores (NOT %APPDATA%, NOT Anthropic's
// dir). Append-only JSONL; a corrupt line is skipped, never fatal.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_USAGE_PATH is a test-only seam (tests point it at a temp file).
const usagePath = process.env.HELM_USAGE_PATH || path.join(__dirname, "..", "..", "helm-usage.jsonl");

// Consecutive navs more than this far apart don't count as a "path" transition -
// they're separate sittings, not an A->B move. Keeps cross-session noise out.
const SESSION_GAP_MS = 30 * 60 * 1000;

export function helmUsagePath() {
  return usagePath;
}

/** Append one usage event ({ type, page?, action?, at }). Best-effort. */
export function trackHelmUsage(event) {
  if (!event || !event.type) {
    return;
  }
  try {
    fs.appendFileSync(usagePath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // best-effort: analytics must never break a navigation
  }
}

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(usagePath, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip a torn/corrupt line
    }
  }
  return events;
}

/**
 * Aggregates the usage log: per-view visit counts, the most common navigation
 * transitions (A->B, within a sitting), action counts, and the time span.
 * `sinceMs` optionally limits to recent events.
 */
export function summarizeHelmUsage({ sinceMs } = {}) {
  const all = readEvents();
  const events = sinceMs ? all.filter((e) => (e.at || 0) >= sinceMs) : all;

  const navs = events.filter((e) => e.type === "nav" && e.page);
  const viewCounts = {};
  for (const e of navs) {
    viewCounts[e.page] = (viewCounts[e.page] || 0) + 1;
  }
  const views = Object.entries(viewCounts)
    .map(([page, count]) => ({ page, count }))
    .sort((a, b) => b.count - a.count);

  const transCounts = {};
  let prevPage = null;
  let prevAt = 0;
  for (const e of navs) {
    const at = e.at || 0;
    const sameSitting = prevPage && at - prevAt <= SESSION_GAP_MS;
    if (sameSitting && prevPage !== e.page) {
      const key = `${prevPage} → ${e.page}`;
      transCounts[key] = (transCounts[key] || 0) + 1;
    }
    prevPage = e.page;
    prevAt = at;
  }
  const transitions = Object.entries(transCounts)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  const actionCounts = {};
  for (const e of events.filter((e) => e.type === "action" && e.action)) {
    actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
  }
  const actions = Object.entries(actionCounts)
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);

  const times = events.map((e) => e.at).filter((t) => typeof t === "number");
  return {
    totalEvents: events.length,
    views,
    transitions,
    actions,
    firstAt: times.length ? Math.min(...times) : null,
    lastAt: times.length ? Math.max(...times) : null,
  };
}
