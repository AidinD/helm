// Unit test: review records (task ce2d19ab). The point of the feature is that a
// review item says which ones actually need Aidin's judgment and HOW to check
// them - so the rules worth testing are the refusals: an item with no way to
// check it, or a judgment item with no stated ask, must not render as reviewed.
// Run:  node scripts/e2e/test-review-records.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  reviewsDir,
  reviewRecordPath,
  reviewRecordProblems,
  reviewRecordReadability,
  READABILITY_LIMITS,
  readReviewRecord,
  listReviewRecords,
  writeReviewRecord,
  removeReviewRecord,
  buildReviewQueue,
  reviewQueueTally,
  recordCheckRun,
  gauntletStatus,
  signCheckRun,
  verifyCheckRun,
  passForcingReason,
  recordCaveats,
  currentHead,
  reviewBand,
  codeChangedBetween,
  acceptanceDrift,
} from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rev-"));
const ID_A = "7d9d2188-277e-4365-82d6-071da5669262";
const ID_B = "4bf2421c-cb41-4673-a87a-516be7f30d8e";

const complete = (over = {}) => ({
  taskId: ID_A,
  title: "Scheduled prompts",
  verdict: "stamp",
  summary: "A caret by the send button queues a prompt for the quota reset.",
  commits: ["bf30f42"],
  evidence: [{ claim: "31 unit assertions on the queue", kind: "test" }],
  notVerified: [],
  testSteps: [{ step: "Type a prompt, click the caret, pick 'Send when quota resets'", expect: "A queued bar appears naming the wait" }],
  release: "0.1.456",
  // Required since 2026-07-27: criticality has no default, because a missing tier
  // is the author declining to say how much it costs to be wrong.
  criticality: "cosmetic",
  // Required since 2026-07-27: the tier that needs no evidence has to be argued for.
  whyNotCritical: "a caret in the composer - a bug here is visible and reversible",
  // Required since 2026-08-04 whenever the record declares checks: a check needs a
  // directory to run in. On the base fixture because a real record has one - the
  // records that lacked it are exactly how a check came to fail for a missing
  // directory rather than for a result.
  projectPath: "D:\\Repo\\Tools\\helm",
  // Required since 2026-08-21 for core and critical: the ask the work was written
  // against (task 10928bdf). On the BASE fixture, at `cosmetic`, even though cosmetic
  // does not require it - a real record has one at every tier, and the alternative was
  // adding it to a dozen `criticality: "core"` overrides one at a time.
  //
  // The tier behaviour itself is NOT asserted through this fixture, deliberately: a
  // default that satisfies the gate cannot show that the gate exists. test-intent.mjs
  // drives reviewRecordIntentProblems directly, both ways, so the rule is pinned
  // somewhere the fixture cannot quietly make it pass.
  intent: { text: "Let a queued prompt wait for the quota reset instead of failing.", source: "captain" },
  ...over,
});

try {
  // --- path safety ---
  ok(reviewRecordPath(metaHome, ID_A).startsWith(reviewsDir(metaHome)), "a record lands inside .helm/reviews");
  ok(reviewRecordPath(metaHome, "../../etc/passwd") === null, "a traversal id is refused outright");
  ok(reviewRecordPath(metaHome, "") === null, "an empty id is refused");
  ok(reviewRecordPath(metaHome, "short") === null, "a too-short id is refused");

  // --- completeness rules (the refusals are the feature) ---
  ok(reviewRecordProblems(complete()).length === 0, "a complete record has no problems");
  ok(reviewRecordProblems(null).length > 0, "null is not a record");

  const noSteps = reviewRecordProblems(complete({ testSteps: [] }));
  ok(noSteps.some((p) => /assertion/.test(p)), `no test steps is a problem even for a stamp (${noSteps[0]})`);

  const halfStep = reviewRecordProblems(complete({ testSteps: [{ step: "click it" }] }));
  ok(halfStep.some((p) => /expected result/.test(p)), "a step without an expected result is incomplete");

  const judgmentNoAsk = reviewRecordProblems(complete({ verdict: "judgment", ask: "" }));
  ok(judgmentNoAsk.some((p) => /ask/.test(p)), "a judgment item with no ask is incomplete");
  ok(reviewRecordProblems(complete({ verdict: "judgment", ask: "Confirm the layout" })).length === 0, "a judgment item WITH an ask is fine");

  ok(reviewRecordProblems(complete({ verdict: "looks-fine" })).some((p) => /verdict/.test(p)), "an invented verdict is refused");
  ok(reviewRecordProblems(complete({ summary: "  " })).some((p) => /summary/.test(p)), "an empty summary is refused");
  ok(reviewRecordProblems(complete({ notVerified: undefined })).some((p) => /notVerified/.test(p)), "notVerified must be present - the gaps are the useful half");

  // --- write refuses incomplete, accepts complete ---
  const bad = writeReviewRecord(metaHome, complete({ testSteps: [] }));
  ok(bad.ok === false && Array.isArray(bad.problems), `write REFUSES an incomplete record (${bad.error?.slice(0, 60)})`);
  ok(readReviewRecord(metaHome, ID_A) === null, "nothing was written for the refused record");

  const good = writeReviewRecord(metaHome, complete(), { now: 1000 });
  ok(good.ok === true && good.record.createdAt === 1000, "a complete record is written with a createdAt");
  ok(fs.existsSync(good.path), "the file exists on disk");

  // --- rewrite keeps createdAt, bumps updatedAt ---
  const again = writeReviewRecord(metaHome, complete({ summary: "revised summary" }), { now: 2000 });
  ok(again.record.createdAt === 1000 && again.record.updatedAt === 2000, "a rewrite keeps createdAt and bumps updatedAt");
  ok(readReviewRecord(metaHome, ID_A).summary === "revised summary", "the rewrite replaced the content");

  // --- listing + remove ---
  writeReviewRecord(metaHome, complete({ taskId: ID_B, title: "Widget dashboard", verdict: "judgment", ask: "Confirm the layout" }), { now: 3000 });
  ok(listReviewRecords(metaHome).length === 2, "both records list");
  ok(listReviewRecords(path.join(metaHome, "nope")).length === 0, "a missing dir lists nothing, no throw");

  // --- the queue: judgment first, unrecorded surfaced not hidden ---
  const tasks = [
    { id: ID_A, text: "Scheduled prompts", priority: 0, category: "Helm" },
    { id: ID_B, text: "Widget dashboard", priority: 0, category: "Helm" },
    { id: "cbd60642-0000-4000-8000-000000000000", text: "Double-firing routine", priority: 1, category: "Helm" },
  ];
  const rows = buildReviewQueue(tasks, listReviewRecords(metaHome));
  ok(rows.length === 3, "every board item appears, with or without a record");
  ok(rows[0].verdict === "judgment", `judgment items sort FIRST (got ${rows[0].verdict})`);
  ok(rows[1].verdict === "stamp", "then stamps");
  ok(rows[2].verdict === "unrecorded", "then anything with no record");
  ok(rows[2].incomplete === true && /no review record/.test(rows[2].problems[0]), "an unrecorded task is flagged, NOT hidden - hiding it would let it pass as reviewed");
  ok(rows[0].title === "Widget dashboard", "the title comes through");

  const tally = reviewQueueTally(rows);
  ok(tally.total === 3 && tally.judgment === 1 && tally.stamp === 1 && tally.unrecorded === 1, `the tally reads at a glance (${JSON.stringify(tally)})`);

  ok(buildReviewQueue([], []).length === 0, "an empty board is an empty queue");
  ok(buildReviewQueue(null, null).length === 0, "null inputs do not throw");

  ok(removeReviewRecord(metaHome, ID_A) === true, "remove works");
  ok(removeReviewRecord(metaHome, ID_A) === false, "removing twice is a no-op");

  const leftovers = fs.readdirSync(reviewsDir(metaHome)).filter((f) => f.includes(".tmp"));
  ok(leftovers.length === 0, "atomic write leaves no .tmp files");
  // --- a declared check must have somewhere to RUN (2026-08-04) --------------
  // reviews:runChecks resolves the directory as `check.cwd || rec.projectPath` and
  // refuses to guess when both are missing. Nothing stopped a record being WRITTEN
  // without either, so the refusal surfaced later as a review row whose checks failed
  // for a reason that looked like the code. It was my record, not his app (Aidin:
  // "End to end test failar på denna i review"). The condition asserted here is the
  // same expression the runner uses, so the two cannot drift apart.
  const withCheck = (over = {}, checkOver = {}) =>
    complete({ criticality: "core", checks: [{ label: "suite", cmd: "node scripts/e2e/x.mjs", ...checkOver }], ...over });
  const homeless = reviewRecordProblems(withCheck({ projectPath: undefined }));
  ok(homeless.some((p) => /nowhere to run/.test(p)), `a check with no projectPath and no cwd is refused (${homeless.join(" | ") || "accepted"})`);
  ok(
    reviewRecordProblems(withCheck({ projectPath: "  " })).some((p) => /nowhere to run/.test(p)),
    "whitespace is not a path"
  );
  ok(reviewRecordProblems(withCheck({ projectPath: "D:\\Repo\\Tools\\helm" })).length === 0, "a record-level projectPath satisfies it");
  ok(
    reviewRecordProblems(withCheck({ projectPath: undefined }, { cwd: "D:\\Repo\\Tools\\helm" })).length === 0,
    "so does a cwd on the check itself - the same either/or the runner applies"
  );
  // The requirement must NOT spread to records that declare no checks: a cosmetic item
  // legitimately has none, and demanding a path from it would make the rule noise.
  ok(
    reviewRecordProblems(complete({ criticality: "cosmetic", checks: [], projectPath: undefined })).length === 0,
    "a record with no checks needs no path"
  );
  ok(
    reviewRecordProblems(complete({ criticality: "cosmetic", projectPath: undefined })).length === 0,
    "nor does one that omits checks entirely"
  );

  // --- a check must be runnable in the shell that runs it (2026-08-04) --------
  // Same failure mode as the missing directory above, one layer down: checks are
  // spawned with `shell: true`, which on Windows is cmd.exe, and `VAR=1 node x.mjs`
  // is Unix syntax. cmd.exe reads `VAR=1` as a program name and fails before the
  // test starts. Aidin met this as "ett test failar" on a card whose code was fine -
  // my own record had declared exactly that command.
  const envPrefixed = reviewRecordProblems(withCheck({}, { cmd: "HELM_LIVE_CLI_TESTS=1 node scripts/e2e/x.mjs" }));
  ok(
    envPrefixed.some((p) => /Unix env-var prefix/.test(p)),
    `a check with a Unix env-var prefix is refused at write time (${envPrefixed.join(" | ") || "accepted"})`
  );
  ok(
    envPrefixed.some((p) => /HELM_LIVE_CLI_TESTS=1/.test(p)),
    "and the message quotes the offending prefix, so the fix is obvious without reading a shell error"
  );
  ok(
    reviewRecordProblems(withCheck({}, { cmd: "node scripts/e2e/x.mjs --live" })).length === 0,
    "the flag form of the same intent is accepted"
  );
  // A command that merely CONTAINS an "=" is fine - the rule is about a leading
  // assignment, not about the character, or it would refuse most real commands.
  for (const cmd of ['node -e "a=1"', "node scripts/run-tests.mjs --fast persona", "npm test -- --grep=review"]) {
    ok(reviewRecordProblems(withCheck({}, { cmd })).length === 0, `not tripped by an ordinary command containing "=" (${cmd})`);
  }

  // --- the criticality gradient (Aidin 2026-07-27) ---------------------------
  // "störst effort borde ligga på systemkritiska moment. security issues borde
  // t.ex aldrig slinka igenom, medans en front end bugg är mer acceptabelt."
  ok(reviewRecordProblems(complete({ criticality: undefined })).some((p) => /criticality must be one of/.test(p)),
    "a record with NO criticality is refused - silence must not resolve to the lenient tier");
  ok(reviewRecordProblems(complete({ criticality: "kritisk" })).some((p) => /criticality must be one of/.test(p)),
    "an unknown tier is refused rather than treated as a note");
  ok(reviewRecordProblems(complete({ criticality: "cosmetic" })).length === 0,
    "a cosmetic item needs no runnable check - a front-end bug is recoverable");

  // core: needs a check, but the author may still be the only reviewer.
  ok(reviewRecordProblems(complete({ criticality: "core" })).some((p) => /needs at least one runnable check/.test(p)),
    "a CORE item with no check is refused - state others depend on can't rest on prose");
  ok(reviewRecordProblems(complete({ criticality: "core", checks: [{ label: "x", cmd: "node -e 0" }] })).length === 0,
    "a core item with a check is complete");

  // critical: the author's own passing tests are explicitly not enough, AND the captain
  // always gets the call. Aidin, 2026-08-20: "ändringar som påverkar eventuell säkerhet
  // eller integritet ska vara needs you." A stamp means "read the evidence and move on",
  // and this is the one tier where being wrong is expensive or irreversible - so the
  // author does not get to decide his eyes were unnecessary. judgment also forces `ask`,
  // which is what makes "these specific parts" a required field instead of a hope.
  const crit = (over = {}) =>
    complete({
      criticality: "critical",
      verdict: "judgment",
      ask: "Confirm the token store choice before this ships.",
      checks: [{ label: "x", cmd: "node -e 0" }],
      ...over,
    });
  ok(
    reviewRecordProblems(crit({ verdict: "stamp", ask: undefined })).some((p) => /cannot be a stamp/.test(p)),
    "a CRITICAL item cannot be a stamp - security and integrity always need the captain, whatever the checks say"
  );
  ok(reviewRecordProblems(crit()).some((p) => /needs independentReview/.test(p)),
    "a CRITICAL item without an independent pass is refused - green self-written tests are not evidence at this tier");
  ok(reviewRecordProblems(crit({ independentReview: { by: "code-review agent", summary: "" } })).some((p) => /needs independentReview/.test(p)),
    "an independentReview with no summary doesn't count - a name alone proves nothing");
  ok(reviewRecordProblems(crit({ independentReview: { by: "code-review agent", summary: "found 2 real issues" } })).some((p) => /findings must be a number/.test(p)),
    "it must say HOW MANY findings the independent pass raised");
  const reviewed = { by: "code-review agent", summary: "no issues found", findings: 0 };
  // MUTATION EVIDENCE, new on 2026-08-03. A green suite proves the tests pass, not
  // that they would fail if the thing they guard broke - and the two worst misses
  // that day were guards whose removal left every check green, because the checks
  // asserted which FUNCTION was called and never with what arguments.
  ok(
    reviewRecordProblems(crit({ independentReview: reviewed })).some((p) => /mutation evidence/.test(p)),
    "a CRITICAL item with an independent pass but NO mutation evidence is still refused"
  );
  ok(
    reviewRecordProblems(
      crit({
        independentReview: reviewed,
        evidence: [{ claim: "the merged-branch gate holds", detail: "mutation: disabled the gate and test-worktree-sweep went red on 3 checks" }],
      })
    ).length === 0,
    "with an independent pass AND a described mutation, it is complete"
  );
  ok(
    reviewRecordProblems(
      crit({ independentReview: reviewed, evidence: [{ claim: "I ran the suite", detail: "49/49 passed" }] })
    ).some((p) => /mutation evidence/.test(p)),
    "a green suite alone does not satisfy it - passing is not the same as being able to fail"
  );
  ok(
    reviewRecordProblems(
      crit({
        independentReview: reviewed,
        evidence: [
          {
            claim: "broke the guard on purpose",
            // TIGHTENED 2026-08-03: this used to be the two words "the suite caught
            // it", which was enough. It no longer is - the gate now wants the sentence
            // to name what noticed, because the loose version also accepted records
            // stating that breaking the guard left the suite GREEN, which is the exact
            // condition it exists to catch (independent review).
            detail: "removed the merged-branch check and test-worktree-sweep-live went red on two cases",
          },
        ],
      })
    ).length === 0,
    "and it reads the claim's own words rather than a checkbox a hopeful author would tick");
  ok(reviewRecordProblems(complete({ criticality: "critical", independentReview: { by: "a", summary: "b", findings: 0 } }))
    .some((p) => /needs at least one runnable check/.test(p)),
    "critical needs BOTH a check and an independent pass, not either/or");

  // --- acceptance criteria: intent captured before the work ------------------
  // The bug this closes: the "Jump in" criterion was "I land in the session" and the
  // test COUNTED buttons. Nothing connected the two, so it passed while broken.
  const withAc = (criteria, steps) => complete({ criticality: "cosmetic", acceptanceCriteria: criteria, testSteps: steps });
  const AC1 = { index: 1, text: "I click Jump in and land in that project's session" };
  const AC2 = { index: 2, text: "the drift list disappears once the docs are reconciled" };
  ok(reviewRecordProblems(withAc([AC1], [{ step: "count the buttons", expect: "one button" }]))
    .some((p) => /has no test step covering it/.test(p)),
    "a criterion with no linked test step is refused - this is the exact Jump-in failure");
  ok(reviewRecordProblems(withAc([AC1], [{ step: "click Jump in", expect: "chat opens on that session", ac: 1 }])).length === 0,
    "linking the step to the criterion by number satisfies it");
  ok(reviewRecordProblems(withAc([AC1], [{ step: "click Jump in", expect: "chat opens", ac: AC1.text }])).length === 0,
    "linking by the criterion's text works too");
  ok(reviewRecordProblems(withAc([AC1, AC2], [{ step: "click", expect: "opens", ac: [1, 2] }])).length === 0,
    "one step may cover two criteria");
  ok(reviewRecordProblems(withAc([AC1, AC2], [{ step: "click", expect: "opens", ac: 1 }]))
    .some((p) => /criterion 2 has no test step/.test(p)),
    "covering only the first of two criteria is still refused");
  ok(reviewRecordProblems(withAc([AC1], [{ step: "click", expect: "opens", ac: 7 }]))
    .some((p) => /not one of this task's acceptance criteria/.test(p)),
    "a step claiming to cover a criterion that doesn't exist is an error, not noise");
  ok(reviewRecordProblems(complete({ criticality: "cosmetic", acceptanceCriteria: [] })).length === 0,
    "an explicitly EMPTY criteria list is allowed - it claims the task had none, visibly");
  ok(reviewRecordProblems(complete({ criticality: "cosmetic" })).length === 0,
    "a record with no criteria field at all is not refused - work predating this must stay writable");

  // Drift: the record snapshots the criteria, so a later task edit must be REPORTED,
  // never silently adopted or silently ignored.
  const snap = { acceptanceCriteria: [AC1] };
  ok(acceptanceDrift(snap, "blah\nAC: I click Jump in and land in that project's session\nmore").drifted === false,
    "matching criteria are not drift");
  ok(acceptanceDrift(snap, "AC: something else entirely happens now").drifted === true,
    "an edited criterion IS drift - either the work or the record needs revisiting");
  ok(acceptanceDrift(snap, "no criteria here").drifted === true, "removing the criteria from the task is drift too");

  // --- the gauntlet: declared checks vs what actually ran --------------------
  // This had NO repo test until a live run exposed the bug below - the same miss
  // as the feature it guards (a test that lived only in a scratch file).
  const G = "cccccccc-3333-4333-8333-333333333333";
  const gRec = {
    taskId: G,
    title: "Gauntlet subject",
    verdict: "stamp",
    summary: "Two declared checks.",
    criticality: "core",
    // The test's OWN temp dir, not a real repo path.
    //
    // This used to read "D:\Repo\Tools\helm" with SINGLE backslashes, which JS silently
    // collapses to "D:RepoToolshelm" - `\R` and `\T` are not escapes it knows, so it drops
    // the backslash. That is how four real records on disk came to carry an unusable
    // project path, and reviewRecordProblems now refuses the shape, which is what turned
    // this fixture red.
    //
    // Spelling it correctly then broke it a SECOND way, and that is the interesting half:
    // the mangled path pointed at nothing, so currentHead() returned null and staleness was
    // never computed. A correct path to the real helm repo made it resolve, and every run
    // scored stale against a HEAD that has nothing to do with this fixture's commits. This
    // block is about gauntlet SCORING; commit pinning has its own block below with a real
    // temp git repo. A non-repo directory is what keeps the two separate.
    projectPath: metaHome,
    // A `core` record is refused without the ask it was written against (task 10928bdf).
    intent: { text: "Score a multi-check gauntlet correctly.", source: "captain" },
    evidence: [],
    notVerified: [],
    testSteps: [{ step: "Run it", expect: "It works" }],
    checks: [
      { label: "first", cmd: "node -e \"process.exit(0)\"" },
      { label: "second", cmd: "node -e \"process.exit(0)\"" },
    ],
  };
  const gWrote = writeReviewRecord(metaHome, gRec);
  ok(gWrote.ok, `the gauntlet fixture wrote (${gWrote.ok ? "ok" : gWrote.error}) - every check below depends on it`);
  ok(gauntletStatus(readReviewRecord(metaHome, G), metaHome).state === "incomplete", "declared-but-unrun reads as incomplete, never as passing");
  ok(gauntletStatus(readReviewRecord(metaHome, G), metaHome).unrun === 2, "both unrun checks are counted");

  // THE BUG: stamping a run is itself a write. When the baseline was the record's
  // updatedAt, the second stamp moved it past the FIRST run, so run 1 read as
  // stale - meaning a multi-check gauntlet could never reach "passing" however
  // green the checks were. Staleness now measures against contentUpdatedAt.
  recordCheckRun(metaHome, G, { label: "first", cmd: "x", exitCode: 0 });
  recordCheckRun(metaHome, G, { label: "second", cmd: "x", exitCode: 0 });
  const afterBoth = gauntletStatus(readReviewRecord(metaHome, G), metaHome);
  ok(afterBoth.state === "passing", `two passing checks make a PASSING gauntlet (got ${afterBoth.state}: pass ${afterBoth.passed}, stale ${afterBoth.stale})`);
  ok(afterBoth.passed === 2 && afterBoth.stale === 0, `both runs count as fresh (pass ${afterBoth.passed}, stale ${afterBoth.stale})`);

  // A red check cannot be talked around.
  recordCheckRun(metaHome, G, { label: "second", cmd: "x", exitCode: 7 });
  const withFail = gauntletStatus(readReviewRecord(metaHome, G), metaHome);
  ok(withFail.state === "failing" && withFail.failed === 1, `a non-zero exit makes the gauntlet FAILING (got ${withFail.state})`);
  ok(readReviewRecord(metaHome, G).checkRuns.find((r) => r.label === "second").exitCode === 7, "the real exit code is stored, not just a boolean");

  // But a real EDIT must still invalidate green ticks - otherwise a pass keeps
  // vouching for work that has since changed. This is the failure mode the
  // isRunStamp split had to avoid re-introducing in the other direction.
  recordCheckRun(metaHome, G, { label: "second", cmd: "x", exitCode: 0 });
  ok(gauntletStatus(readReviewRecord(metaHome, G), metaHome).state === "passing", "back to passing after the check is re-run green");
  const edited = { ...readReviewRecord(metaHome, G), summary: "changed after the checks ran" };
  writeReviewRecord(metaHome, edited, { now: Date.now() + 5000 });
  const afterEdit = gauntletStatus(readReviewRecord(metaHome, G), metaHome);
  ok(afterEdit.state === "incomplete" && afterEdit.stale === 2, `editing the record makes every earlier run stale (got ${afterEdit.state}, stale ${afterEdit.stale})`);
  ok(afterEdit.passed === 0, "a stale run is not counted as a pass");

  // --- run provenance: "the app ran this" vs "someone typed this" ------------
  // The finding that mattered most in the independent review of this file:
  // writeReviewRecord (and all its refusals) is not on any production path, records
  // are authored by an agent writing JSON directly, and gauntletStatus trusted an
  // `ok: true` FIELD. So a hand-written record with a plausible label and no command
  // ever executed read as "Checks passing (1/1), ready to stamp".
  const legacyFile = reviewRecordPath(metaHome, G);
  const fabricated = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  fabricated.checks = [{ label: "auth e2e (34 assertions)", cmd: "node -e \"process.exit(0)\"" }];
  fabricated.checkRuns = [{ label: "auth e2e (34 assertions)", ok: true }];
  fs.writeFileSync(legacyFile, JSON.stringify(fabricated), "utf8");
  let g = gauntletStatus(readReviewRecord(metaHome, G), metaHome);
  ok(g.state !== "passing", `a hand-written run with ok:true and no command ever run does NOT read as passing (got ${g.state})`);
  ok(g.unverified === 1 && g.passed === 0, `it is counted as unverified, not as a pass (unverified ${g.unverified}, passed ${g.passed})`);

  // Even a fully plausible forgery - exit code, timestamp, the works - fails without
  // the signature only the running app can produce.
  fabricated.checkRuns = [{ label: "auth e2e (34 assertions)", ok: true, exitCode: 0, ranAt: Date.now() }];
  fs.writeFileSync(legacyFile, JSON.stringify(fabricated), "utf8");
  g = gauntletStatus(readReviewRecord(metaHome, G), metaHome);
  ok(g.unverified === 1, "a run with a plausible exit code and timestamp but no signature is still unverified");

  // A signature from a DIFFERENT record can't be transplanted.
  const rec2 = readReviewRecord(metaHome, G);
  const otherSig = signCheckRun(metaHome, ID_B, { label: "auth e2e (34 assertions)", cmd: "node -e \"process.exit(0)\"", exitCode: 0, ranAt: 5000 });
  fabricated.checkRuns = [{ label: "auth e2e (34 assertions)", cmd: "node -e \"process.exit(0)\"", exitCode: 0, ranAt: 5000, sig: otherSig }];
  fs.writeFileSync(legacyFile, JSON.stringify(fabricated), "utf8");
  ok(gauntletStatus(readReviewRecord(metaHome, G), metaHome).unverified === 1, "a signature made for another task does not verify here");

  // And a genuine signed run does verify - the mechanism has to be usable, not just strict.
  const realRun = { label: "auth e2e (34 assertions)", cmd: "node -e \"process.exit(0)\"", exitCode: 0, ranAt: 6000 };
  ok(verifyCheckRun(metaHome, G, { ...realRun, sig: signCheckRun(metaHome, G, realRun) }) === true, "a run signed for this record verifies");
  ok(verifyCheckRun(metaHome, G, { ...realRun, exitCode: 1, sig: signCheckRun(metaHome, G, realRun) }) === false,
    "changing the exit code after signing breaks the signature - the outcome is covered, not just the label");
  ok(verifyCheckRun(metaHome, G, realRun) === false, "an unsigned run never verifies");
  ok(verifyCheckRun(null, G, { ...realRun, sig: "x" }) === false, "with no metaHome nothing can be verified, so nothing is trusted");

  // Records written before contentUpdatedAt existed must not all read as stale -
  // but they still need genuine, signed runs.
  const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  delete legacy.contentUpdatedAt;
  legacy.updatedAt = 1000;
  legacy.checks = [{ label: "legacy check", cmd: "node -e \"process.exit(0)\"" }];
  const legacyRun = { label: "legacy check", cmd: "node -e \"process.exit(0)\"", exitCode: 0, ranAt: 2000 };
  legacy.checkRuns = [{ ...legacyRun, ok: true, sig: signCheckRun(metaHome, G, legacyRun) }];
  fs.writeFileSync(legacyFile, JSON.stringify(legacy), "utf8");
  ok(gauntletStatus(readReviewRecord(metaHome, G), metaHome).state === "passing",
    "a record without contentUpdatedAt falls back to updatedAt rather than reading as all-stale");

  // --- a run is pinned to the commit it ran against --------------------------
  // The ordinary second lap used to break the gauntlet: Aidin sends a task back, the
  // next session fixes the code and returns the task to review WITHOUT rewriting the
  // record, and the pre-fix green run still vouches for it. Staleness only looked at
  // the record's own contentUpdatedAt, so nothing noticed the code had moved.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-head-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["init", "-b", "main", repo], { windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "first");
  const sha1 = git("rev-parse", "HEAD").trim();

  const HEADID = "ffffffff-6666-4666-8666-666666666666";
  writeReviewRecord(metaHome, complete({
    taskId: HEADID,
    criticality: "core",
    intent: { text: "Pin each check run to the commit it verified.", source: "captain" },
    checks: [{ label: "suite", cmd: "node -e 0" }],
    // One projectPath, the real temp repo. There used to be a mangled
    // "D:\Repo\Tools\helm" literal above this line, silently overridden by it.
    projectPath: repo,
  }));
  recordCheckRun(metaHome, HEADID, { label: "suite", exitCode: 0 });
  const pinned = readReviewRecord(metaHome, HEADID);
  ok(pinned.checkRuns[0].head === sha1, `the run records the commit it ran against (${pinned.checkRuns[0].head?.slice(0, 8)})`);
  ok(pinned.checkRuns[0].headDirty === false, "and whether the tree was dirty at the time");
  ok(gauntletStatus(pinned, metaHome, { head: sha1 }).state === "passing", "at that commit it passes");

  // The second lap: code moves, record untouched.
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  git("add", "-A");
  git("commit", "-m", "the fix after the send-back");
  const sha2 = git("rev-parse", "HEAD").trim();
  const afterFix = gauntletStatus(readReviewRecord(metaHome, HEADID), metaHome, { head: sha2 });
  ok(afterFix.state !== "passing", `after a new commit the old pass no longer vouches (${afterFix.state})`);
  ok(afterFix.stale === 1, `it reads as stale, not as a pass (${JSON.stringify(afterFix)})`);

  // Re-running at the new commit clears it - the mechanism has to be usable.
  recordCheckRun(metaHome, HEADID, { label: "suite", exitCode: 0 });
  ok(gauntletStatus(readReviewRecord(metaHome, HEADID), metaHome, { head: sha2 }).state === "passing",
    "re-running at the current commit restores the pass");

  // The head is covered by the signature, so it cannot be edited to fake currency.
  const repinned = readReviewRecord(metaHome, HEADID);
  const forgedPin = { ...repinned, checkRuns: [{ ...repinned.checkRuns[0], head: sha1 }] };
  ok(gauntletStatus(forgedPin, metaHome, { head: sha1 }).unverified === 1,
    "editing the recorded commit breaks the signature - a pass cannot be re-pinned by hand");

  // No git, or a project that isn't a repo: unknown must not read as verified-fresh,
  // but it also must not break a machine without git.
  ok(currentHead(path.join(repo, "nope")) === null, "a non-repo path yields no head rather than throwing");
  ok(currentHead(null) === null, "no project path yields no head");
  const unpinned = gauntletStatus(readReviewRecord(metaHome, HEADID), metaHome, { head: null });
  ok(unpinned.state === "passing", "when the current head is unknown, an existing pass is not invented away - the pin is a bonus signal, not a requirement");
  fs.rmSync(repo, { recursive: true, force: true });

  // --- a documentation commit must not invalidate a code check ---------------
  // Pinning a pass to a commit made ANY commit stale every check, including one that
  // only edited a markdown file. Safe in direction, but it left the whole board reading
  // stale during an active session - and a warning that is always on stops being a
  // warning. So the comparison asks whether anything OTHER than docs changed.
  const dRepo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-docs-"));
  const dg = (...args) => execFileSync("git", ["-C", dRepo, ...args], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["init", "-b", "main", dRepo], { windowsHide: true });
  dg("config", "user.email", "t@t.t");
  dg("config", "user.name", "T");
  dg("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dRepo, "code.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dRepo, "NOTES.md"), "# notes\n");
  dg("add", "-A");
  dg("commit", "-m", "init");
  const base = dg("rev-parse", "HEAD").trim();

  fs.writeFileSync(path.join(dRepo, "NOTES.md"), "# notes\n\nmore prose\n");
  dg("add", "-A");
  dg("commit", "-m", "docs only");
  const afterDocs = dg("rev-parse", "HEAD").trim();
  ok(codeChangedBetween(dRepo, base, afterDocs) === false, "a commit touching only a .md file does NOT count as a code change");

  fs.writeFileSync(path.join(dRepo, "code.js"), "export const a = 2;\n");
  dg("add", "-A");
  dg("commit", "-m", "real change");
  const afterCode = dg("rev-parse", "HEAD").trim();
  ok(codeChangedBetween(dRepo, afterDocs, afterCode) === true, "a commit touching code DOES count");
  ok(codeChangedBetween(dRepo, base, afterCode) === true, "and a range containing both counts - the docs commit cannot mask the code one");
  ok(codeChangedBetween(dRepo, base, base) === false, "the same commit is not a change");
  // Unknown must never read as "nothing changed" - a false stale is annoying, a false
  // fresh is the failure the pin exists to prevent.
  ok(codeChangedBetween(dRepo, base, "0".repeat(40)) === true, "an unknown commit counts as changed rather than unchanged");
  ok(codeChangedBetween(null, base, afterCode) === true, "no project path counts as changed");
  ok(codeChangedBetween(dRepo, null, afterCode) === true, "a run with no recorded commit counts as changed");

  // --- a stale run must say WHICH kind of stale (2026-08-04) -----------------
  // Four quite different situations collapsed into one "stale", and the card printed a
  // single explanation for all of them. So a check that went GREEN on an uncommitted tree
  // was reported as "ran before the last change" - not what happened, and it sent him
  // looking in the wrong place (Aidin, task d6b33767: "Säger all checks passed men visar
  // inte det på kortet"). The state is unchanged; what is new is that the reason travels
  // with it.
  const DIRTY = "66666666-8888-4888-8888-888888888888";
  const dirtyChecks = [{ label: "suite", cmd: 'node -e "process.exit(0)"' }];
  writeReviewRecord(metaHome, complete({ taskId: DIRTY, criticality: "core", checks: dirtyChecks, projectPath: dRepo }));
  fs.writeFileSync(path.join(dRepo, "code.js"), "export const a = 3; // uncommitted\n");
  recordCheckRun(metaHome, DIRTY, { label: "suite", cmd: 'node -e "process.exit(0)"', exitCode: 0 });
  const dirtyRec = readReviewRecord(metaHome, DIRTY);
  ok(dirtyRec.checkRuns[0].headDirty === true, "a run on an uncommitted tree records that it was dirty");
  const dirtyG = gauntletStatus(dirtyRec, metaHome, {
    head: dg("rev-parse", "HEAD").trim(),
    codeChanged: (from, to) => codeChangedBetween(dRepo, from, to),
  });
  ok(dirtyG.state !== "passing", `a green run on an uncommitted tree still does not count (${dirtyG.state})`);
  ok(
    dirtyG.perCheck[0].staleReason === "ran on uncommitted changes",
    `and it says WHY, in the words that match what happened (${JSON.stringify(dirtyG.perCheck[0].staleReason)})`
  );
  ok(dirtyG.perCheck[0].exitCode === 0, "the exit code is still reported as the zero it was - the run is not being called a failure");
  // Commit it and the same run is admissible: the reason was the dirt, not the code.
  dg("add", "-A");
  dg("commit", "-m", "commit the change the run was made on");
  recordCheckRun(metaHome, DIRTY, { label: "suite", cmd: 'node -e "process.exit(0)"', exitCode: 0 });
  const cleanRec = readReviewRecord(metaHome, DIRTY);
  const cleanG = gauntletStatus(cleanRec, metaHome, {
    head: dg("rev-parse", "HEAD").trim(),
    codeChanged: (from, to) => codeChangedBetween(dRepo, from, to),
  });
  ok(cleanG.state === "passing", `re-running on a clean tree counts (${cleanG.state})`);
  ok(cleanG.perCheck[0].staleReason === null, "and carries no reason, because there is nothing to explain");

  // End to end through gauntletStatus: the same pass survives a docs commit and dies
  // on a code commit.
  const DOCPIN = "77777777-9999-4999-8999-999999999999";
  const docChecks = [{ label: "suite", cmd: "node -e \"process.exit(0)\"" }];
  writeReviewRecord(metaHome, complete({ taskId: DOCPIN, criticality: "core", checks: docChecks, projectPath: dRepo }));
  // Stamp a run pinned to `base` by hand-signing it the way recordCheckRun would.
  const pinRun = { label: "suite", cmd: docChecks[0].cmd, exitCode: 0, ranAt: Date.now() + 30000, head: base, headDirty: false };
  const pinned2 = {
    ...readReviewRecord(metaHome, DOCPIN),
    checkRuns: [{ ...pinRun, ok: true, sig: signCheckRun(metaHome, DOCPIN, pinRun, docChecks[0].cmd) }],
    contentUpdatedAt: 1,
  };
  const changed = (from, to) => codeChangedBetween(dRepo, from, to);
  ok(gauntletStatus(pinned2, metaHome, { head: afterDocs, codeChanged: changed }).state === "passing",
    "a pass survives a documentation-only commit");
  ok(gauntletStatus(pinned2, metaHome, { head: afterCode, codeChanged: changed }).stale === 1,
    "and still goes stale on a code commit");
  // The DEFAULT resolver must stay strict: a caller that forgets to pass one gets the
  // safe behaviour, not the lenient one.
  ok(gauntletStatus(pinned2, metaHome, { head: afterDocs }).stale === 1,
    "with no resolver supplied, any different commit is stale - the safe default");
  fs.rmSync(dRepo, { recursive: true, force: true });

  // --- cosmetic must be argued for, and absences must be visible -------------
  // The most likely path to false trust was not a trick: a `cosmetic` record with no
  // checks and no criteria is fully valid, renders NO gauntlet box at all (so nothing
  // amber, no Run checks button), and lands under "Ready to stamp".
  ok(reviewRecordProblems(complete({ whyNotCritical: undefined })).some((p) => /must state whyNotCritical/.test(p)),
    "a cosmetic record with no stated reason is refused - the tier that needs no evidence has to be argued for");
  ok(reviewRecordProblems(complete({ whyNotCritical: "ui only" })).some((p) => /must state whyNotCritical/.test(p)),
    "a two-word hand-wave doesn't count as an argument");
  // A pure LENGTH gate accepted these; the word-count requirement is what rejects them.
  ok(reviewRecordProblems(complete({ whyNotCritical: "..............." })).some((p) => /must state whyNotCritical/.test(p)),
    "fifteen dots is not an argument");
  ok(reviewRecordProblems(complete({ whyNotCritical: "n/a n/a n/a n/a" })).some((p) => /must state whyNotCritical/.test(p)),
    "nor is a placeholder repeated to length");
  ok(reviewRecordProblems(complete({ criticality: "core", checks: [{ label: "x", cmd: "node -e 0" }], whyNotCritical: undefined })).length === 0,
    "core and critical don't need it - only the tier that buys its way out of evidence");

  // Caveats are TRUE STATEMENTS about the record, not validity errors: their signature
  // is an absence, and an absence renders as nothing at all unless something says so.
  const bare = complete();
  ok(reviewRecordProblems(bare).length === 0, "a bare cosmetic record with a stated reason is still admissible");
  const cav = recordCaveats(bare);
  ok(cav.some((c) => /No executed check at all/.test(c)), `...but it is reported as resting on the author's word (${JSON.stringify(cav)})`);
  ok(cav.some((c) => /No acceptance criteria were agreed/.test(c)), "and as having no agreed intent to check against");
  ok(recordCaveats(complete({ acceptanceCriteria: [] })).some((c) => /explicitly recorded as none/.test(c)),
    "an explicitly empty criteria list reads differently from a missing one - one is a claim, the other is a gap");
  const withReal = complete({ criticality: "core", checks: [{ label: "u", cmd: "node -e 0" }], acceptanceCriteria: [] });
  ok(!recordCaveats(withReal).some((c) => /No executed check/.test(c)), "a record with a real check is not flagged for having none");
  ok(recordCaveats(complete({ criticality: "core", checks: [{ label: "u", cmd: "npm test || exit 0" }] }))
    .some((c) => /cannot fail/.test(c)), "a pass-forcing check is named in the caveats too");
  ok(recordCaveats(null).length === 0, "recordCaveats(null) is a safe empty list");

  // ONE FILE IS NOT THE SUITE. A single test file passing in isolation cannot show
  // one test interfering with another - and on 2026-08-03 a new test passed alone
  // and failed under the runner, because standalone it had written to a REAL data
  // file instead of its temp one. The file said green; the suite said what was true.
  ok(
    recordCaveats(complete({ criticality: "core", checks: [{ label: "u", cmd: "node scripts/e2e/test-thing.mjs" }] })).some((c) =>
      /No check runs the whole suite/.test(c)
    ),
    "a record whose only check is one test FILE is flagged for never having run the suite"
  );
  ok(
    !recordCaveats(complete({ criticality: "core", checks: [{ label: "u", cmd: "npm run test:fast" }] })).some((c) =>
      /No check runs the whole suite/.test(c)
    ),
    "and one that runs the suite is not"
  );
  // CORRECTED 2026-08-03. This assertion used to expect `node run-tests.mjs --fast`
  // to be flagged as "not the suite" on the grounds that it names a .mjs file - which
  // encoded the bug rather than the rule: run-tests.mjs IS the whole suite, and the
  // caveat therefore cried wolf on the one command this repo uses to run everything
  // (independent review). Naming a file is only evidence of a subset when the file is
  // not the runner.
  ok(
    !recordCaveats(complete({ criticality: "core", checks: [{ label: "u", cmd: "node run-tests.mjs --fast" }] })).some((c) =>
      /No check runs the whole suite/.test(c)
    ),
    "the suite RUNNER counts as the suite even though it names a .mjs file"
  );
  ok(
    recordCaveats(complete({ criticality: "core", checks: [{ label: "u", cmd: "npm run test:fast -- worktree" }] })).some((c) =>
      /No check runs the whole suite/.test(c)
    ),
    "but a filter argument makes it a subset again, however suite-like the command looks"
  );

  // --- a command that cannot fail is not a pass ------------------------------
  // The worst finding of the whole day, and it was mine: passForcingReason DETECTED a
  // pass-forcing command and then nothing acted on it. `state` came purely from the
  // exit code, so `node test.mjs || exit 0`, genuinely run and signed by the app, read
  // "Checks passing (1/1)", landed under "Ready to stamp", counted zero in
  // tally.unconfirmed, raised no badge, and signed off on ONE CLICK. It is the exact
  // attack the pattern list was written for, and two of these tests asserted it was
  // correct behaviour.
  const FORCED = "88888888-8888-4888-8888-888888888888";
  const forcedChecks = [{ label: "auth suite (34 assertions)", cmd: "node scripts/e2e/test-auth.mjs || exit 0" }];
  const forcedRun = { label: forcedChecks[0].label, cmd: forcedChecks[0].cmd, exitCode: 0, ranAt: Date.now() + 20000 };
  const forcedLive = {
    taskId: FORCED,
    checks: forcedChecks,
    checkRuns: [{ ...forcedRun, ok: true, sig: signCheckRun(metaHome, FORCED, forcedRun, forcedChecks[0].cmd) }],
    contentUpdatedAt: 1,
  };
  const fs2 = gauntletStatus(forcedLive, metaHome);
  ok(fs2.state !== "passing", `a GENUINELY RUN, correctly signed check whose command cannot fail does NOT read as passing (got ${fs2.state})`);
  ok(fs2.unusable === 1 && fs2.passed === 0, `it is counted as unusable, not as a pass (${JSON.stringify({ unusable: fs2.unusable, passed: fs2.passed })})`);
  ok(fs2.perCheck[0].passForced === "|| always-succeeds fallback", "and the reason is carried for the page to show");
  // The tally and band must agree - the header used to say "1 ready to stamp".
  const forcedRow = { verdict: "stamp", criticality: "core", gauntlet: fs2 };
  ok(reviewBand(forcedRow) === "unconfirmed", `such a row bands as unconfirmed, not stamp (${reviewBand(forcedRow)})`);
  ok(reviewQueueTally([{ ...forcedRow, band: reviewBand(forcedRow) }]).unconfirmed === 1, "and the header counts it apart from real stamps");

  // A check with no declared command at all: verification would otherwise fall back to
  // run.cmd, a field in the file the author writes, so DELETING checks[].cmd turned a
  // forged run back into a pass.
  const noCmd = gauntletStatus({ ...forcedLive, checks: [{ label: forcedChecks[0].label }] }, metaHome);
  ok(noCmd.state !== "passing" && noCmd.unusable === 1, `a check with no declared command is unusable, never a pass (${noCmd.state})`);

  // --- the run must belong to the DECLARED check -----------------------------
  // Runs used to be matched to checks by LABEL alone, with nothing comparing the two
  // commands - so a run stamped for `exit 0` could score a check whose displayed
  // command was a real e2e script. The field the code called "the fact" was not the
  // thing that produced the exit code.
  const BIND = "eeeeeeee-5555-4555-8555-555555555555";
  writeReviewRecord(metaHome, complete({
    taskId: BIND,
    criticality: "core",
    // The temp dir, not a real repo - same reason as the gauntlet block above. This line
    // used to be a single-backslash "D:\Repo\Tools\helm" that collapsed to nothing, so
    // currentHead() never resolved and staleness never applied. Spelling it correctly made
    // every run here score stale against the live helm HEAD, which this block is not about.
    projectPath: metaHome,
    intent: { text: "Bind each stamped run to the command that produced it.", source: "captain" },
    checks: [{ label: "e2e suite", cmd: "node scripts/e2e/test-real-thing.mjs" }],
  }));
  // A stamp for a label the record doesn't declare is refused outright.
  const strayLabel = recordCheckRun(metaHome, BIND, { label: "some other check", cmd: "node -e \"process.exit(0)\"", exitCode: 0 });
  ok(strayLabel.ok === false && /declares no check labelled/.test(strayLabel.error || ""),
    `a run for an undeclared label is refused (${strayLabel.error?.slice(0, 70)})`);

  // A stamp that CLAIMS a different command gets the declared command stored and
  // signed, so it cannot smuggle its own version onto the card.
  recordCheckRun(metaHome, BIND, { label: "e2e suite", cmd: "node -e \"process.exit(0)\"", exitCode: 0 });
  const bound = readReviewRecord(metaHome, BIND);
  ok(bound.checkRuns[0].cmd === "node scripts/e2e/test-real-thing.mjs",
    `the stored run carries the DECLARED command, not the caller's (${bound.checkRuns[0].cmd})`);
  ok(gauntletStatus(bound, metaHome).state === "passing", "a genuine stamp for a declared check still passes");

  // Now swap the declared command underneath a signed run: the signature covers the
  // declared command, so the pass stops applying to the new one.
  const swapped = { ...bound, checks: [{ label: "e2e suite", cmd: "node -e \"process.exit(0)\"" }] };
  ok(gauntletStatus(swapped, metaHome).unverified === 1,
    "changing the declared command invalidates the run signed for the old one - a pass cannot be moved onto a different command");

  // --- commands that cannot fail ---------------------------------------------
  // reviews:runChecks spawns with shell:true, so `node test.mjs || exit 0` exits 0
  // whatever the test does - a GENUINE signed green.
  ok(passForcingReason("node scripts/e2e/x.mjs || exit 0") === "|| always-succeeds fallback", "an || fallback is flagged");
  ok(passForcingReason("npm test ; exit 0") === "; exit 0 appended", "a ; exit 0 tail is flagged");
  ok(passForcingReason("npm test | true") === "piped to true", "a pipe to true is flagged");
  ok(passForcingReason("jest --passWithNoTests") === "--passWithNoTests", "--passWithNoTests is flagged");
  ok(passForcingReason("node scripts/e2e/test-review-records.mjs") === null, "an ordinary command is not flagged");
  ok(passForcingReason("") === null && passForcingReason(null) === null, "empty input does not throw or flag");
  // It FLAGS rather than refuses - a check that refuses to run is a check that gets
  // deleted - but the flag has to reach the reader.
  const forcedRec = complete({ taskId: BIND, criticality: "core", checks: [{ label: "e2e suite", cmd: "npm test || exit 0" }] });
  ok(reviewRecordProblems(forcedRec).length === 0, "a pass-forcing command is not a validity error (it flags, it doesn't refuse)");
  const forcedStatus = gauntletStatus(forcedRec, metaHome);
  ok(forcedStatus.perCheck[0].passForced === "|| always-succeeds fallback",
    `the flag is carried on perCheck so the page can show it (${forcedStatus.perCheck[0].passForced})`);

  // --- duplicate check labels ------------------------------------------------
  // Runs are keyed by label, so two checks sharing one collapsed to a single run and
  // a FAILING check disappeared behind a passing one - reported as 2/2 passing.
  const dupeRec = complete({ taskId: ID_B, criticality: "core", checks: [{ label: "e2e", cmd: "exit 7" }, { label: "e2e", cmd: "node -e \"process.exit(0)\"" }] });
  ok(reviewRecordProblems(dupeRec).some((p) => /labels must be unique/.test(p)), "duplicate check labels are refused at the record level");
  // The previous version of this assertion passed `checkRuns: []`, which cannot fail:
  // with no runs at all nothing could be passing whatever the duplicate rule does.
  // Proven by mutation - disabling the duplicate-label guard produced zero failures.
  // So give the duplicate a REAL signed passing run and require the record to still
  // refuse to read as passing.
  const DUPE = "99999999-7777-4777-8777-777777777777";
  const dupeChecks = [{ label: "e2e", cmd: "node -e \"process.exit(0)\"" }, { label: "e2e", cmd: "node -e \"process.exit(7)\"" }];
  const dupeRun = { label: "e2e", cmd: dupeChecks[0].cmd, exitCode: 0, ranAt: Date.now() + 10000 };
  const dupeLive = {
    taskId: DUPE,
    checks: dupeChecks,
    checkRuns: [{ ...dupeRun, ok: true, sig: signCheckRun(metaHome, DUPE, dupeRun, dupeChecks[0].cmd) }],
    contentUpdatedAt: 1,
  };
  const dupeStatus = gauntletStatus(dupeLive, metaHome);
  ok(dupeStatus.state !== "passing",
    `a duplicate label does not read as passing even with a genuine signed green run for it (got ${dupeStatus.state})`);
  ok(dupeStatus.passed === 1 && dupeStatus.unverified === 1,
    `the first is scored, the duplicate is unverified (passed ${dupeStatus.passed}, unverified ${dupeStatus.unverified})`);

  ok(gauntletStatus({ taskId: G }).state === "none", "a record declaring no checks has no gauntlet, rather than a fake pass");
  ok(gauntletStatus(null).state === "none", "gauntletStatus(null) is a safe no-op");
  ok(recordCheckRun(metaHome, "no-such-id-000000", { label: "x", exitCode: 0 }).ok === false, "stamping a run onto a missing record fails loudly");
  ok(recordCheckRun(metaHome, G, { exitCode: 0 }).ok === false, "a run with no label is refused - it could not be matched to a check");

  // ---- readability, enforced 2026-08-20 ---------------------------------------
  // Measured first, not guessed: across the 93 records that existed that day the median
  // summary was 393 characters and the median gap line 180. Only 3 of the 93 pass these
  // limits, which is why they are enforced at the WRITE and never at the render - marking
  // ninety records incomplete at once is the noise this exists to remove.
  const L = READABILITY_LIMITS;
  ok(reviewRecordReadability(complete()).length === 0, "a short record is readable");

  const longSummary = complete({ summary: "x".repeat(L.summary + 1) });
  ok(
    reviewRecordReadability(longSummary).some((p) => /summary is \d+ characters/.test(p)),
    `one character over the summary limit (${L.summary}) is refused`
  );
  ok(
    reviewRecordProblems(longSummary).length === 0,
    "but reviewRecordProblems does NOT flag it - readability is not retroactive, or every old record turns incomplete at once"
  );

  // THE property that makes the limits fair rather than lossy: the honest long half is
  // not deleted, it moves behind the expander, and `detail` is uncapped.
  const longLine = "y".repeat(L.visibleLine + 1);
  ok(
    reviewRecordReadability(complete({ evidence: [longLine] })).some((p) => /split it into \{ claim, detail \}/.test(p)),
    "a long visible line is refused, and the message says where the long half goes"
  );
  ok(
    reviewRecordReadability(complete({ evidence: [{ claim: "Short claim.", detail: longLine.repeat(6) }] })).length === 0,
    "moving that text into `detail` makes it pass - detail has NO limit, so nothing has to be dropped to comply"
  );
  ok(
    reviewRecordReadability(complete({ notVerified: [longLine] })).some((p) => /notVerified\[0\]/.test(p)),
    "the same limit applies to the gaps, named by index so it is findable"
  );
  ok(
    reviewRecordReadability(complete({ evidence: Array.from({ length: L.evidenceItems + 1 }, (_, i) => `point ${i}`) })).some((p) =>
      /merge the ones that make the same point/.test(p)
    ),
    `more than ${L.evidenceItems} evidence entries is refused`
  );
  ok(
    reviewRecordReadability(
      complete({ testSteps: [{ step: "z".repeat(L.step + 1), expect: "fine" }] })
    ).some((p) => /one action per step/.test(p)),
    "an over-long step is refused with what to do instead"
  );

  // And the gate actually bites on the way in, not only in a pure function.
  // A task id nothing else in this file has written, so "nothing was written" is
  // actually testing the refusal rather than reading a record from an earlier case.
  const FRESH = "7c1e9d40-5a2b-4c8e-9f31-2ad6be845100";
  const wroteLong = writeReviewRecord(metaHome, complete({ taskId: FRESH, summary: "q".repeat(L.summary + 50) }));
  ok(wroteLong.ok === false && /too long to be read/.test(wroteLong.error || ""), "writeReviewRecord REFUSES an unreadable record");
  ok(readReviewRecord(metaHome, FRESH) === null, "and nothing was written to disk");
  ok(writeReviewRecord(metaHome, complete({ taskId: FRESH })).ok === true, "while the same record within the limits writes fine");

} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(metaHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: review records - refusals hold, queue puts judgment first, unrecorded tasks are surfaced." : "VERIFY FAILED.");
process.exit(exit);
