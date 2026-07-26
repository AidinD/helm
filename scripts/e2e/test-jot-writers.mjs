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
const { addSubtask, setTaskStatus, mutateJotFile, reviewTasks } = await import("../../src/lib/jot.js");

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
    // Simulate the Jot app writing in our window: touch the file mid-mutation so
    // the pre-rename re-stat sees a different mtime/size.
    data.todos.push({ id: "33333333-3333-4333-8333-333333333333", text: "ours", status: "open", categoryId: CAT, parentId: null });
    const other = read();
    other.todos.push({ id: "44444444-4444-4444-8444-444444444444", text: "theirs", status: "open", categoryId: CAT, parentId: null });
    fs.writeFileSync(jotPath, JSON.stringify(other, null, 2) + "  ", "utf8");
    return { ok: true };
  });
  const after = read();
  ok(after.todos.some((t) => t.text === "theirs"), "the CONCURRENT write survives - it is not silently reverted");
  ok(raced.ok === false || after.todos.length >= before + 1, `the racing write either retried or aborted, never clobbered (ok=${raced.ok})`);

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
