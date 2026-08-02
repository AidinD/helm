// A handoff must never invent a topic behind your back.
//
// The bug (Aidin, 2026-08-02): he archived "Träning och kost (Hevy)" and got a
// second handoff file, traning-och-kost-hevy.md, sitting next to the
// training-coaching.md it belonged in. Two files, one subject, and nothing said
// anything had gone wrong - the toast happily announced a new topic.
//
// The chain: the topic classifier returned nothing (it is a real `claude` call
// with a 30s budget, and a cold start alone measured 15.5s), the caller fell back
// to the session title, and the fallback path was the ONE path that skipped the
// match-an-existing-topic-first rule entirely. So the moment matching mattered
// most - the model was unavailable, nothing else was going to catch a
// near-duplicate - was the moment no matching ran.
//
// Two rules now, both checked here:
//   1. A fallback title is matched against existing topics like any proposal.
//   2. If nothing can be picked and topics already exist, REFUSE and ask. Never
//      guess. (With no topics on file there is nothing to mis-split, so the title
//      is a fine first name.)
//
// This also class-checks that the IPC handler routes through the shared planner
// rather than re-deciding inline, which is how the fallback diverged in the
// first place.
//
// Run: node scripts/e2e/test-handoff-topic-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planHandoffFiling } from "../../src/lib/handoffStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};
const J = JSON.stringify;

// --- 1. the refusal ------------------------------------------------------
const existing = ["diabetesjournal-och-forlopp", "training-coaching"];
const refused = planHandoffFiling({ proposed: null, existing, title: "Träning och kost (Hevy)" });
ok(refused.needsCategory === true, `no topic + existing topics -> refuse and ask (${J(refused)})`);
ok(!refused.category, "the refusal carries no category at all - nothing can quietly use one");
ok(
  Array.isArray(refused.existing) && refused.existing.length === 2,
  `the caller is handed the topics to choose from (${J(refused.existing)})`
);
ok(
  refused.suggestion === "traning-och-kost-hevy",
  `and a suggested new name, clearly labelled as coming from the title (${J(refused.suggestion)})`
);

// The exact regression: the old code returned this suggestion as a DECISION.
ok(
  refused.category !== refused.suggestion,
  "the suggestion is never returned as the chosen category - that is the whole bug"
);

// --- 2. the first topic on a clean store is not worth blocking on --------
const firstEver = planHandoffFiling({ proposed: null, existing: [], title: "Träning och kost (Hevy)" });
ok(
  firstEver.needsCategory !== true && firstEver.category === "traning-och-kost-hevy",
  `with NO topics on file the title is accepted - nothing to split (${J(firstEver)})`
);

// --- 3. the fallback is matched, not taken literally ---------------------
const folded = planHandoffFiling({ proposed: null, existing: ["training", "kombucha"], title: "Training log" });
ok(folded.category === "training", `a fallback title folds into an existing topic (${J(folded)})`);
ok(folded.isNew === false, "and is not announced as a new topic");

// --- 4. an explicit choice always wins -----------------------------------
const chosen = planHandoffFiling({ proposed: "training-coaching", existing, title: "Träning och kost (Hevy)" });
ok(
  chosen.category === "training-coaching" && chosen.isNew === false,
  `re-sending with an explicit topic files it there (${J(chosen)})`
);

// --- 5. CLASS CHECK: the handler must not re-decide inline ---------------
const mainSrc = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");
const code = mainSrc
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
ok(
  code.includes("planHandoffFiling("),
  "the saveHandoff handler goes through the shared planner"
);
ok(
  !/resolveHandoffCategory\(/.test(code),
  "and does NOT call the lower-level resolver directly, which would bypass the refusal"
);
// The classifier must be able to report WHY it failed; a bare null is what made
// this invisible. Its own guard lives in the helper.
const helperSrc = fs.readFileSync(path.join(here, "..", "..", "src", "lib", "orchestratorHelper.js"), "utf8");
const classifier = helperSrc.slice(helperSrc.indexOf("export function classifyHandoffCategory"));
const body = classifier.slice(0, classifier.indexOf("\nconst TRIAGE_SCHEMA"));
ok(
  !/\bresolve\(null\)|finish\(null\)/.test(body),
  "the topic classifier never resolves a bare null - every failure carries a reason"
);
ok(
  /error:/.test(body) && /classification failed/.test(body),
  "and a failure is logged in plain words, not swallowed"
);

console.log(
  fails === 0
    ? "\nVERIFY OK: a handoff topic is matched or asked for, never invented."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
