/**
 * A model may propose which commits are a card's; only a person may say so.
 *
 * ## What this is protecting
 *
 * The window in commitCandidates.js narrows nothing when several cards share a period - five
 * cards created on one day are each offered the same eighty-odd commits. The only thing that
 * separates them is what the commits did, and reading that across a Swedish card and an
 * English commit is a model's job.
 *
 * Which puts a wrong answer one click away from a person reviewing the wrong diff while being
 * told it is the right one. That is worse than the blank page this replaces, so the seam
 * between "proposed" and "bound" is the thing worth testing, and it is tested without
 * spending a token: the prompt builder, the answer shaper and the binding store are all pure
 * or file-backed. The live model call is a separate, opt-in check.
 *
 * Run: node scripts/e2e/test-commit-match-and-bind.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMatchPrompt, shapeMatchAnswer, MATCH_SCHEMA, MATCH_SYSTEM } from "../../src/lib/commitMatch.js";
import { writeBinding, readBinding, removeBinding, boundCommits, bindingPath } from "../../src/lib/commitBindings.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const OFFERED = [
  { sha: "a".repeat(40), shortSha: "aaaaaaaa", subject: "fix(pricing): a flat rate with nothing under it charges nothing" },
  { sha: "b".repeat(40), shortSha: "bbbbbbbb", subject: "feat(reports): sort and filter the summary table" },
  { sha: "c".repeat(40), shortSha: "cccccccc", subject: "chore: regenerate the changelog" },
];

// --- the prompt carries what makes a cross-language pairing possible ----------------
{
  const card = {
    title: "Timrapporten visar fel för fast pris",
    description: "Ett fast arvode bokförs som om hela summan tjänats in direkt.",
    category: "Some Board",
  };
  const prompt = buildMatchPrompt(card, OFFERED);
  ok(prompt.includes(card.title), "the card's title is in the prompt");
  // The description is the half that makes a commit recognisable across the language gap: a
  // four-word title often shares nothing with an English subject, but the symptom does.
  ok(prompt.includes("Ett fast arvode"), "and its description, not just the title");
  for (const c of OFFERED) {
    ok(prompt.includes(c.shortSha) && prompt.includes(c.subject), `and commit ${c.shortSha} with its subject`);
  }
  // The instruction that stops "it is close in time" being offered as a reason.
  ok(/never for vocabulary in common|read for what the change DID/i.test(MATCH_SYSTEM), "the system prompt forbids matching on words");
  ok(/empty list/i.test(MATCH_SYSTEM), "and tells it that finding nothing is a real answer");
  ok(MATCH_SCHEMA.properties.matches.items.required.includes("why"), "and the schema makes a reason mandatory, not optional");
}

// --- a sha that was never offered cannot get through --------------------------------
// The dangerous failure, because it arrives with a confident reason attached and no basis.
{
  const answer = {
    matches: [
      { sha: "aaaaaaaa", confidence: "high", why: "it is the flat-rate booking bug" },
      { sha: "deadbeef", confidence: "high", why: "invented out of nowhere" },
    ],
  };
  const shaped = shapeMatchAnswer(answer, OFFERED);
  ok(shaped.proposals.length === 1, `only the offered commit survives (${shaped.proposals.length})`);
  ok(shaped.proposals[0].sha === "a".repeat(40), "and it carries the FULL sha, not the short one the model echoed");
  ok(shaped.invented === 1, "and the invented one is counted rather than silently dropped", `invented: ${shaped.invented}`);
}

// --- confidence orders the list, and a bad value does not become "high" --------------
{
  const answer = {
    matches: [
      { sha: "bbbbbbbb", confidence: "low", why: "maybe" },
      { sha: "aaaaaaaa", confidence: "high", why: "clearly" },
      { sha: "cccccccc", confidence: "nonsense", why: "?" },
    ],
  };
  const shaped = shapeMatchAnswer(answer, OFFERED);
  ok(shaped.proposals[0].confidence === "high", "the confident one comes first");
  const bad = shaped.proposals.find((x) => x.shortSha === "cccccccc");
  ok(bad.confidence === "low", "and an unrecognised confidence falls to low, never to high", bad.confidence);
}

// --- "nothing here" is carried, not turned into a guess ------------------------------
{
  const shaped = shapeMatchAnswer({ matches: [], unmatched: "None of these touch pricing." }, OFFERED);
  ok(shaped.proposals.length === 0, "an empty answer stays empty");
  ok(shaped.unmatched === "None of these touch pricing.", "and its reason is passed through", shaped.unmatched);
}

// --- the binding is a fact with an author -------------------------------------------
{
  const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-bind-"));
  const taskId = "0f1e2d3c-0000-4000-8000-000000000000";

  const unattributed = writeBinding(metaHome, taskId, { shas: ["a".repeat(40)], by: "" });
  ok(unattributed.ok === false, "a binding with no author is refused", unattributed.error);
  ok(/who made it|inference/i.test(unattributed.error), "and the refusal says why that matters");

  const empty = writeBinding(metaHome, taskId, { shas: [], by: "captain" });
  ok(empty.ok === false, "and one naming no commit is refused too");

  const good = writeBinding(metaHome, taskId, {
    projectPath: "D:/somewhere",
    shas: ["a".repeat(40), "not-a-sha", "b".repeat(40)],
    by: "captain",
    proposedBy: "claude-haiku-4-5-20251001",
  });
  ok(good.ok === true, "a real one is written", good.error || good.path);
  ok(good.shas.length === 2, "with the junk filtered out rather than stored", `${good.shas.length} kept`);

  const read = readBinding(metaHome, taskId);
  ok(read.by === "captain", "it reads back attributed to the person");
  // Provenance, and the reason it is separate from `by`: a model proposed, a person decided,
  // and a record that conflated them would let an inference read as a decision later.
  ok(read.proposedBy === "claude-haiku-4-5-20251001", "and remembers which model proposed it", read.proposedBy);

  // --- and this is what makes the diff resolvable -----------------------------------
  const noRecord = boundCommits(metaHome, taskId, null);
  ok(noRecord.source === "binding" && noRecord.shas.length === 2, "a card with no record resolves its commits from the binding", noRecord.source);
  const withRecord = boundCommits(metaHome, taskId, { commits: ["c".repeat(40)] });
  ok(withRecord.source === "record", "and a record still wins over a binding", withRecord.source);
  ok(withRecord.shas[0] === "c".repeat(40), "using the record's own commits");

  // A corrupt binding must not take a queue build down - the whole page depends on it.
  // Asked for rather than spelled out again: a check that hardcodes the path is a second
  // copy of the rule, and the two drift the first time the store moves.
  fs.writeFileSync(bindingPath(metaHome, taskId), "{ not json", "utf8");
  ok(readBinding(metaHome, taskId) === null, "a corrupt binding reads as no binding rather than throwing");
  ok(boundCommits(metaHome, taskId, null).source === "none", "and the card falls back to having none");

  removeBinding(metaHome, taskId);
  ok(readBinding(metaHome, taskId) === null, "and a removed binding is gone");
  fs.rmSync(metaHome, { recursive: true, force: true });
}

// --- the page asks on a click, never on a render ------------------------------------
// The passive-drain rule. A model call inside the queue build would spend tokens for as long
// as the Review page is open, and that has been a real accusation against this app once.
{
  const src = fs.readFileSync(new URL("../../src/lib/reviewQueueBuild.js", import.meta.url), "utf8");
  ok(!/commitMatch|matchCommits|askClaude/.test(src), "the queue build does not call a model");
  const renderer = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const call = renderer.indexOf("matchReviewCommits");
  ok(call > 0, "the renderer does call it");
  // It must sit inside a click handler. Checked by looking backwards for the nearest of the
  // two, rather than by trusting the code to be laid out the way it currently is.
  const before = renderer.slice(Math.max(0, call - 1200), call);
  ok(
    before.lastIndexOf('addEventListener("click"') > before.lastIndexOf("function render"),
    "and does so from a click handler, not from a render path"
  );
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: the model proposes with a reason, an invented sha cannot get through, and only an attributed binding is written.");
