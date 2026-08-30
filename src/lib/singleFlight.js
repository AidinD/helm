/**
 * Run one expensive build at a time, WITHOUT serving an answer that predates the caller.
 *
 * The naive form of this - "if a build is running, return its promise" - is correct for two
 * readers who arrive together and wrong for a caller that has just written something. That
 * caller joins a build which started before the write and receives an answer that cannot
 * contain it, with nothing in the payload marking it as old.
 *
 * Helm shipped the naive form on the review queue and it cost nine days of chasing the wrong
 * component (2026-08-30). A stamped check run was on disk, the worker read it correctly and
 * built `declared: 1`, and the caller still got `declared: 0` - because it had joined the
 * build before that one. The symptom in the app was "I ran the checks and the result
 * vanished": the page refreshes, a badge tick's build is already in flight, and the refresh
 * inherits its pre-stamp answer. It looked like the worker lying about the record, which is
 * why disabling the worker appeared to fix it - that only changed the timing.
 *
 * So the join is conditional on a FINGERPRINT of the inputs:
 *
 *   - same fingerprint  -> join; the running build will see what this caller sees.
 *   - moved fingerprint -> wait for the slot, then build against what is on disk now.
 *   - unreadable        -> treated as moved. "Cannot tell" must never read as "unchanged".
 *
 * @param {object} opts
 * @param {() => string|null} opts.fingerprint  Cheap, synchronous summary of the inputs.
 *   Returning null means "could not read them" and forces a fresh build.
 * @param {(print: string|null) => Promise<any>} opts.run  The expensive build. Receives the
 *   fingerprint taken BEFORE it started, which is the one that governs its result - an edit
 *   landing mid-build must invalidate the answer it was not included in, not be stamped as
 *   already accounted for.
 * @param {number} [opts.maxWaits]  How many times to yield the slot before building anyway,
 *   so a pathological stream of writers cannot starve a reader forever.
 */
export function createSingleFlight({ fingerprint, run, maxWaits = 5 }) {
  if (typeof fingerprint !== "function" || typeof run !== "function") {
    throw new TypeError("createSingleFlight needs a fingerprint function and a run function");
  }
  let inFlight = null;
  let inFlightPrint = null;

  return async function get() {
    // A loop, not a single check: the build we wait for can finish while a THIRD caller
    // starts the next one, and falling through there would run two builds concurrently -
    // the exact thing single-flighting exists to prevent.
    for (let waited = 0; inFlight && waited < maxWaits; waited += 1) {
      const now = fingerprint();
      if (now !== null && inFlightPrint !== null && now === inFlightPrint) {
        return inFlight;
      }
      try {
        await inFlight;
      } catch {
        // Its own caller handles its failure; this one only needed the slot.
      }
    }

    const print = fingerprint();
    inFlightPrint = print;
    inFlight = (async () => {
      try {
        return await run(print);
      } finally {
        inFlight = null;
        inFlightPrint = null;
      }
    })();
    return inFlight;
  };
}
