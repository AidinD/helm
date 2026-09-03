// Concurrency test: mutateJotFile under real competing processes.
//
// WHY REAL PROCESSES. Helm is not the only writer of todos.json - the Jot app is
// usually open, the MCP server is its own process, and Dropbox can replace the
// file wholesale. Every mistake in this area is invisible in a single-process
// test, because the whole failure mode IS the interleaving: two writers that both
// read, both mutate their own copy and both rename leave one edit, with nothing
// anywhere saying the other was lost. So this test spawns workers and asserts the
// contract that matters:
//
//   EVERY WRITE EITHER LANDS OR IS REFUSED. Never silently lost.
//
// It also measures the two things that were wrong on 2026-09-03:
//
//  - mutateJotFile lost its read-side retry on 2026-07-27, when the commit that
//    centralised the atomic write swapped its outer loop for writeFileAtomicSync's
//    attempt loop. Those are not the same loop: the writer retries the WRITE with
//    `contents` and the expected hash frozen, so every attempt failed identically
//    and the caller got a refusal for a collision a re-read would have absorbed.
//    `retriedWrites` below is what the read-side retry is worth in practice; for
//    five weeks it was necessarily zero, and no test noticed because none of them
//    ran two writers at once.
//  - the guard's check and the rename were two steps with no lock, so another
//    writer could pass its own check while a rename was in flight and then rename
//    over it. `lost` below is that number, and it must be 0. It is not
//    theoretical: taking only that lock back out of keel/storage and running this
//    file again loses writes - 7 of 720 measured here, and an independent reviewer
//    measured 4, 0 and 3 of 240 in three runs, against 0 of 1440 with the lock. Note
//    their middle run: loss needs two writers inside the same few microseconds, so a
//    single clean run proves nothing, which is why ROUNDS aggregates below. (An
//    earlier version of this comment said "every run", from a 3-run sample. It is
//    wrong, and anyone re-running the measurement on that basis would conclude the
//    lock is unnecessary.) The hash guard is present in both cases - it is right one
//    step before the swap and loses anyway.
//
// Run: node scripts/e2e/test-jot-concurrent-writes.mjs
//      HELM_JOT_WORKERS=6 HELM_JOT_ITERATIONS=40 node scripts/e2e/test-jot-concurrent-writes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const JOT_MODULE = new URL("../../src/lib/jot.js", import.meta.url).href;

// CONTENDED BY DEFAULT, and this used to be 4 x 15. Mutation testing measured what
// the smaller default was worth: removing the lock outright still passed 3 of 8 runs
// at 4 x 15, so a green run was not evidence of anything. Loss here is probabilistic
// - it needs two writers inside the same few microseconds - so the sample has to be
// big enough that its absence means something, and it is aggregated over ROUNDS
// below rather than judged one run at a time.
const WORKERS = Number(process.env.HELM_JOT_WORKERS || 6);
const ITERATIONS = Number(process.env.HELM_JOT_ITERATIONS || 40);
const ROUNDS = Number(process.env.HELM_JOT_ROUNDS || 3);

/**
 * The whole point of a synchronous writer is that the window is frozen while it
 * runs, so a write that takes tens of seconds is a broken app even when it succeeds.
 * Review measured 22.6s before there was any budget. This is the ceiling for ONE
 * call with a live lock holder in the way, and it is generous: the lock wait is 2s.
 */
const ONE_WRITE_CEILING_MS = 5000;

// ---------------------------------------------------------------------------
// Lock-holder mode. Takes the board's write lock and sits on it, as a LIVE
// process - which matters, because a live holder's lock must never be broken and
// a dead one's must be taken over at once. Used to measure what one write costs
// when it cannot have the lock.
// ---------------------------------------------------------------------------
if (process.env.HELM_JOT_HOLD_LOCK) {
  const { acquireLock, releaseLock, sleepSync } = await import("keel/storage");
  const lock = acquireLock(process.env.HELM_JOT_HOLD_LOCK);
  process.stdout.write("held");
  sleepSync(Number(process.env.HELM_JOT_HOLD_MS || 5000));
  releaseLock(lock);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Worker mode. Each worker moves ITERATIONS cards of its own to "review" via
// mutateJotFile and reports, per card, whether the write was accepted. The
// parent then checks the board against those reports.
// ---------------------------------------------------------------------------
if (process.env.HELM_JOT_WORKER_ID) {
  const id = process.env.HELM_JOT_WORKER_ID;
  const board = process.env.HELM_JOT_BOARD;
  const { mutateJotFile } = await import(JOT_MODULE);

  const accepted = [];
  const refused = [];
  let mutations = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const cardId = `${id}-${i}`;
    const res = mutateJotFile(board, (data) => {
      mutations += 1;
      const todo = data.todos.find((t) => t.id === cardId);
      if (!todo) {
        return { ok: false, error: `card ${cardId} missing` };
      }
      todo.status = "review";
      return { ok: true };
    });
    if (res.ok) {
      accepted.push(cardId);
    } else {
      refused.push({ cardId, error: res.error });
    }
  }
  process.stdout.write(JSON.stringify({ id, accepted, refused, mutations }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode.
// ---------------------------------------------------------------------------
let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};

/** A board with one card per worker per iteration, all present up front. */
function seedBoard(dir) {
  const board = path.join(dir, "todos.json");
  const todos = [];
  for (let worker = 0; worker < WORKERS; worker += 1) {
    for (let i = 0; i < ITERATIONS; i += 1) {
      todos.push({
        id: `w${worker}-${i}`,
        text: `card ${worker}/${i}`,
        status: "open",
        description: "",
        images: [],
        categoryId: "cat1",
        tags: [],
        priority: 0,
        deadline: null,
        parentId: null,
        createdAt: Date.now(),
        completedAt: null,
      });
    }
  }
  fs.writeFileSync(board, JSON.stringify({ categories: [{ id: "cat1", name: "Helm" }], tags: [], todos }, null, 2), "utf8");
  return board;
}

/** One round: WORKERS processes each doing ITERATIONS guarded writes to `board`. */
function runRound(board) {
  return Promise.all(
    Array.from({ length: WORKERS }, (_, worker) => {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HERE], {
          env: { ...process.env, HELM_JOT_WORKER_ID: `w${worker}`, HELM_JOT_BOARD: board, HELM_JOT_ITERATIONS: String(ITERATIONS) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          err += chunk;
        });
        child.on("error", reject);
        child.on("exit", (status) => {
          if (status !== 0 || !out) {
            reject(new Error(`worker w${worker} exited ${status}: ${err || "no output"}`));
            return;
          }
          // A WORKER'S WARNING IS A FINDING, not noise, and this used to be thrown
          // away on success. keel/storage writes to stderr exactly when it had to
          // fall back to a weaker guarantee - "no usable write lock ... falling back
          // to the change guard alone" - so a worker running with no lock at all was
          // invisible in a green run. Mutation testing proved it: forcing the
          // degraded path passed this whole file silently.
          resolve({ ...JSON.parse(out), stderr: err.trim() });
        });
      });
    })
  );
}

// ---------------------------------------------------------------------------
// Part 1 - the write discipline, in-process and deterministic.
//
// The multi-process part below can only observe loss probabilistically. These two
// checks pin down the mechanisms that make it rare, and both exist because
// mutation testing showed the contention run does NOT notice when they break.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jot-discipline-"));
  const board = seedBoard(dir);
  const { mutateJotFile } = await import(JOT_MODULE);

  // ONE READ PER ATTEMPT for the board's own bytes, plus the guard's re-read.
  // Hashing the file separately from parsing it means the guard defends bytes
  // nobody parsed, which produces collisions with nobody on the other side. That
  // regression is invisible to the contention run, because spurious retries read as
  // MORE green (the only assertion on retry volume is a lower bound).
  const realRead = fs.readFileSync;
  let boardReads = 0;
  try {
    fs.readFileSync = (file, options) => {
      if (String(file) === board) {
        boardReads += 1;
      }
      return realRead.call(fs, file, options);
    };
    const res = mutateJotFile(board, (data) => {
      data.todos[0].status = "review";
      return { ok: true };
    });
    ok(res.ok === true, "an uncontended guarded write succeeds");
  } finally {
    fs.readFileSync = realRead;
  }
  ok(
    boardReads === 2,
    `one uncontended write reads the board exactly twice - once to parse and hash, once for the guard (read it ${boardReads}x)`
  );

  // A LIVE LOCK HOLDER MUST NOT FREEZE THE APP. These writers are synchronous and
  // run on Electron's main thread, so this is the difference between a refused
  // write and an unresponsive window. Nothing asserted a latency bound before, which
  // is how a 22.6-second write went unnoticed.
  const holder = spawn(process.execPath, [HERE], {
    env: { ...process.env, HELM_JOT_HOLD_LOCK: board, HELM_JOT_HOLD_MS: "8000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let holderSaid = "";
  holder.stdout.on("data", (chunk) => {
    holderSaid += chunk;
  });
  const holderGone = new Promise((resolve) => holder.on("exit", resolve));
  const waitedFor = Date.now() + 10_000;
  while (!holderSaid.includes("held") && Date.now() < waitedFor) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  ok(holderSaid.includes("held"), "the lock-holder process took the lock");

  const before = fs.readFileSync(board, "utf8");
  const t0 = Date.now();
  const blocked = mutateJotFile(board, (data) => {
    data.todos[1].status = "review";
    return { ok: true };
  });
  const waited = Date.now() - t0;
  holder.kill();
  await holderGone;

  ok(waited < ONE_WRITE_CEILING_MS, `one write against a live lock holder gives up in ${waited}ms, under the ${ONE_WRITE_CEILING_MS}ms ceiling`);
  ok(blocked.ok === false, "and it reports failure rather than writing without the lock");
  ok(fs.readFileSync(board, "utf8") === before, "and the board is untouched");
  console.log(`INFO - blocked write: ${blocked.error}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 2 - real competing processes, aggregated over rounds.
// ---------------------------------------------------------------------------
const totalPerRound = WORKERS * ITERATIONS;
const all = { accepted: [], refused: [], mutations: 0, lost: [], phantom: [], warnings: [] };
let slowestRound = 0;

// Every keel-store lock in the temp directory before we start, so the leak check
// below can be a BEFORE/AFTER DIFF rather than a question asked of the code under
// test. Asking `lockPathFor(board)` where to look means a mutation to the naming
// makes the check pass for free - mutation testing caught exactly that.
const locksBefore = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("keel-store-")));

for (let round = 0; round < ROUNDS; round += 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jot-concurrent-"));
  const board = seedBoard(dir);

  const started = Date.now();
  const results = await runRound(board);
  const elapsed = Date.now() - started;
  slowestRound = Math.max(slowestRound, elapsed);

  const accepted = results.flatMap((r) => r.accepted);
  const refused = results.flatMap((r) => r.refused);
  const after = JSON.parse(fs.readFileSync(board, "utf8"));
  const inReview = new Set(after.todos.filter((t) => t.status === "review").map((t) => t.id));

  all.accepted.push(...accepted);
  all.refused.push(...refused);
  all.mutations += results.reduce((sum, r) => sum + r.mutations, 0);
  all.lost.push(...accepted.filter((id) => !inReview.has(id)));
  all.phantom.push(...refused.filter(({ cardId }) => inReview.has(cardId)));
  all.warnings.push(...results.filter((r) => r.stderr).map((r) => `${r.id}: ${r.stderr.split("\n")[0]}`));

  ok(after.todos.length === totalPerRound, `round ${round + 1}: the board still holds all ${totalPerRound} cards (has ${after.todos.length})`);
  const temps = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  ok(temps.length === 0, `round ${round + 1}: no orphaned temp files (found ${temps.length})`);

  fs.rmSync(dir, { recursive: true, force: true });
}

const total = totalPerRound * ROUNDS;

// THE assertion, aggregated. A write that was accepted must be on the board: an
// accepted write that is not there is one that something renamed over, which is the
// silent data loss this whole mechanism exists to prevent.
ok(
  all.lost.length === 0,
  `no accepted write was silently lost across ${ROUNDS} rounds (${all.accepted.length} accepted, ${all.lost.length} lost${all.lost.length ? `: ${all.lost.slice(0, 5).join(", ")}` : ""})`
);

// And the converse: nothing landed that was reported as refused. A refusal has to
// mean nothing was written, or a caller cannot safely re-run its mutation.
ok(all.phantom.length === 0, `no refused write landed anyway (${all.refused.length} refused, ${all.phantom.length} phantom)`);

// No worker may have quietly run without a lock. See the stderr note in runRound.
ok(all.warnings.length === 0, `no worker fell back to a weaker guarantee (${all.warnings.length}${all.warnings.length ? `: ${all.warnings[0]}` : ""})`);

// The retry has to be doing something, or it is not being tested. More mutate()
// calls than writes means collisions happened and were re-applied against a fresh
// read - exactly what the old code could not do. Aggregated, because a single round
// on a loaded or single-core machine can legitimately see very little contention.
const retriedWrites = all.mutations - total;
ok(retriedWrites > 0, `collisions were re-read and re-applied rather than handed back (${retriedWrites} extra mutate() runs over ${total} writes)`);

// HEALTH IS MEASURED ON EVERY REFUSAL, not just on the one wording. This matched
// /gave up after/ before, so a mutation that made two thirds of writes fail for a
// DIFFERENT reason reported "0.0% out of attempts" and passed.
const refusedPct = ((all.refused.length / total) * 100).toFixed(1);
console.log(
  `INFO - ${ROUNDS} rounds x ${WORKERS} workers x ${ITERATIONS} writes (slowest round ${slowestRound}ms): ` +
    `${all.accepted.length} accepted, ${all.refused.length} refused (${refusedPct}%), ${retriedWrites} collisions re-applied`
);
for (const { cardId, error } of all.refused.slice(0, 3)) {
  console.log(`INFO - refusal sample ${cardId}: ${error}`);
}
ok(all.refused.length / total < 0.1, `fewer than 10% of writes were refused for any reason (${refusedPct}%)`);

// A round of writes that takes this long has stopped being a save and started being
// a hang, even if every write lands.
ok(slowestRound < 30_000, `a round of ${totalPerRound} contended writes finishes in ${slowestRound}ms`);

// No lock left behind by any of it, judged independently of the code under test.
const leaked = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("keel-store-") && !locksBefore.has(f));
ok(leaked.length === 0, `no write lock was left behind (${leaked.length}${leaked.length ? `: ${leaked.join(", ")}` : ""})`);

// ---------------------------------------------------------------------------
// Part 3 - the jitter is CALLED, not merely imported.
//
// keel unit-tests jitteredBackoffMs itself, but nothing asserted that this module
// uses it, and removing the jitter at the call site survived every suite. Without
// it two writers back off on the same schedule, stay in lockstep and keep colliding.
// This repo has made the "an import is not a call" mistake before, so the assertion
// is on the call, with comments stripped first - a source scan that matches a
// comment is its own known failure mode.
// ---------------------------------------------------------------------------
{
  // Comments AND import lines are stripped first, for two reasons this suite has
  // learned the hard way: a source scan that matches its own explanatory comment
  // checks nothing, and an IMPORT is not a CALL - the mutation that removed the
  // jitter left the import sitting there untouched.
  const source = fs
    .readFileSync(new URL("../../src/lib/jot.js", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*") &&
        !trimmed.startsWith("import ")
      );
    })
    .join("\n");
  // Not `sleepSync(jitteredBackoffMs(` literally: the wait is computed into a
  // variable so the time budget can look at it before sleeping, and an assertion
  // pinned to one expression's shape breaks on a refactor that changed nothing.
  ok(/\bjitteredBackoffMs\s*\(/.test(source), "the retry wait is computed by jitteredBackoffMs");
  ok(/\bsleepSync\s*\(/.test(source), "and is slept on rather than computed and dropped");
  ok(!/\bsleepSync\s*\(\s*backoffMs\s*\(/.test(source), "and not taken from the unjittered backoff");
}

console.log(
  code === 0
    ? "\nVERIFY OK: competing processes either land their write or are refused, a collision is re-read rather than returned, and one write cannot freeze the app."
    : "\nVERIFY FAILED"
);
process.exit(code);
