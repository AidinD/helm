// Where the auto lane's bar actually sits, measured with real triage calls.
//
// the captain, task e4ba1807: "auto är alldeles för restriktiv. auto är lite för feg. Går till needs
// clarification alldeles för enkelt." The old prompt asked whether a card was WELL DEFINED -
// "clearly enough WHAT to change and HOW you would know it worked" - and was told to bias to
// false. Almost nothing on his board clears that: "en copy code knapp" does not say how you
// would know it worked, and it is a perfectly actionable card.
//
// The bar he chose instead (2026-08-04): hold back only what genuinely cannot be acted on. The
// `auto` tag is already his judgement that the work is wanted.
//
// A prompt change is a behaviour change, so asserting the new WORDING proves nothing. This
// drives the real triage call over real cards from his board plus the cases that must still be
// held back, and checks the verdicts. It spends a few cheap Haiku calls, so it is opt-in:
//
//   node scripts/e2e/test-auto-triage-bar.mjs --live
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAGE_SYSTEM_PROMPT, buildTriageInput } from "../../src/lib/autoCaptain.js";
import { triageAutoTask } from "../../src/lib/orchestratorHelper.js";
import { requireLive } from "./live-gate.mjs";
requireLive(
  "makes real triage calls against the board",
  "It is the only check that MEASURES where the auto lane's bar sits, rather than reading the prompt."
);


let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Real cards off his Helm board (terse on purpose - that is the point), then the cases the
// safety net still exists for.
const CARDS = [
  { start: true, text: "en copy code knapp", description: "" },
  { start: true, text: "dra filer till prompten ska också fungera (nu fungerar bara bilder)", description: "" },
  { start: true, text: "är 12 hårdkodat i review widgeten?", description: "något säger 12 men det är bara 1" },
  {
    start: true,
    text: "regressions bug tror jag - senaste output försvinner",
    description: "ibland försvinner det senaste jag och claude outputat. Måste starta om appen för att få tillbaka den",
  },
  { start: true, text: "Vi borde ta bort session vyn från chat", description: "" },
  // Still held back: a decision, a question, and a bare topic.
  {
    start: false,
    text: "Ska vi använda Postgres eller SQLite för lagringen?",
    description: "Jag har inte bestämt mig. Vilken tycker du?",
  },
  { start: false, text: "Fundera på prissättningen", description: "" },
  {
    start: false,
    text: "Fixa det där vi pratade om igår",
    description: "du vet vilken jag menar",
  },
];

let agreed = 0;
for (const card of CARDS) {
  const verdict = await triageAutoTask({
    cwd: repo,
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    input: buildTriageInput({ text: card.text, description: card.description }, { name: "Helm" }),
  });
  if (!verdict) {
    ok(false, `"${card.text.slice(0, 45)}" - the triage call could not be made at all`);
    continue;
  }
  const got = verdict.dispatchable;
  if (got === card.start) {
    agreed += 1;
  }
  ok(
    got === card.start,
    `${card.start ? "STARTS" : "HELD"}: "${card.text.slice(0, 45)}"${got === card.start ? "" : ` -> got ${got ? "start" : "held"}: ${verdict.reason}`}`
  );
}

// The direction matters more than any single card, and it was measured rather than assumed:
// run through the OLD prompt on 2026-08-04, all five of the actionable cards above came back
// HELD - including "en copy code knapp", whose reason asked him to "describe how to verify that
// it works", and the bug report, whose reason asked for exact reproduction steps for a bug he
// was reporting precisely because he could not reproduce it on demand. That is the complaint,
// in the model's own words.
const actionable = CARDS.filter((c) => c.start).length;
ok(agreed >= CARDS.length - 1, `at most one disagreement across ${CARDS.length} cards (${agreed} agreed)`);
console.log(`   (all ${actionable} of the actionable ones were held back by the old prompt - measured, not assumed)`);

console.log(
  exit === 0
    ? "VERIFY OK: terse but actionable cards start, and a decision, a question and a bare topic are still held back."
    : "VERIFY FAILED - the bar is not where it was asked to be."
);
process.exit(exit);
