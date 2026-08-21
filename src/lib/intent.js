// The ask behind the work - captured BEFORE it, reviewed AGAINST (the captain, 2026-08-21:
// "alla tasks kommer ju från en uppgift ... till slut hamnar det som en klar intent.
// Den här intentet ska sparas").
//
// WHY THIS IS NOT THE ACCEPTANCE CRITERIA. They are deliberately two things, and the
// distinction is the whole point:
//
//   intent - what was asked, and why. Prose. NOT checkable.
//   AC     - how we will know it is met. One line, linked to a test step. Checkable.
//
// A piece of work can satisfy every criterion it was given and still answer the wrong
// question, because the criteria were derived from the same misreading as the code. The
// intent is the only artifact that can catch that, and it can only catch it if the
// reviewer is shown it - which, measured 2026-08-21, it never was: the reviewer's brief
// carried the title, the author's account of what was done, its evidence, its gaps and
// its checks, and none of its four instructions asked whether that was what was wanted.
//
// WHY IT LIVES IN THE JOT DESCRIPTION, as `INTENT:` lines. Same three reasons acceptance.js
// gives for the same choice, and they hold identically here:
//   - Jot is a shipped public app; Helm must not bolt private schema onto its data.
//   - the captain has to be able to CORRECT the intent before the work starts, which means it
//     has to be visible where he already looks at the task.
//   - One home, so the task and the intent cannot drift apart.
//
// AND THE HONEST LIMIT, which no code here can close: an intent I wrote is my paraphrase
// of what he said, so a reviewer given it inherits my misreading. Two things bound that
// and neither is a guarantee. It sits in Jot where he can rewrite it, and the record
// records WHOSE words it is (`source`), so a card can say "this is my reading of the ask"
// instead of presenting it as the ask itself.
//
// The parse is strict, like a git trailer - not prose. A description that merely talks
// about goals has no intent as far as this file is concerned, which is correct: the value
// is in having written the sentence down deliberately.

const INTENT_LINE = /^\s*INTENT\s*:\s*(.*?)\s*$/i;

/** Where an intent's words came from. Ordered most to least trustworthy. */
export const INTENT_SOURCES = Object.freeze(["captain", "goal", "assistant"]);

/**
 * The whole visible intent line the card shows. Longer than a chat sentence and much
 * shorter than a paragraph: two rows on the card, "asked" over "done", is the shape
 * that made review readable at all, and a wall of text in the top row undoes it.
 *
 * `summary` (what was done) is capped at 240 by READABILITY_LIMITS. This is the same
 * number on purpose - the two rows are read as a pair, and one of them running four
 * times longer than the other is what makes a card look like homework.
 */
export const INTENT_MAX_CHARS = 240;

/**
 * Pull the intent out of a Jot task description.
 *
 * Several `INTENT:` lines join into one text with a space, so a two-sentence ask can be
 * written on two lines without inventing a continuation syntax.
 *
 * @param {string} description
 * @returns {string} the intent, or "" when the description states none
 */
export function parseIntent(description) {
  if (!description || typeof description !== "string") {
    return "";
  }
  const parts = [];
  for (const line of description.split(/\r?\n/)) {
    const m = line.match(INTENT_LINE);
    if (!m) {
      continue;
    }
    const text = m[1].trim();
    // An empty "INTENT:" is someone gesturing at the idea without stating it - the exact
    // thing this exists to prevent - so it contributes nothing. hasEmptyIntentLine reports
    // it separately, so the difference between "none written" and "written blank" survives.
    if (text) {
      parts.push(text);
    }
  }
  return parts.join(" ").trim();
}

/** True if the description has an `INTENT:` line that states nothing. */
export function hasEmptyIntentLine(description) {
  if (!description || typeof description !== "string") {
    return false;
  }
  return description.split(/\r?\n/).some((l) => /^\s*INTENT\s*:\s*$/i.test(l));
}

/**
 * True when an `INTENT:` line looks like it CONTINUES onto the next line without the
 * prefix - so half the ask is silently outside the intent.
 *
 * Found the hard way, on the first two cards ever written under this rule: I wrapped the
 * sentence at the margin, prefixed only the first line, and the parser kept the first
 * half. The drift detector caught it there only because a record already existed to
 * disagree with; on a task at work-START, which is when intents are actually written,
 * nothing would have said a word and the reviewer would have been handed half a question.
 *
 * Deliberately narrow, because a false positive here is a caveat nobody should see. All
 * four conditions must hold: the intent line does not end in sentence punctuation, the
 * next line is non-blank, it is not itself a trailer, and it starts LOWERCASE. That last
 * one is what separates a wrapped sentence from the ordinary next paragraph - status
 * notes in these descriptions start "LÖST", "BYGGT", "SLICE 2 KVAR".
 */
export function hasOrphanedIntentContinuation(description) {
  if (!description || typeof description !== "string") {
    return false;
  }
  const lines = description.split(/\r?\n/);
  return lines.some((line, i) => {
    const m = line.match(INTENT_LINE);
    if (!m || !m[1].trim()) {
      return false;
    }
    if (/[.!?:]$/.test(m[1].trim())) {
      return false;
    }
    const next = lines[i + 1];
    if (next === undefined) {
      return false;
    }
    const t = next.trim();
    // A trailer of any kind is a new statement, not a continuation.
    if (!t || /^[A-Z][A-Z-]*\s*:/.test(t) || INTENT_LINE.test(next)) {
      return false;
    }
    return /^\p{Ll}/u.test(t);
  });
}

/**
 * Cut an intent down to what the card can show, on a word boundary.
 *
 * Only for text Helm did not author - an autopilot's goal, which is whatever length it
 * was written at. A HAND-written intent over the limit is refused instead, with a message
 * saying to shorten it: silently truncating the author's own sentence would leave the card
 * showing half an ask and nobody knowing the other half existed.
 */
export function clampIntentText(text, max = INTENT_MAX_CHARS) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (t.length <= max) {
    return t;
  }
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // The ellipsis is the point: it says out loud that there is more, so nobody reads a
  // trimmed goal as the whole ask.
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The intent as a record carries it: the words, and whose words they are.
 *
 * Accepts a bare string, because a record is hand-authored JSON and the shape that is
 * easiest to write is the shape that gets written. An unattributed intent is read as
 * `assistant` - the least trustworthy reading of the three, deliberately: guessing
 * "captain" would turn my paraphrase into his stated ask on the strength of a missing
 * field, and that is precisely the confusion the `source` field exists to prevent.
 *
 * @param {string|{text?: string, source?: string}} value
 * @returns {{text: string, source: string}|null}
 */
export function normalizeIntent(value) {
  if (!value) {
    return null;
  }
  const text = String(typeof value === "string" ? value : value.text || "").trim();
  if (!text) {
    return null;
  }
  const raw = typeof value === "string" ? "" : String(value.source || "").trim().toLowerCase();
  return { text, source: INTENT_SOURCES.includes(raw) ? raw : "assistant" };
}

/** How to describe an intent's provenance on screen, in plain words. */
export function intentSourceNote(source) {
  switch (source) {
    case "captain":
      return "the captain's own words.";
    case "goal":
      return "The goal the autopilot was given, written before the run.";
    default:
      // Not hedging for its own sake: a reviewer and a reader both need to know that
      // agreeing with this sentence is not the same as agreeing with what he asked for.
      return "My reading of the ask, not confirmed by the captain - correct it in the task if it is wrong.";
  }
}

/**
 * Has the task's intent changed since the record snapshotted it?
 *
 * Reported, never auto-resolved, exactly like acceptanceDrift - but here it usually means
 * something specific and good: the captain corrected the ask. Either the work needs revisiting
 * or the record does, and only he knows which.
 *
 * @param {object} rec
 * @param {string} taskDescription
 */
export function intentDrift(rec, taskDescription) {
  const snapshot = normalizeIntent(rec?.intent);
  const live = parseIntent(taskDescription);
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  // Drift needs BOTH sides. Two absences, each of which is not a change:
  //
  // No live `INTENT:` line - most tasks predate this, and reporting every one of them as
  // "the ask moved" is the same noise that made the review page unreadable.
  //
  // No SNAPSHOT - a record written before intents existed never had an ask to move. Adding
  // one to the task is the ask being WRITTEN DOWN, not rewritten, and the two are
  // different. This was wrong on the first real use: backfilling an intent onto the five
  // cards already in review lit all five with "what was asked for changed", which is false
  // and is exactly the noise being removed. The card already carries the honest signal for
  // this case - it marks the ask as read from the task rather than snapshotted at handoff.
  //
  // Either way, `drifted: false` here means "nothing to compare", never "they agree".
  if (!live || !snapshot) {
    return { drifted: false, snapshot: snapshot?.text || "", live };
  }
  return {
    drifted: norm(snapshot?.text) !== norm(live),
    snapshot: snapshot?.text || "",
    live,
  };
}
