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
 * Entries that FAILED and have not been acknowledged, newest first.
 *
 * A prompt he queued and that never reached the model is the one state worth interrupting
 * him about, and it was the one state nothing showed: "fired" is terminal, so the row simply
 * left the queue (task a797eb69 - "skickades aldrig, de bara försvann"). These stay visible
 * until dismissed rather than expiring, because a signal that ages out is a signal he will
 * miss exactly when he was away - which is the whole reason to schedule a prompt.
 */
export function failedScheduledPrompts() {
  return readAll()
    .filter((p) => p.status === "failed" && !p.acknowledgedAt)
    .sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0));
}

/** Acknowledge a failed entry, so it stops being shown. */
export function acknowledgeScheduledPrompt(id, { now = Date.now() } = {}) {
  const all = readAll();
  const entry = all.find((p) => p.id === id);
  if (!entry) {
    return false;
  }
  entry.acknowledgedAt = now;
  writeAll(all);
  return true;
}

/**
 * How long each named rate-limit window lasts, so an elapsed reading of a
 * RECURRING window can be rolled forward to its next boundary. The CLI only
 * ever tells us when the LAST observed window ended; the windows themselves
 * repeat (a five-hour window that ended at T ends again at T+5h, T+10h, ...).
 *
 * Keyed by the `rateLimitType` the CLI reports (e.g. "five_hour", "seven_day",
 * "seven_day_opus"). We parse "<count>_<unit>[_<model>]" so an unseen variant
 * (a per-model weekly window, say) still resolves without a code change.
 */
const PERIOD_WORD_COUNTS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
const PERIOD_UNIT_MS = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
};

export function windowPeriodMs(rateLimitType) {
  if (!rateLimitType || typeof rateLimitType !== "string") {
    return null;
  }
  const tokens = rateLimitType.toLowerCase().split(/[_-]/);
  let count = null;
  let unitMs = null;
  for (const tok of tokens) {
    if (count === null && PERIOD_WORD_COUNTS[tok] !== undefined) {
      count = PERIOD_WORD_COUNTS[tok];
    } else if (count === null && /^\d+$/.test(tok)) {
      count = parseInt(tok, 10);
    }
    // units may be plural in some variants ("hours"); match on the singular stem
    const stem = tok.replace(/s$/, "");
    if (unitMs === null && PERIOD_UNIT_MS[stem] !== undefined) {
      unitMs = PERIOD_UNIT_MS[stem];
    }
  }
  if (count === null || count <= 0 || unitMs === null) {
    return null;
  }
  return count * unitMs;
}

/**
 * Resolve the fireAt for a "when the quota window resets" schedule from the
 * persisted quota readings. Returns null when no window has a usable reset, so
 * the caller can fall back to a plain delay rather than guessing.
 *
 * quotaWindows is main.js's accumulator shape: [{ info: { resetsAt, rateLimitType }, at }]
 * where resetsAt is unix SECONDS. Picks the SOONEST upcoming reset across all
 * windows - that is the first moment work can plausibly continue.
 *
 * The windows recur, so an ELAPSED reading is not dead: for a window whose
 * period we know (see windowPeriodMs), we roll its last-known end forward to the
 * next boundary. Without that, a stale short window (a five-hour one whose stored
 * end has passed) was silently dropped and the schedule fell through to whatever
 * window still had a future stamp - typically the seven-day one, landing the
 * prompt DAYS out instead of at the next few-hour reset (the captain, task 5143316e:
 * "schedule on token reset ger helt fel tid"). A window whose period we cannot
 * parse still yields nothing when elapsed, rather than a guess.
 */
export function quotaResetFireAt(quotaWindows, now = Date.now(), graceMs = 60_000) {
  let soonest = null;
  for (const w of quotaWindows || []) {
    const secs = w?.info?.resetsAt;
    if (typeof secs !== "number" || secs <= 0) {
      continue;
    }
    let ms = secs * 1000;
    if (ms <= now) {
      // Elapsed reading: roll a recurring window forward to its next boundary.
      // A window whose period we can't determine tells us nothing about the
      // future, so it is skipped (the pre-fix behaviour, kept for that case).
      const period = windowPeriodMs(w?.info?.rateLimitType);
      if (!period) {
        continue;
      }
      const missed = Math.ceil((now - ms) / period);
      ms += missed * period;
      if (ms <= now) {
        ms += period; // landed exactly on 'now' - take the next boundary
      }
    }
    if (soonest === null || ms < soonest) {
      soonest = ms;
    }
  }
  // A small grace period after the stated reset: firing at the exact boundary
  // tends to hit the limit that is only just lifting.
  return soonest === null ? null : soonest + graceMs;
}

function scheduledPromptLabel(fireAt, waitForQuota, now = Date.now()) {
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
 * Record what the fired run actually DID, once it has finished.
 *
 * "scheduled meddelande on token reset skickades aldrig, de bara försvann" (the captain, task
 * a797eb69). markScheduledPromptFired above is called the moment the process is spawned, which
 * is all that is known at that point - but it writes the terminal status "fired", so the entry
 * left the queue looking sent whatever happened next. A prompt fired into a quota that was
 * still spent, or resumed against a session the CLI could not find, therefore ended as a
 * confident "fired" with nothing to show: never sent, and gone from the list.
 *
 * `sawResult` is the launcher's own answer to "did the CLI produce a real reply", which is the
 * only trustworthy signal - a non-zero exit is not required for a run to have produced nothing.
 */
export function markScheduledPromptOutcome(id, { sawResult = false, isError = false, code = null, error = null, now = Date.now() } = {}) {
  const all = readAll();
  const entry = all.find((p) => p.id === id);
  if (!entry) {
    return null;
  }
  // Only an entry we launched has an outcome to record; leave anything else alone.
  if (entry.status !== "fired" && entry.status !== "failed") {
    return entry;
  }
  entry.finishedAt = now;
  // A result event is not the same as an ANSWER: the CLI also ends with one for an error, a
  // max-turns stop and a run that hit the usage limit. Trusting sawResult alone recorded a prompt
  // fired into a spent quota as DELIVERED - the headline case this function exists for (found by
  // review, 2026-08-04). isError comes from the launcher, which now carries it out.
  if (sawResult && !isError) {
    entry.status = "fired";
    entry.error = null;
  } else {
    entry.status = "failed";
    entry.error =
      error ||
      (typeof code === "number" && code !== 0
        ? `the run exited with code ${code} without replying`
        : "the run ended without producing a reply");
  }
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
  // An UNACKNOWLEDGED failure is never pruned, whatever its age. The notice is supposed to stay
  // until dismissed, and prune runs at every launch - so a prompt that failed while he was away
  // for a week was silently dropped on the next start, which is the same "de bara försvann" this
  // was built to end (found by review, 2026-08-04).
  const kept = all.filter(
    (p) => p.status === "pending" || (p.status === "failed" && !p.acknowledgedAt) || (now - (p.firedAt || p.createdAt || 0)) < maxAgeMs
  );
  if (kept.length !== all.length) {
    writeAll(kept);
  }
  return all.length - kept.length;
}
