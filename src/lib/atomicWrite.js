import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// One atomic write, used by every durable store (task efcaf486).
//
// The discipline - write a temp file, then rename over the target - was copied into
// seven modules, and all seven copies had the same hole: on Windows the rename fails
// with EPERM while another process holds the target, and every copy let that throw
// straight through as a lost write.
//
// This is not an edge case here. Helm's durable state lives under a Dropbox-synced
// meta-home, so the sync client holding a file mid-rename is the normal operating
// condition. Observed for real on 2026-07-27: a board update returned
// "Failed to write Jot data: EPERM ... rename" and the change was simply gone. The
// stores at risk are the ones it hurts most to lose - the dispatch queue, routines,
// handoffs, the orchestration budget, scheduled prompts, and the REVIEW RECORDS
// themselves, i.e. the mechanism whose whole job is to be trustworthy evidence.
//
// Fixed once, here, rather than seven times.

const MAX_ATTEMPTS = 4;

/**
 * Is this "someone else has the file right now", rather than a real failure?
 *
 * Windows reports BOTH a locked file and a permission-denied folder as EPERM, so
 * the code alone cannot tell them apart. `targetExists` is what separates them: you
 * can only be fighting over a file that is there. A folder Helm is not allowed to
 * write in produces the same EPERM with no file at the end of it, and retrying
 * that four times just delays a wrong answer - the pre-release review measured the
 * app blocking for 377ms and then telling the user Dropbox might be syncing, for a
 * permission problem that will never clear on its own.
 *
 * Called with one argument it keeps the old, more forgiving behaviour, so the
 * exported predicate stays usable as a plain "could this be a lock?" check.
 */
export function isTransientLock(err, targetExists = true) {
  if (err?.code === "EBUSY") {
    return true; // always a live handle on something
  }
  if (err?.code === "EPERM" || err?.code === "EACCES") {
    return targetExists;
  }
  return false;
}

/**
 * Block for ms without burning CPU.
 *
 * A synchronous sleep is deliberate: these writers are all sync (they are called
 * straight from IPC handlers), the path is rare, and the total is bounded to a few
 * hundred milliseconds. The alternative is silently dropping a write the user asked
 * for. Frequency is what makes blocking unacceptable, not blocking itself - contrast
 * the docs-drift sweep, which had to go async precisely because it ran on every tick.
 */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable - skip the backoff rather than failing the write.
  }
}

/**
 * Write `contents` to `filePath` atomically, retrying while the target is locked.
 *
 * Returns { ok: true } or { ok: false, error } - it does NOT throw, because every
 * caller here has a meaningful "the write did not happen" path and a throw was how
 * these failures got lost in the first place.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {{ onBeforeRename?: () => string|null }} [opts] - a hook to re-check
 *   preconditions immediately before the rename (jot.js uses it for its
 *   concurrent-edit guard); return a reason string to abort the attempt and retry.
 */
// A write failure ends up in a toast the captain reads. A bare "EROFS: read-only file
// system, open '...'" tells him nothing he can act on, and a raw error code
// appearing from nowhere is exactly the reporting failure he called out
// (CLAUDE.md, "no unexplained jargon"). So say what happened in words, and keep
// the code in brackets for a bug report.
function plainReason(err, filePath) {
  const code = err?.code || "";
  const where = path.dirname(filePath);
  if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
    return `Helm isn't allowed to write in ${where} - if this is the installed app, its data folder is misconfigured. [${code}]`;
  }
  if (code === "ENOENT") {
    return `the folder ${where} doesn't exist and couldn't be created. [${code}]`;
  }
  if (code === "ENOSPC") {
    return `the disk holding ${where} is full. [${code}]`;
  }
  return err?.message || String(err);
}

/**
 * Remove a temp file that never made it onto its target. Best-effort - it never
 * throws - but RETRIED, because the obvious "unlinkSync and swallow" loses a race
 * on Windows+Dropbox: the sync client can grab a lock on the temp the instant it
 * appears, so a single silent unlink leaves it behind. That is how the dispatch dir
 * accumulated 1462 orphaned `.fleet-state.json.<uuid>.tmp` files (found 2026-08-12)
 * - fleet state is rewritten every ~5s, so each lost cleanup compounds fast. Retry
 * over the same backoff the rename uses so a transient lock on the temp clears
 * before we give up.
 */
function bestEffortRemove(tmp) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.unlinkSync(tmp);
      return;
    } catch (err) {
      if (err?.code === "ENOENT") {
        return; // already gone (e.g. the rename actually took) - nothing to clean up
      }
      // The temp still exists if we got here with anything but ENOENT, so an EPERM/
      // EBUSY/EACCES is a live lock worth waiting out - same signal as for the rename.
      if (isTransientLock(err, true) && attempt < MAX_ATTEMPTS - 1) {
        sleepSync(60 * (attempt + 1));
        continue;
      }
      return; // out of attempts, or a non-lock error - still best-effort, never throw
    }
  }
}

export function writeFileAtomicSync(filePath, contents, { onBeforeRename = null } = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const tmp = path.join(dir, `.${base}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, contents, "utf8");
      if (onBeforeRename) {
        const abort = onBeforeRename();
        if (abort) {
          bestEffortRemove(tmp);
          lastError = abort;
          continue;
        }
      }
      fs.renameSync(tmp, filePath);
      return { ok: true };
    } catch (err) {
      bestEffortRemove(tmp);
      // Whether the destination already exists decides whether an EPERM is a lock
      // worth waiting out or a permission problem worth reporting immediately.
      let targetExists = false;
      try {
        targetExists = fs.existsSync(filePath);
      } catch {
        // unreadable - treat as absent, i.e. not a lock
      }
      if (isTransientLock(err, targetExists)) {
        if (attempt < MAX_ATTEMPTS - 1) {
          lastError = `${err.code} (file locked, likely Dropbox sync)`;
          sleepSync(60 * (attempt + 1));
          continue;
        }
        // Out of attempts. Name the likely CAUSE, not just the errno - "operation not
        // permitted" reads like a bug in Helm, when the actionable fact is that
        // something else is holding the file.
        return {
          ok: false,
          error: `the file stayed locked (${err.code}) after ${MAX_ATTEMPTS} attempts - Dropbox may be syncing it. Nothing was changed; try again.`,
        };
      }
      return { ok: false, error: plainReason(err, filePath) };
    }
  }
  return { ok: false, error: lastError || "the file kept changing during the write" };
}

/** The common case: pretty-printed JSON with a trailing newline. */
export function writeJsonAtomicSync(filePath, value) {
  return writeFileAtomicSync(filePath, JSON.stringify(value, null, 2) + "\n");
}
