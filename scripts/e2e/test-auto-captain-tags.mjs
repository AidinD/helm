// The auto-captain's trigger tag has to EXIST, or the feature is unreachable.
//
// Aidin, 2026-08-02, reviewing the finished auto-captain: "det finns ingen auto
// tag". He was right. `auto` is the one tag the USER applies - it is the entire
// entry point - and nothing in Helm or Jot ever created it, so there was nothing
// to pick from Jot's tag list. Every gate, cap and kill switch was tested; the
// door was locked.
//
// The two tags Helm writes back would have appeared on demand, but bare: no
// colour and no description, next to six hand-made tags that have both. The
// descriptions are also the only place in Jot that says what tagging a card does.
//
// Run: node scripts/e2e/test-auto-captain-tags.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTagsExist, readJotState } from "../../src/lib/jot.js";
import { AUTO_CAPTAIN_TAGS, AUTO_TAG, tagIdByName } from "../../src/lib/autoCaptain.js";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};
const J = JSON.stringify;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-autotags-"));
const board = path.join(tmp, "todos.json");
const write = (o) => fs.writeFileSync(board, JSON.stringify(o, null, 2), "utf8");
const read = () => JSON.parse(fs.readFileSync(board, "utf8"));

try {
  // A board shaped like his: real tags, none of ours.
  write({
    todos: [{ id: "t1", title: "a task", status: "open", tags: [] }],
    categories: [],
    tags: [{ id: "tag-urgent", name: "Urgent", color: "#ff8c42", description: "Needs attention soon" }],
  });

  const first = ensureTagsExist({ path: board }, AUTO_CAPTAIN_TAGS);
  ok(first.ok === true, `seeding runs (${J(first.error || "ok")})`);
  ok(first.added.length === 3, `all three tags are added (${J(first.added)})`);

  const after = read();
  const auto = after.tags.find((t) => t.name === AUTO_TAG);
  ok(!!auto, "the TRIGGER tag exists - this is the whole point");
  ok(!!auto.id && !!auto.color, `and carries an id and a colour like a hand-made tag (${J(auto)})`);
  ok(
    /only ever STARTS/i.test(auto.description || ""),
    "its description says what tagging a card actually does - it is the only documentation in Jot"
  );
  ok(
    after.tags.some((t) => t.name === "Urgent" && t.color === "#ff8c42"),
    "his own tags are untouched"
  );

  // Jot's whole-row stripe (TagEmphasis). Only for the two ACTIVE states - a
  // stripe on every card that MAY be started would mean nothing.
  const byName = (n) => after.tags.find((t) => t.name === n);
  ok(byName("auto-running").emphasis === "stripe", "auto-running marks the whole card - a machine is working on it now");
  ok(byName("needs-clarification").emphasis === "stripe", "so does needs-clarification - it is waiting on him");
  ok(
    byName(AUTO_TAG).emphasis === null,
    `but plain "auto" does not: eligible is not an active state (${J(byName(AUTO_TAG).emphasis)})`
  );

  // Turning the stripe off in Jot must STICK. Re-asserting it every launch is
  // the can-create-but-cannot-reverse shape we keep getting wrong.
  const off = read();
  off.tags.find((t) => t.name === "auto-running").emphasis = null;
  write(off);
  ensureTagsExist({ path: board }, AUTO_CAPTAIN_TAGS);
  ok(
    read().tags.find((t) => t.name === "auto-running").emphasis === null,
    "a stripe switched off by hand is not switched back on at the next launch"
  );
  ok(
    !!tagIdByName(readJotState({ path: board }).tags, "AUTO"),
    "and the auto-captain's own lookup finds it, case-insensitively - the two agree"
  );

  // --- idempotent, and does not touch the file when there is nothing to do ---
  const bytesBefore = fs.readFileSync(board);
  const mtimeBefore = fs.statSync(board).mtimeMs;
  const second = ensureTagsExist({ path: board }, AUTO_CAPTAIN_TAGS);
  ok(second.added.length === 0, `a second run adds nothing (${J(second.added)})`);
  ok(read().tags.length === after.tags.length, "no duplicates");
  ok(
    fs.readFileSync(board).equals(bytesBefore) && fs.statSync(board).mtimeMs === mtimeBefore,
    "and the file is not rewritten at all - this runs every startup, against a file Jot may have open"
  );

  // A tag he renamed the colour of must survive, not be reset every launch.
  const recoloured = read();
  recoloured.tags.find((t) => t.name === AUTO_TAG).color = "#123456";
  write(recoloured);
  ensureTagsExist({ path: board }, AUTO_CAPTAIN_TAGS);
  ok(
    read().tags.find((t) => t.name === AUTO_TAG).color === "#123456",
    "a colour he changed himself is left alone"
  );

  // --- it must not invent a board -----------------------------------------
  const missing = ensureTagsExist({ path: path.join(tmp, "nope.json") }, AUTO_CAPTAIN_TAGS);
  ok(missing.ok === false && missing.added.length === 0, `no board -> no write, no crash (${J(missing)})`);
  ok(
    !fs.existsSync(path.join(tmp, "nope.json")),
    "and it does NOT create a board file - Jot owns that, Helm only ever edits one that exists"
  );

  const disabled = ensureTagsExist({ enabled: false, path: board }, AUTO_CAPTAIN_TAGS);
  ok(disabled.ok === true && disabled.added.length === 0, "with Jot switched off in Helm it does nothing");
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  fails === 0
    ? "\nVERIFY OK: the auto tag exists on the board, described, once, without rewriting the file."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
