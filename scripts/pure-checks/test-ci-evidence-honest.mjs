// Evidence from outside the author's reach must state its own limits.
//
// Two things landed together, and they are the same property seen from two sides:
//
//   - .github/workflows/pure-tests.yml runs the PURE lane on GitHub's machines, so a
//     result exists that nobody in this repository wrote.
//   - reviewRecords' `externalRuns` lets a review record cite that run.
//
// The danger in both is identical, and it is not "the tests fail". It is that a green
// tick, or a cited url, reads as more coverage than it is. Roughly half the checks in
// scripts/app-checks launch the real Electron app with a window; a build machine has no
// window, so they are not run there and no workflow runs them. A CI job that quietly
// ran the cheap half - or a citation that said "CI passed" with no scope - would put an
// authoritative-looking green on a suite whose app-level behaviour nobody checked.
// PARTIAL COVERAGE THAT LOOKS COMPLETE IS WORSE THAN NONE, and it is precisely why this
// was deferred rather than half-built.
//
// So this check defends the honesty of the claim, not the passing of the tests:
//
//   1. the coverage statement's numbers come from the suite AT RUNTIME, computed here a
//      second, independent time and compared
//   2. no lane count is hardcoded anywhere in the workflow or the CI script, so it
//      cannot describe a suite that has since moved
//   3. the CI wrapper REFUSES to report a pass when the runner's own numbers disagree
//      with the suite, when it cannot read the report, or when a check that could not
//      run would otherwise count as green
//   4. the workflow never reaches for the app lane, and never hides a red
//   5. a cited CI run cannot score a check, and cannot be filed without saying what it
//      left out
//
// Mutation-tested: hardcoding the app-lane count in scripts/ci-fast-lane.mjs, and
// dropping the app-count cross-check, each turn this red. See the run notes on the
// card.
//
// Pure (no app/harness) - runs in the fast lane, which is the lane CI itself runs.
// Run:  node scripts/pure-checks/test-ci-evidence-honest.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifySuite, coverageStatement, interpretRunnerOutput, EXCLUDED, citation } from "../ci-fast-lane.mjs";
import { reviewRecordProblems, externalRuns, externalRunProblems, gauntletStatus } from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const pureDir = path.join(repo, "scripts", "pure-checks");
const appDir = path.join(repo, "scripts", "app-checks");
const WORKFLOW = path.join(repo, ".github", "workflows", "pure-tests.yml");
const CI_SCRIPT = path.join(repo, "scripts", "ci-fast-lane.mjs");

// --- 1. the split, computed twice ------------------------------------------------
const split = classifySuite({ appDir, pureDir });
ok(split.total > 0 && split.fast > 0, `the suite classified (${split.total} checks: ${split.fast} pure, ${split.app} app)`);
ok(split.fast + split.app === split.total, "every check is in exactly one lane - a check in neither would be uncovered and unnamed");
ok(split.app > 0, "there ARE checks that launch the app, so the coverage statement can never claim the whole suite");

// Counted here rather than taken from classifySuite. Since the lane became a FOLDER the two
// necessarily agree on the split, so what this still catches is a directory read going wrong
// or a filter drifting - not a misclassification. Whether the folder matches BEHAVIOUR is the
// question that used to be asked here, and it moved to a guard that can answer it properly:
// pure-checks/test-lane-folders-tell-the-truth.mjs.
{
  const mine = fs.readdirSync(appDir).filter((f) => f.startsWith("test-") && f.endsWith(".mjs")).length;
  ok(mine === split.app, `a second, independent count of the app lane agrees (${mine} vs ${split.app})`);
  const total = mine + fs.readdirSync(pureDir).filter((f) => f.startsWith("test-") && f.endsWith(".mjs")).length;
  ok(total === split.total, `and of the suite size (${total} vs ${split.total})`);
}

// --- 2. the statement says the unwelcome part, in numbers taken at runtime -------
{
  const statement = coverageStatement(split, { ran: 10, passed: 10, selfSkipped: ["test-x.mjs"], excludedNotRun: Object.keys(EXCLUDED) });
  ok(statement.includes(String(split.app)), `the statement carries the live app-lane count (${split.app})`);
  ok(statement.includes(String(split.fast)), "and the live pure-lane count");
  ok(statement.includes(String(split.total)), "and the live suite size");
  ok(/NOT run here/.test(statement), "and says outright that the app lane is not run here");
  // The two FACTS a reader needs, not a sentence. This assertion has now been broken twice by
  // the wording changing while the truth did not - first when a probe workflow appeared, then
  // when it grew into the real app lane. Pinning prose makes the check fail for the right
  // reason and the wrong cause, every time somebody improves a paragraph.
  ok(/app-lane/.test(statement), "the statement NAMES the workflow that does run them, so a reader can go and look");
  ok(
    /says nothing/i.test(statement) && /green tick|this job/i.test(statement),
    "and says a green tick on THIS job says nothing about them - which is the whole point of printing any of this"
  );
  // MECHANICALLY, not by phrase. This assertion used to match the sentence "no workflow in
  // this repository runs them", which is a claim about the repo checked by reading the claim.
  // The moment a manual probe workflow appeared, the sentence had to change and the check
  // failed - correctly, but for the wrong reason: it was guarding wording, not truth.
  //
  // So the truth is checked against the workflows themselves: any OTHER workflow that runs
  // app-lane checks must be manual-only. A scheduled or push-triggered one would be coverage,
  // and then the statement above is a lie that nobody would be reminded to fix - which is
  // exactly the shape of defect this whole file exists to prevent.
  {
    const dir = new URL("../../.github/workflows/", import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== "pure-tests.yml");
    const offenders = [];
    for (const f of files) {
      const body = fs.readFileSync(new URL(f, dir), "utf8");
      // Does it drive app-lane checks at all? The harness is what makes a check app-lane, and
      // a workflow that runs them names them or names the runner script.
      const runsAppChecks = /scripts\/e2e\//.test(body) || /run-tests\.mjs(?!.*--fast)/.test(body);
      if (!runsAppChecks) {
        continue;
      }
      const manualOnly = /workflow_dispatch/.test(body) && !/^\s*push:/m.test(body) && !/^\s*schedule:/m.test(body);
      if (!manualOnly) {
        offenders.push(f);
      }
    }
    ok(
      offenders.length === 0,
      offenders.length === 0
        ? `and every other workflow that touches app checks is manual-only (${files.length} other workflow(s) read)`
        : `these workflows run app checks automatically, so the "not covered" statement is now false: ${offenders.join(", ")}`
    );
  }
  for (const file of Object.keys(EXCLUDED)) {
    ok(statement.includes(file), `the excluded check ${file} is named in the statement rather than merely not counted`);
  }
  ok(statement.includes("test-x.mjs"), "a check that skipped itself is named too");
  // The runner counts a check it STARTED and that died on a missing package inside its
  // own tally. Leaving it in the denominator turns "could not run" into "ran and did
  // not pass" - the wrong end of the same dishonesty, and the number then means
  // neither thing.
  const claim = coverageStatement(split, { ran: 10, passed: 8, excludedNotRun: ["test-a.mjs", "test-b.mjs"] });
  ok(/claim of this run is: 8 of 8 pure checks passed/.test(claim), `the checks that could not run are out of the denominator (${(claim.match(/claim of this run is:.*/) || [])[0]})`);
  ok(/the runner started 10/.test(claim), "and the raw tally is still shown, so the arithmetic is checkable rather than quietly adjusted");
}

// --- 3. no lane count may be a literal -------------------------------------------
// A number typed into a workflow or a script is how a coverage note ends up describing
// a suite that has since doubled. Both counts must come from the suite at runtime.
{
  const sources = [
    ["scripts/ci-fast-lane.mjs", fs.readFileSync(CI_SCRIPT, "utf8")],
    [".github/workflows/pure-tests.yml", fs.readFileSync(WORKFLOW, "utf8")],
  ];
  for (const [name, src] of sources) {
    for (const [what, n] of [["app-lane", split.app], ["pure-lane", split.fast], ["suite size", split.total]]) {
      const hit = new RegExp(`(?<![\\d.])${n}(?![\\d.])`).test(src);
      ok(!hit, `${name} does not hardcode the ${what} count (${n}) - it would go stale the next time a check is added`);
    }
  }
}

// --- 4. the wrapper refuses everything that would overstate the result -----------
// Synthetic reports, so the honesty machinery is testable without a suite run behind
// it. The shapes are the ones scripts/run-tests.mjs really prints.
{
  const report = ({ fast = split.fast, app = split.app, lines = null, ran = null, passed = null } = {}) => {
    const files = split.fastFiles;
    const body = lines || files.map((f) => `ok    ${f}`);
    const total = ran === null ? files.length : ran;
    const good = passed === null ? total : passed;
    return [
      "--- syntax ---",
      "ok    src/main.js",
      "",
      `--- ${fast} fast tests (6 at a time) ---`,
      ...body,
      "",
      `=== ${good}/${total} passed in 34s (${app} app tests NOT run - use \`npm test\` for the full sweep) ===`,
    ].join("\n");
  };

  const clean = interpretRunnerOutput(report(), { split, exitCode: 0 });
  ok(clean.ok, `a clean report is accepted (${clean.problems.join("; ") || "no problems"})`);

  // A real failure.
  const victim = split.fastFiles.find((f) => !Object.keys(EXCLUDED).includes(f));
  const broken = interpretRunnerOutput(
    report({ lines: split.fastFiles.map((f) => (f === victim ? `FAIL  ${f}` : `ok    ${f}`)), ran: split.fastFiles.length, passed: split.fastFiles.length - 1 }),
    { split, exitCode: 1 }
  );
  ok(!broken.ok && broken.realFailures.includes(victim), "a failing check fails the job");

  // An EXCLUDED check that failed is expected, and must be reported as not run rather
  // than swallowed - "did not run" and "passed" are the two things that must never be
  // confused here.
  const excludedName = Object.keys(EXCLUDED)[0];
  const withExcluded = interpretRunnerOutput(
    report({ lines: split.fastFiles.map((f) => (f === excludedName ? `FAIL  ${f}` : `ok    ${f}`)), ran: split.fastFiles.length, passed: split.fastFiles.length - 1 }),
    { split, exitCode: 1 }
  );
  ok(withExcluded.ok, "a check excluded by name may fail without failing the job - it was never claimed to run");
  ok(withExcluded.excludedNotRun.includes(excludedName), "and it is reported as NOT RUN, by name");
  ok(!withExcluded.problems.length, `with nothing else refused (${withExcluded.problems.join("; ")})`);

  // The drift detectors. These are the assertions that make the coverage statement
  // worth reading at all: if the runner and this script disagree about the lanes, the
  // statement is wrong and the job must say so instead of printing a number.
  const wrongApp = interpretRunnerOutput(report({ app: split.app + 1 }), { split, exitCode: 0 });
  ok(!wrongApp.ok, "a run that held back a different number of app checks is refused");
  ok(wrongApp.problems.some((p) => /app checks/.test(p)), `and says which number moved (${wrongApp.problems[0] || "none"})`);

  const wrongFast = interpretRunnerOutput(report({ fast: split.fast + 1 }), { split, exitCode: 0 });
  ok(!wrongFast.ok, "a run whose pure-lane count disagrees with the suite is refused");

  // The app lane sneaking IN. `run-tests.mjs` prints the "N app tests NOT run" clause
  // only in --fast mode, so its absence means the full suite was attempted - which on a
  // build machine means the app checks failed for want of a window, not for a defect.
  const fullSuite = interpretRunnerOutput(
    report().replace(/ \(\d+ app tests NOT run[^)]*\)/, ""),
    { split, exitCode: 0 }
  );
  ok(!fullSuite.ok, "a run that did NOT hold back the app lane is refused - CI must not pretend to cover it");
  ok(fullSuite.problems.some((p) => /app tests/.test(p)), "and says why");

  // Unreadable output must be red, not green. A wrapper that cannot tell what happened
  // has nothing to report but that.
  const garbage = interpretRunnerOutput("something went very wrong\n", { split, exitCode: 1 });
  ok(!garbage.ok, "an output this wrapper cannot interpret is a failure, not a pass");
  const silent = interpretRunnerOutput("", { split, exitCode: 0 });
  ok(!silent.ok, "and so is no output at all with a zero exit code");

  // Missing verdicts: every pure check must produce a line, or one of them vanished.
  const short = interpretRunnerOutput(report({ lines: split.fastFiles.slice(1).map((f) => `ok    ${f}`) }), { split, exitCode: 0 });
  ok(!short.ok, "a check that produced no verdict at all is refused rather than assumed green");

  // Exit code and lines must agree.
  const lying = interpretRunnerOutput(
    report({ lines: split.fastFiles.map((f) => (f === victim ? `FAIL  ${f}` : `ok    ${f}`)) }),
    { split, exitCode: 0 }
  );
  ok(!lying.ok, "a runner that exits 0 while reporting a failure is refused");

  // The harmless direction, which still must not leave a false claim standing.
  const stale = interpretRunnerOutput(report(), { split, exitCode: 0 });
  ok(stale.staleExclusions.includes(excludedName), "an excluded check that PASSED is flagged so the exclusion gets deleted rather than kept");
  ok(stale.ok, "but it does not fail the job - more coverage than claimed is the safe direction");

  // A self-skipped check is neither.
  const skipped = interpretRunnerOutput(
    report({ lines: split.fastFiles.map((f) => (f === victim ? `skip  ${f}` : `ok    ${f}`)), ran: split.fastFiles.length - 1, passed: split.fastFiles.length - 1 }),
    { split, exitCode: 0 }
  );
  ok(skipped.selfSkipped.includes(victim), "a check that skipped itself is reported as skipped");
  ok(!skipped.passed || skipped.passed < split.fastFiles.length, "and is not inside the passed tally");
}

// --- 5. the workflow itself ------------------------------------------------------
{
  ok(fs.existsSync(WORKFLOW), "the workflow exists");
  const wf = fs.readFileSync(WORKFLOW, "utf8");
  // The "must not appear" assertions read the workflow with its comments stripped.
  // The comments explain at length what this job does NOT do, and matching those
  // sentences would make the check red for saying the right thing. Every rule below is
  // about what the YAML actually declares.
  const commentLines = wf.split(/\r?\n/).filter((l) => /^\s*#/.test(l)).length;
  ok(commentLines > 0, `the workflow is commented (${commentLines} lines), so its own limits are readable next to it`);
  const code = wf
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  ok(/node scripts\/ci-fast-lane\.mjs/.test(code), "it runs the pure lane through scripts/ci-fast-lane.mjs, which is where the refusals live");
  // The app lane must not be reachable from here. `npm test` and a bare run-tests.mjs
  // both launch the real app once per app check.
  ok(!/npm (run )?test\b(?!:)/.test(code), "it never runs `npm test` - that is the full suite, one Electron launch per app check");
  ok(!/run-tests\.mjs(?![^\n]*--fast)/.test(code), "and never run-tests.mjs without --fast");
  ok(!/--live/.test(code), "and never --live, which would spend tokens on GitHub's machines");
  ok(!/\belectron\b/i.test(code), "and starts no Electron");
  // AC: a failed run must not block work. It blocks nothing because it is not a
  // required check and writes nothing - not because it is dressed up as passing.
  ok(/permissions:\s*[\r\n]+\s*contents:\s*read/.test(code), "its token is read-only, so a run cannot change the repository whatever it decides");
  ok(!/continue-on-error/.test(code), "and it does not use continue-on-error to render a failure as a pass - hiding a red is the same sin as overstating coverage");
  ok(!/git (push|commit|tag)/.test(code), "it pushes, commits and tags nothing");
  ok(/on:[\s\S]*push:[\s\S]*branches:\s*\[main\]/.test(wf), "it runs on push to main");
  ok(/on:[\s\S]*pull_request:/.test(wf), "and on pull requests");
  ok(/runs-on:\s*windows-latest/.test(wf), "on Windows, which is the platform the app targets and the only one this lane has been observed green on");
}

// --- 6. every exclusion has to earn its place ------------------------------------
{
  ok(Object.keys(EXCLUDED).length > 0 || true, "exclusions are allowed to be empty - this only checks the ones that exist");
  for (const [file, { pkg, why }] of Object.entries(EXCLUDED)) {
    const full = path.join(pureDir, file);
    ok(fs.existsSync(full), `${file} exists, so the exclusion describes a real check`);
    ok(split.fastFiles.includes(file), `${file} is a pure check - excluding an app-lane check here would be meaningless`);
    ok(!!pkg && !!String(why || "").trim(), `${file} states which package is missing and why`);
    ok(pkg !== "keel", `${file} is not excluded over keel, which the workflow does provide`);
    // The named package must actually be reachable from the check, or the reason is
    // fiction. One import hop is enough to catch the real cases.
    const src = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    let reaches = src.includes(pkg);
    if (!reaches) {
      for (const m of src.matchAll(/from\s+"(\.\.\/\.\.\/src\/[^"]+)"/g)) {
        const dep = path.join(pureDir, m[1]);
        if (fs.existsSync(dep) && fs.readFileSync(dep, "utf8").includes(pkg)) {
          reaches = true;
        }
      }
      // Also the dynamic-import form several checks use for a module under test.
      for (const m of src.matchAll(/import\(\s*[^)]*?"?([\w./-]*src\/[\w./-]+\.js)"?/g)) {
        const dep = path.join(repo, m[1].replace(/^.*?src\//, "src/"));
        if (fs.existsSync(dep) && fs.readFileSync(dep, "utf8").includes(pkg)) {
          reaches = true;
        }
      }
    }
    ok(reaches, `${file} really does reach ${pkg} - an exclusion whose reason is not true is just a check nobody runs`);
  }
}

// --- 7. a citation says what it covers, and cannot score anything ---------------
const RECORD = Object.freeze({
  taskId: "3d01cf26-0000-0000-0000-000000000000",
  summary: "The pure lane runs on GitHub's machines and a record can cite the run.",
  verdict: "stamp",
  criticality: "core",
  intent: "Run the tests outside my reach so the evidence is not my word.",
  projectPath: "C:/repo",
  testSteps: [{ step: "Open the cited run", expect: "The run exists and its conclusion matches" }],
  evidence: ["the pure lane passed on a runner"],
  notVerified: ["the checks that launch the app are not run in CI"],
  checks: [{ label: "pure lane", cmd: "node scripts/ci-fast-lane.mjs", cwd: "C:/repo" }],
});

const CITE = Object.freeze({
  provider: "github-actions",
  runId: "17564321987",
  url: "https://github.com/AidinD/helm/actions/runs/17564321987",
  workflow: "pure-tests",
  conclusion: "success",
  commit: "0123456789abcdef0123456789abcdef01234567",
  ranAt: 1_786_000_000_000,
  covers: "the pure module checks only; the checks that launch the real app are not part of this run",
});

{
  // Additive: a record from before this field existed must still validate.
  ok(reviewRecordProblems(RECORD).length === 0, `the baseline record validates (${reviewRecordProblems(RECORD).join("; ")})`);
  ok(externalRunProblems(RECORD).length === 0, "a record with no externalRuns has no citation problems - the field is optional");
  ok(externalRuns(RECORD).length === 0, "and reads as no citations");

  const cited = { ...RECORD, externalRuns: [CITE] };
  ok(reviewRecordProblems(cited).length === 0, `a well-formed citation is accepted (${reviewRecordProblems(cited).join("; ")})`);
  ok(externalRuns(cited)[0].passed === true, "and reads as a pass of the CITED run");

  // The scope statement is the whole reason this field is safe to show.
  const { covers, ...noScope } = CITE;
  ok(
    reviewRecordProblems({ ...RECORD, externalRuns: [noScope] }).some((p) => /covers/.test(p)),
    "a citation with no stated scope is refused - 'CI passed' with nothing about the app lane is the exact overstatement this is for"
  );
  ok(
    externalRunProblems({ ...RECORD, externalRuns: [{ ...CITE, url: "https://example.com/looks-official" }] }).some((p) => /url/.test(p)),
    "a url that is not a run url is refused - a citation nobody can open is not evidence"
  );
  ok(
    externalRunProblems({ ...RECORD, externalRuns: [{ ...CITE, runId: "999" }] }).some((p) => /not the run the url points at/.test(p)),
    "a run id that disagrees with its own url is refused"
  );
  ok(
    externalRunProblems({ ...RECORD, externalRuns: [{ ...CITE, conclusion: "green" }] }).some((p) => /conclusion/.test(p)),
    "an invented conclusion word is refused"
  );
  ok(
    externalRunProblems({ ...RECORD, externalRuns: [{ ...CITE, provider: "my-laptop" }] }).some((p) => /provider/.test(p)),
    "and an unknown provider - the point is a source the author does not control"
  );
  ok(externalRunProblems({ ...RECORD, externalRuns: {} }).some((p) => /array/.test(p)), "a non-array externalRuns is refused");

  // THE LOAD-BEARING ONE. The JSON is still written by an agent, so a citation must
  // never be able to turn a declared check green. If it could, a pass would be
  // mintable out of a string - strictly worse than the honour system it replaces.
  const g = gauntletStatus({ ...RECORD, externalRuns: [CITE] }, null);
  ok(g.declared === 1 && g.passed === 0, "a cited CI success scores NOTHING - the check is still not passed");
  ok(g.unrun === 1 && g.state === "incomplete", `the record still reads as incomplete (${g.state})`);
  const src = fs.readFileSync(path.join(repo, "src", "lib", "reviewRecords.js"), "utf8");
  const gaunt = src.slice(src.indexOf("export function gauntletStatus("), src.indexOf("export const BAND_ORDER"));
  ok(!/externalRuns/.test(gaunt), "and gauntletStatus does not so much as read the field, so no later edit can wire it into scoring by accident");
}

// --- 8. the citation the workflow hands out is a valid one ----------------------
{
  const cite = citation(split, { ok: true, ran: 135, passed: 135 }, {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "AidinD/helm",
    GITHUB_RUN_ID: "17564321987",
    GITHUB_WORKFLOW: "pure-tests",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
  });
  ok(!!cite, "CI builds the citation from GitHub's own environment, not from anything this repo writes");
  ok(externalRunProblems({ externalRuns: [cite] }).length === 0, `and it passes the record's own validation (${externalRunProblems({ externalRuns: [cite] }).join("; ")})`);
  ok(cite.covers.includes(String(split.app)), "its scope names the live count of checks the run did NOT cover");
  ok(citation(split, { ok: true }, {}) === null, "with no GitHub environment there is no citation to offer - it is never fabricated locally");
}

// --- 9. the status doc must not claim more than this ----------------------------
{
  const doc = fs.readFileSync(path.join(repo, "docs", "review-pipe-status.md"), "utf8");
  ok(/pure-tests\.yml|GitHub Actions/.test(doc), "docs/review-pipe-status.md mentions the CI run, so a reader of the status doc learns it exists");
  ok(/NOT run|not run/.test(doc) && /app lane|launch the app|Electron/i.test(doc), "and states that the app lane is not covered there");
}

console.log("");
console.log(
  exit === 0
    ? "VERIFY OK: the coverage statement's numbers come from the suite at runtime, the wrapper refuses every report that would overstate the result, the workflow cannot reach the app lane, and a cited CI run states its scope and scores nothing."
    : "VERIFY FAILED."
);
process.exit(exit);
