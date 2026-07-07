// First-mate tier width + depth cap predicates (docs/first-mate-tier-design.md
// sections 3 + 5), factored out of main.js as PURE functions so they can be
// unit-tested without booting Electron, and so the single dispatch authority
// (main.js's watcher) and the tests share one definition. They operate on a
// plain array of live-run descriptors `[{ goalRunId, dispatchedBy }]` - main.js
// builds this from liveGoalRuns at the call site.
//
// WIDTH cap: at most `widthCap` CONCURRENT dispatched runs per mate (design
// decision 3 = 3), keyed on `dispatchedBy` (a first mate's mateId).
//
// DEPTH cap: 2 - a dispatched run (a "second mate") may not itself dispatch, so
// the only legal chain is first-mate -> second-mate run. A dispatch request's
// caller is identified by `dispatchedBy`. That value is a first-mate mateId
// (only first mates ever get a mateId + the dispatch tools); a dispatched run's
// OWN identity is its goalRunId (a UUID), a disjoint namespace. So a request is
// a depth violation iff its caller id matches a live dispatched run's own
// goalRunId - i.e. a run is trying to dispatch. A caller id that merely appears
// as the `dispatchedBy` of live runs is a first mate that already has runs in
// flight, which is a WIDTH concern, not depth. Conflating the two wrongly
// refused a first mate's 2nd concurrent dispatch (caught by the cap test).

/** Number of a mate's currently-live dispatched runs. */
export function countLiveDispatchesForMate(liveRuns, mateId) {
  if (!mateId) {
    return 0;
  }
  let n = 0;
  for (const run of liveRuns) {
    if (run.dispatchedBy && run.dispatchedBy === mateId) {
      n += 1;
    }
  }
  return n;
}

/** True when accepting another run for this mate would exceed the width cap. */
export function widthCapExceeded(liveRuns, mateId, widthCap) {
  if (!mateId) {
    // A request with no caller id can't be attributed to a mate for width
    // accounting; treat as depth-1 and let it through (validation elsewhere).
    return false;
  }
  return countLiveDispatchesForMate(liveRuns, mateId) >= widthCap;
}

/**
 * True when a request would exceed the depth cap - i.e. its caller IS itself a
 * live dispatched run (a request originating from within a second-mate run).
 * The caller (request.dispatchedBy) is compared against each live run's OWN
 * identity (goalRunId): a match means a dispatched run is trying to dispatch,
 * which is depth 3 and refused. A first-mate caller never matches (its id is a
 * mateId, not a goalRunId), so a normal depth-1 dispatch is always allowed -
 * even when that mate already has runs in flight (that is a width concern).
 * Structurally this should be unreachable (only first mates get the dispatch
 * MCP tools), but it is enforced here at the single authority regardless.
 */
export function depthCapExceeded(liveRuns, request) {
  const caller = request?.dispatchedBy || null;
  if (!caller) {
    return false;
  }
  for (const run of liveRuns) {
    if (run.goalRunId && run.goalRunId === caller) {
      return true;
    }
  }
  return false;
}
