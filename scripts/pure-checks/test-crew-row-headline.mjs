// A crew row names the TASK, not the whole prompt it was given.
//
// The row printed `run.goal` verbatim. For an auto-started run that is
// "Task from the board: <card title>\n\n<the whole description>\n\n<standing
// instructions about branches and not merging>" - so once the Auto tree finally
// rendered, five rows in one project all opened with the same words, the card title
// appeared twice in a row, and whatever distinguished them was past the ellipsis
// (the captain, 2026-08-03: "radetiketterna är obrukbara").
//
// Worth recording why there was no helper for this: one was written that morning and
// deleted the same day as dead code. It genuinely had no caller - but "uncalled"
// meant "never wired up", not "problem solved", and the problem was invisible until
// the rows rendered at all. Deleting an unused thing is right; concluding that its
// reason is gone is not.
//
// Run:  node scripts/e2e/test-crew-row-headline.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");

// The REAL function, lifted out of renderer.js rather than reimplemented, so a change
// there cannot pass here.
const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};
const maxMatch = rSrc.match(/const CREW_HEADLINE_MAX = (\d+);/);
const MAX = maxMatch ? Number(maxMatch[1]) : 0;
const headline = new Function(`const CREW_HEADLINE_MAX = ${MAX};\n${grab("crewRunHeadline")}\nreturn crewRunHeadline;`)();

ok(MAX > 20 && MAX < 120, `there is a sane cut length (${MAX})`);

// The exact goal the auto dispatch builds (see the auto-captain's `goal` array).
const REAL_AUTO_GOAL = [
  "Task from the board: Kör snabba testsviten",
  "",
  "Kör snabba testsviten i Helm och rapportera utfallet. Kör node scripts/run-tests.mjs --fast i D:\\Repo\\Tools\\helm och rapportera antalet gröna och namnen på röda.",
  "",
  "Started automatically from the Auto lane. Leave the work committed on this run's own branch.",
  "Do not merge, rebase or push, and do not mark anything finished on the board - the captain does that.",
].join("\n");

const h = headline(REAL_AUTO_GOAL);
console.log(`    headline: ${JSON.stringify(h)}`);
ok(h === "Kör snabba testsviten", `it is the card's title, and nothing else (${JSON.stringify(h)})`);
ok(!h.includes("run-tests"), "the description does not leak into the row");
ok(!/Task from the board/i.test(h), "nor the machine prefix every auto row would otherwise share");
ok(!h.includes("\n"), "one line");
ok(!/Do not merge/.test(h), "and certainly not the standing instructions");

// Two different cards in one project must be distinguishable AT THE FRONT of the row,
// which is the whole point - the previous labels differed only past the ellipsis.
const goalFor = (title) => `Task from the board: ${title}\n\nsome description\n\nStarted automatically from the Auto lane.`;
const a = headline(goalFor("Kör snabba testsviten"));
const b = headline(goalFor("Fixa quota-widgeten"));
ok(a !== b, `two cards give two different headlines (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
ok(a.slice(0, 8) !== b.slice(0, 8), "and they differ in the first few characters, not past a cut");

// A hand-written goal (the Goal page, not the board) has no prefix to strip.
ok(
  headline("Add a --version flag that prints the version") === "Add a --version flag that prints the version",
  "a hand-written goal is left alone"
);

// Truncation: on a word boundary, marked, and never longer than the cap plus the mark.
const long = headline(goalFor("Refactor the entire settings page into per-group modules with their own controllers"));
ok(long.endsWith("…"), `a long title is marked as cut (${JSON.stringify(long)})`);
ok(long.length <= MAX + 1, `and stays within the cap (${long.length} <= ${MAX + 1})`);
ok(!/ …$/.test(long), "no dangling space before the ellipsis");
// The RULE, not an example. My first version of this asserted that one particular
// word was not split, and a mutation that removed word-boundary handling entirely
// survived it: the cut landed mid-word somewhere else and the assertion still passed.
// So: the kept text must be a prefix of the title that ENDS where a space begins.
const LONG_TITLE = "Refactor the entire settings page into per-group modules with their own controllers";
const kept = long.replace(/…$/, "");
ok(LONG_TITLE.startsWith(kept), "what is kept is a genuine prefix of the title");
ok(
  kept.length === LONG_TITLE.length || LONG_TITLE[kept.length] === " ",
  `and it ends exactly where a word does (next char: ${JSON.stringify(LONG_TITLE[kept.length])})`
);

// Degenerate input must not throw or render "undefined".
for (const [input, why] of [
  [undefined, "undefined"],
  [null, "null"],
  ["", "empty string"],
  ["\n\n\n", "only newlines"],
  ["   ", "only spaces"],
]) {
  const out = headline(input);
  ok(typeof out === "string" && out.length > 0 && !/undefined|null/.test(out), `${why} gives a harmless placeholder (${JSON.stringify(out)})`);
}

// A goal that is ONLY the prefix must not collapse to nothing.
ok(headline("Task from the board:") === "Task from the board:", "a goal that is only the prefix keeps something to read");

// And the row still carries the full prompt, so nothing is lost - just moved.
ok(/item\.title = String\(run\.goal/.test(rSrc), "the full prompt moves to the row's tooltip rather than disappearing");
ok(/crewRunHeadline\(run\.goal\)/.test(rSrc), "and the label is built from the headline");
ok(!/\+ run\.goal;/.test(rSrc), "the raw-goal label is gone, not merely bypassed");

console.log(
  exit === 0
    ? "VERIFY OK: a crew row is named after the card, distinguishable at a glance, cut on a word boundary, with the full prompt one hover away."
    : "VERIFY FAILED."
);
process.exit(exit);
