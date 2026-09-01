/**
 * A killed process leaves git's index lock behind, and the repository goes silent.
 *
 * ## What happens
 *
 * git takes `.git/index.lock` before it writes the index and releases it after. Kill the
 * process between those two steps and the lock stays forever, and git then refuses EVERY
 * writing command in that repository.
 *
 * Found on 2026-08-20 by accident - an ordinary git command in one repo refused, and the lock
 * was empty and two days old. A sweep of the whole tree found four, all from the same
 * afternoon, two of them WORK repositories that had been unable to accept a commit since.
 *
 * Three things make it worse than it sounds. It is silent: nothing warns, and the repository
 * looks normal until the next write. The damage lands OUTSIDE the repos Helm was working in.
 * And the error, when it finally arrives, is about a lock file rather than about a run that
 * died two days earlier, so nobody connects the two.
 *
 * Confirmed still live on 2026-09-01: it happened twice in one session, both times from an
 * interrupted shell command rather than from a killed Helm run - which is a WIDER cause than
 * the card assumed, and a reason to sweep rather than only to fix how runs are killed.
 *
 * ## Why this only ever removes a lock it is sure about
 *
 * Deleting a LIVE lock corrupts the index write it belongs to, which is worse than the
 * problem. So a lock is only removed when every one of these holds:
 *
 *   - it is zero bytes: git writes the new index INTO the lock, so a lock with content is
 *     one that got somewhere;
 *   - it is older than the grace period: a zero-byte lock is also what a lock looks like in
 *     its first milliseconds;
 *   - no git process on this machine mentions that repository.
 *
 * Anything that fails one of those is REPORTED and left alone. And when the process list
 * cannot be read at all, every repository counts as busy - an unreadable answer must not
 * become permission to delete.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** How long a lock must have sat there before it is treated as abandoned. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Command lines of every git process on this machine.
 *
 * One query for all of them rather than one per repository: a repo list is a dozen entries
 * and a process query costs about a second on Windows.
 *
 * @returns {{ ok: boolean, lines: string[] }} ok:false means "could not tell", which every
 *   caller must read as "assume busy".
 */
export function runningGitCommandLines() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { $_.CommandLine }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 }
    );
    return { ok: true, lines: String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
  } catch {
    // No PowerShell, a timeout, a locked-down machine. "Could not tell" is not "nothing is
    // running", and the difference decides whether a live index write gets destroyed.
    return { ok: false, lines: [] };
  }
}

function normalise(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * Which of these repositories are holding an index lock, and which of those are abandoned.
 *
 * @param {string[]} repoPaths
 * @param {object} [options]
 * @param {number} [options.minAgeMs]
 * @param {number} [options.now]
 * @param {{ ok: boolean, lines: string[] }} [options.gitProcesses] injected so a check never
 *   has to spawn PowerShell
 * @returns {{ stale: Array<{repoPath: string, lockPath: string, ageMs: number}>,
 *   kept: Array<{repoPath: string, lockPath: string, why: string}> }}
 */
export function findStaleIndexLocks(repoPaths, { minAgeMs = STALE_AFTER_MS, now = Date.now(), gitProcesses } = {}) {
  const processes = gitProcesses ?? runningGitCommandLines();
  const stale = [];
  const kept = [];

  for (const repoPath of new Set((repoPaths || []).filter(Boolean))) {
    const lockPath = path.join(repoPath, ".git", "index.lock");
    let stat;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      continue; // no lock, which is the normal case
    }
    if (!stat.isFile()) {
      continue;
    }
    const ageMs = now - stat.mtimeMs;

    if (stat.size > 0) {
      // git writes the new index into the lock, so content means the write got somewhere.
      // Removing it could lose that, and this is not the tool to decide.
      kept.push({ repoPath, lockPath, why: `the lock is not empty (${stat.size} bytes), so a write may have got somewhere` });
      continue;
    }
    if (ageMs < minAgeMs) {
      kept.push({ repoPath, lockPath, why: `only ${Math.round(ageMs / 1000)}s old - an empty lock is also what a live one looks like at first` });
      continue;
    }
    if (!processes.ok) {
      kept.push({ repoPath, lockPath, why: "the running processes could not be read, so this repository counts as busy" });
      continue;
    }
    const needle = normalise(repoPath);
    const busy = processes.lines.some((line) => normalise(line).includes(needle));
    if (busy) {
      kept.push({ repoPath, lockPath, why: "a git process is running against this repository right now" });
      continue;
    }
    stale.push({ repoPath, lockPath, ageMs });
  }

  return { stale, kept };
}

/**
 * Remove the locks that are certainly abandoned. Reports everything, including what it left.
 *
 * @param {string[]} repoPaths
 * @param {object} [options] same as findStaleIndexLocks, plus `dryRun`
 * @returns {{ removed: Array<{repoPath: string, lockPath: string, ageMs: number}>,
 *   failed: Array<{repoPath: string, error: string}>,
 *   kept: Array<{repoPath: string, lockPath: string, why: string}> }}
 */
export function clearStaleIndexLocks(repoPaths, { dryRun = false, ...options } = {}) {
  const { stale, kept } = findStaleIndexLocks(repoPaths, options);
  const removed = [];
  const failed = [];
  for (const entry of stale) {
    if (dryRun) {
      removed.push(entry);
      continue;
    }
    try {
      fs.rmSync(entry.lockPath);
      removed.push(entry);
    } catch (err) {
      // Best effort per repository: one unremovable lock must not stop the others being
      // cleared, and it must not take the app's startup down either.
      failed.push({ repoPath: entry.repoPath, error: err.message });
    }
  }
  return { removed, failed, kept };
}
