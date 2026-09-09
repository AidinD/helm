// Two processes must never hold the write lock at once.
//
// THIS CHECK FAILS TODAY, ON PURPOSE. It documents an open bug in keel's lock, and it is
// registered in scripts/checks-lib/known-open.mjs so the suite reports it as OPEN rather than
// counting it as either a pass or an ordinary failure. The day it starts PASSING, the runner
// fails instead - see that file for why that direction matters.
//
// WHAT IS WRONG. `lockIsAbandoned` in keel falls back to an AGE rule whenever it cannot read the
// holder's claim:
//
//     try { owner = JSON.parse(readFileSync(lockPath/owner.json)) }
//     catch { /* No claim, or an unreadable one - fall through to the age rule. */ }
//     if (owner && Number.isInteger(owner.pid)) return !processExists(owner.pid)   // correct
//     try { return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS }        // the hole
//
// That catch conflates "I could not read the claim just now" with "there is no claim". The
// second is handled by the very rule the pid rule was written to REPLACE, for the very reason it
// was replaced: age cannot tell a dead holder from a slow one.
//
// WHY A SCHEDULING DELAY IS NOT A FANTASY. keel keeps the age rule for one case it claims to be
// right about - a directory created by something that died between the mkdir and its claim. Age
// cannot tell that from a process merely DESCHEDULED between the same two syscalls. Under 24 CPU
// burners on 6 cores, measured holds ran 6.1s, 6.2s, 7.6s, 10.4s and once 31.6s, all past the 5s
// threshold. A gap that size between two adjacent syscalls in a starved writer is the same order
// of event.
//
// SO THIS INJECTS NO ERROR. Process A is alive and healthy throughout; it is only slow to reach
// its own claim write. Everything else is keel's unmodified code - no failure is simulated, only
// a delay, which is why this reproduces on demand rather than under load.
//
// WHAT IT OBSERVES, and this is the part worth reading before trusting the warning keel prints.
// B is granted the lock after about 4ms - it does not wait, it takes it - and both processes are
// then inside the critical section at once. keel DOES print
// "carries another writer's claim" - but B prints it on its way OUT, when it discovers at
// release that the claim under it is not its own. By then both writers have been free to write
// for seconds. The warning is a post-mortem, not a guard, and a suite that greps for it is
// finding out afterwards.
//
// (The investigation this is adapted from saw a variant where nothing was printed at all. This
// file reports what IT sees each run rather than restating that, because the two differ and only
// what runs here is evidence.)
//
// Run: node scripts/pure-checks/test-a-live-holders-lock-is-not-taken.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const BOARD = path.join(os.tmpdir(), `helm-live-holder-${process.pid}.json`);
// B must find a directory that is claimless AND older than keel's 5s LOCK_STALE_MS - that is the
// state the age rule answers wrongly.
//
// TIMED OFF AN OBSERVED EVENT, NOT THE CLOCK. The first version started B at a fixed 5500ms
// against a 6500ms stall: 500ms of margin on a machine this same file describes stalling
// processes for 6 to 31 seconds. Under load the setup would simply not happen, the check would
// exit 0 - and this file is registered as a known-open reproduction, where exit 0 means THE BUG
// IS FIXED. A flaky reproduction plus that rule is a false all-clear, which is worse than the
// bug it watches. So A announces the moment its directory exists and its claim does not, and
// everything downstream is measured from there.
const STALE_MS = 5000;
const MARGIN_MS = 2500;
// Long enough that B has arrived, decided and acted well before A wakes.
const STALL_MS = STALE_MS + MARGIN_MS * 2 + 3000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const inode = (p) => {
  try {
    return String(fs.statSync(p).ino);
  } catch {
    return null;
  }
};

// --- child A: alive the whole time, just slow to write its own claim ------------------------
if (process.env.HELM_LOCKPROOF_A) {
  const board = process.env.HELM_LOCKPROOF_BOARD;
  const realWrite = fs.writeFileSync;
  let stalled = false;
  // The ONLY intervention, and it is a DELAY, not a failure: the write still happens, later.
  fs.writeFileSync = function (file, ...rest) {
    if (!stalled && String(file).endsWith("owner.json")) {
      stalled = true;
      // The directory exists and its claim does not - exactly the window. Announced, so the
      // driver waits for the state instead of guessing when it will arrive.
      process.stdout.write(`${JSON.stringify({ ev: "A-window-open", pid: process.pid })}\n`);
      sleep(STALL_MS);
    }
    return realWrite.call(this, file, ...rest);
  };
  const { acquireLock, releaseLock } = await import("keel/storage");
  const lock = acquireLock(board);
  fs.writeFileSync = realWrite;
  process.stdout.write(`${JSON.stringify({ ev: "A-holds", pid: process.pid, ino: inode(lock.lockPath), nonce: lock.nonce })}\n`);
  // Stay inside the critical section, as a real guarded write would be.
  sleep(4000);
  process.stdout.write(`${JSON.stringify({ ev: "A-still-alive", pid: process.pid, ino: inode(lock.lockPath) })}\n`);
  releaseLock(lock);
  process.exit(0);
}

// --- child B: an ordinary writer arriving while A holds --------------------------------------
if (process.env.HELM_LOCKPROOF_B) {
  const board = process.env.HELM_LOCKPROOF_BOARD;
  const { acquireLock, releaseLock } = await import("keel/storage");
  let lock = null;
  let error = null;
  const t0 = Date.now();
  try {
    lock = acquireLock(board);
  } catch (e) {
    error = e?.message || String(e);
  }
  process.stdout.write(
    `${JSON.stringify({ ev: "B-acquire", pid: process.pid, waitedMs: Date.now() - t0, acquired: Boolean(lock?.lockPath), ino: lock?.lockPath ? inode(lock.lockPath) : null, error })}\n`
  );
  if (lock) {
    sleep(2500);
    releaseLock(lock);
  }
  process.exit(0);
}

// --- the check itself -------------------------------------------------------------------------
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${what}`);
  if (!cond) {
    fails += 1;
  }
};

const { lockPathFor } = await import("keel/storage");
fs.writeFileSync(BOARD, "{}", "utf8");
fs.rmSync(lockPathFor(BOARD), { recursive: true, force: true });

const events = { A: [], B: [] };
let stderrAll = "";

const spawnChild = (env, label) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [HERE], {
      env: { ...process.env, ...env, HELM_LOCKPROOF_BOARD: BOARD },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      for (const line of String(d).trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          events[label].push(JSON.parse(line));
        } catch {
          // not an event line
        }
      }
    });
    child.stderr.on("data", (d) => {
      // Attributed to A or B, because "a warning was printed" and "the holder noticed on its way
      // out" are different facts, and only the first could ever be a guard.
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) {
          stderrAll += `[${label}] ${line.trim()}\n`;
        }
      }
    });
    child.on("exit", () => resolve());
  });

const a = spawnChild({ HELM_LOCKPROOF_A: "1" }, "A");
// Wait for the window to be open, then for the directory to age past the threshold. If A never
// gets that far the wait times out and the preconditions below fail loudly, which is the point:
// a reproduction that did not set itself up must not read as "nothing to see here".
const windowOpenedAt = await (async () => {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (events.A.some((e) => e.ev === "A-window-open")) {
      return Date.now();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
})();
if (windowOpenedAt) {
  await new Promise((r) => setTimeout(r, STALE_MS + MARGIN_MS));
}
const b = spawnChild({ HELM_LOCKPROOF_B: "1" }, "B");
await Promise.all([a, b]);

fs.rmSync(BOARD, { force: true });
fs.rmSync(lockPathFor(BOARD), { recursive: true, force: true });

const aHolds = events.A.find((e) => e.ev === "A-holds");
const aAlive = events.A.find((e) => e.ev === "A-still-alive");
const bAcq = events.B.find((e) => e.ev === "B-acquire");

// The preconditions, asserted rather than assumed - without them a green below would only mean
// the reproduction did not set itself up, which is the "null result with no control" trap.
ok(Boolean(windowOpenedAt), "A reached the window where its directory exists and its claim does not");
ok(Boolean(aHolds), `A took the lock (${aHolds ? `inode ${aHolds.ino}` : "NO EVENT - the reproduction did not start"})`);
ok(Boolean(aAlive), "and A was still running when it let go - it was never a dead holder, only a slow one");
ok(Boolean(bAcq), `B tried to take the lock (${bAcq ? `waited ${bAcq.waitedMs}ms` : "NO EVENT"})`);

// THE PROPERTY. B must be refused while A holds.
ok(
  bAcq ? bAcq.acquired === false : false,
  bAcq?.acquired
    ? `B TOOK THE LOCK FROM A LIVE HOLDER after only ${bAcq.waitedMs}ms - it did not wait for it. A was inside the critical section and stayed alive; both then held the write lock at once${aHolds?.ino === bAcq.ino ? ` (the same lock directory, inode ${bAcq.ino})` : ` (A on inode ${aHolds?.ino}, B on ${bAcq.ino} - A's directory was destroyed under it)`}`
    : `B was refused while A held it (${bAcq?.error || "no error recorded"})`
);

// And the reason this one is the dangerous variant, reported rather than asserted: the loud
// version of this bug prints a warning a suite run can catch. This version prints nothing.
const warned = /carries another writer's claim|has no claim in it any more|no usable write lock/.test(stderrAll);
const said = stderrAll
  .split("\n")
  .filter((l) => /claim|write lock/.test(l))
  .join(" | ");
console.log(`      warnings printed: ${warned ? said : "NONE - the double hold was completely silent"}`);

// The runner will only excuse this failure if the run SAYS it reproduced the documented bug -
// see scripts/checks-lib/known-open.mjs. Printed on the one path that is that bug, so a crash or
// an unrelated regression comes out as an ordinary failure instead of wearing this one's name.
if (bAcq?.acquired && aHolds && aAlive) {
  console.log("OPEN BUG REPRODUCED - d203c05d");
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: a live holder's lock cannot be taken by a writer that finds it claimless."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
