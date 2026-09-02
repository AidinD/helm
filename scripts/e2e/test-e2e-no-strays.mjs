// An E2E run must not leave a Helm running, and must not drive somebody else's.
//
// Both halves of that were broken, and they fed each other. `launch()` cleaned up
// only in `close()`, so any failure on the way to returning a harness - a ready
// timeout on a slow cold start, most often - left a fully live Helm behind that
// its caller had no handle to. That stray then held the debug port, so the NEXT
// run's Electron could not bind it; Chromium does not fail there, it just logs
// "Cannot start http server for devtools" and runs on. The harness found the
// stray's target on /json/list and drove THAT, while the app it had just spawned
// sat invisible in temp. And because a stray Helm is a working Helm, its review
// gauntlet could go on spawning E2E children of its own.
//
// the captain hit the whole chain on 2026-08-18: a stray on port 9392 turned a single
// launch into 2-3 new profile directories and broke an unrelated test's cleanup
// assertion, with ~20 leaked Chromium profiles in %TEMP% behind it.
//
// What is asserted here is the PROPERTY in each case - no surviving process, no
// leftover directory, and the app we drive is the app we started - rather than
// the presence of the code that is supposed to produce it. Every one of these
// failed before the fix.
//
// Run:  node scripts/e2e/test-e2e-no-strays.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
// One line on purpose: run-tests.mjs decides a test is an APP test by matching
// `import ... harness.mjs` on a SINGLE line, and this file launches three real
// Electrons. Wrapped across lines it was silently demoted into the fast lane and
// ran four-at-a-time with the pure-node checks.
// (Do not let a formatter wrap this import - see above.)
import { launch, ownerState, rmDirWithRetries, sweepAbandonedRuns, processesUsingE2EProfiles } from "./harness.mjs";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const TMP = os.tmpdir();
const USERDATA_PREFIX = "helm-e2e-userdata-";
const cleanup = [];
const listProfiles = () =>
  new Set(fs.readdirSync(TMP).filter((d) => d.startsWith(USERDATA_PREFIX) || d.startsWith("helm-e2e-config-")));

/** A PID that is guaranteed not to be running: one we watched exit. */
async function deadPid() {
  const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => p.on("close", r));
  return p.pid;
}

/** A per-run profile directory with a chosen owner PID (or none at all). */
function fakeProfile({ pid, mtimeAgeMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, USERDATA_PREFIX));
  if (pid !== undefined) {
    // BESIDE the directory, matching the harness. Inside it, a partial delete of a
    // locked profile takes the marker with it and the directory silently downgrades
    // to "unknown" - which is what actually happened, and is what the assertion
    // further down about a half-deleted profile now pins.
    cleanup.push(`${dir}.owner.json`);
    fs.writeFileSync(`${dir}.owner.json`, JSON.stringify({ pid, startedAt: Date.now() }));
  }
  if (mtimeAgeMs) {
    const when = new Date(Date.now() - mtimeAgeMs);
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

/** How many processes are currently running out of a given profile directory. */
async function procsOn(dir) {
  const base = path.basename(dir);
  return (await processesUsingE2EProfiles()).filter((p) => p.profiles.includes(base)).length;
}

/**
 * Wait for a profile to have no processes left, and report whether it got there.
 *
 * `taskkill /T /F` returns once the kill is REQUESTED, not once Windows has finished
 * tearing down nine processes, so sampling the count the instant close() returns
 * asserts something the OS never promised - and it duly flaked. The property under
 * test is that the instance goes away, not that it goes away within zero
 * milliseconds; a wait that gives up is still a failure.
 */
async function procsGone(dir, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let n = await procsOn(dir);
  while (n > 0 && Date.now() < deadline) {
    await delay(250);
    n = await procsOn(dir);
  }
  return n === 0;
}

try {
  // ---------------------------------------------------------------- A. the sweep
  // The old rule was "delete anything older than an hour", which is wrong in both
  // directions: it would delete a LIVE run's profile once the run passed an hour,
  // and it kept a directory leaked seconds ago for a full hour of test runs. What
  // the sweep actually wants to know is whether the run that made it still exists.
  const liveOwned = fakeProfile({ pid: process.pid });
  const deadOwned = fakeProfile({ pid: await deadPid() });
  const unmarkedFresh = fakeProfile();
  const unmarkedOld = fakeProfile({ mtimeAgeMs: 2 * 60 * 60 * 1000 });
  cleanup.push(liveOwned, deadOwned, unmarkedFresh, unmarkedOld);

  ok(ownerState(liveOwned) === "alive", "a profile owned by a running test process reads as alive");
  ok(ownerState(deadOwned) === "dead", "a profile whose owning test process has exited reads as dead");

  await sweepAbandonedRuns();
  ok(fs.existsSync(liveOwned), "the sweep leaves a LIVE run's profile alone (however long it has been running)");
  ok(!fs.existsSync(deadOwned), "the sweep removes an abandoned profile immediately, not an hour later");
  ok(fs.existsSync(unmarkedFresh), "an unmarked directory is given the benefit of the doubt while it is fresh");
  ok(!fs.existsSync(unmarkedOld), "an unmarked directory older than the fallback window is still collected");

  // The case that made the first version of this useless in exactly the situation
  // it was built for. close() removes the profile with fs.rmSync(recursive, force),
  // which deletes what it CAN before throwing on Chromium's locked files - so with
  // the marker stored inside the directory, a failed cleanup destroyed the evidence
  // and a known-dead profile downgraded to "unknown", the most protected state
  // there is. Found live: five leaked profiles, forty processes between them, every
  // one shielded by the one-hour grace period. The marker lives beside the
  // directory now, so a partial delete cannot reach it.
  const halfDeleted = fakeProfile({ pid: await deadPid() });
  fs.writeFileSync(path.join(halfDeleted, "Cookies"), "locked-ish");
  for (const entry of fs.readdirSync(halfDeleted)) {
    fs.rmSync(path.join(halfDeleted, entry), { force: true, recursive: true });
  }
  cleanup.push(halfDeleted);
  ok(
    ownerState(halfDeleted) === "dead",
    "a profile whose contents were half-deleted by a failed cleanup is STILL attributable to its dead run"
  );
  await sweepAbandonedRuns();
  ok(!fs.existsSync(halfDeleted), "so the sweep collects it instead of shielding it for an hour");

  // Everything destructive here is anchored to a per-run directory directly under
  // the system temp dir, because some of the paths it acts on are parsed out of
  // ANOTHER process's command line. The prefix alone is a check on data we do not
  // control; this asserts the anchor as well, since a kill or a delete that can
  // reach past its own litter is the one mistake this project has already made.
  const outsideTmp = path.join(os.homedir(), "helm-e2e-userdata-notreally");
  const wrongPrefix = path.join(TMP, "something-else-entirely");
  for (const bad of [outsideTmp, wrongPrefix, TMP, path.join(TMP, USERDATA_PREFIX)]) {
    let refused = false;
    try {
      await rmDirWithRetries(bad);
    } catch {
      refused = true;
    }
    ok(refused, `removal refuses a path that is not a per-run E2E directory: ${bad}`);
  }
  ok(!fs.existsSync(outsideTmp) && fs.existsSync(TMP), "and nothing outside temp was touched by trying");

  // ------------------------------------------------- B. a launch that never works
  // The failure path is the one that made strays. A launch that throws hands its
  // caller nothing to close, so whatever it spawned is unreachable forever.
  const before = listProfiles();
  const emptyDir = fs.mkdtempSync(path.join(TMP, "helm-e2e-noapp-"));
  cleanup.push(emptyDir);
  let threw = null;
  try {
    await launch({ appDir: emptyDir, readyTimeoutMs: 20000 });
  } catch (err) {
    threw = err;
  }
  ok(!!threw, "launching against a directory with no Electron app fails instead of hanging");
  await delay(500);
  const leakedByFailure = [...listProfiles()].filter((d) => !before.has(d));
  ok(
    leakedByFailure.length === 0,
    `a failed launch leaves no temp directory behind${leakedByFailure.length ? `: ${leakedByFailure.join(", ")}` : ""}`
  );

  // ------------------------------- C. two apps, one port: drive the one we started
  // THE central property. Before the fix the second launch attached to the first
  // app's renderer and drove it, silently - every assertion after that point was
  // about the wrong window, and the second app could not be closed by anyone.
  const app1 = await launch({ port: 9481 });
  ok(app1.port === 9481, `the first launch got the port it asked for (${app1.port})`);

  const app2 = await launch({ port: 9481 });
  ok(
    app2.userDataTmpDir !== app1.userDataTmpDir,
    "a second launch on the same port gets its own profile, not a share of the first's"
  );
  ok(
    app2.port !== app1.port,
    `and its own debug port rather than the taken one (${app2.port} vs ${app1.port})`
  );
  // Read defensively. When this property is broken the file does not exist at all
  // (the second Electron never got a debugger), and a throw here would skip the
  // window-identity check below - which is the assertion that actually describes
  // the damage.
  let reported = null;
  try {
    reported = Number(
      fs.readFileSync(path.join(app2.userDataTmpDir, "DevToolsActivePort"), "utf8").split("\n")[0]
    );
  } catch {
    /* reported stays null, which fails the assertion below */
  }
  ok(
    reported === app2.port,
    `and the port it is driving is the one ITS OWN Electron reported (${reported} === ${app2.port})`
  );

  // Proof by consequence rather than by bookkeeping: mark each window through its
  // own CDP connection and check the marks did not land in the same renderer.
  await app1.eval(`window.__strayProbe = "one"`);
  await app2.eval(`window.__strayProbe = "two"`);
  const seenBy1 = await app1.eval(`window.__strayProbe`);
  const seenBy2 = await app2.eval(`window.__strayProbe`);
  ok(
    seenBy1 === "one" && seenBy2 === "two",
    `the two harnesses are driving two different windows (saw "${seenBy1}" and "${seenBy2}")`
  );

  const dir1 = app1.userDataTmpDir;
  const dir2 = app2.userDataTmpDir;
  await app2.close();
  ok(await procsGone(dir2), "close() takes the whole instance with it");
  ok((await procsOn(dir1)) > 0, "and leaves the OTHER live instance running - it kills only its own");
  await app1.close();
  ok(await procsGone(dir1), "which then closes normally too");
  ok(!fs.existsSync(dir1) && !fs.existsSync(dir2), "and both profiles are gone from temp");

  // ------------------------------------------ D. a run that is killed, not closed
  // What the runner's own timeout does, and what Ctrl-C does. The test process
  // dies with no chance to run close(), so the guarantee has to come from the tree
  // kill (nothing survives) plus the next sweep (nothing accumulates).
  const inner = path.join(TMP, `helm-e2e-inner-${process.pid}.mjs`);
  const harnessUrl = new URL("./harness.mjs", import.meta.url).href;
  fs.writeFileSync(
    inner,
    `import { launch } from ${JSON.stringify(harnessUrl)};\n` +
      `const app = await launch({ port: 9482 });\n` +
      `console.log("READY " + app.userDataTmpDir);\n` +
      `await new Promise(() => {});\n`
  );
  cleanup.push(inner);
  const child = spawn(process.execPath, [inner], { stdio: ["ignore", "pipe", "pipe"] });
  let innerOut = "";
  child.stdout.on("data", (c) => (innerOut += c.toString()));
  child.stderr.on("data", (c) => (innerOut += c.toString()));
  for (let i = 0; i < 120 && !innerOut.includes("READY"); i++) {
    await delay(500);
  }
  const strayDir = (innerOut.match(/READY (.+)/) || [])[1]?.trim();
  ok(!!strayDir, "a child test run launched an app of its own");
  if (strayDir) {
    cleanup.push(strayDir);
    ok((await procsOn(strayDir)) > 0, "which is really running");
    // Exactly what scripts/run-tests.mjs now does when a test overruns its budget.
    await new Promise((r) => {
      const k = spawn("powershell.exe", ["-NoProfile", "-Command", `taskkill /PID ${child.pid} /T /F 2>&1 | Out-Null`], {
        stdio: "ignore",
      });
      k.on("close", r);
      k.on("error", r);
    });
    await delay(2500);
    ok(
      await procsGone(strayDir),
      "killing the test process TREE takes its Electron with it - no stray survives the timeout"
    );
    await sweepAbandonedRuns();
    ok(!fs.existsSync(strayDir), "and the next sweep collects the profile it had no chance to delete");
  }

  // -------------------------------------- E. a stray that DID survive gets reaped
  // Belt and braces for anything the above misses (an older Helm from before this
  // fix, a hard power-cycle of a run). A leftover holding the port a new run wants
  // is our own litter, identifiable as such, and is cleared rather than worked
  // around.
  const litterDir = fakeProfile({ pid: await deadPid() });
  // A stand-in for the leftover Electron, not a second copy of the app: what the
  // reap looks at is the command line and the owner marker, and this carries the
  // same two flags on the same port. `node -e` will not take them (it parses them
  // as node options and refuses), so they have to reach argv via a script file -
  // which the first version of this test got wrong, and it showed up as this very
  // assertion failing rather than as a silently vacuous pass.
  const litterScript = path.join(TMP, `helm-e2e-litter-${process.pid}.mjs`);
  fs.writeFileSync(
    litterScript,
    `import net from "node:net";\nnet.createServer().listen(9483, "127.0.0.1");\nsetInterval(() => {}, 1e9);\n`
  );
  cleanup.push(litterScript, litterDir);
  const litter = spawn(
    process.execPath,
    [litterScript, `--remote-debugging-port=9483`, `--user-data-dir=${litterDir}`],
    { stdio: "ignore" }
  );
  await delay(1500);
  ok((await procsOn(litterDir)) > 0, "a leftover instance from a dead run is holding a debug port");

  const app3 = await launch({ port: 9483 });
  ok(
    app3.port === 9483,
    `a new launch reaps it and takes the port back rather than working around it (got ${app3.port})`
  );
  ok(await procsGone(litterDir), "the leftover process is gone");
  ok(!fs.existsSync(litterDir), "and so is its profile directory");
  await app3.close();
  try {
    litter.kill();
  } catch {
    /* already reaped, which is the point */
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  for (const p of cleanup) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: a failed launch cleans up after itself, two runs on one port drive their own apps, a killed run leaves no Electron behind, and a leftover from an earlier run is reaped rather than attached to."
    : "VERIFY FAILED."
);
process.exit(exit);
