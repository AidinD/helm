// Unit test: acceptance criteria captured before the work (Flow task bd5d7b4b).
// Run: node scripts/e2e/test-acceptance.mjs
import {
  parseAcceptanceCriteria,
  formatAcceptanceCriteria,
  acceptanceCoverage,
  acceptanceProblems,
  hasEmptyAcceptanceLine,
} from "../../src/lib/acceptance.js";

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};

// --- parsing out of a real-looking Jot description -------------------------
const desc = [
  "Gör docs-staleness-pillret till en aktiv nudge (UI)",
  "",
  "AC: the Dashboard lists every project whose docs are behind, worst first",
  "AC: clicking Jump in opens that project's most recent session in chat",
  "some prose in between that mentions AC informally",
  "  ac: the nudge disappears within a minute of reconciling",
  "[Claude note] blah",
].join("\n");
const parsed = parseAcceptanceCriteria(desc);
ok(parsed.length === 3, `three AC lines are found (${parsed.length})`);
ok(parsed[0].index === 1 && /worst first/.test(parsed[0].text), "the first is parsed with its text and a 1-based index");
ok(/within a minute/.test(parsed[2].text), "lowercase `ac:` and leading whitespace still parse - it's a trailer, not prose");
ok(!parsed.some((c) => /informally/.test(c.text)), "a mention of AC mid-sentence is NOT a criterion - only a line that starts with it");

ok(parseAcceptanceCriteria("").length === 0, "an empty description has no criteria");
ok(parseAcceptanceCriteria(null).length === 0, "null does not throw");
ok(parseAcceptanceCriteria("AC: same thing\nAC: Same Thing").length === 1, "a duplicated criterion is collapsed, not counted twice");
ok(parseAcceptanceCriteria("AC:").length === 0, "an empty AC line is not a criterion");
ok(hasEmptyAcceptanceLine("AC:") === true, "...but it IS reported, so a gesture at a criterion doesn't pass silently");
ok(hasEmptyAcceptanceLine("AC: real one") === false, "a stated criterion is not an empty line");

// Round-trip, so writing criteria back onto a task is lossless.
const round = parseAcceptanceCriteria(formatAcceptanceCriteria(parsed));
ok(round.length === 3 && round[1].text === parsed[1].text, "format -> parse round-trips");
ok(formatAcceptanceCriteria([]) === "", "no criteria formats to nothing, not a stray header");
ok(formatAcceptanceCriteria(["plain string"]) === "AC: plain string", "plain strings are accepted as criteria");

// --- coverage: by explicit link, never by counting -------------------------
const A = { index: 1, text: "clicking Jump in opens that project's session" };
const B = { index: 2, text: "the nudge disappears once reconciled" };
let cov = acceptanceCoverage([A, B], [
  { step: "click Jump in", expect: "chat opens on that session", ac: 1 },
  { step: "reconcile the docs", expect: "the row disappears", ac: 2 },
]);
ok(cov.uncovered.length === 0 && cov.covered.length === 2, "both criteria linked -> fully covered");

// The failure this whole thing exists for: plenty of steps, nothing linked.
cov = acceptanceCoverage([A, B], [
  { step: "count the Jump in buttons", expect: "one button per row" },
  { step: "look at the section", expect: "it renders" },
  { step: "check the classes", expect: "dash-board" },
]);
ok(cov.uncovered.length === 2, `three unlinked steps cover NOTHING (${cov.uncovered.length} uncovered) - counting would have called this covered`);

cov = acceptanceCoverage([A, B], [{ step: "x", expect: "y", ac: [1, 2] }]);
ok(cov.uncovered.length === 0, "one step may cover two criteria");
cov = acceptanceCoverage([A], [{ step: "x", expect: "y", ac: A.text.toUpperCase() }]);
ok(cov.covered.length === 1, "linking by text is case-insensitive");
cov = acceptanceCoverage([A], [{ step: "x", expect: "y", ac: "9" }]);
ok(cov.dangling.length === 1, "a link to a criterion that doesn't exist is surfaced as dangling");
cov = acceptanceCoverage([A], [{ step: "x", expect: "y", ac: null }, null, { step: "z" }]);
ok(cov.uncovered.length === 1, "null steps and null links don't throw or accidentally satisfy anything");
ok(acceptanceCoverage(null, null).uncovered.length === 0, "null inputs are an empty result");

// --- the nudge at take-time (advice, not refusal) --------------------------
ok(acceptanceProblems("no criteria at all").some((p) => /no acceptance criteria/.test(p)), "a task with no criteria is flagged before work starts");
ok(acceptanceProblems("AC:\nAC: a proper observable outcome here").some((p) => /states nothing/.test(p)), "an empty AC line is called out");
// Unfalsifiable criteria are the real trap: "works correctly" can never fail, so it
// constrains nothing and reads as covered.
ok(acceptanceProblems("AC: works correctly").some((p) => /too short to be observable/.test(p)), "a two-word criterion is rejected as unobservable");
ok(acceptanceProblems("AC: clicking Jump in lands me in that session").length === 0, "a properly observable criterion passes clean");

console.log(code === 0 ? "\nVERIFY OK: criteria parse as trailers, coverage is by explicit link (never counting), and vague criteria are called out." : "\nVERIFY FAILED");
process.exit(code);
