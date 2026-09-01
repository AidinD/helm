/**
 * A usage limit must survive the trip from the CLI's answer to the classifier that reads it.
 *
 * ## What the card measured, and what the measurement actually meant
 *
 * Card 95a06783: zero runs have ever been classified `quota_exhausted`, and zero carry an
 * error matching the quota pattern - while the captain's own scheduled prompt records two
 * autopilots dying because he ran out of tokens. The classifier looked right, so the card
 * asked which of two things was true: the error never reaches it, or the run leaves by
 * another door first.
 *
 * Checking the installed history on 2026-09-01 answered a prior question the card had not
 * asked. Of 56 runs, 16 stopped at `two_consecutive_failures` and NOT ONE carries any error
 * text at all - only 5 records in the whole file have an `error`, and all five are a run
 * that never started (a missing notes.md, a path that was not a repository). The run-level
 * error field is written only when runGoal itself throws; an iteration's error was returned
 * to the caller and dropped on the floor.
 *
 * So "zero runs match the quota pattern" was never evidence that quota had not killed one.
 * It was evidence that the field where the answer would have been written is empty for
 * precisely the runs that would carry it.
 *
 * ## The hole this found on the way in
 *
 * The envelope reader only reached for the CLI's text once it had already decided the
 * envelope looked like an error - is_error true, or an error subtype, or a string `error`
 * field. An envelope reporting subtype "success", carrying a usage-limit sentence in
 * `result` and no structured output, fell past all three and became the generic "did not
 * match the expected schema". The quota phrasing was dropped one line before the classifier
 * that exists to recognise it.
 *
 * This does NOT close the card. Reproducing a real exhaustion is still the only way to know
 * what the CLI actually emits, and that needs a spent quota. What it does is make the
 * question answerable next time instead of leaving it a matter of opinion.
 *
 * Run: node scripts/e2e/test-quota-reaches-the-classifier.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isResumableQuotaError, lastFailureOf } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "..", "src", "lib", "goalOrchestrator.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");

// --- the classifier recognises the phrasings that actually occur -----------------------------
{
  const quota = [
    "Claude usage limit reached. Your limit will reset at 3pm.",
    "You've hit your 5-hour limit",
    "rate_limit_error: Number of requests has exceeded your rate limit",
    "429 Too Many Requests",
    "529 overloaded_error",
    "Your credit balance is too low to access the Anthropic API",
  ];
  for (const text of quota) {
    ok(isResumableQuotaError(text), `recognised as resumable: "${text.slice(0, 48)}"`);
  }
  // The other direction matters just as much: a real failure classified as quota keeps a
  // broken run's worktree and lets it auto-resume in a loop.
  const notQuota = [
    "Error: insufficient permissions to write to that path",
    "RangeError: Maximum call stack size exceeded",
    "npm ERR! code ELIFECYCLE",
    "The iteration reported failure without saying why.",
  ];
  for (const text of notQuota) {
    ok(!isResumableQuotaError(text), `not mistaken for quota: "${text.slice(0, 48)}"`);
  }
}

// --- the envelope reader hands it the text at all ---------------------------------------------
{
  // The exact shape that fell through: no structured output, no error flag, the sentence
  // sitting in `result`.
  ok(
    /const envelopeText = String\(parsed\.error \|\| parsed\.result \|\| subtype \|\| ""\);/.test(src),
    "the envelope's text is read unconditionally, not only when it already looks like an error"
  );
  ok(
    !/parsed\.is_error === true \|\|[\s\S]{0,200}\? String\(parsed\.error/.test(src),
    "and the old looks-like-an-error gate in front of it is gone"
  );
  // Simulating the reader over the real shapes, because a source assertion alone says
  // nothing about what the expression produces.
  const envelopeTextOf = (parsed) => {
    const subtype = parsed.subtype === "success" ? "" : parsed.subtype;
    return String(parsed.error || parsed.result || subtype || "");
  };
  const quietLimit = { type: "result", subtype: "success", is_error: false, result: "Claude usage limit reached. Your limit will reset at 3pm." };
  ok(isResumableQuotaError(envelopeTextOf(quietLimit)), "a usage limit reported under subtype \"success\" still reaches the classifier");
  const loudLimit = { type: "result", subtype: "error_during_execution", is_error: true, error: "429 Too Many Requests" };
  ok(isResumableQuotaError(envelopeTextOf(loudLimit)), "and so does one reported as an outright error");
  const genuineMismatch = { type: "result", subtype: "success", is_error: false, structured_output: null };
  // Reading the subtype unconditionally turned this into the error text "Iteration
  // errored: success", which is worse than the generic message it replaced.
  ok(envelopeTextOf(genuineMismatch) === "", "while an envelope that really says nothing produces no text to misread");
  ok(/parsed\.subtype === "success" \? "" : parsed\.subtype/.test(src), "because a subtype of \"success\" is not an error message");
}

// --- a failed run records what failed -----------------------------------------------------------
{
  ok(lastFailureOf([]) === null, "a run with no iterations has no last failure");
  ok(lastFailureOf([{ iteration: 1, ok: true, result: { success: true } }]) === null, "and neither has one that succeeded");

  const hard = lastFailureOf([
    { iteration: 1, ok: true, result: { success: true } },
    { iteration: 2, ok: false, error: "Iteration errored: Claude usage limit reached. Your limit will reset at 3pm." },
  ]);
  ok(!!hard && hard.iteration === 2, "a hard process error is recorded, with its iteration number");
  ok(!!hard && isResumableQuotaError(hard.error), "and the text survives intact enough to classify");

  // The second failure shape. Only counting the first would move the hole one branch along.
  const soft = lastFailureOf([{ iteration: 1, ok: true, result: { success: false, summary: "The build never compiled." } }]);
  ok(!!soft && /never compiled/.test(soft.error), "an iteration that reported failure is recorded too, by its summary");

  // The LAST one, not the first: a run that failed, recovered and failed again should
  // report the failure that stopped it.
  const latest = lastFailureOf([
    { iteration: 1, ok: false, error: "first failure" },
    { iteration: 2, ok: true, result: { success: true } },
    { iteration: 3, ok: false, error: "the one that stopped it" },
  ]);
  ok(!!latest && /stopped it/.test(latest.error), "the most recent failure wins, not the first");

  ok(/lastFailure: lastFailureOf\(iterations\)/.test(src), "runGoal returns it");
  ok(/lastFailure: result\?\.lastFailure \|\| null/.test(mainSrc), "and the persisted record keeps it - which is the whole point, since the return value was never the missing half");
}

console.log("");
console.log(
  exit === 0
    ? "VERIFY OK: a usage limit reaches the classifier whatever the envelope calls itself, and a failed run now records what failed."
    : "VERIFY FAILED."
);
process.exit(exit);
