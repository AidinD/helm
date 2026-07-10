import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { nextRun, validateCron } from "./cron.js";

// Helm-OWNED routines: recurring `claude -p` launches Helm schedules and fires
// itself, stored in a plain readable JSON on D:\ beside the app's other stores
// (config.json, mates.json). This replaces the old read-only mirror of Claude
// Desktop's private scheduler - Helm owns the format so the Routines page can
// fully see + manage them (schedule, next/last run, enable/disable, edit,
// delete). Trade-off (the captain's call): a routine only fires while Helm is running
// (missed ones fire once on next startup via catch-up), in exchange for full
// control + visibility. See DECISIONS.md.
//
// A routine: { id, name, prompt, cron, cwd, model, effort, enabled, createdAt,
// lastRunAt, nextRunAt }. cron is a numeric 5-field expression (see cron.js).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_ROUTINES_PATH is a test-only seam (tests point it at a temp file).
const routinesPath = process.env.HELM_ROUTINES_PATH || path.join(__dirname, "..", "..", "routines.json");

export function routinesFilePath() {
  return routinesPath;
}

function readAll() {
  if (!fs.existsSync(routinesPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(routinesPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(routines) {
  const tmp = routinesPath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(routines, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, routinesPath);
}

/** All routines, in creation order. */
export function listRoutines() {
  return readAll();
}

/**
 * Create a routine. Validates the cron up front and seeds nextRunAt from now.
 * Returns the created routine. Throws on an invalid cron.
 */
export function createRoutine({ name, prompt, cron, cwd, model, effort, enabled = true } = {}) {
  if (!name || !name.trim()) {
    throw new Error("routine: name is required");
  }
  if (!prompt || !prompt.trim()) {
    throw new Error("routine: prompt is required");
  }
  const v = validateCron(cron);
  if (!v.ok) {
    throw new Error(v.error);
  }
  const now = Date.now();
  const next = nextRun(cron, now);
  const routine = {
    id: `routine_${crypto.randomUUID()}`,
    name: name.trim(),
    prompt: prompt.trim(),
    cron: cron.trim(),
    cwd: cwd || "",
    model: model || "",
    effort: effort || "",
    enabled: enabled !== false,
    createdAt: now,
    lastRunAt: null,
    nextRunAt: next ? next.getTime() : null,
  };
  const all = readAll();
  all.push(routine);
  writeAll(all);
  return routine;
}

/**
 * Patch a routine. If cron changes it's re-validated and nextRunAt recomputed
 * from now. Re-enabling also recomputes nextRunAt from now (so a routine left
 * disabled for weeks doesn't immediately fire for every missed occurrence).
 * Returns the updated routine, or null if not found. Throws on an invalid cron.
 */
export function updateRoutine(id, patch = {}) {
  const all = readAll();
  const r = all.find((x) => x.id === id);
  if (!r) {
    return null;
  }
  if (patch.cron !== undefined && patch.cron !== r.cron) {
    const v = validateCron(patch.cron);
    if (!v.ok) {
      throw new Error(v.error);
    }
  }
  const wasEnabled = r.enabled;
  for (const key of ["name", "prompt", "cron", "cwd", "model", "effort", "enabled"]) {
    if (patch[key] !== undefined) {
      r[key] = key === "enabled" ? patch[key] !== false : patch[key];
    }
  }
  const cronChanged = patch.cron !== undefined;
  const reEnabled = !wasEnabled && r.enabled;
  if (cronChanged || reEnabled) {
    const next = nextRun(r.cron, Date.now());
    r.nextRunAt = next ? next.getTime() : null;
  }
  writeAll(all);
  return r;
}

/** Remove a routine. Returns true if one was removed. */
export function removeRoutine(id) {
  const all = readAll();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) {
    return false;
  }
  writeAll(next);
  return true;
}

/** Enabled routines whose nextRunAt is due (<= now). */
export function dueRoutines(now = Date.now()) {
  return readAll().filter((r) => r.enabled && typeof r.nextRunAt === "number" && r.nextRunAt <= now);
}

/**
 * Record that a routine fired: set lastRunAt and advance nextRunAt to the next
 * occurrence STRICTLY AFTER the fire time. Firing once then advancing means a
 * routine that missed several occurrences while Helm was down fires a single
 * catch-up run, not one per missed slot. Returns the updated routine or null.
 */
export function markRoutineFired(id, firedAt = Date.now()) {
  const all = readAll();
  const r = all.find((x) => x.id === id);
  if (!r) {
    return null;
  }
  r.lastRunAt = firedAt;
  let next = null;
  try {
    next = nextRun(r.cron, firedAt);
  } catch {
    next = null; // a cron that somehow became invalid just stops scheduling
  }
  r.nextRunAt = next ? next.getTime() : null;
  writeAll(all);
  return r;
}
