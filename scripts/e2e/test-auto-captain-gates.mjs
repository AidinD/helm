// The auto-captain's SAFETY GATES, through the real app (task ea0546d1).
//
// This is the one feature in Helm that spends money and changes a repo without
// being asked each time, so the properties worth testing are the ones that stop it,
// not the ones that make it go:
//
//   1. OFF by default, and a tick while off does nothing at all.
//   2. The orchestration kill switch stops it even when it is on.
//   3. A task whose list has no folder is HELD BACK with a written reason on the
//      card - it never guesses where to run.
//   4. A held task is not re-judged until the card changes.
//   5. It never marks anything done.
//
// Every case here reaches a decision WITHOUT a model call or a spawned session, on
// purpose: a test that fires real work would cost money to run and would be a
// strange thing to leave in a suite. The live triage call and the dispatch itself
// are deliberately NOT covered - they are staged to run under the captain's eyes with
// "Run one pass", which is what the design doc asks for.
//
// Run: node scripts/e2e/test-auto-captain-gates.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-auto-"));
const jotPath = path.join(tmp, "todos.json");
const configPath = path.join(tmp, "config.json");
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

const AUTO_TAG_ID = "tag-auto";
const UNBOUND = "cat-unbound";
const board = () => ({
  categories: [{ id: UNBOUND, name: "Ideas" }],
  // All three of the auto-captain's tags, because that is the state of a real
  // board after the first launch: Helm seeds them at startup so the trigger tag
  // is pickable in Jot at all (test-auto-captain-tags.mjs covers the seeding).
  // Present here so the byte-for-byte checks below measure what THIS test is
  // about - the pass not acting - rather than the one-off seeding write.
  tags: [
    { id: AUTO_TAG_ID, name: "auto" },
    { id: "tag-needs-clarification", name: "needs-clarification" },
    { id: "tag-auto-running", name: "auto-running" },
  ],
  todos: [
    { id: "task-1", text: "Make it better somehow", description: "", status: "open", categoryId: UNBOUND, priority: 0, parentId: null, tags: [AUTO_TAG_ID] },
    { id: "task-2", text: "Not tagged, must be left alone", description: "", status: "open", categoryId: UNBOUND, priority: 1, parentId: null, tags: [] },
  ],
});
fs.writeFileSync(jotPath, JSON.stringify(board(), null, 2), "utf8");
fs.writeFileSync(configPath, JSON.stringify({ jot: { enabled: true, path: jotPath } }, null, 2), "utf8");

process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9387";

const readBoard = () => JSON.parse(fs.readFileSync(jotPath, "utf8"));
const task = (id) => readBoard().todos.find((t) => t.id === id);
const tagNames = (t) => {
  const tags = readBoard().tags;
  return (t.tags || []).map((id) => tags.find((x) => x.id === id)?.name).filter(Boolean);
};
const J = JSON.stringify;

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // ---- 1. off by default, and off means OFF -------------------------------
  const status0 = await app.eval(`window.helm.autoCaptainStatus()`);
  ok(status0?.enabled === false, `it is off out of the box (${status0?.enabled})`);
  ok(status0?.cap === 3, `and capped at three at once (${status0?.cap})`);

  const whileOff = await app.eval(`window.helm.runAutoCaptainNow()`);
  ok(/off/i.test(whileOff?.skipped || ""), `a pass while off does nothing and says so (${J(whileOff)})`);
  ok(J(readBoard()) === J(board()), "and the board is byte-for-byte untouched");

  // ---- 2. the kill switch outranks the toggle -----------------------------
  await app.eval(`window.helm.setAutoCaptainEnabled(true)`);
  const onNow = await app.eval(`window.helm.autoCaptainStatus()`);
  ok(onNow?.enabled === true, "it can be turned on");
  await app.eval(`window.helm.killOrchestration()`);
  const killed = await app.eval(`window.helm.runAutoCaptainNow()`);
  ok(/kill switch/i.test(killed?.skipped || ""), `the kill switch stops it even while on (${J(killed)})`);
  ok(J(readBoard()) === J(board()), "board still untouched");
  await app.eval(`window.helm.resumeOrchestration()`);

  // ---- 3. an unbound list is held back, with a reason ----------------------
  const ran = await app.eval(`window.helm.runAutoCaptainNow()`);
  ok(ran?.ok === true && ran.held === 1 && ran.acted === 0, `one task held back, none started (${J(ran)})`);

  const t1 = task("task-1");
  ok(tagNames(t1).includes("needs-clarification"), `the card is tagged needs-clarification (${J(tagNames(t1))})`);
  ok(t1.status === "open", `and left in open - it was not started (${t1.status})`);
  ok(/isn't bound to a folder/.test(t1.description), `the card SAYS why, on the card (${J((t1.description || "").slice(0, 90))})`);
  ok(/Set the list's folder in Jot/.test(t1.description), "and what to do about it");

  const t2 = task("task-2");
  ok((t2.tags || []).length === 0 && t2.status === "open" && !t2.description, "an untagged task on the same list is untouched");

  // Nothing was started, so nothing is running and nothing reached the fleet.
  const afterHold = await app.eval(`window.helm.autoCaptainStatus()`);
  ok((afterHold?.running || []).length === 0, `nothing is running (${J(afterHold?.running)})`);
  const bindings = fs.existsSync(process.env.HELM_SECOND_MATES_PATH)
    ? JSON.parse(fs.readFileSync(process.env.HELM_SECOND_MATES_PATH, "utf8"))
    : {};
  ok(Object.keys(bindings).length === 0, `no second mate was created (${J(Object.keys(bindings))})`);

  // ---- 4. it does not re-judge the same card ------------------------------
  const descAfterFirst = task("task-1").description;
  const second = await app.eval(`window.helm.runAutoCaptainNow()`);
  ok(second?.held === 0 && second?.acted === 0, `a second pass leaves it alone entirely (${J(second)})`);
  ok(task("task-1").description === descAfterFirst, "so the card does not collect a second identical note");

  // Editing the card makes it eligible again - otherwise a fixed task would be
  // stuck forever, which is a worse failure than an extra note.
  const edited = readBoard();
  edited.todos.find((t) => t.id === "task-1").description += "\n\nNow with an acceptance criterion.";
  fs.writeFileSync(jotPath, JSON.stringify(edited, null, 2), "utf8");
  const third = await app.eval(`window.helm.runAutoCaptainNow()`);
  ok(third?.held === 1, `editing the card makes it eligible again (${J(third)})`);

  // ---- 5. it never marks anything done ------------------------------------
  const statuses = readBoard().todos.map((t) => t.status);
  ok(!statuses.includes("done"), `nothing was marked done (${J(statuses)})`);

  // ---- and the switch is reachable from the widget ------------------------
  const ui = await app.eval(`(() => {
    const host = document.createElement("div");
    host.append(widgetBodyAuto({ secondMates: [] }));
    const btns = [...host.querySelectorAll("button")].map(b => b.textContent);
    return { btns, text: host.textContent };
  })()`);
  ok(ui.btns.includes("Run one pass"), `the widget offers a single supervised pass (${J(ui.btns)})`);
  ok(ui.btns.some((b) => b === "On" || b === "Off"), "and its own on/off switch");

  // ---- reachable without the widget dashboard -----------------------------
  // The Auto widget only exists on the widget dashboard, which the captain has off - so
  // without a command-palette entry the whole feature would be unreachable for him.
  const palette = await app.eval(`(() => {
    const cmds = typeof cmdkBuildCommands === "function" ? cmdkBuildCommands() : null;
    if (!cmds) { return null; }
    return cmds.filter(c => c.tag === "Auto").map(c => c.label);
  })()`);
  if (palette === null) {
    console.log("SKIP - command list builder not exposed under this name");
  } else {
    ok(palette.length === 2, `the command palette carries the auto-captain (${J(palette)})`);
    ok(palette.some((l) => /run one pass/i.test(l)), "including a single supervised pass");
    ok(palette.some((l) => /turn on|turn OFF/.test(l)), "and the switch");
  }

  await app.eval(`window.helm.setAutoCaptainEnabled(false)`);
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
console.log(
  fails === 0
    ? "\nVERIFY OK: the auto-captain stays off, obeys the kill switch, never guesses a project, and says on the card why it held back."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
