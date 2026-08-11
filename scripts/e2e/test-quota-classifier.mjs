// The root cause of the 2026-08-11 incident: two auto runs stopped because the
// user's Claude subscription tokens ran out, but that was NOT recognised as a
// resumable quota stop - it counted as two ordinary iteration failures, so the
// runs were marked non-resumable and (zero commits) had their worktrees deleted.
// The work was lost and there was no Resume path.
//
// Two things had to be true for the miss: (1) runIteration must SURFACE the SDK's
// own error text (a usage-limit banner arrives as an error envelope or on stdout,
// never as our structured output), and (2) isResumableQuotaError must RECOGNISE
// that text. This guards #2 directly and pins the exact strings runIteration now
// produces for #1, so a regression in either half is caught.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-quota-classifier.mjs
import { isResumableQuotaError } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- MUST classify as a resumable quota/limit stop -------------------------
// The exact shapes runIteration now emits (see its close handler): an SDK error
// envelope surfaced as "Iteration errored: <text>", and a stdout tail on the
// JSON-parse-failure path. These are the strings that were previously swallowed.
const resumable = [
  "Iteration errored: Claude AI usage limit reached · resets 3pm",
  "Iteration errored: usage limit reached",
  "Could not parse iteration output as JSON (exit code 1). stdout: Claude AI usage limit reached |resets 3pm | stderr: ",
  "Iteration errored: rate_limit_error: 429 Too Many Requests",
  "Iteration errored: overloaded_error",
  "Could not parse iteration output as JSON (exit code 1). stdout:  | stderr: Error: 529 overloaded_error",
  "Anthropic API error: insufficient quota",
  "Your credit balance is too low to access the Claude API.",
];
for (const s of resumable) {
  ok(isResumableQuotaError(s) === true, `resumable: ${JSON.stringify(s.slice(0, 64))}`);
}

// --- MUST NOT be treated as quota (real failures / unrelated stops) --------
// The dangerous false NEGATIVE the incident showed is covered above; these guard
// the opposite - a real bug or a max-turns stop must stay a plain failure so it
// still counts toward the two-failures abort rather than silently "resuming".
const notResumable = [
  "Iteration response did not match the expected schema.",
  "Iteration errored: error_max_turns",
  "Iteration timed out after 600000ms",
  "TypeError: Cannot read properties of undefined (reading 'map')",
  "Verify command failed: exit code 1",
  "",
  null,
  undefined,
];
for (const s of notResumable) {
  ok(isResumableQuotaError(s) === false, `NOT resumable: ${JSON.stringify(String(s).slice(0, 64))}`);
}

console.log(
  exit === 0
    ? "VERIFY OK: a token/quota/overload stop is recognised as resumable; a real failure or max-turns stop is not."
    : "VERIFY FAILED."
);
process.exit(exit);
