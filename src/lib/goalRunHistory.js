import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Persistent index of goal-orchestrator runs (Fas 3 Point 11), so the Goal
// page still shows what happened after a restart — Maestro is restarted
// often, and until now `goalRuns` lived only in the renderer's in-memory Map
// (reset on every reload), even though the real artifacts (worktree, branch,
// commits) survive on disk. This stores a COMPACT record per run only —
// never the full iteration transcript, which stays recoverable from the
// worktree's own .maestro-goal/notes.md — mirroring config.js's plain
// JSON-file-next-to-config.json pattern rather than inventing a new storage
// location (e.g. Electron's userData dir, which nothing else here uses).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const historyPath = path.join(__dirname, "..", "..", "goal-run-history.json");

const MAX_RECORDS = 200; // compact records are tiny; this is a generous cap, not a rolling window tuned for size

function readAll() {
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(records) {
  fs.writeFileSync(historyPath, JSON.stringify(records, null, 2) + "\n", "utf8");
}

/** Returns all persisted goal-run records, oldest first (same order as stored). */
export function loadGoalRunHistory() {
  return readAll();
}

/**
 * Upserts one record by goalRunId. Called at start ("running") and again at
 * each terminal event ("done"/"error"), so an interrupted run (app killed
 * mid-run) is left on disk as "running" rather than silently missing —
 * rehydration on the next load is what turns that into "interrupted".
 *
 * First-mate tier (docs/first-mate-tier-design.md section 3) adds three
 * ADDITIVE fields, written by startGoalRun in main.js when a run was dispatched
 * by a first mate (all null for a direct/captain-initiated Goal-page run):
 *   - dispatchedBy: the mateId that dispatched this run (the mate -> second-mate
 *     edge the Dashboard tree draws from)
 *   - dispatchId: correlates the dispatch request, the run, and the report
 *   - tier: "crew" for a dispatched run (the run IS crew - the autonomous work
 *     a second-mate project session owns; the second mate itself is a derived
 *     per-(firstMate,project) session, see secondMates.js)
 * Because this is a `{...records[idx], ...record}` spread upsert, the fields are
 * purely additive - old records simply have them undefined, and no read path
 * needs to change.
 */
export function upsertGoalRunRecord(record) {
  const records = readAll();
  const idx = records.findIndex((r) => r.goalRunId === record.goalRunId);
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...record };
  } else {
    records.push(record);
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }
  }
  writeAll(records);
}

/**
 * Removes one record by goalRunId, e.g. once its worktree has been deleted
 * from the Goal page and there is nothing left on disk worth remembering it
 * by. A no-op (not an error) if the id isn't present.
 */
export function removeGoalRunRecord(goalRunId) {
  const records = readAll();
  const next = records.filter((r) => r.goalRunId !== goalRunId);
  if (next.length !== records.length) {
    writeAll(next);
  }
}
