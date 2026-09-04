// The three review-presentation asks from 2026-08-11, pinned.
//
//  1. task ccbf82e2 - "Present diff" presented the wrong thing. The page must be the WHOLE
//     review (warnings, evidence, gaps, checks, steps, verdict) with the diff LAST, not a
//     diff with some chips on top.
//  2. task cb249577 - a commit with no Jot task must get a real body, not just a diff, and
//     must say plainly that no record exists rather than looking like a reviewed card.
//  3. task 7bd1e2df - the independent reviewer's verdict must come back in the language the
//     TASK was written in, and in plain language.
//
// Run:  node scripts/e2e/test-review-presentation.mjs
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
const repo = path.join(here, "..", "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

const { buildReviewHtml, buildCommitReviewHtml } = await import("../../src/lib/reviewHtml.js");
const { detectLanguage, reviewWritingBriefLines } = await import("../../src/lib/reviewLanguage.js");

// --- 3. language and register ------------------------------------------------
ok(detectLanguage("Review borde vara skriven på samma språk som prompten") === "sv", "Swedish letters are decisive");
ok(
  detectLanguage("Jag vill att den blir mer lattlast och inte sa teknisk") === "sv",
  "and so are two Swedish function words, so a card typed without diacritics is still Swedish"
);
ok(detectLanguage("Fix the stop button hanging on a killed process") === "en", "an ordinary English title is English");
ok(
  detectLanguage("Add an option to the shop") === "en",
  "one word that happens to exist in both languages ('an', 'to') is not enough to flip it - that was the whole reason for requiring two"
);
ok(detectLanguage("") === "en" && detectLanguage(null) === "en", "an empty sample does not throw or return null");

const svBrief = reviewWritingBriefLines("Review borde vara skriven på samma språk som prompten").join("\n");
const enBrief = reviewWritingBriefLines("Fix the stop button hanging").join("\n");
ok(/Write the verdict in Swedish\./.test(svBrief), "the brief NAMES the language rather than saying 'the same language as the task'");
ok(/Write the verdict in English\./.test(enBrief), "and names English for an English task");
ok(
  /do not translate those/.test(svBrief),
  "code identifiers, paths and output are exempted - a translated file path is not a friendlier review, it is a broken one"
);
ok(/file:line/.test(svBrief), "plain language must not cost the evidence: file:line and real commands are explicitly kept");

// The lines have to actually reach a dispatched reviewer, in both briefs.
const rSrc = read("src", "renderer", "renderer.js");
ok(
  /\.\.\.\(writingBrief \|\| \[\]\),/.test(rSrc) && (rSrc.match(/\.\.\.\(writingBrief \|\| \[\]\),/g) || []).length === 2,
  "both the task brief and the commit brief splice the writing instructions in"
);
ok(
  /getReviewerPlan\(row\.taskId, `\$\{row\.title \|\| ""\}\\n\$\{row\.description \|\| ""\}`[,)]/.test(rSrc),
  "the task's own prose is what the language is judged from - title alone is often too short a sample"
);
const mSrc = read("src", "main.js");
ok(/writingBrief: reviewWritingBriefLines\(sample \|\| ""\)/.test(mSrc), "main computes it for a task");
ok(/writingBrief: reviewWritingBriefLines\(`\$\{detail\.commit\.subject\}/.test(mSrc), "and for a commit, off the commit message");
ok(
  !/reviewWritingBriefLines/.test(rSrc),
  "the renderer does NOT reimplement the rule - it is a classic script and cannot import, so it asks main instead of mirroring"
);
ok(
  /description: t\.description \|\| null/.test(read("src", "lib", "reviewRecords.js")),
  "the queue row carries the task description, which is where the language sample comes from"
);

// --- 1. the presented page is the whole review -------------------------------
const row = {
  taskId: "abcdef12-0000-0000-0000-000000000000",
  title: "Stop-knappen hänger sig",
  category: "Helm",
  criticality: "core",
  verdict: "stamp",
  problems: [],
  caveats: ["No executed check at all - everything here rests on the author's word."],
  whyNotCritical: "Front-end only.",
  drift: { drifted: true, snapshot: [1], live: [1, 2] },
  // WHAT WAS ASKED FOR, and the fact that the ask itself has since moved (task 10928bdf).
  // Both on the row, because the queue resolves them from the record plus the live task.
  intent: { text: "Stop-knappen ska stoppa pipen, inte hänga sig.", source: "assistant" },
  intentDrift: { drifted: true, snapshot: "Stop-knappen ska stoppa pipen, inte hänga sig.", live: "Stop-knappen ska stoppa pipen inom 6 sekunder." },
  gauntlet: {
    declared: 2,
    passed: 1,
    failed: 0,
    state: "incomplete",
    perCheck: [
      { label: "unit", cmd: "npm run test:fast", state: "passed", exitCode: 0, ranAt: 1770000000000, tail: "41 passed" },
      { label: "e2e", cmd: "npm test", state: "unverified", exitCode: null, ranAt: null, tail: null },
    ],
  },
};
const record = {
  taskId: row.taskId,
  projectPath: "D:\\Repo\\Tools\\helm",
  summary: "Sammanfattning av vad som gjordes.",
  verdict: "judgment",
  ask: "Vill du att den ska vänta 6 eller 10 sekunder?",
  evidence: [{ claim: "Watchdog fires", detail: "observed in a real run" }, "A second, plain-string claim"],
  notVerified: ["Not exercised against a real hung pipe"],
  acceptanceCriteria: ["The pane goes idle within 10s"],
  testSteps: [{ step: "Press Stop", expect: "The pane goes idle", ac: 1 }],
  checks: [{ label: "unit", cmd: "npm run test:fast" }],
};
const diffText = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,2 @@
-old line
+new line
`;
const html = buildReviewHtml({
  row,
  record,
  commits: [{ sha: "0123456789abcdef", subject: "Fix the thing" }],
  commitSource: "record",
  diffText,
  independentNote: "# Verdict\n\nNOT CONFIRMED. **Two** findings:\n\n- one\n- two\n",
  independentNoteAt: 1770000000000,
  release: "v0.2.1",
});

for (const [needle, why] of [
  ["Sammanfattning av vad som gjordes.", "the record's summary is on the page"],
  ["Asked for", "what was ASKED is a section of its own, not folded into the summary"],
  ["Stop-knappen ska stoppa pipen, inte hänga sig.", "and the ask itself is printed"],
  ["What was done", "the summary is labelled as the ANSWER, so the pair reads as question then answer"],
  ["not confirmed by the captain", "a paraphrase is marked as one rather than presented as his stated ask"],
  ["What was asked for changed", "and a corrected ask is a warning on the page, not only in the app"],
  ["Stop-knappen ska stoppa pipen inom 6 sekunder.", "with the CURRENT wording, which is the one the work has to answer"],
  ["Needs a decision from you", "a judgment verdict's open question is a section of its own"],
  ["Vill du att den ska vänta 6 eller 10 sekunder?", "and the question itself is printed"],
  ["Resting on the author&#x27;s word".replace("&#x27;", "'"), "the caveats are shown"],
  ["What I checked", "the evidence block"],
  ["observed in a real run", "including an evidence entry's detail half"],
  ["A second, plain-string claim", "and a plain-string evidence entry, which is the other shape the record allows"],
  ["Not exercised against a real hung pipe", "the declared gaps"],
  ["Agreed up front", "the acceptance criteria"],
  ["Walk through these yourself", "the manual steps"],
  ["Expect: The pane goes idle", "with what each step should produce"],
  ["Checks, and what happened when they ran", "the gauntlet"],
  ["npm run test:fast", "the command a check actually declares"],
  ["not stamped by the app", "and an unverified run is called what it is, not left blank"],
  ["The acceptance criteria moved", "drift is a warning on the page, not only in the app"],
  ["Independent reviewer", "the independent verdict"],
  ["shipped in v0.2.1", "the release it went out in"],
]) {
  ok(html.includes(needle), why);
}
ok(
  html.indexOf("The change") > html.indexOf("Walk through these yourself"),
  "the diff is the LAST section - it was the whole page before, which is the bug in task ccbf82e2"
);
ok(/<strong>Two<\/strong>/.test(html), "the reviewer's markdown is rendered, so its verdict is readable rather than raw");
ok(/<h3>Verdict<\/h3>/.test(html), "including its headings, demoted so they sit under the page's own");

// A record whose summary contains markup must not become markup.
const evil = buildReviewHtml({
  row: { ...row, title: "<script>alert(1)</script>", caveats: [], drift: { drifted: false } },
  record: { ...record, summary: "<img src=x onerror=alert(1)>" },
  independentNote: "<script>alert(2)</script>",
});
ok(!/<script>alert\(1\)<\/script>/.test(evil), "a title cannot inject script");
ok(!/<img src=x/.test(evil), "nor can a summary");
ok(!/<script>alert\(2\)<\/script>/.test(evil), "nor can the agent-written verdict file, which is the least trusted input here");

// A record with no commits is not an error - it is exactly the cosmetic-stamp case.
const noDiff = buildReviewHtml({ row, record, commits: [], diffText: "" });
ok(noDiff.includes("Walk through these yourself"), "a record with no commit still renders its body");
ok(noDiff.includes("No diffable content"), "and says there is no diff instead of refusing the whole page");
ok(
  !/return \{ ok: false, error: resolved\.error \|\| "No commits found for this task\." \};[\s\S]{0,400}buildReviewHtml/.test(mSrc),
  "the handler no longer bails out when a task has no commits"
);

// --- 2. commits without a task get a real body -------------------------------
const commitHtml = buildCommitReviewHtml({
  commit: { sha: "0123456789abcdef", shortSha: "01234567", subject: "Bump deps", body: "Because of X.", author: "the captain", date: "2026-08-11" },
  projectName: "helm",
  diffText,
});
ok(commitHtml.includes("Nobody wrote down what to check"), "the commit page states the absence of a record first");
ok(commitHtml.includes("Treat it as unreviewed"), "in the same words an unrecorded task row uses");
ok(commitHtml.includes("Because of X."), "the full commit message body is shown - it was never displayed anywhere before");
ok(commitHtml.includes("the captain") && commitHtml.includes("2026-08-11"), "with who wrote it and when");
ok(commitHtml.includes("The change"), "and the diff, last");

ok(/ipcMain\.handle\("reviews:commitDetail"/.test(mSrc), "main can answer what git knows about one commit");
ok(/%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e/.test(mSrc), "parsed on separators that cannot occur in a commit message, since a body can contain anything");
ok(/ipcMain\.handle\("reviews:commitReviewerPlan"/.test(mSrc), "and an independent reviewer can be sent at a commit");
ok(/criticality: null,/.test(mSrc), "with criticality left UNSTATED rather than guessed - nobody classified this row, and pretending otherwise is the failure mode");

const commitBody = rSrc.slice(rSrc.indexOf("const loadBody = async ()"), rSrc.indexOf("if (expanded) {\n        loadBody();"));
ok(/No Jot task, so no review record/.test(commitBody), "the in-app commit row leads with the same statement");
ok(/getCommitDetail/.test(commitBody), "then the commit's author, date, size and message");
ok(/getIndependentNote\(c\.sha\)/.test(commitBody), "reads back a verdict written against the commit's sha");
ok(/presentCommitReview/.test(commitBody) && /openCommitIndependentReview/.test(commitBody), "and offers the same two actions a task row does");
ok(/getCommitDiff/.test(commitBody), "the diff is still reachable from the row");
ok(
  /openDiffViewer\(/.test(commitBody) && !/renderDiffFiles\(/.test(commitBody),
  "but it opens the shared VIEWER rather than being rendered into the card - a commit row was the last place pouring a diff inline (2026-08-12)"
);
ok(!/presentReviewDiff/.test(rSrc) && !/reviews:presentDiff/.test(mSrc), "the diff-only presenter is gone, not left as a second door to the old behaviour");

process.exit(exit);
