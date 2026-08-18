// E2E through the real app: acknowledging a task that reached done with no review
// record stops the audit repeating it - without ever claiming the work was reviewed.
//
// Why the distinction is the whole test. The audit exists to tell the captain that something
// bypassed review. Once he has read that, repeating it for a fortnight teaches him to
// skim the section, which is how an attention signal dies (his review, 2026-07-28:
// "när du sett dem en gång blir de bara tjat"). But an acknowledgement must not
// silently become evidence: the work still has no record, and if a record later appears
// it must be judged on its own terms.
//
// Run: node scripts/e2e/test-ack-no-record.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-ack-"));
const jotDir = path.join(tmp, "jot");
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(jotDir, { recursive: true });
fs.mkdirSync(path.join(metaHome, ".helm", "reviews"), { recursive: true });

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const now = Date.now();
fs.writeFileSync(
  path.join(jotDir, "todos.json"),
  JSON.stringify({
    categories: [{ id: "c1", name: "Helm" }],
    todos: [
      { id: A, text: "Marked done directly", status: "done", categoryId: "c1", priority: 0, parentId: null, completedAt: now - 1000 },
      { id: B, text: "Also marked done directly", status: "done", categoryId: "c1", priority: 1, parentId: null, completedAt: now - 2000 },
    ],
  }),
  "utf8"
);
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ jot: { enabled: true, path: path.join(jotDir, "todos.json") } }), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9376";

const titles = (res) => (res.doneWithoutRecord || []).map((t) => t.title);

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const before = await app.eval(`window.helm.listReviews()`);
  ok((before.doneWithoutRecord || []).length === 2, `both un-recorded done tasks are listed (${titles(before).length})`);

  const acked = await app.eval(`window.helm.acknowledgeNoRecord(${JSON.stringify(A)})`);
  ok(acked?.ok === true, "acknowledging succeeds");

  const after = await app.eval(`window.helm.listReviews()`);
  ok((after.doneWithoutRecord || []).length === 1, `the acknowledged one stops being listed (${titles(after).length} left)`);
  ok(titles(after)[0] === "Also marked done directly", `and the OTHER one is untouched (${titles(after)[0]})`);

  // It must not have created evidence. The task still has no record, so if it ever
  // came back to review it would read as unrecorded, not as reviewed.
  const recFile = path.join(metaHome, ".helm", "reviews", `${A}.json`);
  ok(!fs.existsSync(recFile), "acknowledging writes NO review record - it is not a substitute for evidence");
  const board = JSON.parse(fs.readFileSync(path.join(jotDir, "todos.json"), "utf8"));
  ok(board.todos.find((t) => t.id === A).status === "done", "the task itself is untouched on the board");
  ok(!/know|acknowledg/i.test(board.todos.find((t) => t.id === A).description || ""), "and nothing is written onto the task - this is a fact about what the captain read, not about the work");

  // Proof it is not just filtering by chance: put it back in review and it must read
  // as unrecorded, i.e. the acknowledgement did not vouch for anything.
  board.todos.find((t) => t.id === A).status = "review";
  fs.writeFileSync(path.join(jotDir, "todos.json"), JSON.stringify(board), "utf8");
  const back = await app.eval(`window.helm.listReviews()`);
  const row = (back.rows || []).find((r) => r.taskId === A);
  ok(row?.verdict === "unrecorded", `back in review it reads UNRECORDED despite being acknowledged (${row?.verdict})`);

  // Acknowledging survives a reload (it is in config, not memory).
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ok((cfg.acknowledgedNoRecord || []).includes(A), "the acknowledgement is persisted");
  ok(!(cfg.acknowledgedNoRecord || []).includes(B), "and only for the one acknowledged");

  const bad = await app.eval(`window.helm.acknowledgeNoRecord(null)`);
  ok(bad?.ok === false, "acknowledging with no task id is refused rather than writing junk");

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(fails === 0 ? "\nVERIFY OK: acknowledging stops the nagging without ever standing in for evidence." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
