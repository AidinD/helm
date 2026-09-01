/**
 * Can the model actually pair a Swedish card against English commits? Asked, not assumed.
 *
 * ## Why this exists on top of the offline check
 *
 * test-commit-match-and-bind proves the wiring: an invented sha cannot get through, a
 * binding needs an author, the queue build spends nothing. It proves nothing about the
 * READING, which is the entire premise - that a model can see through a card written in
 * Swedish to a commit written in English, where the two share no vocabulary at all.
 *
 * ## The control, and why it is the whole point
 *
 * Run against real cards on 2026-09-01, the first two answers were both "none of these look
 * like this card". Very likely correct - and indistinguishable from a model that always
 * declines. A check that only ever asked those would have reported success while measuring
 * a refusal reflex.
 *
 * So this asks about a pairing whose answer is known, at full cross-language strength: a card
 * about "rösten" in "ett paketerat Helm", against this repo's own commits, one of which is
 * unmistakably its work while containing no Swedish and no word the card uses.
 *
 * Measured when it was written: it picked that commit at HIGH confidence, and it picked
 * BETTER than the person writing this check - the expected answer here was the packaged
 * verification follow-up, and the model put the primary commit first.
 *
 * Spawns the real CLI and costs money (about $0.05 for twenty commits), so it is OPT-IN:
 *   node scripts/e2e/test-commit-match-live.mjs --live
 * Without the flag it SKIPS LOUDLY.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireLive } from "./live-gate.mjs";
requireLive("asks a real model to pair a card against this repo's commits");

import { buildMatchPrompt, shapeMatchAnswer, MATCH_SCHEMA, MATCH_SYSTEM } from "../../src/lib/commitMatch.js";
import { ask } from "keel/claude";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// The card as it was written on the board. Kept as a literal rather than read from Jot: the
// board changes, and a control whose expected answer can drift is not a control.
const CARD = {
  title: "Rösten har aldrig fungerat i ett paketerat Helm - den letar inuti app.asar",
  description:
    "INTENT: Den installerade Helm ska kunna transkribera, eller åtminstone säga att den inte kan - inte tyst " +
    "låtsas att funktionen finns.\n\n" +
    "whisperRoot() går tre nivåer upp från sin egen filplats. Rätt i en utcheckning. I ett paketerat bygge ligger " +
    "modulen i resources/app.asar/node_modules/keel/src/whisper, så tre nivåer upp blir en mapp som inte finns.\n\n" +
    "AC: ett paketerat bygge hittar motorn, eller säger tydligt varför inte.",
  category: "Helm",
};

// The commit that answers it, found by its subject rather than pinned by sha - a sha written
// down here would stop existing the next time this history is rewritten, which has already
// happened to one check in this suite.
const SUBJECT = "Let Helm say where its own transcription engine is";

function log(n) {
  const raw = execFileSync("git", ["-C", repo, "log", "--no-merges", `--max-count=${n}`, "--pretty=format:%H%x1f%s"], {
    encoding: "utf8",
  });
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\x1f");
      return { sha, shortSha: sha.slice(0, 8), subject: rest.join("\x1f") };
    });
}

const commits = log(20);
const expected = commits.find((c) => c.subject.includes(SUBJECT));
if (!expected) {
  // Not a failure: the commit has simply aged out of the window. Saying so is very different
  // from reporting the model broken, and both differ from passing.
  console.log(`SKIP - "${SUBJECT}" is no longer in the last 20 commits, so there is no known answer to check against.`);
  process.exit(0);
}
console.log(`asking about ${commits.length} commits; the known answer is ${expected.shortSha}\n`);

const answer = await ask({
  prompt: buildMatchPrompt(CARD, commits),
  model: "claude-haiku-4-5-20251001",
  system: MATCH_SYSTEM,
  schema: MATCH_SCHEMA,
});
ok(answer.ok, "the model answered at all", answer.ok ? `${answer.model}, $${(answer.costUsd || 0).toFixed(4)}` : answer.reason);
if (!answer.ok) {
  process.exit(1);
}

const shaped = shapeMatchAnswer(answer.value, commits);
ok(shaped.invented === 0, "and named only commits that were actually offered", `invented: ${shaped.invented}`);
ok(shaped.proposals.length > 0, "it did NOT simply decline - which is what a broken reading looks like");

const hit = shaped.proposals.find((p) => p.sha === expected.sha);
ok(!!hit, `it found the commit a person would pick (${expected.shortSha})`);
ok(hit?.confidence === "high" || hit?.confidence === "medium", "and did not bury it at low confidence", hit?.confidence);

// The reason has to be about the change. "It is recent" or "same repository" would mean the
// answer came from the ordering rather than the reading, and the ordering is the caller's.
ok(
  !!hit && hit.why.length > 20 && !/recent|same (repo|project)|close in time/i.test(hit.why),
  "and its reason is about what the commit did, not about when it landed",
  hit?.why
);

// The cross-language claim, stated as a measurement rather than an assumption: the card and
// the commit really do share no meaningful word.
{
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-zåäö]{5,}/g) || []);
  const cardWords = words(`${CARD.title} ${CARD.description}`);
  const shared = [...words(expected.subject)].filter((w) => cardWords.has(w));
  ok(shared.length === 0, "and it did so with no word in common between card and commit", shared.join(", ") || "none");
}

console.log("\nwhat it proposed:");
for (const p of shaped.proposals) {
  console.log(`  [${p.confidence}] ${p.shortSha}  ${p.subject}`);
  console.log(`         ${p.why}`);
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a Swedish card and an English commit that share no word were paired, with a reason about the change.");
