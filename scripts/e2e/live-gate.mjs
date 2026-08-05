// The one opt-in gate for a check that reaches a real model.
//
// Why this is shared rather than copy-pasted: four checks had grown their own inline
// version of it with three different flag spellings, and eleven MORE spent tokens with
// no gate at all - so `npm test` quietly drew quota, which is exactly the thing Aidin
// asked about on 2026-08-05 ("testsviten körs inte av ai eller hur, det är skript så
// den använder inte massa tokens?"). The answer was no, and the reason was that nothing
// made the expensive case declare itself.
//
// Call it FIRST in a check that spawns the real CLI or starts a real session - before
// launching Electron, before writing fixtures - so a default run pays nothing for it:
//
//   import { requireLive } from "./live-gate.mjs";
//   requireLive("drives a real first mate through a dispatch");
//
// scripts/e2e/test-live-checks-declared.mjs FAILS on any check that reaches a model
// without this call, so the rule cannot be forgotten by the next test rather than
// broken on purpose.
export const LIVE_ENV = "HELM_LIVE_CLI_TESTS";

/** Did the caller ask for the expensive checks? */
export function liveRequested(argv = process.argv) {
  return argv.includes("--live") || process.env[LIVE_ENV] === "1";
}

/**
 * Skip unless live was asked for. `reason` completes the sentence "this check ...", and
 * is printed so the runner's summary names what was not run and why - a skip nobody can
 * read is how coverage disappears silently.
 *
 * `note` is for a check whose VALUE needs a sentence of its own - two of these are the
 * only measurement of something, and a reader deciding whether to spend the tokens needs
 * to know that. Printed under the skip line, and kept when this replaced their
 * hand-rolled gates so nothing they said was lost.
 */
export function requireLive(reason, note = null) {
  if (liveRequested()) {
    return;
  }
  console.log(`SKIPPED - this check ${reason}, so it spends tokens. Pass --live to run it.`);
  if (note) {
    console.log(`          ${note}`);
  }
  process.exit(0);
}
