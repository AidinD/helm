// The pure lane, run somewhere the author cannot reach.
//
// Everything that protects a review record today lives inside this process. The key
// that signs a check run sits on disk in the meta-home; the function that stamps a
// result is one an agent can import and call. That is tamper-EVIDENT, not
// tamper-proof, and reviewRecords.js says so in its own comments: "a real guarantee
// needs the runner outside the author's reach (CI)". This script is the CI side of
// that sentence.
//
// It is deliberately a WRAPPER, not a second runner. `scripts/run-tests.mjs` owns
// the lane split, the concurrency, the timeouts and the token gate; a copy of that
// logic here would be a second place to forget, and forgetting is what this suite
// keeps being punished for. So this script:
//
//   1. classifies the suite itself (cheap, pure - see classifySuite)
//   2. runs `node scripts/run-tests.mjs --fast` unchanged
//   3. CROSS-CHECKS the runner's own printed numbers against its own classification
//      and refuses the run if they disagree - so drift is a red build, not a stale
//      sentence in a workflow file
//   4. prints what this run does NOT cover, with every number taken from the suite
//      at runtime
//
// PARTIAL COVERAGE THAT LOOKS COMPLETE IS WORSE THAN NONE. That is the whole reason
// this was deferred for two months: roughly half the checks in the suite launch the
// real Electron app with a window, an ordinary build machine has no window, and a
// workflow that quietly runs only the cheap half would put a green tick on a repo
// whose app-level behaviour nobody checked. So the app lane is not run here, is named
// as not run, and is counted at runtime so the count cannot go stale.
//
// Two pure checks are not run here either, by name, because this runner does not
// install what they import. They are reported as EXCLUDED, never as passed.
//
// Run locally exactly as CI runs it:  node scripts/ci-fast-lane.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
// The lanes are folders now, so this reads two directories instead of splitting one by
// source. See run-tests.mjs for why the folder became the classifier.
const APP_DIR = path.join(here, "app-checks");
const PURE_DIR = path.join(here, "pure-checks");

/*
 * Helm imports two packages that are not on npm: `keel` and `@jot/core`, both
 * declared as `file:` paths to sibling repositories. The workflow provides `keel` by
 * checking the (public, dependency-free, build-free) repo straight into
 * node_modules/keel, which is enough for all but two pure checks.
 *
 * The two below are excluded rather than accommodated, and the reason is written out
 * so the trade is visible instead of implied:
 *
 *   - @jot/core is a BUILD ARTEFACT of another repository (jot's `build:core` bundles
 *     it with esbuild and emits declarations with tsc). Reproducing that in this
 *     workflow means installing jot's whole toolchain to satisfy one check, and every
 *     part of it is a way for this job to go red for a reason that is not Helm.
 *   - @huggingface/transformers pulls the ONNX runtime - hundreds of megabytes - and
 *     the check that needs it reads one env field off the imported module.
 *
 * If either becomes cheap to provide, delete the entry: the check then simply runs,
 * and this script reports the exclusion as stale rather than keeping the claim.
 */
export const EXCLUDED = Object.freeze({
  "test-jot-ipc-bridge.mjs": Object.freeze({
    pkg: "@jot/core",
    why: "imports @jot/core, which is not published - it is a build artefact of the sibling jot repo. This runner does not build it, so this check is NOT run here.",
  }),
  "test-voice-model-cache-dir.mjs": Object.freeze({
    pkg: "@huggingface/transformers",
    why: "loads @huggingface/transformers (the ONNX runtime, hundreds of megabytes) to read one env field. This runner does not install it, so this check is NOT run here.",
  }),
});

/*
 * The same two rules `run-tests.mjs` uses, for the same reason it reads them from the
 * source instead of keeping a list: a list is a second place to forget.
 *
 * Since 2026-09-03 the lane split is a FOLDER, so this no longer re-derives it - it reads
 * the same two directories run-tests.mjs runs. The numbers are still compared at runtime
 * against the ones run-tests.mjs prints about its own run (interpretRunnerOutput), and a
 * disagreement still fails the build: that turns "the coverage note quietly went stale"
 * into "the build is red and says which number moved". What the import pattern below is
 * for now is the GUARD - proving a folder and the behaviour of its files agree.
 */
// Exported so the folder guard can check the folders against BEHAVIOUR rather than against
// another copy of this pattern. It is no longer a classifier here - the folders are.
export const LAUNCHES_APP = /^\s*(?:import\s|const\s*\{[^}]*\}\s*=\s*await\s+import\()[^\n]*harness\.mjs/m;
const DRIVES_A_MODEL = /^\s*requireLive\s*\(/m;

/**
 * How the suite actually splits, read off the files rather than declared anywhere.
 *
 * `app` is the number this whole script exists to state out loud: checks that launch a
 * real Electron window, which no workflow runs as coverage. A separate manual workflow
 * (app-lane) runs them on a hosted runner - it exists and it works, but it is triggered by a
 * person rather than by a push, so a green tick HERE still says nothing about them.
 */
export function classifySuite({ appDir = APP_DIR, pureDir = PURE_DIR } = {}) {
  const read = (dir) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
      .sort();
  const fastFiles = read(pureDir);
  const appFiles = read(appDir);
  const files = [...fastFiles, ...appFiles];
  // Which lane a check is in comes from its folder. Whether it drives a real MODEL still
  // comes from its source, because no folder carries that fact.
  const modelFiles = [];
  for (const [dir, list] of [[pureDir, fastFiles], [appDir, appFiles]]) {
    for (const file of list) {
      if (DRIVES_A_MODEL.test(fs.readFileSync(path.join(dir, file), "utf8"))) {
        modelFiles.push(file);
      }
    }
  }
  const excludedFiles = Object.keys(EXCLUDED).filter((f) => fastFiles.includes(f));
  return {
    total: files.length,
    fast: fastFiles.length,
    app: appFiles.length,
    fastFiles,
    appFiles,
    modelFiles,
    // Pure checks that drive a real model: they self-skip without --live, which this
    // runner never passes, so they are skips here and not passes.
    modelInFast: modelFiles.filter((f) => fastFiles.includes(f)),
    excludedFiles,
  };
}

/**
 * The sentence a reader has to be able to trust more than the green tick.
 *
 * Every number is passed in from a live classification or from the runner's own
 * output. Nothing here is a literal, because a literal is how a coverage note ends up
 * describing a suite that has since doubled.
 */
export function coverageStatement(split, observed = {}) {
  const { ran = null, passed = null, selfSkipped = [], excludedNotRun = [] } = observed;
  const lines = [];
  lines.push("WHAT THIS RUN DOES NOT COVER");
  lines.push("");
  lines.push(`  ${split.total} checks exist across scripts/pure-checks and scripts/app-checks.`);
  lines.push(`  ${split.fast} of them are pure node. Those are the only ones this job can execute.`);
  lines.push(
    `  ${split.app} of them launch the REAL Electron app with a window. They are NOT run here,`
  );
  lines.push(
    "    and this job does not cover them. A separate manual workflow (app-lane) runs them"
  );
  lines.push(
    "    on a hosted runner, but by hand rather than on a push - so nothing automatic covers"
  );
  lines.push(
    "    them. A green tick on this job says nothing"
  );
  lines.push("    whatsoever about them - it is roughly half the behaviour Helm is judged on.");
  if (excludedNotRun.length > 0) {
    lines.push(
      `  ${excludedNotRun.length} pure check(s) were NOT run here either, by name, because this runner does`
    );
    lines.push("    not install what they import:");
    for (const file of excludedNotRun) {
      lines.push(`      - ${file}: ${EXCLUDED[file]?.why || "excluded"}`);
    }
  }
  if (selfSkipped.length > 0) {
    lines.push(
      `  ${selfSkipped.length} pure check(s) skipped THEMSELVES: they drive a real model, and this job has no`
    );
    lines.push("    model access. They are reported as skipped and counted as neither pass nor fail:");
    for (const file of selfSkipped) {
      lines.push(`      - ${file}`);
    }
  }
  lines.push("");
  if (ran !== null && passed !== null) {
    // The excluded checks are inside the runner's own `ran` tally - it started them and
    // they failed on a missing package. Leaving them in the denominator would quietly
    // present "could not run" as "ran and did not pass", which is the wrong end of the
    // same dishonesty: it understates the claim instead of overstating it, and either
    // way the number does not mean what it says.
    const attempted = ran - excludedNotRun.length;
    lines.push(`So the whole claim of this run is: ${passed} of ${attempted} pure checks passed.`);
    if (excludedNotRun.length > 0) {
      lines.push(
        `  (the runner started ${ran}; the ${excludedNotRun.length} named above could not run here and are not in that ${attempted})`
      );
    }
  }
  lines.push("It is evidence about the pure modules only. Nothing else.");
  return lines.join("\n");
}

/**
 * Read `run-tests.mjs --fast`'s own report, and decide whether this job passed.
 *
 * Split out as a pure function on purpose: it is the honesty machinery, so it has to be
 * testable without a suite run behind it (scripts/pure-checks/test-ci-evidence-honest.mjs
 * feeds it synthetic reports, including the ones that must be refused).
 *
 * It refuses far more than a failing test. An output it cannot interpret, a lane count
 * that disagrees with the suite on disk, an exit code that does not match what the
 * lines say - all of those are "this job cannot tell you what happened", which must
 * read as red. The one thing it will not do is let a check that could not run count as
 * a pass.
 */
export function interpretRunnerOutput(text, { split, exitCode = null, excluded = EXCLUDED } = {}) {
  const problems = [];
  const results = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    // The runner prints `${mark}  ${file}` where mark is "ok  ", "FAIL" or "skip".
    // The syntax gate uses the same shape for src/*.js paths, which do not match here -
    // a syntax failure shows up instead as an output with no test lines at all, which
    // is refused below.
    const m = /^(ok|FAIL|skip)\s+(test-[A-Za-z0-9._-]+\.mjs)\s*$/.exec(line);
    if (m) {
      results.set(m[2], m[1]);
    }
  }
  const declaredFast = /^--- (\d+) fast tests/m.exec(text ?? "");
  const appNotRun = /\((\d+) app tests NOT run/.exec(text ?? "");
  const summary = /^=== (\d+)\/(\d+) passed/m.exec(text ?? "");

  if (!declaredFast || !summary) {
    problems.push(
      "could not read the runner's own report (no fast-lane header or no summary line) - this job cannot say what ran, so it must not report a pass"
    );
  }
  if (declaredFast && Number(declaredFast[1]) !== split.fast) {
    problems.push(
      `the runner ran ${declaredFast[1]} fast checks; this job's own classification says ${split.fast}. One of the two is wrong, so the coverage statement cannot be trusted.`
    );
  }
  if (!appNotRun) {
    problems.push(
      "the runner did not report any app tests as NOT run - either it was not given --fast, or the app lane has vanished. Either way the coverage statement here is a lie."
    );
  } else if (Number(appNotRun[1]) !== split.app) {
    problems.push(
      `the runner held back ${appNotRun[1]} app checks; this job's own classification counts ${split.app}. The number in the coverage statement would be wrong.`
    );
  }

  const failed = [...results].filter(([, r]) => r === "FAIL").map(([f]) => f);
  const selfSkipped = [...results].filter(([, r]) => r === "skip").map(([f]) => f);
  const excludedNames = Object.keys(excluded);
  const excludedFailures = failed.filter((f) => excludedNames.includes(f));
  const realFailures = failed.filter((f) => !excludedNames.includes(f));
  // An excluded check that PASSED means the exclusion is no longer true - coverage is
  // BETTER than claimed, which is the harmless direction, but the claim is still wrong
  // and should be deleted rather than left standing.
  const staleExclusions = excludedNames.filter((f) => results.get(f) === "ok");
  // An excluded check that was never reported at all is a different thing: it means the
  // file is gone, or has moved into the app lane, and the exclusion is describing
  // nothing.
  const phantomExclusions = excludedNames.filter((f) => !results.has(f) && split.fastFiles.includes(f));
  for (const file of phantomExclusions) {
    problems.push(`${file} is excluded by name but the runner never reported it - the exclusion describes nothing`);
  }

  if (results.size > 0 && declaredFast && results.size !== Number(declaredFast[1])) {
    problems.push(
      `the runner reported ${results.size} result line(s) for ${declaredFast[1]} fast checks - some check produced no verdict at all`
    );
  }
  if (exitCode !== null) {
    if (exitCode === 0 && failed.length > 0) {
      problems.push(`the runner exited 0 while reporting ${failed.length} failure(s)`);
    }
    if (exitCode !== 0 && failed.length === 0 && problems.length === 0) {
      problems.push(`the runner exited ${exitCode} without reporting a failed check - it broke for a reason this job cannot name`);
    }
  }

  return {
    ok: problems.length === 0 && realFailures.length === 0,
    ran: summary ? Number(summary[2]) : null,
    passed: summary ? Number(summary[1]) : null,
    failed,
    realFailures,
    excludedFailures,
    excludedNotRun: [...new Set([...excludedFailures, ...phantomExclusions])],
    selfSkipped,
    staleExclusions,
    problems,
  };
}

/**
 * The citation a review record can carry, built from the environment GitHub sets - not
 * from anything this repository writes.
 *
 * `covers` is not decoration. A review record that cites a CI run without saying what
 * that run left out is exactly the "partial coverage that looks complete" this whole
 * script exists to refuse, so reviewRecords.js requires the field and this is where its
 * text comes from.
 */
export function citation(split, verdict, env = process.env) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repository = env.GITHUB_REPOSITORY || null;
  const runId = env.GITHUB_RUN_ID || null;
  if (!repository || !runId) {
    return null;
  }
  return {
    provider: "github-actions",
    runId: String(runId),
    url: `${server}/${repository}/actions/runs/${runId}`,
    workflow: env.GITHUB_WORKFLOW || null,
    conclusion: verdict.ok ? "success" : "failure",
    commit: env.GITHUB_SHA || null,
    ranAt: Date.now(),
    covers:
      `${verdict.passed ?? 0} of ${(verdict.ran ?? 0) - (verdict.excludedNotRun?.length ?? 0)} pure module checks. ` +
      `The ${split.app} checks that launch the real Electron app are NOT part of this run.`,
  };
}

function stream(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: repo, shell: false, windowsHide: true });
    let out = "";
    const take = (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (err) => resolve({ code: 1, out: out + `\n[could not start the runner: ${err.message}]` }));
  });
}

async function main() {
  const split = classifySuite();
  console.log(
    `[ci] ${split.total} checks on disk: ${split.fast} pure, ${split.app} that launch the app (not run here).`
  );
  console.log("");

  const { code, out } = await stream(process.execPath, [path.join("scripts", "run-tests.mjs"), "--fast"]);
  const verdict = interpretRunnerOutput(out, { split, exitCode: code });

  console.log("");
  console.log(coverageStatement(split, verdict));
  console.log("");

  if (verdict.excludedNotRun.length > 0) {
    console.log(`EXCLUDED (not run, not counted): ${verdict.excludedNotRun.join(", ")}`);
  }
  for (const file of verdict.staleExclusions) {
    console.log(`NOTE: ${file} is listed as excluded but PASSED here - delete the exclusion, it is no longer true.`);
  }
  for (const p of verdict.problems) {
    console.log(`REFUSED: ${p}`);
  }
  for (const f of verdict.realFailures) {
    console.log(`FAILED: ${f}`);
  }

  const cite = citation(split, verdict);
  if (cite) {
    console.log("");
    console.log("Cite this run in a review record's externalRuns:");
    console.log(JSON.stringify(cite, null, 2));
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const md = [
      `## ${verdict.ok ? "Pure lane passed" : "Pure lane did NOT pass"}`,
      "",
      "```",
      coverageStatement(split, verdict),
      "```",
      ...(verdict.problems.length ? ["", "### Refused", ...verdict.problems.map((p) => `- ${p}`)] : []),
      ...(verdict.realFailures.length ? ["", "### Failed", ...verdict.realFailures.map((f) => `- ${f}`)] : []),
      ...(cite ? ["", "### Cite this run in a review record", "", "```json", JSON.stringify(cite, null, 2), "```"] : []),
      "",
      "This job is not a gate. It is not a required check, it writes nothing, and a red",
      "result here blocks nothing - it is a signal for the review flow to read.",
      "",
    ].join("\n");
    try {
      fs.appendFileSync(summaryFile, md, "utf8");
    } catch (err) {
      console.log(`[ci] could not write the step summary: ${err.message}`);
    }
  }

  console.log("");
  console.log(verdict.ok ? "CI PURE LANE OK" : "CI PURE LANE FAILED");
  process.exit(verdict.ok ? 0 : 1);
}

// Importable for its own test without running a suite.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
