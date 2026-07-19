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
// (`launching` from the design sketch folds into `working` here - sessions:get has
// no distinct pre-first-output signal to key it on; it can be added when the
// override logic moves in.)

/**
 * @param {{status?: string, orchestratorTag?: {statusTag?: string}|null}} session
 * @returns {"working"|"waiting"|"wrapped"|"idle"|"archived"}
 */
export function sessionLifecycleState(session) {
  const status = session?.status;
  const classifierDone = session?.orchestratorTag?.statusTag === "done_not_archived";
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
  // idle (includes the acked-downgrade). A done classifier tag reads as wrapped.
  return classifierDone ? "wrapped" : "idle";
}

// The decisions each surface makes today, expressed against the state - so the
// reader migration is a mechanical, behaviour-preserving swap.
export const isNeedsYouState = (s) => s === "waiting";
export const isWorkingState = (s) => s === "working";
export const isArchiveSuggestState = (s) => s === "wrapped" || s === "idle";
