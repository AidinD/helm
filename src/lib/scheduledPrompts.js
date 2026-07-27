import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicSync } from "./atomicWrite.js";

// Scheduled prompts (task 7d9d2188).
//
// The case: "oftast tar min kvot slut mitt under ett jobb. Då behöver jag vänta
// tills kvoten resettats och sedan skriva fortsätt." So: queue a prompt now, let
// Helm send it when the quota window has actually reset - or at any chosen time,
// the way Slack's "Schedule message" works.
//
// Deliberately a QUEUE OF PROMPTS, not an auto-continue-everything sweep. Firing
// every interrupted session the moment quota returns would spawn a pile of work
// nobody asked for; queuing is per-prompt and explicit, so what resumes is what
// the captain chose to resume.
//
// The store is a plain JSON array beside the app, with the same HELM_*_PATH seam
// every other store uses (see packagedPaths.js for why a packaged build redirects
// these).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storePath = () => process.env.HELM_SCHEDULED_PROMPTS_PATH || path.join(__dirname, "..", "..", "scheduled-prompts.json");

/**
 * One entry: {
 *   id, prompt, cwd, resumeSessionId|null, model, effort,
 *   fireAt,            // absolute ms
 *   waitForQuota,      // true = "at quota reset": re-check at fire time
 *   createdAt, firedAt|null, status: "pending"|"fired"|"cancelled"|"failed",
 *   error|null, label  // human description of the schedule, for the UI
 * }
 */

function readAll() {
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  // Shared atomic write with the Dropbox-lock retry (task efcaf486): the previous
  // private copy re-threw EPERM, so a queued prompt could vanish while the sync
  // client held the file - and a prompt that silently never fires is indistinguishable
  // from one that was never queued.
  const res = writeJsonAtomicSync(storePath(), list);
  if (!res.ok) {
    throw new Error(`Could not write the scheduled-prompt queue: ${res.error}`);
  }
}

export function scheduledPromptsPath() {
  return storePath();
}

export function listScheduledPrompts() {
  return readAll();
}

/** Pending entries only, soonest first - what the UI shows as queued. */
export function pendingScheduledPrompts(now = Date.now()) {
  return readAll()
    .filter((p) => p.status === "pending")
    .sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0))
    .map((p) => ({ ...p, overdue: (p.fireAt || 0) <= now }));
}

/**
 * Resolve the fireAt for a "when the quota window resets" schedule from the
 * persisted quota readings. Returns null when no window has a usable future
 * reset, so the caller can fall back to a plain delay rather than guessing.
 *
 * quotaWindows is main.js's accumulator shape: [{ info: { resetsAt, ... }, at }]
 * where resetsAt is unix SECONDS. Picks the SOONEST future reset - that is the
 * first moment work can plausibly continue.
 */
export function quotaResetFireAt(quotaWindows, now = Date.now(), graceMs = 60_000) {
  let soonest = null;
  for (const w of quotaWindows || []) {
    const secs = w?.info?.resetsAt;
    if (typeof secs !== "number" || secs <= 0) {
      continue;
    }
    const ms = secs * 1000;
    if (ms <= now) {
      continue; // already elapsed - that window tells us nothing about the future
    }
    if (soonest === null || ms < soonest) {
      soonest = ms;
    }
  }
  // A small grace period after the stated reset: firing at the exact boundary
  // tends to hit the limit that is only just lifting.
  return soonest === null ? null : soonest + graceMs;
}

export function scheduledPromptLabel(fireAt, waitForQuota, now = Date.now()) {
  const mins = Math.max(0, Math.round((fireAt - now) / 60000));
  const when = mins >= 120 ? `${Math.round(mins / 60)}h` : mins >= 1 ? `${mins}m` : "under a minute";
  return waitForQuota ? `at quota reset (~${when})` : `in ${when}`;
}

/**
 * Queue a prompt. Throws on missing essentials so a bad call can't silently
 * create an entry that will never fire usefully.
 */
export function scheduledPromptAdd({ prompt, cwd, resumeSessionId = null, model = "", effort = "", fireAt, waitForQuota = false, now = Date.now() } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("A scheduled prompt needs prompt text.");
  }
  if (!cwd) {
    throw new Error("A scheduled prompt needs a folder to run in.");
  }
  if (typeof fireAt !== "number" || !isFinite(fireAt)) {
    throw new Error("A scheduled prompt needs a fireAt timestamp.");
  }
  const entry = {
    id: "sp_" + crypto.randomUUID(),
    prompt: String(prompt),
    cwd,
    resumeSessionId: resumeSessionId || null,
    model: model || "",
    effort: effort || "",
    fireAt,
    waitForQuota: !!waitForQuota,
    label: scheduledPromptLabel(fireAt, !!waitForQuota, now),
    createdAt: now,
    firedAt: null,
    status: "pending",
    error: null,
  };
  const all = readAll();
  all.push(entry);
  writeAll(all);
  return entry;
}

export function cancelScheduledPrompt(id) {
  const all = readAll();
  const entry = all.find((p) => p.id === id);
  if (!entry || entry.status !== "pending") {
    return false;
  }
  entry.status = "cancelled";
  writeAll(all);
  return true;
}

/**
 * Which pending prompts are due to fire right now.
 *
 * `quotaLimited` is the caller's answer to "is the quota still spent?". A
 * waitForQuota entry that comes due while the quota is STILL limited is not
 * fired - firing into an exhausted quota just burns the prompt on the same
 * failure. It is pushed instead (see pushScheduledPrompt), which is the whole
 * point of re-checking at fire time rather than trusting the estimate made when
 * it was queued.
 */
export function dueScheduledPrompts(now = Date.now(), { quotaLimited = false } = {}) {
  return readAll().filter((p) => p.status === "pending" && (p.fireAt || 0) <= now && !(p.waitForQuota && quotaLimited));
}

/** Move a not-yet-runnable entry's fireAt out, keeping it pending. */
export function pushScheduledPrompt(id, nextFireAt, now = Date.now()) {
  const all = readAll();
  const entry = all.find((p) => p.id === id);
  if (!entry || entry.status !== "pending") {
    return null;
  }
  entry.fireAt = nextFireAt;
  entry.label = scheduledPromptLabel(nextFireAt, entry.waitForQuota, now);
  writeAll(all);
  return entry;
}

/** Record the outcome of an attempted fire. */
export function markScheduledPromptFired(id, { ok = true, error = null, now = Date.now() } = {}) {
  const all = readAll();
  const entry = all.find((p) => p.id === id);
  if (!entry) {
    return null;
  }
  entry.status = ok ? "fired" : "failed";
  entry.firedAt = now;
  entry.error = ok ? null : error || "unknown error";
  writeAll(all);
  return entry;
}

/**
 * Drop old terminal entries so the queue file cannot grow without bound. Pending
 * entries are never pruned regardless of age - a prompt queued for a long wait is
 * exactly the use case.
 */
export function pruneScheduledPrompts(now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const all = readAll();
  const kept = all.filter((p) => p.status === "pending" || (now - (p.firedAt || p.createdAt || 0)) < maxAgeMs);
  if (kept.length !== all.length) {
    writeAll(kept);
  }
  return all.length - kept.length;
}
