/**
 * A finding must land on a line the diff actually changed, or it must not survive.
 *
 * ## What this is for
 *
 * The second diff view the captain asked for: "en diff med bara de delar som AI bedömt som behöver
 * second opinion". Its whole value is that the warning sits next to the line that earned it.
 * A finding anchored to the wrong place is worse than no finding - it puts a warning beside
 * innocent code and, in doing so, takes attention off whatever actually deserved it.
 *
 * ## Why snippets and not line numbers
 *
 * Asking a model for a line number is asking it to count, and that is the thing it is worst
 * at. A snippet is self-verifying: it either appears in that file's changed lines or it does
 * not, and "does not" is a fact rather than a judgement. Every case below is about that seam.
 *
 * Offline - no model, no app. The live behaviour has its own opt-in check.
 *
 * Run: node scripts/e2e/test-diff-attention.mjs
 */
import fs from "node:fs";
import {
  buildAttentionPrompt,
  shapeAttentionAnswer,
  changedLinesByFile,
  ATTENTION_SCHEMA,
  ATTENTION_SYSTEM,
  MAX_DIFF_CHARS,
} from "../../src/lib/diffAttention.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const DIFF = [
  "diff --git a/src/rate.js b/src/rate.js",
  "index 111..222 100644",
  "--- a/src/rate.js",
  "+++ b/src/rate.js",
  "@@ -1,4 +1,5 @@",
  " export function charge(order) {",
  "-  return order.hours * order.rate;",
  "+  const rate = order.rate ?? fallbackRate;",
  "+  return order.hours * rate;",
  " }",
  "diff --git a/src/report.js b/src/report.js",
  "index 333..444 100644",
  "--- a/src/report.js",
  "+++ b/src/report.js",
  "@@ -10,3 +10,4 @@",
  " function total(rows) {",
  "+  rows = rows.filter((r) => r.billable);",
  "   return rows.length;",
  " }",
].join("\n");

// --- what the model is given -----------------------------------------------------
{
  const { prompt, truncated } = buildAttentionPrompt(DIFF, { title: "Fast pris bokförs fel", description: "Ett fast arvode." });
  ok(prompt.includes("Fast pris bokförs fel"), "the card's intent goes with the diff");
  // Without it, findings drift into style: a diff read with no idea what it was for has
  // nothing to judge relevance against.
  ok(prompt.includes("Ett fast arvode"), "including its description");
  ok(prompt.includes("const rate = order.rate ?? fallbackRate;"), "and the diff itself");
  ok(truncated === false, "a small diff is not marked truncated");

  const big = buildAttentionPrompt("x".repeat(MAX_DIFF_CHARS + 500), {});
  ok(big.truncated === true, "an oversized one is");
  ok(big.sentChars === MAX_DIFF_CHARS, "and reports exactly how much was sent", String(big.sentChars));
  ok(/cut here/i.test(big.prompt), "and the model is told not to talk about what it cannot see");

  ok(/not reviewing the change/i.test(ATTENTION_SYSTEM), "the system prompt says this is not a review");
  ok(/Returning nothing is a real answer/i.test(ATTENTION_SYSTEM), "and that finding nothing is allowed");
  // The instruction that keeps "consider adding a test" out of the list.
  ok(/must not be returned/i.test(ATTENTION_SYSTEM), "and names the non-findings it must not return");
  ok(ATTENTION_SCHEMA.properties.findings.items.required.includes("snippet"), "the schema demands an anchor");
}

// --- only changed lines count as anchorable ---------------------------------------
{
  const byFile = changedLinesByFile(DIFF);
  ok(byFile.size === 2, "both files are seen", [...byFile.keys()].join(", "));
  const rate = byFile.get("src/rate.js");
  ok(rate.some((l) => l.includes("fallbackRate")), "an added line is anchorable");
  ok(rate.some((l) => l.includes("order.hours * order.rate")), "and so is a removed one");
  // A context line is code this change did not touch. A finding about it is a different
  // conversation and would make the view about the file rather than about the change.
  ok(!rate.some((l) => l.includes("export function charge")), "but an untouched context line is not");
}

// --- a snippet that is not in the diff is dropped ----------------------------------
{
  const answer = {
    findings: [
      { file: "src/rate.js", snippet: "order.rate ?? fallbackRate", severity: "high", why: "fallbackRate is never defined here" },
      { file: "src/rate.js", snippet: "await db.commit()", severity: "high", why: "invented, no such line" },
      { file: "src/nowhere.js", snippet: "anything", severity: "low", why: "invented file" },
    ],
  };
  const shaped = shapeAttentionAnswer(answer, DIFF);
  ok(shaped.findings.length === 1, `only the real one survives (${shaped.findings.length})`);
  ok(shaped.unanchored === 2, "and the two that could not be anchored are counted", String(shaped.unanchored));
  ok(
    shaped.findings[0].line.includes("fallbackRate"),
    "the surviving finding carries the WHOLE line, not just the fragment",
    shaped.findings[0].line.trim()
  );
}

// --- path spellings must not lose a real finding ------------------------------------
// A model answering "b/src/rate.js" or "src\\rate.js" is right about the code and wrong
// about the punctuation. Dropping that would be throwing away a finding over a slash.
{
  for (const spelling of ["b/src/rate.js", "src\\rate.js", "rate.js"]) {
    const shaped = shapeAttentionAnswer(
      { findings: [{ file: spelling, snippet: "fallbackRate", severity: "low", why: "x" }] },
      DIFF
    );
    ok(shaped.findings.length === 1, `"${spelling}" resolves to the right file`);
  }
}

// --- whitespace must not lose one either --------------------------------------------
{
  const shaped = shapeAttentionAnswer(
    { findings: [{ file: "src/rate.js", snippet: "const   rate =    order.rate", severity: "low", why: "x" }] },
    DIFF
  );
  ok(shaped.findings.length === 1, "a snippet whose spacing differs still anchors");
}

// --- severity orders, and an unknown one does not become high ------------------------
{
  const shaped = shapeAttentionAnswer(
    {
      findings: [
        { file: "src/report.js", snippet: "r.billable", severity: "low", why: "a" },
        { file: "src/rate.js", snippet: "fallbackRate", severity: "high", why: "b" },
        { file: "src/rate.js", snippet: "order.hours * rate", severity: "made-up", why: "c" },
      ],
    },
    DIFF
  );
  ok(shaped.findings[0].severity === "high", "the heaviest comes first");
  ok(shaped.findings.every((f) => ["high", "medium", "low"].includes(f.severity)), "and nothing carries an invented severity");
  ok(shaped.findings.find((f) => f.why === "c").severity === "low", "an unknown severity falls to low, never up");
}

// --- "nothing stands out" is carried through -----------------------------------------
{
  const shaped = shapeAttentionAnswer({ findings: [], nothingStandsOut: "Two small changes, both self-contained." }, DIFF);
  ok(shaped.findings.length === 0, "an empty answer stays empty");
  ok(shaped.nothingStandsOut === "Two small changes, both self-contained.", "with its sentence intact");
}

// --- and the view refuses to imply the rest is fine ------------------------------------
// The failure mode this whole feature could quietly become: a filtered view that reads as
// "these are the problems", i.e. that everything else was checked. Nothing checked it.
{
  const renderer = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(/were not reviewed either/.test(renderer), "the panel says the unlisted parts were not reviewed either");
  ok(/not a verdict/.test(renderer), "and that a finding is not a verdict");
  // Same passive-drain rule as the commit match.
  const call = renderer.indexOf("reviewDiffAttention");
  ok(call > 0, "the renderer calls the attention pass");
  const before = renderer.slice(Math.max(0, call - 1500), call);
  ok(
    before.lastIndexOf('addEventListener("click"') > before.lastIndexOf("function render"),
    "and only from a click handler, never from a render path"
  );
  const queue = fs.readFileSync(new URL("../../src/lib/reviewQueueBuild.js", import.meta.url), "utf8");
  ok(!/diffAttention|ATTENTION_/.test(queue), "and the queue build never reaches for it");
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a finding lands on a line this change made, or it does not survive.");
