// Session lifecycle state - the single field every UI surface should read for
// "what is this session doing", instead of combining `status` + `orchestratorTag`
// itself (Epic f3d096fa; design in docs/session-status-fsm-design.md).
//
// This is FSM increment 1: a PURE projection of the signals already resolved by
// sessions:get (status - which by that point reflects the acked-downgrade + the
// live-turn override - plus the orchestratorTag). It is ADDITIVE: exposed as
// session.lifecycleState, nothing reads it yet, so there is zero behaviour change.
// Later increments migrate the needs-you / working / archive surfaces onto it and
// then fold the override logic in here, collapsing the four-layers-on-one-field
// smell into one place.
//
// States:
//   working  - a turn is live, or the heuristic says a turn is in progress.
//   waiting  - the turn ended and it's awaiting the user (an open question). needs-you.
//   wrapped  - the turn ended and finished cleanly; nothing awaited. archive-suggest.
//   idle     - parked (old, acknowledged, or indeterminate). archive-suggest.
//   archived - removed from the active board.
//
//   launching - Helm spawned it and nothing has come back yet (increment 5).
//
// (Increment 1 folded `launching` into `working`, because sessions:get had no
// pre-first-output signal to key it on. Increment 5 added one - the launch
// registry in liveSessions.js - so it is now a state of its own.)

/**
 * @param {{status?: string, orchestratorTag?: {statusTag?: string}|null}} session
 * @param {{isAcked?: boolean}} [opts]
 * @returns {"working"|"waiting"|"wrapped"|"idle"|"archived"}
 */
export function sessionLifecycleState(session, { isAcked = false, isLaunching = false } = {}) {
  const status = session?.status;
  // launching: Helm spawned this and nothing has come back yet. Only ever true for
  // a Helm-OWNED session, because it is the launch itself that proves it - a
  // foreign Desktop session has no launch Helm could know about. Checked before
  // everything else: a brand-new session's transcript says nothing, so the
  // heuristic would read it as idle, which is the exact "idle while working" class
  // of bug this epic exists to close (Epic f3d096fa).
  if (isLaunching && status !== "archived") {
    return "launching";
  }
  const tag = session?.orchestratorTag?.statusTag;
  const classifierDone = tag === "done_not_archived";
  const classifierNeedsYou = tag === "waiting_for_input";
  if (status === "archived") {
    return "archived";
  }
  if (status === "active") {
    return "working";
  }
  if (status === "waiting") {
    // A waiting turn the classifier is confident finished (not awaiting input) is
    // wrapped, not needs-you - the same suppression the needs-you gate does today.
    return classifierDone ? "wrapped" : "waiting";
  }
  // idle: parked - age-decayed past the attention window, acked, or indeterminate.
  // But the time heuristic (deriveStatus) buries an assistant-ended session as idle
  // once it's older than the attention window, which silently drops a genuine open
  // question to "idle" just because you didn't answer within a day (bug 4cd7d592:
  // "Needs your input visas som idle"). A content signal that the last turn is
  // actually awaiting input promotes it back to needs-you REGARDLESS of age - an
  // unanswered question still needs you (the captain prefers false positives here). The
  // one exception is a session you explicitly acked ("I'm done with this"): the ack
  // is you overriding the signal, so it stays parked even if it ended on a question.
  if (classifierNeedsYou && !isAcked) {
    return "waiting";
  }
  // A done classifier tag reads as wrapped.
  return classifierDone ? "wrapped" : "idle";
}

// The decisions each surface makes today, expressed against the state - so the
// reader migration is a mechanical, behaviour-preserving swap.
export const isNeedsYouState = (s) => s === "waiting";
// launching counts as working: something IS happening, it just hasn't spoken yet.
export const isWorkingState = (s) => s === "working" || s === "launching";
// A launching session must never be offered for archive - it has barely started.
export const isArchiveSuggestState = (s) => s === "wrapped" || s === "idle";

/**
 * Where a session's state actually came from - the design's "hybrid" caveat made
 * explicit (Epic f3d096fa).
 *
 * "tracked"  - Helm launched this session, so live-turn and launch signals are
 *              authoritative. This is the half where "idle while working" cannot
 *              happen, because working is a transition Helm observes directly.
 * "derived"  - a foreign (Desktop) session. Helm has nothing but the transcript
 *              heuristic: last role plus age. Still useful, but it is a guess, and
 *              anything reading it should know that.
 *
 * Exposed rather than inferred so a surface (or a future bug report) can tell the
 * difference instead of assuming the heuristic is truth everywhere.
 */
export function sessionStateSource(session, { isLive = false, isLaunching = false } = {}) {
  if (!session?.helmOwned) {
    return "derived";
  }
  return isLive || isLaunching ? "tracked" : "derived";
}

// FSM increment 4 (Epic f3d096fa): the ONE place that applies the status
// OVERRIDES - the manual-ack downgrade and the live-turn override - that
// sessions:get used to do as two separate inline operations. (These must run
// BEFORE Jot scoring, which reads status; lifecycleState is projected separately,
// AFTER orchestratorTag is set - an ordering constraint that keeps these two apart.)
// Recompute (stateless, drift-free) by deliberate choice: a persisted transition
// machine would need a reconcile-from-truth step that re-derives this anyway,
// making the transition layer vestigial for Helm's poll-per-read model.
// Behaviour-preserving: same status output as the previous inline logic.
//
// inputs: { isLive, isAcked } - supplied by the caller from the live-turn registry
// and the acknowledged-sessions config (main-process state this pure module
// shouldn't reach into).
export function applyStatusOverrides(session, { isLive = false, isAcked = false } = {}) {
  // Manual "I'm done" ack downgrades a still-waiting session to idle.
  if (session.status === "waiting" && isAcked) {
    session.status = "idle";
  }
  // A live turn is authoritatively "working", over whatever the file heuristic
  // decayed to (the "idle while working" fix - task 5939df).
  if (isLive) {
    session.status = "active";
  }
  return session;
}
