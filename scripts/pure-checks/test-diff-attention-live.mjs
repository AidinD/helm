/**
 * Does the second diff view actually find anything, and does it land where it points?
 *
 * ## The control, again, because it is the only thing that makes a green meaningful
 *
 * Everything offline is about the seam: a snippet that is not in the diff gets dropped, a
 * severity it invented falls to low, a path spelled with a backslash still resolves. None of
 * that is disturbed by a model that answers "nothing stands out" to everything, and such a
 * model would sail through every one of those checks.
 *
 * So this sends a diff with a defect planted in it - a value read before the guard that
 * makes it safe, in a shape that is entirely ordinary to look at - and requires the pass to
 * find that line. If it does not, the view is decorative and the check says so.
 *
 * A second, quieter property is checked at the same time and matters as much: that it does
 * NOT return a finding per changed line. A view that flags everything gets skimmed, and then
 * the one that mattered is skimmed too.
 *
 * Spawns the real CLI and costs money, so it is OPT-IN:
 *   node scripts/e2e/test-diff-attention-live.mjs --live
 * Without the flag it SKIPS LOUDLY.
 */
import { requireLive } from "../checks-lib/live-gate.mjs";
requireLive("sends a real diff to a real model to see which parts it flags");

import { buildAttentionPrompt, shapeAttentionAnswer, ATTENTION_SCHEMA, ATTENTION_SYSTEM } from "../../src/lib/diffAttention.js";
import { ask } from "keel/claude";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// The planted defect is on the `total` line: `session.user.name` is read before the guard
// below it establishes that `session.user` exists. Everything else in the diff is ordinary
// and correct, so a pass that flags all of it is as wrong as one that flags none.
const DIFF = [
  "diff --git a/src/summary.js b/src/summary.js",
  "index 1111111..2222222 100644",
  "--- a/src/summary.js",
  "+++ b/src/summary.js",
  "@@ -1,12 +1,18 @@",
  " import { formatHours } from './format.js';",
  " ",
  " export function buildSummary(session, rows) {",
  "-  const label = 'unknown';",
  "+  const label = session.user.name + ' (' + rows.length + ' rows)';",
  "+  if (!session.user) {",
  "+    return { label: 'unknown', total: 0 };",
  "+  }",
  "   const billable = rows.filter((r) => r.billable);",
  "-  const total = billable.length;",
  "+  const total = billable.reduce((sum, r) => sum + r.hours, 0);",
  "   return { label, total: formatHours(total) };",
  " }",
  "@@ -20,4 +26,8 @@",
  " export function rowCount(rows) {",
  "   return rows.length;",
  " }",
  "+",
  "+export function billableCount(rows) {",
  "+  return rows.filter((r) => r.billable).length;",
  "+}",
].join("\n");

const CARD = {
  title: "Sammanfattningen ska visa fakturerbara timmar, inte antal rader",
  description: "Totalen räknade rader i stället för timmar, och etiketten saknade användarnamnet.",
};

const { prompt } = buildAttentionPrompt(DIFF, CARD);
const answer = await ask({
  prompt,
  model: "claude-opus-4-8",
  system: ATTENTION_SYSTEM,
  schema: ATTENTION_SCHEMA,
  timeoutMs: 240_000,
});
ok(answer.ok, "the model answered", answer.ok ? `${answer.model}, $${(answer.costUsd || 0).toFixed(4)}` : answer.reason);
if (!answer.ok) {
  process.exit(1);
}

const shaped = shapeAttentionAnswer(answer.value, DIFF);
console.log("");
for (const f of shaped.findings) {
  console.log(`  [${f.severity}] ${f.file}`);
  console.log(`     ${f.line.trim()}`);
  console.log(`     ${f.why}`);
}
console.log("");

ok(shaped.findings.length > 0, "it found something - a pass that always declines would look identical offline");
ok(shaped.unanchored === 0, "and every finding anchored to a line this diff really changed", `${shaped.unanchored} did not`);

// The planted one. Matched on the line rather than on the wording of the reason, so the
// check is about WHERE it pointed and not about how it phrased it.
const planted = shaped.findings.find((f) => f.line.includes("session.user.name"));
ok(!!planted, "including the line that reads session.user before the guard below it");
ok(planted?.severity !== "low", "and did not file it as a passing remark", planted?.severity);
ok((planted?.why || "").length > 25, "with a reason of some substance", planted?.why);

// Restraint. Eight lines changed here and only one of them is wrong.
const changedLines = DIFF.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !/^[+-]{3}/.test(l)).length;
ok(
  shaped.findings.length <= Math.ceil(changedLines / 2),
  `it did not flag most of the diff (${shaped.findings.length} findings across ${changedLines} changed lines)`
);

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: the pass found the planted defect, anchored every finding, and did not flag the whole diff.");
