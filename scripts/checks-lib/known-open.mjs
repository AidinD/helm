// Checks that FAIL on purpose, because they document a bug that is still open.
//
// THE PROBLEM THIS SOLVES. A reproduction is the most valuable thing an investigation produces -
// it is the difference between "we think X happens" and "run this". But a reproduction of an
// unfixed bug fails, and a suite that is permanently red teaches you to ignore red, which is the
// same disease as a flaky check and this repo already refuses that trade elsewhere. The usual
// escapes are worse: deleting the reproduction throws the evidence away, and commenting it out
// leaves a file nobody runs, which rots into a file nobody can run.
//
// SO: a check listed here is reported as OPEN. It is counted as neither a pass nor a failure,
// it is named at the end of every run with its reason, and it does not turn the suite red.
//
// AND THE HALF THAT KEEPS IT HONEST: if a check listed here PASSES, the suite FAILS. That is not
// a quirk. The bug is fixed at that moment, and the only thing standing between the repository
// and a permanent excuse is that somebody must come back and delete the entry. Making the good
// news fail the run is what forces that visit. Without it this file becomes the place checks go
// to stop mattering.
//
// A NOTE ON WHAT BELONGS HERE. Only a check that fails because the PRODUCT is wrong. A check
// that fails because it is badly written, or flaky, or needs a dependency this runner does not
// install, does not belong - the first two are bugs in the check and the third is EXCLUDED in
// ci-fast-lane.mjs. Every entry names the card that carries the finding, so the reason cannot
// quietly become "it has always been like that".
export const KNOWN_OPEN = Object.freeze({
  "test-a-live-holders-lock-is-not-taken.mjs": Object.freeze({
    card: "d203c05d",
    why:
      "keel's lockIsAbandoned falls back to an age rule whenever it cannot read the holder's claim, so a writer that is alive but slow has its lock taken. Reproduced deterministically with no error injected, only a scheduling delay. The fix is a keel change (version bump plus tag) and is not built.",
  }),
});

/** True when this check is expected to fail because the thing it checks is still broken. */
export function isKnownOpen(file) {
  return Object.hasOwn(KNOWN_OPEN, file);
}

/** The reason and card for a known-open check, or null. */
export function knownOpenReason(file) {
  return KNOWN_OPEN[file] || null;
}
