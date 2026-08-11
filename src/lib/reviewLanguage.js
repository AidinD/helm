/**
 * What language a review should be WRITTEN in, and in what register.
 *
 * the captain, task 7bd1e2df: "Review borde vara skriven på samma språk som prompten - och
 * dessutom borde den vara lättare att förstå, mindre teknisk." Both halves are about
 * the same failure: the independent reviewer's verdict is the one artifact on the
 * Review page written FOR him rather than for the code, and it came back in English
 * jargon because everything a reviewer reads (the diff, the record, the brief itself)
 * is in English. Nothing ever told it otherwise, so it matched its input instead of
 * its reader.
 *
 * The language is DETECTED and then stated flatly in the brief rather than asked for
 * as "the same language as the task". "Same language as" is ambiguous when the task
 * title is Swedish and the code it points at is English - and the model resolves that
 * ambiguity towards English every time. A named language cannot be resolved wrongly.
 *
 * Detection is deliberately a two-language question (Swedish or English), because
 * those are the only two languages this board is written in. A wrong guess is cheap
 * and visible - the verdict comes back in the other language and can be re-run - so
 * a heuristic is the right size of solution here; an LLM call to classify a sentence
 * would cost tokens on every dispatch to answer a question a regex answers.
 */

/** Swedish function words that are rare-to-absent in English text. */
const SV_WORDS = [
  "och", "att", "inte", "jag", "det", "som", "för", "med", "på", "är", "en", "ett",
  "den", "de", "vi", "kan", "ska", "vill", "borde", "men", "till", "från", "om",
  "har", "blir", "gör", "när", "så", "eller", "man", "hur", "varför", "dessa",
];

/**
 * "sv" or "en" for a piece of prose.
 *
 * Swedish wins on either signal: a Swedish-only letter, or two or more Swedish
 * function words. Two rather than one because "en", "om", "man", "de" and "har" are
 * all also English words, so a single hit is noise; a pair of them in one short task
 * title effectively never happens in English.
 *
 * @param {string} text
 * @returns {"sv"|"en"}
 */
export function detectLanguage(text) {
  const s = String(text || "");
  if (!s.trim()) {
    return "en";
  }
  if (/[åäöÅÄÖ]/.test(s)) {
    return "sv";
  }
  const words = s.toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  const set = new Set(words);
  let hits = 0;
  for (const w of SV_WORDS) {
    if (set.has(w)) {
      hits += 1;
    }
  }
  return hits >= 2 ? "sv" : "en";
}

/** The human name of a language code, for putting in a prompt. */
function languageName(code) {
  return code === "sv" ? "Swedish" : "English";
}

/**
 * The lines a review brief needs so its verdict comes back readable.
 *
 * Returned as an array of lines (not a paragraph) so a brief can splice them in at
 * the point where the writing instructions belong - which is at the END, next to
 * "write your verdict to this file", not buried above the investigation steps where
 * the model has a page of technical instruction to forget them by.
 *
 * The tone half is written as concrete rules rather than "be less technical",
 * because "less technical" is exactly the kind of instruction a model satisfies by
 * adding an introductory sentence and changing nothing else. Naming the artifacts
 * that must survive (file:line, the command you ran) matters as much as naming what
 * must go: a plain-language verdict that drops its evidence is a worse review, not a
 * friendlier one.
 *
 * @param {string} sample prose whose language the verdict should match - the task
 *   title and description, or the commit message. NOT the diff.
 * @returns {string[]}
 */
export function reviewWritingBriefLines(sample) {
  const lang = languageName(detectLanguage(sample));
  return [
    `HOW TO WRITE IT - this matters as much as what you find:`,
    ``,
    `- Write the verdict in ${lang}. The task was written in ${lang}, and the verdict is`,
    `  read by the person who wrote the task, not by the code. Keep code identifiers,`,
    `  file paths, commands and quoted output exactly as they are - do not translate those.`,
    `- Write it for someone who knows this app well but has NOT just read this diff.`,
    `  Lead each finding with what actually goes wrong for a user of the app, then the`,
    `  technical cause. Not the other way round.`,
    `- No jargon where a plain word exists, and no unexplained internal names: the first`,
    `  time you name a function, a module or a flag, say in half a sentence what it does.`,
    `- Short paragraphs and plain sentences. Do not pad it with structure - a wall of`,
    `  nested headings is not clearer than four sentences that say the same thing.`,
    `- Keep every concrete thing: file:line references, the exact commands you ran, and`,
    `  their real output. Plain language means fewer abstractions, not less evidence.`,
  ];
}
