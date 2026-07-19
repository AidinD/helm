// The append-system-prompt a second-mate launch carries, split by launch kind
// (task 9c358433).
//
// Verified on live transcripts: EVERY real second mate ground its whole
// assignment inline (up to 42 edits) with ZERO helm_dispatch calls - exactly the
// batch case ("work the Jot list", "take care of these N p0 tasks") the manual
// warns against. The delegation manual was only appended on a FRESH launch
// (`if (!resumeSessionId)`), but real second mates are almost always driven via
// jump-in/direct, so every turn passes resumeSessionId and the directive was
// never re-stated. (Note: --append-system-prompt is NOT written to the transcript,
// so the manual's absence can't be seen there - the behaviour is the signal.)
//
// Fix: a FRESH launch still gets the full manual; a RESUMED turn gets this
// condensed delegate-vs-do reminder, so the guardrail is present on EVERY turn
// (like the first mate's is structural) without re-sending the whole manual each
// turn. Kept tight on purpose - it's a per-turn token cost.
export const SECOND_MATE_RESUME_REMINDER = [
  "Reminder - you are a SECOND MATE, this project's coordinator (not a normal coding session).",
  "Before you edit files, decide delegate-vs-do. Your DEFAULT for real task work is to DISPATCH crew via helm_dispatch - one well-scoped autonomous run per task, each in its own worktree - then REVIEW each crew diff yourself.",
  "For a batch ('work the Jot list', 'take care of these N p0 tasks'): dispatch one run per task (disjoint files so they parallelize), don't grind them one by one in your own seat.",
  "Do it inline yourself ONLY when it's small/mechanical, still being scoped (scout first, then dispatch the shaped work), or when running-and-observing IS the point (verification, or a small bugfix of a crew diff).",
  "Grinding a whole assignment through your own session - many edits, no crew runs - is the miscalibration to avoid: it collapses the validate-crew role this Opus tier exists for. You hold the judgment; crew holds the keystrokes.",
].join(" ");

/**
 * Pick the append-system-prompt for a second-mate launch.
 * @param {string|null|undefined} resumeSessionId - set on a resumed/jump-in turn.
 * @param {string|undefined} fullManual - the full second-mate manual (fresh only).
 * @returns {string|undefined} the full manual on a fresh launch, the condensed
 *   reminder on a resume. undefined only if the full manual is unavailable on a
 *   fresh launch (never drops the reminder on resume).
 */
export function secondMateAppendPrompt(resumeSessionId, fullManual) {
  if (resumeSessionId) {
    return SECOND_MATE_RESUME_REMINDER;
  }
  return fullManual || undefined;
}
