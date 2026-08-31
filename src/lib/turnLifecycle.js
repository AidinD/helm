/**
 * Ending a turn, in one place, for every way a turn can end.
 *
 * ## The bug this exists for
 *
 * A turn's bookkeeping - the per-session lock, the live marks, the child handle - was
 * released in exactly one place: the `.then` of the promise that started it. A turn whose
 * promise never settled therefore held all of it forever. The process could be gone; the
 * app still believed it was running.
 *
 * Hit live on 2026-08-17. The captain: "den verkar fortfarande bara tugga på och jag kan varken
 * prompta eller stoppa". The process list confirmed nothing was running at all. The
 * session showed "working" for the rest of the app's life, every new prompt was refused
 * by a lock nobody would ever release, and Stop could not help because it only knew how
 * to kill a tracked child and there was none. Restarting Helm was the only way out.
 *
 * ## Why it lives here rather than inline
 *
 * Two reasons, and the second is the one that matters.
 *
 * A release written inline in the promise handler is a release only the promise can
 * perform. Stop, and a sweep that notices a dead process, each needed the same four steps
 * - and four steps copied into three places is four steps that drift in three places.
 *
 * And inline in main.js it could only be checked by reading the source. The bug cost a
 * restart every time it happened; a check that greps for the fix is not proportional to
 * that. Everything here takes its state as arguments, so a test can build a stuck turn,
 * end it, and look at what was actually let go of.
 *
 * Nothing here spawns, kills, or knows what a process is. Killing stays with the caller;
 * this is only about what the app believes afterwards.
 */

/**
 * @param {object} deps
 * @param {Map<string, any>} deps.liveChildren launchId -> child process
 * @param {Map<string, {resumeSessionId: string|null, liveTurnId: string|null}>} deps.launchHolds
 * @param {Set<string>} deps.sessionTurnLocks session ids with a turn in flight
 * @param {{ clearLaunching: (id: string) => void }} deps.liveSessions
 * @param {(id: string) => void} deps.markSessionDone
 * @param {(launchId: string, why: string) => void} [deps.notify] Told only about ABNORMAL
 *   ends. A turn that finished normally sends its own richer event from the stream
 *   handler; firing a second one from here would hand a pane that has already torn its
 *   state down another one to process.
 * @param {(message: string) => void} [deps.log]
 */
export function createTurnLifecycle({ liveChildren, launchHolds, sessionTurnLocks, liveSessions, markSessionDone, notify = null, log = null }) {
  /**
   * Release everything a launch was holding. Safe to call twice - every step is a delete
   * or an idempotent mark - because the whole point is that several things may now try.
   *
   * @param {string} launchId
   * @param {string|null} why Non-null marks an abnormal end and is what `notify` reports.
   * @returns {{resumeSessionId: string|null, liveTurnId: string|null}|null} what it held.
   */
  function finishLaunch(launchId, why = null) {
    const held = launchHolds.get(launchId) || null;
    launchHolds.delete(launchId);
    liveChildren.delete(launchId);
    liveSessions.clearLaunching(launchId);
    if (held?.liveTurnId) {
      markSessionDone(held.liveTurnId);
    }
    if (held?.resumeSessionId) {
      sessionTurnLocks.delete(held.resumeSessionId);
    }
    if (why !== null && notify) {
      notify(launchId, why);
    }
    return held;
  }

  /**
   * Find turns whose process has already exited and let go of them.
   *
   * The startup race is sidestepped STRUCTURALLY, not by a condition: this walks
   * liveChildren, and a turn that has been locked but whose child does not exist yet is
   * simply not in it. That matters because the lock is taken before the spawn, so any
   * check written as "held but not running" would end turns that are merely still
   * starting. Nothing here can reach them, so nothing here can get that wrong.
   *
   * A child carrying an exit code or a signal is unambiguous - that process is not coming
   * back, whatever the promise it was attached to still believes. The `!child` guard below
   * is defensive only; this map is populated exclusively with real children, so it is not
   * a case any test can construct, and it is not claimed as one.
   *
   * @returns {string[]} the launch ids it released.
   */
  function sweepDeadTurns() {
    const released = [];
    for (const [launchId, child] of [...liveChildren.entries()]) {
      if (!child || (child.exitCode === null && child.signalCode === null)) {
        continue;
      }
      if (log) {
        log(`[helm] launch ${launchId} held a turn whose process had already exited - releasing it`);
      }
      finishLaunch(launchId, "the process had already exited");
      released.push(launchId);
    }
    return released;
  }

  return { finishLaunch, sweepDeadTurns };
}
