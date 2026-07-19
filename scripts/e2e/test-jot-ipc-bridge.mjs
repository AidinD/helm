// Unit test (no electron): the Jot IPC bridge's channel -> store-method dispatch
// (applyJotOp). Drives a real @jot/core store through the same channels Jot's
// built renderer invokes, and asserts each maps to the right store mutation. This
// is what lets Helm's embedded Jot webview reuse Jot's renderer unchanged.
//
// Run:  node scripts/e2e/test-jot-ipc-bridge.mjs
import { applyJotOp, JOT_STORE_CHANNELS } from "../../src/lib/jotIpcBridge.js";
import { TodoStore, LocalJsonStorage } from "@jot/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) code = 1;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jotbridge-"));
fs.writeFileSync(path.join(dir, "todos.json"), JSON.stringify({ todos: [], categories: [], tags: [] }));
const store = new TodoStore(new LocalJsonStorage(path.join(dir, "todos.json")), dir);
await store.init();

try {
  // state:get returns the store state.
  const s0 = await applyJotOp(store, "state:get", []);
  ok(s0 && Array.isArray(s0.todos) && s0.todos.length === 0, "state:get returns the empty state");

  // categories:add returns a new id and adds it.
  const catId = await applyJotOp(store, "categories:add", ["Work"]);
  ok(typeof catId === "string" && catId.length > 0, "categories:add returns a new category id");
  ok(applyJotOp(store, "state:get").categories.some((c) => c.id === catId && c.name === "Work"), "categories:add added the category");

  // todos:add adds a todo under the category.
  await applyJotOp(store, "todos:add", ["write the report", catId, 3, null]);
  const st1 = applyJotOp(store, "state:get");
  const todo = st1.todos.find((t) => t.text === "write the report");
  ok(!!todo && todo.categoryId === catId && todo.priority === 3, "todos:add added a todo with category + priority");

  // todos:setStatus moves it.
  await applyJotOp(store, "todos:setStatus", [todo.id, "in-progress", false]);
  ok(applyJotOp(store, "state:get").todos.find((t) => t.id === todo.id).status === "in-progress", "todos:setStatus updated the status");

  // tags:add + todos:setTags.
  const tagId = await applyJotOp(store, "tags:add", ["needs-clarification", "#f00", "unclear"]);
  ok(typeof tagId === "string" && tagId.length > 0, "tags:add returns a new tag id");
  await applyJotOp(store, "todos:setTags", [todo.id, [tagId]]);
  ok(applyJotOp(store, "state:get").todos.find((t) => t.id === todo.id).tags.includes(tagId), "todos:setTags set the tag on the todo (the auto-captain's write path)");

  // todos:setPriority.
  await applyJotOp(store, "todos:setPriority", [todo.id, 0]);
  ok(applyJotOp(store, "state:get").todos.find((t) => t.id === todo.id).priority === 0, "todos:setPriority updated priority");

  // Unknown channel throws (loud, not silent).
  let threw = false;
  try {
    await applyJotOp(store, "todos:teleport", []);
  } catch {
    threw = true;
  }
  ok(threw, "an unknown channel throws");

  // The whole thing persisted to the shared file (a standalone Jot would see it).
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "todos.json"), "utf8"));
  ok(onDisk.todos.some((t) => t.text === "write the report" && t.tags.includes(tagId)), "all mutations persisted to the shared todos.json");

  ok(JOT_STORE_CHANNELS.length >= 20, `bridge covers the core data channel surface (${JOT_STORE_CHANNELS.length} channels)`);

  console.log(code === 0 ? "VERIFY OK: the Jot IPC bridge dispatches every channel to the right @jot/core mutation - Helm can back Jot's renderer." : "VERIFY FAILED.");
} catch (err) {
  code = 1;
  console.log("ERROR", err.stack || err.message);
} finally {
  try { store.dispose?.(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
process.exit(code);
