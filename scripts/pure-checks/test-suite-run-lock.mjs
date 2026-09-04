/**
 * Two runs of this suite at once corrupt each other, so the second one is refused.
 *
 * Observed for real on 2026-08-18, while a parallel session ran the suite during a
 * debugging session. It explained two things that had been blamed on other causes: a test
 * that failed and then passed with no code change between attempts, and a new check that
 * was red on six points against CORRECT code because the harness had attached to an
 * Electron the other run had started.
 *
 * The direction that matters is the one that was not observed. The same collision can
 * just as easily produce GREEN on a fix that is not there, and nothing about that looks
 * wrong to anybody.
 *
 * ## Why a lock rather than isolating the tests
 *
 * Measured 2026-08-31: 69 of the 145 app checks do not point the meta-home at a temp
 * directory, so they share real state. Fixing 69 files would leave the 70th to be written
 * without it - the fix would need re-doing forever. A lock is one place, on the path both
 * runs take, and it converts "quietly wrong" into "refused, with a reason".
 *
 * ## What is checked
 *
 * By running the runner. A lock asserted against its own source is a lock nobody has seen
 * hold - and the three properties here are exactly the ones that look fine in source and
 * fail in practice: that it refuses, that a crashed run does not block the next one
 * forever, and that the deliberate override says so out loud.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

const RUNNER = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "run-tests.mjs");
// ITS OWN lock file, never the real one.
//
// The first version drove the real path, and that made this check destructive: running
// the suite takes that lock, so a check that overwrote and then deleted it left the rest
// of that run unguarded. It passed by breaking the thing it was checking - which is the
// same shape as everything this suite exists to catch, committed by the check itself.
const LOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helm-locktest-")), "suite.lock");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the runner with a term that matches nothing, so it costs almost nothing. */
function runner(extra = []) {
  return spawnSync(process.execPath, [RUNNER, "--fast", "zzz-no-such-test", ...extra], {
    encoding: "utf8",
    env: { ...process.env, HELM_TEST_LOCK: LOCK },
  });
}

// --- a stale lock must not block anybody ------------------------------------------
// A crashed run leaves its lock behind. If that stopped the next run, the lock would be
// worse than the collision it prevents.
{
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: "2026-01-01T00:00:00Z" }), "utf8");
  const r = runner();
  ok(r.status === 0, "a lock whose process is gone is taken, not obeyed", `exit ${r.status}`);
  ok(!/already going/.test(r.stdout + r.stderr), "and nothing is said about it");
}

// --- a live run refuses a second one -----------------------------------------------
{
  // Hold the lock with a process that really exists: this one.
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  const r = runner();
  ok(r.status === 2, "a second run exits 2 rather than running", `exit ${r.status}`);
  const said = r.stdout + r.stderr;
  ok(/already going/.test(said), "and says another run is going");
  ok(new RegExp(String(process.pid)).test(said), "naming the pid, so it can be checked rather than believed");
  // The reason matters more than the refusal: somebody who only reads "locked" will pass
  // --force. Somebody who reads what it costs will not.
  ok(/green/i.test(said) && /not there/i.test(said), "and why - including that a collision can produce a false GREEN");
}

// --- the deliberate override works, and is never quiet ------------------------------
{
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  const r = runner(["--force"]);
  ok(r.status === 0, "--force runs anyway", `exit ${r.status}`);
  ok(/--force: taking the lock/.test(r.stdout + r.stderr), "and says it took the lock from somebody");
}

// --- the lock is released, not left behind ------------------------------------------
{
  fs.rmSync(LOCK, { force: true });
  const r = runner();
  ok(r.status === 0, "a clean run finishes");
  ok(!fs.existsSync(LOCK), "and leaves no lock behind for the next one");
}

// --- and it holds against a REAL concurrent run --------------------------------------
// The cases above drive the lock file directly. This one starts an actual run and asks a
// second one to start while it is going, which is the situation itself rather than a model
// of it.
//
// Two things constrain how the first run is chosen. It must take long enough to still be
// going when the second one asks - a filter matching nothing finishes in milliseconds and
// the case proves nothing, which is how it failed the first time. And it must NOT match
// this file, or the run spawns a run that spawns a run.
//
// Rather than sleeping a guessed interval, this asks repeatedly while the first is alive:
// a refusal is the pass, and the first run exiting first is reported as inconclusive
// instead of counted as one.
{
  fs.rmSync(LOCK, { force: true });
  let firstExited = false;
  const first = spawn(process.execPath, [RUNNER, "--fast", "tier"], {
    stdio: "ignore",
    env: { ...process.env, HELM_TEST_LOCK: LOCK },
  });
  first.on("exit", () => {
    firstExited = true;
  });

  let refused = false;
  for (let i = 0; i < 40 && !refused && !firstExited; i += 1) {
    await delay(100);
    if (fs.existsSync(LOCK)) {
      refused = runner().status === 2;
    }
  }
  if (!refused && firstExited) {
    console.log("--   inconclusive: the first run finished before a second could ask");
    failures += 1;
  } else {
    ok(refused, "a real run in flight refuses a real second run");
  }

  first.kill();
  await delay(400);
  fs.rmSync(LOCK, { force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: one run at a time, a crashed run blocks nobody, and going anyway is said out loud.");
