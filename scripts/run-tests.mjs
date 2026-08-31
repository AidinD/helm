// The test runner Helm did not have.
//
// Until 2026-08-02 there was no `npm test` and no runner script: "the suite" was
// whatever anyone remembered to run. That is exactly how four tests ended up
// failing, or passing for the wrong reason, without anyone noticing - flagged by
// the pre-release review as the gap that let the other gaps hide.
//
//   node scripts/run-tests.mjs --fast    only the tests that don't launch Electron
//   node scripts/run-tests.mjs           everything (slow: one app launch per file)
//   node scripts/run-tests.mjs --live    ALSO the checks that drive real models (costs tokens)
//   node scripts/run-tests.mjs docs jot  only files whose name matches a term
//
// Fast tests run concurrently (they are pure node). App tests run ONE AT A TIME on
// purpose: each launches a real Electron window and several pin a fixed debug port,
// so running them in parallel makes them fight over ports and focus.
//
// TOKENS. Fifteen checks drive a real model - a real first mate, a real second mate, a
// real triage call. They self-skip unless --live (scripts/e2e/live-gate.mjs), which is
// enforced rather than remembered: test-live-checks-declared.mjs fails on any check that
// reaches a model without declaring itself. Before that existed, eleven of them ran on
// every `npm test` and one had drifted into the FAST lane, so even a "quick" run made a
// model call - the question the captain asked on 2026-08-05, whose honest answer was no.
// This runner names them up front, so what a run will and will not cost is visible
// BEFORE it starts rather than in the summary afterwards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(here, "e2e");
const repo = path.join(here, "..");

const args = process.argv.slice(2);
const fastOnly = args.includes("--fast");
const live = args.includes("--live");
const terms = args.filter((a) => !a.startsWith("--"));

/*
 * ONE RUN AT A TIME, and a second one is told rather than left to guess.
 *
 * Two concurrent runs of this suite corrupt each other's results, silently, in both
 * directions. Observed for real on 2026-08-18 while a parallel session ran the suite
 * during a debugging session: a test that failed and then passed with no code change
 * between the two attempts, and a new check that was red on six points against CORRECT
 * code because the harness had attached to an Electron the other run had started.
 *
 * The direction that matters is the other one. The same collision can just as easily
 * produce GREEN on a fix that is not there, and nothing about that looks wrong.
 *
 * 69 of the 145 app checks do not point the meta-home at a temp directory, so they share
 * real state - and fixing 69 files would leave the 70th to be written without it. A lock
 * fixes it once, at the only place both runs pass through, and turns "quietly wrong" into
 * "refused with a reason".
 *
 * The lock carries a pid so a crashed run cannot block the next one forever: a lock whose
 * process is gone is stale and simply taken. --force exists for the case where that
 * judgement is wrong, and says so in the output rather than being silent about it.
 */
// The path is overridable so the check that exercises this lock can use its own file.
// Without that seam it had to drive the REAL lock - which meant that running the suite,
// which holds this lock, ran a test that overwrote and then deleted it. The check passed
// by destroying the protection it was checking, and left the rest of that run unguarded.
//
// Not a way around the lock: pointing it elsewhere takes a deliberate env var, and the
// thing being protected is a developer's own suite run, not anybody's data.
const LOCK = process.env.HELM_TEST_LOCK || path.join(os.tmpdir(), "helm-test-suite.lock");
const forced = args.includes("--force");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else - alive for our purposes.
    return err?.code === "EPERM";
  }
}

function takeLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (held?.pid && held.pid !== process.pid && pidAlive(held.pid)) {
      if (!forced) {
        console.error(`
Another run of this suite is already going (pid ${held.pid}, started ${held.at}).`);
        console.error("Two at once overwrite each other's fixtures and can attach to each other's");
        console.error("Electron - which shows up as a red result on correct code, or worse, a green");
        console.error("one on a fix that is not there.");
        console.error("\nWait for it, or pass --force if you are certain that process is not running this.");
        process.exit(2);
      }
      console.log(`[run-tests] --force: taking the lock from pid ${held.pid} anyway.`);
    }
  } catch {
    // No lock, or an unreadable one. Either way it is ours to take.
  }
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  } catch {
    // A lock we cannot write is a lock we cannot enforce. Say so and carry on rather than
    // refusing to run the suite over its own bookkeeping.
    console.warn("[run-tests] could not write the run lock; a concurrent run will not be detected");
  }
}

function releaseLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (held?.pid === process.pid) {
      fs.rmSync(LOCK, { force: true });
    }
  } catch {
    /* already gone, or never ours */
  }
}

takeLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit(130);
});

// A test "launches the app" if it imports the CDP harness, and it "costs" if it calls the
// shared live gate. Both are read from the source rather than kept in a list here: a list
// is a second place to forget, and forgetting is what made the suite spend tokens quietly.
const all = fs
  .readdirSync(e2eDir)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .filter((f) => terms.length === 0 || terms.some((t) => f.includes(t)))
  .map((f) => {
    const src = fs.readFileSync(path.join(e2eDir, f), "utf8");
    // An IMPORT of the harness, not a mention of it. A plain substring match put
    // test-live-checks-declared in the app lane, because that file contains sample
    // sources as strings - one of which imports the harness. It launches nothing, so
    // it would have paid an Electron slot forever for a quotation.
    const importsHarness = /^\s*(?:import\s|const\s*\{[^}]*\}\s*=\s*await\s+import\()[^\n]*harness\.mjs/m.test(src);
    // Same rule for the gate: a CALL on its own line, not the name appearing in a
    // string or a regex - which is how the guard test that enforces this rule got
    // listed as one of the checks that spend tokens.
    const callsGate = /^\s*requireLive\s*\(/m.test(src);
    return { file: f, launches: importsHarness, costsTokens: callsGate };
  });

const fast = all.filter((t) => !t.launches);
const slow = fastOnly ? [] : all.filter((t) => t.launches);

// Said BEFORE anything runs, not in the summary: the point is to know what a run costs
// while there is still a chance to not run it.
const costing = [...fast, ...slow].filter((t) => t.costsTokens);
if (costing.length > 0) {
  console.log(
    live
      ? `--live: ${costing.length} check(s) WILL drive real models and spend tokens: ${costing.map((t) => t.file.replace(/^test-|\.mjs$/g, "")).join(", ")}`
      : `${costing.length} check(s) drive real models and are being SKIPPED (pass --live to run them): ${costing
          .map((t) => t.file.replace(/^test-|\.mjs$/g, ""))
          .join(", ")}`
  );
} else if (terms.length === 0) {
  console.log("no check in this run drives a real model - nothing here spends tokens");
}

// --- a syntax gate first: cheapest possible check, and the renderer is 14k lines
const SYNTAX_TARGETS = ["src/main.js", "src/renderer/renderer.js", "src/preload.cjs"];

// child.kill() only terminates the process itself. An app test is a node process
// that has launched a whole Electron underneath it, so killing just the node left
// the app running with nobody to close it - a timeout GUARANTEED a stray, which is
// the worst possible moment to make one (the run is already going badly). taskkill
// /T takes the tree, and is scoped to this one PID, never to an image name.
function killTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already exited */
    }
    return;
  }
  try {
    process.kill(pid);
  } catch {
    /* already exited */
  }
}

function run(cmd, cmdArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: repo, shell: false, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve({ code: 124, out: out + "\n[timed out]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const failures = [];
const started = process.hrtime.bigint();
const secs = () => Number(process.hrtime.bigint() - started) / 1e9;

console.log("--- syntax ---");
for (const target of SYNTAX_TARGETS) {
  const r = await run(process.execPath, ["--check", target], 30000);
  console.log(`${r.code === 0 ? "ok  " : "FAIL"}  ${target}`);
  if (r.code !== 0) {
    failures.push({ file: target, out: r.out });
  }
}
if (failures.length) {
  // A syntax error makes every app test fail for the same uninformative reason.
  console.log("\nSyntax errors - stopping before the suite.");
  for (const f of failures) {
    console.log(f.out.slice(0, 800));
  }
  process.exit(1);
}

// Concurrent, but BOUNDED. Promise.all over the whole list spawned all 57 node
// processes at once, and some fast tests are not purely computational - a few
// spawn a child of their own (the MCP server over stdio, git) and wait a fixed
// number of milliseconds for it to answer. Under 57-way contention that child
// can miss its window, and the test fails for load rather than for a defect:
// test-fleet-state-tool failed twice in a row, passed on its own every time, and
// tracking it by adding and removing an unrelated file was pure coincidence
// (2026-08-03). A suite that fails at random is worse than a slow one, because
// every real verification it is asked to back gets doubted too.
const FAST_LANE_WIDTH = Math.max(2, Math.min(8, (os.cpus?.().length || 4) - 2));
async function runPooled(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

// A test can decline to run itself - one spawns the real claude CLI and spends
// tokens, so it is opt-in behind an env flag. It exits 0, which the summary would
// otherwise count as a pass: the same "green that means nothing" this runner
// already refuses for the app tests it never started. A test that announces
// "SKIPPED -" is reported as skipped and named at the end, so an opt-in check
// cannot quietly become a check nobody runs.
const selfSkipped = [];
const mark = (t, r) => {
  if (r.code === 0 && /^SKIPPED - /m.test(r.out || "")) {
    selfSkipped.push({ file: t.file, why: (r.out.match(/^SKIPPED - (.*)$/m) || [])[1] || "" });
    return "skip";
  }
  return r.code === 0 ? "ok  " : "FAIL";
};

console.log(`\n--- ${fast.length} fast tests (${FAST_LANE_WIDTH} at a time) ---`);
// --live is forwarded to each check (that is the flag its own gate reads), and a check
// that drives a real model gets the app lane's longer budget even in the fast lane: one
// of them was KILLED at 120s while genuinely waiting on a model, which read as a product
// failure and was not one.
const fastResults = await runPooled(fast, FAST_LANE_WIDTH, async (t) => ({
  t,
  r: await run(process.execPath, [path.join("scripts", "e2e", t.file), ...(live ? ["--live"] : [])], t.costsTokens ? 300000 : 120000),
}));
for (const { t, r } of fastResults) {
  console.log(`${mark(t, r)}  ${t.file}`);
  if (r.code !== 0) {
    failures.push({ file: t.file, out: r.out });
  }
}

if (slow.length) {
  console.log(`\n--- ${slow.length} app tests (one at a time, ~15-30s each) ---`);
  let i = 0;
  for (const t of slow) {
    i += 1;
    const r = await run(process.execPath, [path.join("scripts", "e2e", t.file), ...(live ? ["--live"] : [])], 300000);
    console.log(`${mark(t, r)}  [${i}/${slow.length}] ${t.file}`);
    if (r.code !== 0) {
      failures.push({ file: t.file, out: r.out });
    }
  }
}

// A suite that leaks must SAY so. Every app test is supposed to leave nothing
// behind, but "nothing was left behind" is invisible when it fails - a leaked
// Chromium profile breaks no assertion, and a surviving Electron only shows up
// later, as an unrelated test failing strangely because the stray holds its debug
// port. So the run reports its own litter and clears it, rather than leaving it
// for whoever runs next to be confused by. Not counted as a failure: the property
// itself is asserted by test-e2e-no-strays.mjs, which CAN fail.
if (slow.length) {
  const { sweepAbandonedRuns, processesUsingE2EProfiles } = await import(
    // pathToFileURL, not a hand-rolled backslash swap: it percent-encodes what a
    // file URL has to encode. The hand-rolled version worked only because this repo
    // sits at a path with no space, `#` or `?` in it - a clone under
    // "C:\My Projects" or a "v1#final" directory would have produced a URL that
    // silently pointed somewhere else, or truncated at the `#`.
    pathToFileURL(path.join(e2eDir, "harness.mjs")).href
  );
  const swept = await sweepAbandonedRuns();
  if (swept.killed.length || swept.removed.length) {
    console.log(
      `\nleftovers from this run: killed ${swept.killed.length} process(es), removed ${swept.removed.length} temp directory(ies)`
    );
  }
  // Let the LAST test's own teardown finish before judging. taskkill returns before
  // Windows has actually torn the tree down, so an immediate check catches the final
  // app mid-exit and cries wolf on a perfectly clean run - which it did on the first
  // run that had this warning (7 processes reported, all gone a moment later). A
  // warning you see every time stops being a warning at all.
  let stillUp = [];
  for (let i = 0; i < 10; i++) {
    stillUp = await processesUsingE2EProfiles();
    if (stillUp.length === 0) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (stillUp.length) {
    console.log(
      `WARNING: ${stillUp.length} E2E process(es) are STILL running 10s after the suite finished (pid ${stillUp
        .map((p) => p.pid)
        .join(", ")}). Nothing should outlive its own test - see test-e2e-no-strays.mjs.`
    );
  }
}

// Count what RAN, not what exists - in --fast mode the app tests were never
// started, and reporting them as passed is the kind of green that means nothing.
const ran = fast.length + slow.length - selfSkipped.length;
const skipped = all.length - (fast.length + slow.length);
console.log(
  `\n=== ${ran - failures.length}/${ran} passed in ${secs().toFixed(0)}s` +
    (skipped ? ` (${skipped} app tests NOT run - use \`npm test\` for the full sweep)` : "") +
    " ==="
);
if (selfSkipped.length) {
  console.log(`\n${selfSkipped.length} test(s) skipped themselves and are NOT counted above:`);
  for (const s of selfSkipped) {
    console.log(`  ${s.file}${s.why ? ` - ${s.why}` : ""}`);
  }
}
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`\n########## ${f.file}`);
    // The tail is where the assertion lines and the verdict are.
    console.log(f.out.split("\n").slice(-25).join("\n"));
  }
}
process.exit(failures.length ? 1 : 0);
