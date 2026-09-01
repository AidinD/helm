/**
 * Ask a model which commits belong to a card - and treat the answer as a proposal.
 *
 * ## Why a model, when a window was cheaper
 *
 * The window (commitCandidates.js) narrows nothing when several cards share a period. Five
 * cards created on one day are each offered the same eighty-odd commits, and the row says so
 * rather than implying otherwise. The only thing that separates them is what the commits
 * actually did, which is a reading task.
 *
 * And it has to be a reading task rather than a matching one, because the house rule is
 * Swedish for cards and English for anything committed. A card and its own commit routinely
 * share not one token - the same fact stated twice in two languages. Every cheap lexical
 * score is therefore not just weak here, it is blind.
 *
 * ## What it is allowed to conclude
 *
 * Nothing on its own. It returns a ranked proposal with a confidence and a reason per
 * commit, and the reason has to be about the commit's own content - a reason a person can
 * disagree with in one read. Writing the binding is a separate, human step
 * (commitBindings.js), and the model's name is recorded on it as the proposer, never as the
 * author.
 *
 * That is not caution for its own sake. A wrong pairing accepted silently sends somebody to
 * review a diff that is not the change, while telling them it is - strictly worse than
 * showing them nothing, which is what the page did before any of this.
 *
 * ## Cost
 *
 * One call per card, on demand, never on a queue build. The queue is rebuilt on every visit
 * to the page and on every refresh; a model call in that path would spend tokens for as long
 * as the window is open, which is the passive drain this app has already been accused of
 * once. Haiku by default: the input is a card and a list of commit subjects, and the job is
 * reading comprehension rather than judgement.
 */

/** The shape the CLI validates the answer against, so a malformed reply is the CLI's problem. */
export const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sha", "confidence", "why"],
        properties: {
          sha: { type: "string", description: "the short sha exactly as it was given" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string", description: "what in this commit connects it to the card" },
        },
      },
    },
    unmatched: {
      type: "string",
      description: "if none of the commits look like this card, say so in one sentence",
    },
  },
};

export const MATCH_SYSTEM =
  "You pair a task card against a list of git commits from the same repository and say which " +
  "commits are that card's work.\n\n" +
  "The card is usually written in Swedish and the commits in English. They will often share " +
  "no words at all - the same change described twice, in two languages, by two conventions. " +
  "So read for what the change DID, never for vocabulary in common.\n\n" +
  "Return only commits you can justify from their own subject. A reason like \"it is close in " +
  "time\" or \"it is in the same area\" is not a reason - the caller already knows the time and " +
  "the repository, and offered you these commits for that reason. If nothing here looks like " +
  "the card, return an empty list and say so; that is a useful answer and a guess is not. " +
  "Somebody will read the diff you point at, so pointing at the wrong one costs them more " +
  "than pointing at nothing.";

/**
 * The prompt for one card.
 *
 * The card's own description comes along, not just the title: a title is often four words
 * and the description is where the symptom and the file are named, which is what makes a
 * commit recognisable across the language gap.
 *
 * @param {{ title: string, description?: string | null, category?: string | null }} card
 * @param {Array<{ shortSha: string, subject: string, at?: number }>} commits
 * @param {{ maxDescription?: number }} [options]
 * @returns {string}
 */
export function buildMatchPrompt(card, commits, { maxDescription = 2000 } = {}) {
  const title = String(card?.title || "").trim() || "(untitled)";
  const description = String(card?.description || "").trim().slice(0, maxDescription);
  const lines = [];
  lines.push("## The card");
  lines.push("");
  lines.push(`Title: ${title}`);
  if (card?.category) {
    lines.push(`Board: ${card.category}`);
  }
  if (description) {
    lines.push("");
    lines.push("Description:");
    lines.push(description);
  }
  lines.push("");
  lines.push("## The commits, newest first");
  lines.push("");
  for (const c of commits) {
    lines.push(`${c.shortSha}  ${String(c.subject || "").trim()}`);
  }
  lines.push("");
  lines.push(
    "Which of these commits is this card's work? Give the short sha exactly as written above, " +
      "a confidence, and what in the commit itself connects it to the card."
  );
  return lines.join("\n");
}

/**
 * Turn a model answer into proposals, dropping anything that does not correspond to a commit
 * that was actually offered.
 *
 * A model naming a sha that was not in the list is not a small formatting problem: it means
 * the answer is about something other than the question, and passing it through would put a
 * commit in front of somebody with a reason attached and no basis. Dropped rather than
 * repaired, and counted so the caller can say it happened.
 *
 * @param {any} answer the validated object from the model
 * @param {Array<{ shortSha: string, sha: string, subject: string }>} offered
 * @returns {{ proposals: Array<{ sha: string, shortSha: string, subject: string, confidence: string, why: string }>, invented: number, unmatched: string | null }}
 */
export function shapeMatchAnswer(answer, offered) {
  const bySha = new Map();
  for (const c of offered) {
    bySha.set(String(c.shortSha).toLowerCase(), c);
    bySha.set(String(c.sha).toLowerCase(), c);
  }
  const proposals = [];
  let invented = 0;
  const seen = new Set();
  for (const m of Array.isArray(answer?.matches) ? answer.matches : []) {
    const key = String(m?.sha || "").trim().toLowerCase();
    const commit = bySha.get(key);
    if (!commit) {
      invented += 1;
      continue;
    }
    if (seen.has(commit.sha)) {
      continue;
    }
    seen.add(commit.sha);
    proposals.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      confidence: ["high", "medium", "low"].includes(m.confidence) ? m.confidence : "low",
      why: String(m.why || "").trim(),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  proposals.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  const unmatched = typeof answer?.unmatched === "string" && answer.unmatched.trim() ? answer.unmatched.trim() : null;
  return { proposals, invented, unmatched };
}
