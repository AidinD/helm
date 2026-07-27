// Unit test: mutateJotFile survives a locked file.
//
// Found live 2026-07-27: a board update from Helm returned
// "Failed to write Jot data: EPERM ... rename" and the change was simply LOST.
// The Jot data dir is always in Dropbox, so the sync client holding the file
// mid-rename is the normal setup, not an edge case - and the existing retry loop
// only covered the concurrent-EDIT case, so a locked file bailed on attempt one.
//
// Run: node scripts/e2e/test-jot-lock-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mutateJotFile } from "../../src/lib/jot.js";

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jot-lock-"));
const file = path.join(dir, "todos.json");
const seed = () =>
  fs.writeFileSync(
    file,
    JSON.stringify({ categories: [{ id: "c", name: "X" }], todos: [{ id: "t", text: "before", status: "open", categoryId: "c" }] }, null, 2),
    "utf8"
  );

const realRename = fs.renameSync;
/** Make renameSync throw `code` for the first `times` attempts on our file. */
function lockFor(times, errCode = "EPERM") {
  let thrown = 0;
  fs.renameSync = (from, to) => {
    if (to === file && thrown < times) {
      thrown += 1;
      const err = new Error("operation not permitted");
      err.code = errCode;
      throw err;
    }
    return realRename(from, to);
  };
  return () => thrown;
}

try {
  // Two transient failures, then success: the write must survive.
  seed();
  let thrownCount = lockFor(2);
  const t0 = Date.now();
  const res = mutateJotFile(file, (d) => {
    d.todos[0].text = "after";
    return { ok: true, result: "mutated" };
  });
  fs.renameSync = realRename;
  const ms = Date.now() - t0;
  ok(res.ok === true, `a locked file is retried, not dropped (${JSON.stringify(res)})`);
  ok(res.result === "mutated", "the mutator's result still comes back");
  ok(thrownCount() === 2, `the lock really fired (${thrownCount()} EPERM)`);
  ok(JSON.parse(fs.readFileSync(file, "utf8")).todos[0].text === "after", "and the change actually reached disk");
  ok(ms < 2000, `the backoff stays bounded (${ms}ms)`);

  // EBUSY and EACCES are the same class of "someone has the file".
  for (const errCode of ["EBUSY", "EACCES"]) {
    seed();
    lockFor(1, errCode);
    const r = mutateJotFile(file, (d) => {
      d.todos[0].text = errCode;
      return { ok: true };
    });
    fs.renameSync = realRename;
    ok(r.ok === true, `${errCode} is treated as a transient lock too`);
    ok(JSON.parse(fs.readFileSync(file, "utf8")).todos[0].text === errCode, `${errCode}: the change reached disk`);
  }

  // A lock that never clears must FAIL - loudly, with the reason. Silently
  // reporting success would be worse than the original bug.
  seed();
  lockFor(99);
  const stuck = mutateJotFile(file, (d) => {
    d.todos[0].text = "never";
    return { ok: true };
  });
  fs.renameSync = realRename;
  ok(stuck.ok === false, "a lock that never clears fails rather than claiming success");
  ok(/EPERM|locked/i.test(stuck.error || ""), `and says why (got "${stuck.error}")`);
  ok(JSON.parse(fs.readFileSync(file, "utf8")).todos[0].text === "before", "the file is left untouched, not half-written");
  ok(fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length === 0, "no .tmp files are left behind by the failed attempts");

  // A REAL error must not be retried into a hang.
  seed();
  fs.renameSync = (from, to) => {
    if (to === file) {
      const err = new Error("no such device");
      err.code = "ENODEV";
      throw err;
    }
    return realRename(from, to);
  };
  const hard = mutateJotFile(file, (d) => {
    d.todos[0].text = "x";
    return { ok: true };
  });
  fs.renameSync = realRename;
  ok(hard.ok === false && /ENODEV|no such device/.test(hard.error || ""), `a non-lock error fails immediately with its own message (got "${hard.error}")`);

  // A mutator that refuses must still refuse, unchanged by any of this.
  seed();
  const refused = mutateJotFile(file, () => ({ ok: false, error: "nope" }));
  ok(refused.ok === false && refused.error === "nope", "a refusing mutator is passed through untouched");
} catch (err) {
  code = 1;
  console.error("ERR", err.stack || err.message);
} finally {
  fs.renameSync = realRename;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
console.log(code === 0 ? "\nVERIFY OK: a Dropbox-locked Jot file is retried and the write survives; a permanent lock fails loudly." : "\nVERIFY FAILED");
process.exit(code);
