// Unit test (no app, no model): the auto-captain's pure brain - task selection
// from the board + triage-verdict parsing (task ea0546d1). The live Haiku triage,
// watch loop, and dispatch sit on top and are gated OFF by default; this covers
// the decision logic that must be right before anything fires.
//
// Run:  node scripts/e2e/test-auto-captain.mjs
import { selectAutoQueuedTasks, parseTriageVerdict } from "../../src/lib/autoCaptain.js";

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

// --- triage verdict parsing ---
ok(parseTriageVerdict('{"well_defined": true, "reason": "clear scope"}').dispatchable === true, "well_defined:true -> dispatchable");
ok(parseTriageVerdict('{"well_defined": false, "reason": "too vague"}').dispatchable === false, "well_defined:false -> not dispatchable");
const withProse = parseTriageVerdict('Here is my verdict:\n{"well_defined": false, "reason": "needs an acceptance criterion"} hope that helps');
ok(withProse.dispatchable === false && /acceptance criterion/.test(withProse.reason), "parses JSON embedded in prose + keeps the reason");
ok(parseTriageVerdict("").dispatchable === false, "empty output -> NOT dispatchable (never fires on no signal)");
ok(parseTriageVerdict("total garbage no json").dispatchable === false, "unparseable -> NOT dispatchable (left for review)");
ok(parseTriageVerdict('{"well_defined": true}').reason.length > 0, "a missing reason still yields a non-empty reason");

console.log(code === 0 ? "VERIFY OK: auto-captain selection + triage parsing behave as intended (safe defaults - never fires on ambiguity)." : "VERIFY FAILED.");
process.exit(code);
