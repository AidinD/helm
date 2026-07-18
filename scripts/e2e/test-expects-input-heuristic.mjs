// Unit test (no app, no API): the bilingual expects-input heuristic. Verifies it
// commits only on clear signals (SV + EN) and returns null when uncertain, so the
// Haiku classifier decides the gray zone (task: smart needs-you).
//
// Run:  node scripts/e2e/test-expects-input-heuristic.mjs
import { expectsUserInputHeuristic } from "../../src/lib/orchestratorHelper.js";

let exitCode = 0;
function eq(text, expected) {
  const got = expectsUserInputHeuristic(text);
  const ok = got === expected;
  console.log(`${ok ? "OK  " : "FAIL"} - [${JSON.stringify(expected)}] <- ${JSON.stringify(text.slice(0, 60))} (got ${JSON.stringify(got)})`);
  if (!ok) {
    exitCode = 1;
  }
}

// Clear completions (no input expected) - Swedish + English.
eq("Klart - Beatdrop-second-maten är uppsatt. Hoppa in i den via Fleet.", "done_not_archived");
eq("Klart. Jag tog hand om alla fyra Beatdrop-tasksen.", "done_not_archived");
eq("Done. Pushed and committed everything.", "done_not_archived");
eq("All set - I've created the file and jump into it whenever.", "done_not_archived");

// Clear questions / asks (expects input) - Swedish + English.
eq("Vill du att jag börjar med playlist-buggen eller monetiseringen?", "waiting_for_input");
eq("Ska jag köra på alternativ A eller B?", "waiting_for_input");
eq("Should I use option A, or would you prefer B?", "waiting_for_input");
eq("Let me know which one you prefer.", "waiting_for_input");
eq("Här är två vägar. Vad tycker du?", "waiting_for_input");

// Uncertain -> null (Haiku decides; flags in the meantime).
eq("Here is a short summary of the weather today. It is sunny and warm.", null);
eq("Jag läser nu igenom koden för att förstå strukturen.", null);
eq("", null);

console.log(exitCode === 0 ? "VERIFY OK: bilingual expects-input heuristic behaves as intended." : "VERIFY FAILED.");
process.exit(exitCode);
