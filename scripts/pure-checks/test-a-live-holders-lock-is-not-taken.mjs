// A published write lock always says who holds it.
//
// THE INVARIANT, AND WHY IT IS THE ONE WORTH WATCHING. A waiter that finds a lock has exactly
// one safe question: is the holder still alive? It can only ask that if the lock carries a
// claim. When it cannot, keel falls back to an AGE rule - and age cannot tell a writer that died
// from one that is merely slow, which is a broken lock and a lost write.
//
// WHAT THIS CAUGHT. keel used to create the lock directory and then write the claim into it, two
// syscalls apart. A lock published in between existed with nothing in it. Measured against
// v0.1.20 by this file: published claimless in 246 of 328 samples, over 7.6 seconds, and a
// second writer walked in and held it alongside the first. Silently - keel does print
// "carries another writer's claim", but the second writer prints it on its way OUT, when it
// finds at release that the claim underneath is not its own. By then both have been free to
// write for seconds. That warning is a post-mortem, not a guard.
//
// FIXED IN keel v0.1.22, which builds the directory with its claim already inside and renames it
// into place. The rename is the publish, so the window does not exist. Against v0.1.22 this
// reads 210 of 210 samples with a claim.
//
// IT WAS A KNOWN-OPEN REPRODUCTION FOR ONE DAY, registered in scripts/checks-lib/known-open.mjs
// on 2026-09-09 so that the evidence could be kept while the bug was open without leaving the
// suite permanently red. The entry is gone: the check went green and the suite failed on the
// spot demanding its removal, which is the half of that mechanism that stops it becoming a place
// checks go to stop mattering. This is an ordinary check now, and it must pass.
//
// HOW IT PROVOKES THE WINDOW, since a check that cannot set up its own scenario proves nothing.
// Process A is alive and healthy throughout and is only slow to reach its own claim write - no
// error is injected, only a delay. Everything else is keel's unmodified code. That a scheduling
// delay of this size is realistic is not an assumption: under 24 CPU burners on 6 cores, holds
// were measured at 6.1s, 6.2s, 7.6s, 10.4s and once 31.6s, all past the 5s staleness threshold.
//
// AND IT WATCHES FROM OUTSIDE BOTH PROCESSES. An earlier version asserted "B must be refused
// while A holds", which stopped being a bug the moment the lock was published complete: B taking
// a lock nobody has published yet is correct, and a check calling that a failure would have been
// reporting its own obsolescence as a defect. Sampling the lock path itself does not depend on
// either process's idea of when it holds anything.
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
// processes for 6 to 31 seconds. Under load the setup would simply not happen and the check
// would pass without having tried anything - a green that means nothing, and back when this
// file was a registered reproduction it meant worse than nothing, because passing was the
// signal that the bug had been fixed. So A announces the moment its directory exists and its
// claim does not, and everything downstream is measured from there; if that moment never
// arrives, the preconditions below fail rather than the run quietly succeeding.
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

// THE INVARIANT, WATCHED DIRECTLY. A published lock must always contain its claim. While that
// holds, a waiter can always ask "is the holder alive?" and never has to fall back to guessing
// from the directory's age - which is the guess that broke a live holder's lock.
//
// Sampled from outside both processes, so it does not depend on either one's idea of when it
// holds anything. That matters: an earlier version of this check asserted "B must be refused",
// which stopped being a bug the moment the lock was published complete - B taking a lock that
// nobody has published yet is correct, and a check that called that a failure would have been
// reporting its own obsolescence as a defect.
const claimless = [];
let sampled = 0;
const watch = setInterval(() => {
  let entries;
  try {
    entries = fs.readdirSync(lockPathFor(BOARD));
  } catch {
    return; // no lock there right now, which is not a violation of anything
  }
  sampled += 1;
  if (!entries.includes("owner.json")) {
    claimless.push(Date.now());
  }
}, 25);

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
clearInterval(watch);

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

// THE PROPERTY: a lock that exists always says who holds it.
ok(sampled > 20, `the lock path was watched while the two writers ran (${sampled} samples with a lock present)`);
ok(
  claimless.length === 0,
  claimless.length === 0
    ? `every sample of the published lock had a claim in it (${sampled} samples) - so a waiter can always ask whether the holder is alive`
    : `the lock was published WITHOUT a claim in ${claimless.length} of ${sampled} samples, over ${Math.round((claimless[claimless.length - 1] - claimless[0]) / 100) / 10}s. A waiter arriving in that window has nothing to ask about the holder, so it falls back to the age rule - and age cannot tell a writer that died between the two calls from one that was merely descheduled between them`
);

// Context, not a verdict. Two different directories at one path is expected here now: A is
// still staging while B takes and releases a lock of its own, and A publishes afterwards. It
// only meant something when they could overlap, and printing it as a bare fact on a green run
// read like a defect report.
if (bAcq?.acquired && aHolds) {
  console.log(
    `      they held it in turn: B on inode ${bAcq.ino}, then A on ${aHolds.ino}${aHolds.ino === bAcq.ino ? " (the same directory, reused after release)" : ""}`
  );
}

// And the reason this one is the dangerous variant, reported rather than asserted: the loud
// version of this bug prints a warning a suite run can catch. This version prints nothing.
const warned = /carries another writer's claim|has no claim in it any more|no usable write lock/.test(stderrAll);
const said = stderrAll
  .split("\n")
  .filter((l) => /claim|write lock/.test(l))
  .join(" | ");
// Worth printing either way. keel's takeover warning arrives at RELEASE, after the damage, so
// its absence is not evidence of health and its presence is not a guard - it is just the last
// thing that happened.
console.log(`      keel printed: ${warned ? said : "nothing"}`);

// NO known-open MARKER HERE ANY MORE. While this file was registered as reproducing an open bug
// it printed "OPEN BUG REPRODUCED - d203c05d" on this path, which is how the runner told a real
// reproduction from a crash wearing its name. The entry is gone, so a marker naming it would
// claim a relationship that no longer exists - and the failure message above already says what
// happened, in more detail than a marker can. If this ever has to go back on that list, see
// scripts/checks-lib/known-open.mjs: the line goes here, on this branch and no other.

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: a live holder's lock cannot be taken by a writer that finds it claimless."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
