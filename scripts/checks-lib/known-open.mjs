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
// AND IT HAS TO PROVE IT FAILED FOR THE DOCUMENTED REASON. Classifying on the exit code alone
// makes every other way of failing - a crash before the reproduction starts, a broken import, an
// unrelated regression - come out as the same reassuring sentence about a bug we already know
// about, and never as a failure. That is this repo's own "a broken matcher and a real absence
// are the same silent zero", one level up: the check would be reporting the bug it was told to
// expect rather than the one it saw. So a registered check must print
//
//     OPEN BUG REPRODUCED - <card>
//
// on the path where it actually reproduces, and only then is a non-zero exit read as `open`.
// Any other failure is an ordinary FAIL. The card in the line is the card in this file, so the
// two cannot drift apart into a marker that matches nothing.
//
// A NOTE ON WHAT BELONGS HERE. Only a check that fails because the PRODUCT is wrong. A check
// that fails because it is badly written, or flaky, or needs a dependency this runner does not
// install, does not belong - the first two are bugs in the check and the third is EXCLUDED in
// ci-fast-lane.mjs. Every entry names the card that carries the finding, so the reason cannot
// quietly become "it has always been like that".
// EMPTY, AND THAT IS THE MECHANISM WORKING RATHER THAN A FILE NOBODY USES.
//
// Its first entry was test-a-live-holders-lock-is-not-taken.mjs, registered on 2026-09-09
// against card d203c05d: keel published a lock directory before writing the claim into it, so a
// waiter arriving in that two-syscall window fell back to the age rule and took a live holder's
// lock. It was removed the same day, and not by anyone remembering to - keel v0.1.22 publishes
// the claim with the directory, the check went green, and the suite failed on the spot saying
// the entry had to go. That is the half this file exists for.
export const KNOWN_OPEN = Object.freeze({});

/** True when this check is expected to fail because the thing it checks is still broken. */
export function isKnownOpen(file) {
  return Object.hasOwn(KNOWN_OPEN, file);
}

/**
 * Did this run actually reproduce the documented bug, or just fail?
 *
 * @param {string} file
 * @param {string} output
 * @returns {boolean}
 */
export function reproducedKnownOpen(file, output) {
  const entry = KNOWN_OPEN[file];
  if (!entry) {
    return false;
  }
  return String(output || "").includes(`OPEN BUG REPRODUCED - ${entry.card}`);
}

/** The reason and card for a known-open check, or null. */
export function knownOpenReason(file) {
  return KNOWN_OPEN[file] || null;
}
