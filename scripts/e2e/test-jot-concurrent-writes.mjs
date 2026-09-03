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
//    file again loses 2-3 of every 240 writes, every run (7 of 720 measured on
//    2026-09-03), against 0 of 1440 with it. The hash guard is present in both
//    cases - it is right one step before the swap and loses anyway.
//
// Run: node scripts/e2e/test-jot-concurrent-writes.mjs
//      HELM_JOT_WORKERS=6 HELM_JOT_ITERATIONS=40 node scripts/e2e/test-jot-concurrent-writes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lockPathFor } from "keel/storage";

const HERE = fileURLToPath(import.meta.url);
const JOT_MODULE = new URL("../../src/lib/jot.js", import.meta.url).href;

const WORKERS = Number(process.env.HELM_JOT_WORKERS || 4);
const ITERATIONS = Number(process.env.HELM_JOT_ITERATIONS || 15);

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jot-concurrent-"));
const board = path.join(dir, "todos.json");

// One card per worker per iteration, all present up front: the test is about
// competing UPDATES to one document, not about who gets to create a card.
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

const started = Date.now();
const results = await Promise.all(
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
        resolve(JSON.parse(out));
      });
    });
  })
);
const elapsed = Date.now() - started;

const total = WORKERS * ITERATIONS;
const accepted = results.flatMap((r) => r.accepted);
const refused = results.flatMap((r) => r.refused);
const mutations = results.reduce((sum, r) => sum + r.mutations, 0);

const after = JSON.parse(fs.readFileSync(board, "utf8"));
const inReview = new Set(after.todos.filter((t) => t.status === "review").map((t) => t.id));

// THE assertion. A write that was accepted must be on the board: an accepted
// write that is not there is one that something renamed over, which is the silent
// data loss this whole mechanism exists to prevent.
const lost = accepted.filter((id) => !inReview.has(id));
ok(lost.length === 0, `no accepted write was silently lost (${accepted.length} accepted, ${lost.length} lost${lost.length ? `: ${lost.slice(0, 5).join(", ")}` : ""})`);

// And the converse: nothing landed that was reported as refused. A refusal has to
// mean nothing was written, or a caller cannot safely re-run its mutation.
const phantom = refused.filter(({ cardId }) => inReview.has(cardId));
ok(phantom.length === 0, `no refused write landed anyway (${refused.length} refused, ${phantom.length} phantom)`);

ok(after.todos.length === total, `the board still holds all ${total} cards (has ${after.todos.length})`);

// The retry has to be doing something, or it is not being tested. More mutate()
// calls than writes means collisions happened and were re-applied against a fresh
// read - exactly what the old code could not do.
const retriedWrites = mutations - total;
ok(retriedWrites > 0, `collisions were re-read and re-applied rather than handed back (${retriedWrites} extra mutate() runs over ${total} writes)`);

// Giving up is safe but useless, so it is measured rather than asserted away. If
// this climbs, JOT_CONFLICT_ATTEMPTS is the number to look at.
const gaveUp = refused.filter(({ error }) => /gave up after/.test(error || "")).length;
const gaveUpPct = ((gaveUp / total) * 100).toFixed(1);
console.log(`INFO - ${WORKERS} workers x ${ITERATIONS} writes in ${elapsed}ms: ${accepted.length} accepted, ${refused.length} refused (${gaveUp} out of attempts, ${gaveUpPct}%)`);
for (const { cardId, error } of refused.slice(0, 3)) {
  console.log(`INFO - refusal sample ${cardId}: ${error}`);
}

// A collision is normal under contention; running OUT of attempts on most of them
// would mean the backoff or the attempt budget is wrong, not that the guard works.
ok(gaveUp / total < 0.1, `fewer than 10% of writes ran out of attempts (${gaveUpPct}%)`);

// No temp files and no lock directories left behind by any of it.
const temps = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
ok(temps.length === 0, `no orphaned temp files (found ${temps.length})`);
// Scoped to THIS board's lock, not to every keel-store lock in the temp
// directory: that directory is shared, so a running Helm or another test holding
// its own lock is none of this test's business and made the check fail for a
// reason that had nothing to do with the code under test.
ok(!fs.existsSync(lockPathFor(board)), `this board's write lock was given back (${lockPathFor(board)})`);

fs.rmSync(dir, { recursive: true, force: true });

console.log(
  code === 0
    ? "\nVERIFY OK: competing processes either land their write or are refused, and a collision is re-read rather than returned."
    : "\nVERIFY FAILED"
);
process.exit(code);
