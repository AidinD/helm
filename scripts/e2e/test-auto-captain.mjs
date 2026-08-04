// Unit test (no app, no model): the auto-captain's pure brain - task selection
// from the board + triage-verdict parsing (task ea0546d1). The live Haiku triage,
// watch loop, and dispatch sit on top and are gated OFF by default; this covers
// the decision logic that must be right before anything fires.
//
// Run:  node scripts/e2e/test-auto-captain.mjs
import {
  selectAutoQueuedTasks,
  resolveTaskProject,
  taskFingerprint,
  planAutoTick,
  clarificationNote,
  buildTriageInput,
  AUTO_WIDTH_CAP,
} from "../../src/lib/autoCaptain.js";
import fs from "node:fs";

let code = 0;
const ok = (c, m) => { console.log(`${c ? "OK  " : "FAIL"} - ${m}`); if (!c) code = 1; };

// --- selection ---
const tags = [
  { id: "t-auto", name: "auto" },
  { id: "t-other", name: "Blocked" },
];
const todo = (id, over = {}) => ({ id, text: id, status: "open", tags: [], priority: 0, parentId: null, ...over });
const state = {
  tags,
  todos: [
    todo("a", { tags: ["t-auto"], priority: 5 }),
    todo("b", { tags: ["t-auto"], priority: 1 }), // more urgent
    todo("c", { tags: ["t-other"] }), // not auto-tagged
    todo("d", { tags: ["t-auto"], status: "in-progress" }), // already running
    todo("e", { tags: ["t-auto"], parentId: "a" }), // subtask
    todo("f", { tags: ["t-auto"] }), // handled already
  ],
};

const sel = selectAutoQueuedTasks(state, { handledIds: new Set(["f"]) });
ok(sel.map((t) => t.id).join(",") === "b,a", `selects only open, auto-tagged, non-subtask, unhandled - urgent first (got ${sel.map((t) => t.id).join(",")})`);
ok(selectAutoQueuedTasks({ tags: [], todos: state.todos }).length === 0, "no 'auto' tag defined -> nothing selected");
ok(selectAutoQueuedTasks({ tags, todos: [] }).length === 0, "empty board -> nothing selected");
// case-insensitive tag name
ok(selectAutoQueuedTasks({ tags: [{ id: "x", name: "AUTO" }], todos: [todo("z", { tags: ["x"] })] }).length === 1, "the 'auto' tag match is case-insensitive");

// The triage-verdict parsing block that lived here tested parseTriageVerdict, which an
// independent review found was never called by any production path (2026-08-04). Ten assertions,
// including three arguing that renaming the answer field could not make the lane more restrictive,
// all guarding a function no user code reached. Both the function and the assertions are gone; the
// parity that actually protects that rename is asserted in test-auto-triage-schema-parity.mjs.

// --- WHERE does the work run? -------------------------------------------------
// Guessing a project from a list NAME would occasionally start real work in the
// wrong repo, which is far worse than not starting it. Only an explicit folder
// binding counts.
const cats = [
  { id: "c-bound", name: "Helm", repoPath: "D:/Repo/Tools/helm" },
  { id: "c-loose", name: "Ideas" },
  { id: "c-blank", name: "Blank", repoPath: "   " },
];
ok(resolveTaskProject({ categoryId: "c-bound" }, cats).projectPath === "D:/Repo/Tools/helm", "a list bound to a folder resolves to it");
const loose = resolveTaskProject({ categoryId: "c-loose" }, cats);
ok(loose.ok === false && /isn't bound to a folder/.test(loose.reason), `an unbound list is refused, with a fixable reason (${loose.reason})`);
ok(/Set the list's folder in Jot/.test(loose.reason), "and the reason says exactly what to do about it");
ok(resolveTaskProject({ categoryId: "c-blank" }, cats).ok === false, "a whitespace-only folder counts as unbound, not as a path");
ok(resolveTaskProject({ categoryId: "nope" }, cats).ok === false, "a task in no list is refused rather than guessed at");

// --- don't re-judge the same words forever ------------------------------------
const t1 = { id: "x", text: "Do the thing", description: "a", categoryId: "c-bound" };
ok(taskFingerprint(t1) === taskFingerprint({ ...t1 }), "the fingerprint is stable for unchanged wording");
ok(taskFingerprint(t1) !== taskFingerprint({ ...t1, description: "a b" }), "editing the description changes it - so it gets re-judged");
ok(taskFingerprint(t1) !== taskFingerprint({ ...t1, text: "Do the other thing" }), "and so does editing the title");

// --- one tick's decision ------------------------------------------------------
const tickState = {
  tags: [{ id: "t-auto", name: "auto" }],
  categories: cats,
  todos: [
    { id: "p0", text: "urgent", status: "open", tags: ["t-auto"], priority: 0, parentId: null, categoryId: "c-bound" },
    { id: "p1", text: "next", status: "open", tags: ["t-auto"], priority: 1, parentId: null, categoryId: "c-bound" },
    { id: "p2", text: "later", status: "open", tags: ["t-auto"], priority: 2, parentId: null, categoryId: "c-bound" },
    { id: "p3", text: "last", status: "open", tags: ["t-auto"], priority: 3, parentId: null, categoryId: "c-bound" },
  ],
};
const plain = planAutoTick(tickState);
ok(plain.act.length === AUTO_WIDTH_CAP, `the cap holds: ${AUTO_WIDTH_CAP} at once, not all four (acting on ${plain.act.length})`);
ok(plain.act.map((t) => t.id).join(",") === "p0,p1,p2", `and the most urgent go first (${plain.act.map((t) => t.id).join(",")})`);
ok(plain.skipped.length === 1 && /waiting/.test(plain.skipped[0].reason), "the rest are recorded as waiting, not dropped");

const busy = planAutoTick(tickState, { running: AUTO_WIDTH_CAP });
ok(busy.act.length === 0, "with the cap already full, nothing new starts");

const oneFree = planAutoTick(tickState, { running: AUTO_WIDTH_CAP - 1 });
ok(oneFree.act.length === 1 && oneFree.act[0].id === "p0", "one free slot starts exactly one, the most urgent");

const held = planAutoTick(tickState, {
  triaged: { p0: taskFingerprint(tickState.todos[0]) },
});
ok(!held.act.some((t) => t.id === "p0"), "a task already judged unclear is not judged again");
ok(held.skipped.some((s) => s.todo.id === "p0" && /unchanged/.test(s.reason)), "and the reason says why it was skipped");

const edited = planAutoTick(
  { ...tickState, todos: [{ ...tickState.todos[0], description: "now with detail" }, ...tickState.todos.slice(1)] },
  { triaged: { p0: taskFingerprint(tickState.todos[0]) } }
);
ok(edited.act.some((t) => t.id === "p0"), "editing the task makes it eligible again - the whole point of the fingerprint");

// --- what the board is told ---------------------------------------------------
const note = clarificationNote("No acceptance criterion.", new Date("2026-08-02T10:00:00Z"));
ok(/2026-08-02/.test(note) && /No acceptance criterion\./.test(note), `the note is dated and carries the reason (${JSON.stringify(note)})`);
ok(/picked up again/.test(note), "and tells the user what happens after they fix it");

const input = buildTriageInput({ text: "Fix the thing", description: "d".repeat(9000) }, { name: "Helm" });
ok(/List: Helm/.test(input) && /Fix the thing/.test(input), "the triage sees the list and the title");
ok(input.length < 5000, `an enormous description is truncated rather than sent whole (${input.length} chars)`);

// --- a started run has to END somewhere -----------------------------------
// the captain, on his first real auto start: "varför hamnade den inte i review när den
// var klar?" It didn't, and nothing was ever going to move it: the card stayed in
// in-progress wearing auto-running forever.
//
// Worse, and invisible: `autoRuns` was only ever added to. Nothing removed an
// entry, so after three starts the cap was permanently full and no card could be
// started again until Helm restarted. A concurrency cap that only counts up is
// not a cap, it is a countdown to a silent stop.
//
// Checked against the SHIPPED source: the wiring is in main.js's IPC layer, which
// this file cannot import, and a comment claiming it is wired is not the wiring.
// CODE only. Matching raw source would pass on a commented-out line: verified by
// mutation - commenting out `autoRuns.delete(taskId)` left every check green,
// because the call was still there as text. That is the atomicWrite guard's old
// bug exactly, and the reason these checks strip comments before asserting.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const mainSrc = stripComments(fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8"));
const finish = mainSrc.slice(mainSrc.indexOf("function finishAutoRun"));
const finishBody = finish.slice(0, finish.indexOf("\n}\n") + 2);
ok(finishBody.length > 0 && finishBody.startsWith("function finishAutoRun"), "a finished run has a handler at all");
ok(/autoRuns\.delete\(/.test(finishBody), "it frees the slot, so the cap can never fill permanently");
ok(/status:\s*"review"/.test(finishBody), "it moves the card to REVIEW - the one thing you have to do is now on the board");
ok(!/status:\s*"done"/.test(finishBody), "and never to done: that stays a joint decision");
ok(/remove:\s*\[AUTO_RUNNING_TAG\]/.test(finishBody), "the running tag comes off - a card claiming work is in flight when nothing runs is worse than an untagged one");
ok(/note:/.test(finishBody), "and it says on the card what happened and where the work is");

// The handler is worthless if the dispatch never asks for it. An auto task is
// dispatched as an AUTOPILOT RUN under the project's second mate (the captain's shape:
// "en 2nd mate för det projektet och sedan autopilots under den för tasken"), so
// the finish hook hangs off the run's completion, not off a relay turn.
ok(/finishAutoRun\(todo\.id, result, meta\)/.test(mainSrc), "the run's completion calls the finish handler");
ok(/dispatchedBy: smId/.test(mainSrc), "the run is dispatched UNDER the project's second mate, so it appears beneath it");
ok(
  /const smId = secondMateId\("direct", where\.projectPath\)/.test(mainSrc),
  "and that second mate is per PROJECT - one row per repo, with its runs underneath"
);
// Anchored on the auto tick's own body. `mainSrc` has comments stripped (a source
// check that matches a comment proves nothing), so the marker has to be code.
const tick = mainSrc.slice(mainSrc.indexOf("const smId = secondMateId(\"direct\", where.projectPath)"));
const tickBody = tick.slice(0, 4000);
ok(/startGoalRun\(\{/.test(tickBody), "it goes through the same autopilot path a first mate's dispatch uses");
ok(/writeReport\(metaHome, report\)/.test(tickBody), "and writes a report, so jumping into the second mate can tell you what happened");
ok(/maxIterations: AUTO_RUN_MAX_ITERATIONS/.test(tickBody), "with a bounded number of iterations, not an open-ended run");

console.log(code === 0 ? "VERIFY OK: auto-captain selection, project resolution, capping and re-triage guards behave as intended (safe defaults - never fires on ambiguity)." : "VERIFY FAILED.");
process.exit(code);
