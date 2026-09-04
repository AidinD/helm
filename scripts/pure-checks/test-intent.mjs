// The ask, captured before the work and reviewed against (task 10928bdf).
//
// Three separate things are pinned here, and they fail for different reasons:
//
//   1. The parse.  `INTENT:` lines in a Jot description, strictly, like a git trailer.
//   2. The gate.   A core/critical record with no intent is REFUSED at write time,
//                  a cosmetic one is allowed and says so on the card instead.
//   3. The bypass. A check STAMP is never refused by the write-time gates - and cannot
//                  be used to smuggle edited content past them either.
//
// (3) is here because it is a regression this change had to fix before it could add a
// third gate of its own: measured 2026-08-21, the readability limits from the day before
// were refusing 89 of 96 existing records, and recordCheckRun re-writes the whole record
// through writeReviewRecord - so "Run checks" ran the command and then silently dropped
// the result. A check that really passed, reading as never run.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-intent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseIntent,
  hasEmptyIntentLine,
  hasOrphanedIntentContinuation,
  normalizeIntent,
  intentDrift,
  clampIntentText,
  intentSourceNote,
  INTENT_MAX_CHARS,
} from "../../src/lib/intent.js";
import {
  reviewRecordIntentProblems,
  reviewRecordProblems,
  reviewRecordReadability,
  writeReviewRecord,
  readReviewRecord,
  recordCheckRun,
  recordCaveats,
  reviewsDir,
  buildAutoReviewRecord,
} from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// ===========================================================================
// 1. The parse
// ===========================================================================
console.log("-- parsing INTENT: out of a task description --");
{
  ok(parseIntent("INTENT: catch work that answers the wrong question") === "catch work that answers the wrong question", "a single line parses");
  ok(
    parseIntent("blah\nINTENT: first half\nAC: something\nINTENT: second half\nmore prose") === "first half second half",
    "two lines join into one ask, so a two-sentence intent needs no continuation syntax"
  );
  ok(parseIntent("intent: lower case works") === "lower case works", "the prefix is case-insensitive, like the AC one");
  ok(parseIntent("we intend to fix the thing") === "", "PROSE about intent is not an intent - the value is in having written the line deliberately");
  ok(parseIntent("  INTENT:   padded   ") === "padded", "surrounding whitespace is not part of the ask");
  ok(parseIntent(null) === "" && parseIntent(undefined) === "" && parseIntent(42) === "", "a missing or non-string description is no intent, not a crash");

  // A blank line looks like the ask was recorded, which is worse than silence: nobody
  // goes looking for something that appears to already be there.
  ok(parseIntent("INTENT:") === "", "a blank INTENT: states nothing, so it parses to nothing");
  ok(hasEmptyIntentLine("INTENT:") === true, "but it is REPORTED, so 'none written' and 'written blank' stay distinguishable");
  ok(hasEmptyIntentLine("INTENT: something") === false, "a stated intent is not a blank one");
  ok(hasEmptyIntentLine("no intent line here") === false, "and silence is not a blank one either");

  // A WRAPPED intent loses its second half with no signal at all - worse than a blank
  // one, because the ask reads as complete and is not. Found on the first two cards ever
  // written under this rule: I wrapped at the margin and prefixed only the first line.
  const wrapped = "INTENT: a check that really ran must always be able to prove it, even on an old\nrecord - the gates exist to keep new text short, not to throw evidence away.";
  ok(parseIntent(wrapped) === "a check that really ran must always be able to prove it, even on an old", "a wrapped line really does lose its second half - this is the trap, not a hypothetical");
  ok(hasOrphanedIntentContinuation(wrapped) === true, "so it is REPORTED, since nothing else would say a word on a task that has no record yet");
  const prefixed = "INTENT: a check that really ran must always be able to prove it, even on an old\nINTENT: record - the gates exist to keep new text short.";
  ok(hasOrphanedIntentContinuation(prefixed) === false, "prefixing the continuation clears it");
  ok(parseIntent(prefixed).endsWith("keep new text short."), "and then the whole ask is read");

  // Narrow on purpose: a caveat nobody should see is worse than no caveat. All four
  // conditions must hold, so the ordinary next paragraph in these descriptions is not
  // mistaken for a wrapped sentence.
  ok(hasOrphanedIntentContinuation("INTENT: do the thing.\nand then something else") === false, "a completed sentence is not a continuation, whatever follows it");
  ok(hasOrphanedIntentContinuation("INTENT: do the thing\nLÖST 2026-08-21, commit abc") === false, "a status note starting uppercase is a new statement, not a wrapped half");
  ok(hasOrphanedIntentContinuation("INTENT: do the thing\nAC: it works") === false, "nor is another trailer");
  ok(hasOrphanedIntentContinuation("INTENT: do the thing\n\nloose prose below") === false, "nor is prose after a blank line");
  ok(hasOrphanedIntentContinuation("INTENT: do the thing") === false, "and a last line has nothing after it to orphan");
}

// ===========================================================================
// 2. Provenance - whose words the ask is in
// ===========================================================================
console.log("\n-- whose words --");
{
  ok(normalizeIntent("just a string").source === "assistant", "an unattributed intent reads as MY paraphrase, the least trustworthy of the three");
  ok(normalizeIntent({ text: "x", source: "captain" }).source === "captain", "a stated source is kept");
  ok(normalizeIntent({ text: "x", source: "CAPTAIN" }).source === "captain", "case does not decide provenance");
  ok(normalizeIntent({ text: "x", source: "his own words honestly" }).source === "assistant", "an unrecognised source falls back to assistant, never up to captain");
  ok(normalizeIntent({ text: "   ", source: "captain" }) === null, "whitespace is not an ask, whatever it claims to be");
  ok(normalizeIntent(null) === null, "and nothing is nothing");
  // The whole point of the field: a paraphrase must not read as his stated ask.
  ok(/not confirmed/i.test(intentSourceNote("assistant")), "an assistant intent is described as unconfirmed on screen");
  ok(!/not confirmed/i.test(intentSourceNote("captain")), "his own words carry no such warning");
}

// ===========================================================================
// 3. Length - the card shows two rows read as a pair
// ===========================================================================
console.log("\n-- length --");
{
  const long = "w".repeat(INTENT_MAX_CHARS + 80);
  const clamped = clampIntentText(long);
  ok(clamped.length <= INTENT_MAX_CHARS, `a goal too long for the card is cut to fit (${clamped.length} <= ${INTENT_MAX_CHARS})`);
  ok(clamped.endsWith("\u2026"), "and says so with an ellipsis, so nobody reads a trimmed goal as the whole ask");
  const words = clampIntentText(`${"word ".repeat(80)}end`);
  ok(!/\s$/.test(words) && words.endsWith("\u2026"), "the cut lands on a word boundary rather than mid-word");
  ok(clampIntentText("short") === "short", "text within the limit is untouched - no gratuitous ellipsis");
  ok(clampIntentText("  spaced   out  ") === "spaced out", "and whitespace is collapsed, since it renders on one line");

  // A HAND-written intent is refused rather than trimmed: silently cutting the author's
  // own sentence would leave the card showing half an ask with nobody told.
  const over = { criticality: "cosmetic", intent: { text: long, source: "captain" } };
  ok(
    reviewRecordReadability(over).some((p) => /^intent is \d+ characters/.test(p)),
    "an over-long hand-written intent is a readability refusal, not a silent truncation"
  );
  ok(
    reviewRecordReadability({ criticality: "cosmetic", intent: { text: "fine", source: "captain" } }).every((p) => !/^intent is/.test(p)),
    "a short one passes"
  );
}

// ===========================================================================
// 4. The gate - graded by what being wrong costs
// ===========================================================================
console.log("\n-- the gate --");
{
  for (const tier of ["core", "critical"]) {
    const gaps = reviewRecordIntentProblems({ criticality: tier });
    ok(gaps.length === 1 && /must carry the intent/.test(gaps[0]), `a ${tier} record with no intent is refused`);
    ok(/INTENT:/.test(gaps[0]), `and the ${tier} message says where to put it, not just that it is missing`);
    ok(reviewRecordIntentProblems({ criticality: tier, intent: "the ask" }).length === 0, `a ${tier} record WITH one passes`);
    ok(
      reviewRecordIntentProblems({ criticality: tier, intent: { text: "the ask", source: "assistant" } }).length === 0,
      `a ${tier} record passes on MY paraphrase too - a gate nobody can clear gets worked around, not satisfied`
    );
    ok(reviewRecordIntentProblems({ criticality: tier, intent: { text: "   " } }).length === 1, `and a ${tier} record cannot clear it with whitespace`);
  }
  ok(reviewRecordIntentProblems({ criticality: "cosmetic" }).length === 0, "cosmetic is allowed through - it buys speed");
  ok(reviewRecordIntentProblems({}).length === 0, "and a record with no tier at all is not refused HERE (criticalityProblems owns that)");

  // Cosmetic buys speed, NOT silence: the absence has to be on the card.
  const caveats = recordCaveats({ criticality: "cosmetic", checks: [{ label: "c", cmd: "npm test" }], acceptanceCriteria: [] });
  ok(caveats.some((c) => /Nothing here says what was asked for/.test(c)), "a record with no intent SAYS so, rather than looking complete");
  const paraphrased = recordCaveats({ criticality: "cosmetic", intent: { text: "x", source: "assistant" }, checks: [{ label: "c", cmd: "npm test" }], acceptanceCriteria: [] });
  ok(paraphrased.some((c) => /in my words, not the captain's/.test(c)), "and a paraphrase is flagged as a paraphrase");
  const his = recordCaveats({ criticality: "cosmetic", intent: { text: "x", source: "captain" }, checks: [{ label: "c", cmd: "npm test" }], acceptanceCriteria: [] });
  ok(!his.some((c) => /asked for/.test(c)), "his own words earn no caveat at all");

  // The two are DIFFERENT things (see intent.js). A record with criteria and no intent
  // must still be refused - otherwise the criteria quietly stand in for the ask, which
  // is the confusion this whole distinction exists to prevent.
  ok(
    reviewRecordIntentProblems({ criticality: "core", acceptanceCriteria: [{ index: 1, text: "it works" }] }).length === 1,
    "acceptance criteria do NOT satisfy the intent gate - checkable criteria are not a statement of the ask"
  );
}

// ===========================================================================
// 4b. The gate is WIRED, not just implemented
// ===========================================================================
// Section 4 drives reviewRecordIntentProblems, which proves the rule and says nothing
// about whether writeReviewRecord consults it. That gap is its own failure shape - the
// mechanism asserted, the symptom never checked - and it was found by mutation: deleting
// the gate from the write path left every check in section 4 green.
console.log("\n-- the gate is actually on the write path --");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "helm-intent-write-"));
  fs.mkdirSync(reviewsDir(home), { recursive: true });
  const mk = (over) => ({
    taskId: "aaaa1111-2222-4222-8222-333344445555",
    title: "A core change",
    verdict: "stamp",
    summary: "Short and readable.",
    criticality: "core",
    projectPath: home,
    evidence: [],
    notVerified: [],
    testSteps: [{ step: "Run it", expect: "It works" }],
    checks: [{ label: "suite", cmd: "npm test" }],
    ...over,
  });

  const refused = writeReviewRecord(home, mk({}));
  ok(refused.ok === false, "a core record with no intent is REFUSED by writeReviewRecord, not merely reported by the checker");
  ok(/does not say what was asked for/.test(refused.error || ""), `and the refusal names the reason (${String(refused.error).slice(0, 50)}...)`);
  ok(readReviewRecord(home, mk({}).taskId) === null, "so nothing lands on disk - the card cannot show a core claim with no ask behind it");

  const accepted = writeReviewRecord(home, mk({ intent: { text: "Stop cards reaching review without the ask.", source: "captain" } }));
  ok(accepted.ok === true, `the same record WITH the ask writes fine (${accepted.ok ? "ok" : accepted.error})`);
  ok(normalizeIntent(readReviewRecord(home, mk({}).taskId).intent)?.source === "captain", "and the provenance survives the round trip to disk");

  // Cosmetic through the real write path too, not just through the checker.
  const cosmetic = writeReviewRecord(
    home,
    mk({ taskId: "bbbb1111-2222-4222-8222-333344445555", criticality: "cosmetic", whyNotCritical: "a label in the sidebar", intent: undefined })
  );
  ok(cosmetic.ok === true, `a cosmetic record still writes with no ask (${cosmetic.ok ? "ok" : cosmetic.error})`);

  fs.rmSync(home, { recursive: true, force: true });
}

// ===========================================================================
// 4c. A Windows path whose backslashes were eaten
// ===========================================================================
// Found on 4 real records (`D:RepoToolshelm`) and in 3 test fixtures, all from a string
// literal written with single backslashes - `\R` and `\T` are not escapes, so they are
// dropped. Every surface that needs the repo roots there, so all of them fail on a
// directory that cannot exist, and the card blames a missing repo rather than the field.
//
// It has its own block because repairing those fixtures left NOTHING exercising the
// guard: a guard written to close a finding, with no test of its own, is the shape that
// survived a 23-mutation matrix last time.
console.log("\n-- a path whose separators were lost --");
{
  const withPath = (over) => ({
    taskId: "cccc1111-2222-4222-8222-333344445555",
    title: "x",
    verdict: "stamp",
    summary: "s",
    criticality: "cosmetic",
    whyNotCritical: "a sidebar label - a bug here is visible immediately and costs nothing to undo",
    evidence: [],
    notVerified: [],
    testSteps: [{ step: "Run it", expect: "works" }],
    checks: [{ label: "suite", cmd: "npm test" }],
    ...over,
  });
  // Scoped to the separator message rather than to problems.length: an assertion that
  // demands a totally clean record passes the moment ANY unrelated rule trips, which is
  // how it would stop testing this guard without ever going red. (It did, on the first
  // run of this block - an unrelated whyNotCritical rule was the only thing failing.)
  const separatorProblem = (rec) => reviewRecordProblems(rec).filter((p) => /no separator after it/.test(p));
  ok(separatorProblem(withPath({ projectPath: "D:RepoToolshelm" })).length === 1, "a drive letter with no separator is refused - nothing can be rooted there");
  ok(separatorProblem(withPath({ projectPath: "D:\\Repo\\Tools\\helm" })).length === 0, "a correctly spelled Windows path passes");
  ok(separatorProblem(withPath({ projectPath: "D:/Repo/Tools/helm" })).length === 0, "forward slashes pass too - both are real on Windows");
  ok(separatorProblem(withPath({ projectPath: "/home/aidin/repo" })).length === 0, "and a POSIX path is not a drive letter at all");
  // A check's own cwd has the same damage and the same consequence.
  ok(
    separatorProblem(withPath({ projectPath: "D:\\Repo", checks: [{ label: "suite", cmd: "npm test", cwd: "C:UsersaidinRepo" }] })).some((p) => /checks\[0\]\.cwd/.test(p)),
    "a check's own cwd is checked as well - it is where the command actually runs"
  );
  // Checked by SHAPE, not existence: a moved or unplugged repo must not put the evidence
  // out of reach exactly when someone is trying to read it.
  ok(separatorProblem(withPath({ projectPath: "Z:\\definitely\\not\\here" })).length === 0, "a well-formed path that does not exist is NOT refused - that is a different problem");
}

// ===========================================================================
// 5. Drift - usually means the captain corrected the ask
// ===========================================================================
console.log("\n-- drift --");
{
  const rec = { intent: { text: "catch wrong-intent work", source: "captain" } };
  ok(intentDrift(rec, "INTENT: catch wrong-intent work").drifted === false, "the same ask is not drift");
  ok(intentDrift(rec, "INTENT:   Catch   Wrong-Intent   Work  ").drifted === false, "nor is a difference of spacing or case");
  const moved = intentDrift(rec, "INTENT: catch work that ships the wrong thing entirely");
  ok(moved.drifted === true && /ships the wrong thing/.test(moved.live), "an edited ask IS drift, and the CURRENT wording travels with it");
  // Silence must not read as a change. Most tasks predate this, and flagging all of them
  // is the same noise that made the review page unreadable in the first place.
  ok(intentDrift(rec, "a description with no INTENT line").drifted === false, "a task with no INTENT: line is 'nothing to compare', not drift");
  // This assertion used to say the OPPOSITE, and the assertion was the bug. Backfilling an
  // intent onto the five cards already in review lit every one of them with "what was asked
  // for changed" - false, and exactly the noise this work is removing. A record that never
  // had an ask has not had it CHANGED; it has had it written down. The card carries the
  // honest signal for that case separately, by marking the ask as read from the task.
  ok(intentDrift({}, "INTENT: something").drifted === false, "a record that never snapshotted an ask is not 'the ask moved' - it is the ask being written down");
  ok(intentDrift({}, "INTENT: something").live === "something", "and the live ask still travels, so the card can show it");
}

// ===========================================================================
// 6. The auto-record path must never go blank for want of an intent
// ===========================================================================
console.log("\n-- the autopilot's own record --");
{
  const base = {
    taskId: "abcd1234-0000-0000-0000-000000000000",
    projectPath: "D:\\Repo\\PomPom",
    outcome: "Finished with 2 commits",
    where: "in a worktree",
    branch: "helm/goal-x",
    worktreePath: "D:\\Repo\\PomPom-worktrees\\goal-x",
    commits: 2,
    stoppedReason: "no_op_convergence",
  };
  const withGoal = buildAutoReviewRecord({ ...base, goal: "Give the header its icon back." });
  ok(withGoal.intent?.source === "goal", "an autopilot record's intent is the GOAL - written before the run, so it cannot be a rationalisation");
  ok(withGoal.intent?.text === "Give the header its icon back.", "and it is the goal's own words");
  ok(reviewRecordIntentProblems(withGoal).length === 0, "so the record clears the gate its own criticality imposes");

  // The blank-card regression this fallback exists to prevent: buildAutoReviewRecord is
  // `core`, so no intent means REFUSED means no record means the blank dead end the
  // function was written to remove.
  const titleOnly = buildAutoReviewRecord({ ...base, goal: null, title: "Header icon is missing" });
  ok(titleOnly.intent?.text === "Header icon is missing", "a run whose goal did not survive falls back to the board's words for the task");
  ok(titleOnly.intent?.source === "assistant", "marked as the weaker source, because a title is a weaker statement of the ask than a goal");
  ok(reviewRecordIntentProblems(titleOnly).length === 0, "so the card still gets a record rather than going blank");

  const neither = buildAutoReviewRecord({ ...base, goal: null, title: null });
  ok(neither.intent === null, "with neither, nothing is invented");
  ok(reviewRecordIntentProblems(neither).length === 1, "and that record is refused - a wiring bug worth failing on, not a sentence worth making up");

  const longGoal = buildAutoReviewRecord({ ...base, goal: "g".repeat(INTENT_MAX_CHARS + 50) });
  ok(reviewRecordReadability(longGoal).every((p) => !/^intent is/.test(p)), "a long goal is trimmed to fit rather than refused - it is not text Helm authored");
}

// ===========================================================================
// 7. A check stamp is EVIDENCE. It is never refused, and cannot smuggle content.
// ===========================================================================
console.log("\n-- stamping a check on a record that would fail the write gates --");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "helm-intent-test-"));
  fs.mkdirSync(reviewsDir(home), { recursive: true });
  const ID = "12341234-1234-4234-8234-123412341234";

  // A record shaped like the 89 real ones: long summary, no intent, a declared check.
  // Written straight to disk BECAUSE writeReviewRecord would (correctly) refuse it - this
  // is a record that already exists, which is the whole situation being tested.
  const legacy = {
    taskId: ID,
    title: "A record from before any of these rules",
    verdict: "stamp",
    criticality: "core",
    summary: "S".repeat(700),
    projectPath: home,
    evidence: [],
    notVerified: [],
    testSteps: [{ step: "Run it", expect: "It works" }],
    checks: [{ label: "suite", cmd: 'node -e "process.exit(0)"' }],
  };
  fs.writeFileSync(path.join(reviewsDir(home), `${ID}.json`), JSON.stringify(legacy, null, 2), "utf8");

  // It really would be refused as a content write - otherwise this test proves nothing.
  const asContent = writeReviewRecord(home, { ...legacy, summary: legacy.summary });
  ok(asContent.ok === false, `writing this record as CONTENT is refused (${String(asContent.error).slice(0, 60)}...) - so the stamp below is a real bypass, not a no-op`);

  const stamp = recordCheckRun(home, ID, { label: "suite", exitCode: 0 });
  ok(stamp.ok === true, `stamping a passing check on it succeeds (${stamp.ok ? "ok" : stamp.error})`);
  const after = readReviewRecord(home, ID);
  ok((after.checkRuns || []).some((r) => r.label === "suite" && r.exitCode === 0), "and the run is actually STORED - a check that really ran must never read as never run");

  // The bypass covers PRESENTATION gates only. An INADMISSIBLE record - one that is not
  // allowed to claim anything - must still be refused, or it quietly accumulates green
  // ticks and its card reads "checks passing". This shipped wrong for a day: the bypass
  // covered reviewRecordProblems too, so a critical record with no independent pass could
  // be stamped. Caught by test-acceptance-gate, which is app-lane and so invisible to the
  // fast suite I was running.
  const CRIT = "99999999-9999-4999-8999-999999999999";
  const inadmissible = {
    ...legacy,
    taskId: CRIT,
    summary: "short and readable",
    criticality: "critical",
    intent: { text: "Make critical work impossible to stamp without a second opinion.", source: "captain" },
    // critical requires an independent pass. Deliberately absent.
  };
  fs.writeFileSync(path.join(reviewsDir(home), `${CRIT}.json`), JSON.stringify(inadmissible, null, 2), "utf8");
  ok(reviewRecordProblems(inadmissible).length > 0, "the fixture really is inadmissible - otherwise the next check proves nothing");
  const critStamp = recordCheckRun(home, CRIT, { label: "suite", exitCode: 0 });
  ok(critStamp.ok === false, `stamping a check on an inadmissible record is REFUSED (${critStamp.ok ? "ACCEPTED" : "refused"})`);
  ok(
    /independentReview|criticality|critical/i.test(String(critStamp.error || "")),
    `and the refusal names why, so the card can say it (${String(critStamp.error).slice(0, 70)})`
  );
  ok((readReviewRecord(home, CRIT).checkRuns || []).length === 0, "and no green tick was stored on a record that may not claim one");

  // MUTATION, in the other direction. The bypass is granted from the content being
  // unchanged, not from the caller's flag - so the flag alone must not carry an edit.
  const smuggled = writeReviewRecord(home, { ...after, summary: "an edit riding in on the stamp flag" }, { isRunStamp: true });
  ok(smuggled.ok === false, `an EDIT passed with isRunStamp is still refused (${smuggled.ok ? "ACCEPTED" : "refused"}) - the flag is not a way past the gates`);
  ok(readReviewRecord(home, ID).summary === legacy.summary, "and the record on disk was not changed by the attempt");

  // The other direction of the same rule: a real edit must still invalidate green ticks,
  // which is what the isRunStamp split has to keep true.
  const fixed = { ...after, summary: "short and readable now", intent: { text: "Make old records stampable again.", source: "captain" } };
  const good = writeReviewRecord(home, fixed);
  ok(good.ok === true, `a record brought up to standard writes normally (${good.ok ? "ok" : good.error})`);
  ok(good.record.contentUpdatedAt >= good.record.updatedAt - 1, "and a content write moves the staleness baseline, so earlier green ticks stop vouching for it");

  fs.rmSync(home, { recursive: true, force: true });
}

// ===========================================================================
// 8. The reviewer's brief actually carries the ask
// ===========================================================================
console.log("\n-- the brief the independent reviewer is sent --");
{
  // Source-level, because the brief is built in the renderer (a classic script that
  // cannot be imported here). Asserted as the PROPERTIES that make it work, not as exact
  // prose: the reviewer must be asked for its own reading FIRST, told that wrong-intent
  // is a finding, and told to write that sentence into the file rather than the chat.
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const brief = src.slice(src.indexOf("function independentReviewBrief"), src.indexOf("function independentReviewSessionArgs"));
  ok(brief.length > 500, "found the brief builder");
  ok(/BEFORE READING ANY FURTHER/.test(brief), "the reviewer is asked for its own reading of the ask BEFORE it is shown anything else");
  const askedIdx = brief.indexOf("BEFORE READING ANY FURTHER");
  const summaryIdx = brief.indexOf("What the author says was done");
  ok(askedIdx > 0 && askedIdx < summaryIdx, "and that question comes BEFORE the author's account - the order is the mechanism, not decoration");
  ok(/is a FINDING/.test(brief), "correct-but-not-what-was-asked is named as a finding it must report");
  ok(/NOBODY WROTE DOWN WHAT WAS ASKED FOR/.test(brief), "a task with no recorded intent says so, instead of the reviewer silently having no question");
  ok(/intentDrift/.test(brief), "a corrected ask reaches the reviewer, so it judges against the current wording");
  ok(/Asked for:/.test(brief), "and the verdict FILE must carry the reviewer's own sentence - a finding left in the chat never reaches the page");
}

// ===========================================================================
// 9. The renderer's copy of the provenance wording agrees with intent.js
// ===========================================================================
// The renderer is a classic script and cannot import a module, so the card carries its
// own copy of these two sentences. reviewHtml.js was a THIRD copy until it was made to
// call intentSourceNote; this pins the one that has to stay duplicated.
//
// It matters because the three surfaces are describing how much to TRUST the ask. A card
// saying "not confirmed by the captain" while the summary page says something softer is not a
// cosmetic divergence - it is two different claims about whose words the reader is
// looking at.
console.log("\n-- the renderer's copy has not drifted --");
{
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  for (const source of ["goal", "assistant"]) {
    const sentence = intentSourceNote(source);
    ok(src.includes(sentence), `the card uses intent.js's exact wording for a "${source}" intent (${JSON.stringify(sentence.slice(0, 34))}...)`);
  }
}

console.log(
  exit === 0
    ? "\nVERIFY OK: the ask is captured before the work, refused when missing on a core item, carried into the reviewer's brief - and a check stamp is never refused for the record being old."
    : "\nVERIFY FAILED."
);
process.exit(exit);
