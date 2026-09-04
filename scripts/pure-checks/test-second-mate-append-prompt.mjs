// Unit test (no app, no API): the second-mate append-system-prompt decision
// (task 9c358433). A FRESH launch gets the full manual; a RESUMED turn (the
// dominant jump-in/direct path) gets the condensed delegate-vs-do reminder, so
// the delegation guardrail is present on EVERY turn - not just the first, which
// is why real second mates ground whole assignments inline with zero dispatches.
//
// (The wiring - session:start/relay pass this to startSession, which pushes it as
// --append-system-prompt - is mechanical and covered by node --check; it can't be
// asserted via transcript because the CLI never logs the appended system prompt.)
//
// Run:  node scripts/e2e/test-second-mate-append-prompt.mjs
import { secondMateAppendPrompt, SECOND_MATE_RESUME_REMINDER } from "../../src/lib/secondMatePrompt.js";

let exitCode = 0;
function ok(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const FULL_MANUAL = "FULL SECOND MATE MANUAL ... Dispatch crew to do the actual work ...";

// Fresh launch (no resume) -> the full manual.
ok(secondMateAppendPrompt(null, FULL_MANUAL) === FULL_MANUAL, "fresh launch (no resume) gets the full manual");
ok(secondMateAppendPrompt(undefined, FULL_MANUAL) === FULL_MANUAL, "fresh launch (undefined resume) gets the full manual");

// Resumed turn -> the condensed reminder (NOT undefined, NOT the full manual).
const resumed = secondMateAppendPrompt("sess-123", FULL_MANUAL);
ok(resumed === SECOND_MATE_RESUME_REMINDER, "a resumed turn gets the condensed reminder, not the full manual");
ok(resumed !== undefined && resumed.length > 0, "the resumed turn's directive is never dropped (guardrail on every turn)");

// The reminder actually carries the delegate-to-crew directive that the real
// second mates were missing in practice.
ok(/helm_dispatch/.test(SECOND_MATE_RESUME_REMINDER), "the reminder names helm_dispatch (the crew-dispatch tool)");
ok(/SECOND MATE/.test(SECOND_MATE_RESUME_REMINDER), "the reminder re-states the second-mate role");
ok(/batch|Jot list|per task/i.test(SECOND_MATE_RESUME_REMINDER), "the reminder covers the batch case (the exact miscalibration observed)");

// Resume wins even if no manual was available (the reminder is self-contained).
ok(secondMateAppendPrompt("sess-x", undefined) === SECOND_MATE_RESUME_REMINDER, "resume still gets the reminder even when the full manual is unavailable");
// Fresh with no manual degrades to undefined (nothing to append), never throws.
ok(secondMateAppendPrompt(null, undefined) === undefined, "fresh with no manual -> undefined (safe, no throw)");

console.log(exitCode === 0 ? "VERIFY OK: second-mate turns always carry the delegation directive - full manual fresh, condensed reminder on resume (9c358433)." : "VERIFY FAILED.");
process.exit(exitCode);
