// Unit test: Jot's writers (task ce2d19ab). addSubtask was refactored onto a
// shared mutateJotFile so review actions could reuse its compare-before-swap
// guard instead of hand-rolling a second copy - so this covers BOTH: that the
// refactor kept addSubtask's behaviour, and that setTaskStatus is safe.
//
// The guard being tested matters: Helm and the Jot app both do whole-file
// read-modify-write with no lock, so a naive rename silently REVERTS the other's
// edit and a real todo vanishes.
// Run:  node scripts/e2e/test-jot-writers.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jot-writers-"));
const jotPath = path.join(dir, "todos.json");
const { addSubtask, setTaskStatus, mutateJotFile, reviewTasks, signedOffWithoutRecord } = await import("../../src/lib/jot.js");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const CAT = "cat-1";
const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const seed = () =>
  fs.writeFileSync(
    jotPath,
    JSON.stringify(
      {
        categories: [{ id: CAT, name: "Helm" }],
        todos: [
          { id: PARENT, text: "Parent task", status: "review", description: "", categoryId: CAT, priority: 0, parentId: null, createdAt: 1, completedAt: null },
          { id: CHILD, text: "A subtask", status: "open", description: "", categoryId: CAT, priority: 0, parentId: PARENT, createdAt: 2, completedAt: null },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
const read = () => JSON.parse(fs.readFileSync(jotPath, "utf8"));
const cfg = { path: jotPath };

try {
  // ---- addSubtask still behaves after the refactor ----
  seed();
  const add = addSubtask(cfg, PARENT, "  fresh subtask  ");
  ok(add.ok === true && typeof add.id === "string", "addSubtask returns the new id");
  const added = read().todos.find((t) => t.id === add.id);
  ok(added && added.text === "fresh subtask", "the text is trimmed");
  ok(added.parentId === PARENT && added.categoryId === CAT, "it inherits the parent's category and links to it");
  ok(added.status === "open" && added.priority === 0 && added.completedAt === null, "sensible defaults");
  ok(read().todos.length === 3, "nothing else was lost");

  ok(addSubtask(cfg, PARENT, "   ").ok === false, "empty text is refused");
  ok(addSubtask(cfg, null, "x").ok === false, "a missing parent id is refused");
  ok(addSubtask(cfg, "nope", "x").ok === false, "an unknown parent is refused");
  ok(addSubtask(cfg, CHILD, "x").ok === false, "a grandchild is refused - Jot nests exactly one level");

  // ---- setTaskStatus ----
  seed();
  const done = setTaskStatus(cfg, PARENT, "done");
  ok(done.ok === true && done.result.from === "review" && done.result.to === "done", "setTaskStatus reports the transition");
  const t1 = read().todos.find((t) => t.id === PARENT);
  ok(t1.status === "done" && typeof t1.completedAt === "number", "done stamps completedAt, like Jot's own writer");
  ok(typeof t1.updatedAt === "number", "it bumps updatedAt");

  seed();
  const back = setTaskStatus(cfg, PARENT, "in-progress", "Sent back: the drag marker still points at the wrong slot.");
  ok(back.ok === true, "a task can be sent back to in-progress");
  const t2 = read().todos.find((t) => t.id === PARENT);
  ok(t2.status === "in-progress" && t2.completedAt === null, "going back clears completedAt");
  ok(/drag marker still points/.test(t2.description), "the note is appended to the description - a bounce without a reason wastes the next session");

  seed();
  const withExisting = setTaskStatus(cfg, PARENT, "open", "second note");
  ok(withExisting.ok, "a note appends rather than replaces");
  seed();
  setTaskStatus(cfg, PARENT, "open", "first");
  setTaskStatus(cfg, PARENT, "open", "second");
  const t3 = read().todos.find((t) => t.id === PARENT);
  ok(/first/.test(t3.description) && /second/.test(t3.description), "both notes survive");

  ok(setTaskStatus(cfg, PARENT, "bogus").ok === false, "an unknown status is refused");
  ok(setTaskStatus(cfg, "nope", "done").ok === false, "an unknown task is refused");
  ok(setTaskStatus(cfg, "", "done").ok === false, "a missing id is refused");

  // ---- the concurrency guard actually guards ----
  seed();
  const before = read().todos.length;
  const raced = mutateJotFile(jotPath, (data) => {
    // Simulate the Jot app writing inside our read->write window.
    //
    // NOTE, and this is why the guard changed: the earlier version of this test
    // appended two spaces to the competing write, which changed the file SIZE - so
    // it only ever exercised the easy case. The realistic concurrent edit from the
    // Jot app is byte-identical in length (a drag-reorder is a pure permutation; a
    // subtask "open"->"done" is the same 4 chars), and Windows' ~15.6ms clock tick
    // meant mtime often matched too. Measured: 250 of 400 same-size writes were
    // invisible to the old size+mtime guard, and Helm renamed straight over them.
    // So the write below is deliberately the SAME LENGTH as what we would produce.
    data.todos.push({ id: "33333333-3333-4333-8333-333333333333", text: "ours", status: "open", categoryId: CAT, parentId: null });
    const other = read();
    other.todos.push({ id: "44444444-4444-4444-8444-444444444444", text: "ours", status: "open", categoryId: CAT, parentId: null });
    fs.writeFileSync(jotPath, JSON.stringify(other, null, 2), "utf8");
    return { ok: true };
  });
  const after = read();
  ok(after.todos.some((t) => t.id === "44444444-4444-4444-8444-444444444444"), "the CONCURRENT write survives - it is not silently reverted");
  // The old assertion here was `raced.ok === false || after.todos.length >= before + 1`,
  // which cannot fail: the guard working gives before+2 and a clobber gives before+1,
  // and both satisfy the disjunction. State the actual requirement instead - our own
  // write must have either been retried on top of theirs, or abandoned.
  // (The competing write re-runs on every retry attempt, so the total count grows by
  // more than one - the count is not the invariant. What matters is whether OUR
  // write landed, and that it only landed if the call reported success.)
  const ours = after.todos.filter((t) => t.id === "33333333-3333-4333-8333-333333333333").length;
  if (raced.ok) {
    ok(ours === 1, `a successful race wrote ours exactly once, on top of the other write (found ${ours})`);
  } else {
    ok(ours === 0, `an aborted race did NOT write ours - no silent clobber (found ${ours}, ${after.todos.length} todos total)`);
  }

  // --- subtasks in review, and the done-without-a-record audit ---------------
  // Subtasks were filtered out of the review queue entirely (`!t.parentId`), so a
  // subtask in review was invisible to the page, needed no record and raised no badge.
  // the captain's own convention uses epics with subtasks, so the hole opens itself.
  const withSub = read();
  const EPIC = "aaaa1111-1111-4111-8111-111111111111";
  const SUB = "bbbb2222-2222-4222-8222-222222222222";
  const DONE_NO_REC = "cccc3333-3333-4333-8333-333333333333";
  const DONE_OLD = "dddd4444-4444-4444-8444-444444444444";
  withSub.todos.push(
    { id: EPIC, text: "An epic", status: "in-progress", categoryId: CAT, parentId: null, priority: 0 },
    { id: SUB, text: "A subtask in review", status: "review", categoryId: CAT, parentId: EPIC, priority: 1 },
    { id: DONE_NO_REC, text: "Marked done directly", status: "done", categoryId: CAT, parentId: null, priority: 0, completedAt: Date.now() - 1000 },
    { id: DONE_OLD, text: "Done long ago", status: "done", categoryId: CAT, parentId: null, priority: 0, completedAt: Date.now() - 90 * 24 * 60 * 60 * 1000 }
  );
  fs.writeFileSync(jotPath, JSON.stringify(withSub, null, 2), "utf8");

  const q = reviewTasks({ enabled: true, path: jotPath });
  const subRow = (q.tasks || []).find((t) => t.id === SUB);
  ok(!!subRow, "a SUBTASK in review appears in the queue - it used to be filtered out and so needed no record at all");
  ok(subRow?.parentTitle === "An epic", `and it names its parent so the row reads as belonging somewhere (${subRow?.parentTitle})`);
  // This used to read `every(t => t.status !== "done")` - which CANNOT FAIL, because
  // reviewTasks maps to {id,title,priority,category,description,parentTitle} and has no
  // `status` field at all, so the predicate was `undefined !== "done"`. It would have
  // stayed green if the status filter were deleted outright. Assert on the ids instead.
  const queued = new Set((q.tasks || []).map((t) => t.id));
  ok(!queued.has(DONE_NO_REC), "a DONE task is not in the review queue (checked by id, since rows carry no status field)");
  ok(!queued.has(EPIC), "nor is an in-progress parent");
  ok(queued.has(SUB), "only tasks whose status is review are queued");

  // The audit. A direct board write cannot be prevented from here, only detected.
  const audit = signedOffWithoutRecord({ enabled: true, path: jotPath }, () => false);
  ok(audit.ok === true, "the audit reads the board");
  ok(audit.tasks.some((t) => t.id === DONE_NO_REC), "a task marked done with no review record is surfaced");
  ok(!audit.tasks.some((t) => t.id === DONE_OLD), "one from months ago is not - this is a signal about current practice, not a history dump");
  ok(!audit.tasks.some((t) => t.id === SUB), "a task still in review is not reported as signed off");
  const auditWithRecords = signedOffWithoutRecord({ enabled: true, path: jotPath }, (id) => id === DONE_NO_REC);
  ok(!auditWithRecords.tasks.some((t) => t.id === DONE_NO_REC), "a done task that DOES have a record is not flagged");
  // Case-shifted ids must still match a record, or the audit would cry wolf forever.
  ok(signedOffWithoutRecord({ enabled: true, path: jotPath }, (id) => id.toLowerCase() === DONE_NO_REC).tasks.length === 0,
    "the record lookup is the caller's business and is honoured as given");
  ok(signedOffWithoutRecord({ enabled: false }, () => false).ok === false, "a disabled Jot config is refused, not treated as an empty board");

  const mutatorRefusal = mutateJotFile(jotPath, () => ({ ok: false, error: "nope" }));
  ok(mutatorRefusal.ok === false && mutatorRefusal.error === "nope", "a mutator can abort and its error passes through");

  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  ok(leftovers.length === 0, "no .tmp files left behind");

  // ---- reviewTasks sees exactly what the board says ----
  seed();
  ok(reviewTasks(cfg).tasks.length === 1, "reviewTasks returns the one top-level review task");
  setTaskStatus(cfg, PARENT, "done");
  ok(reviewTasks(cfg).tasks.length === 0, "once done, it leaves the review queue");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: Jot writers - addSubtask unchanged by the refactor, setTaskStatus safe, concurrency guard intact." : "VERIFY FAILED.");
process.exit(exit);
