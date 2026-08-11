// Unit test: parseLiveSubAgents detects in-flight sub-agents (tool_use with no
// matching tool_result) from a transcript. Covers both tool names: "Agent" is
// the current CLI name; "Task" was the old one and stayed unmatched in the
// wild for a while after the rename, which is exactly the bug this guards.
//
// Run:  node scripts/e2e/test-sub-agents.mjs
import { parseLiveSubAgents } from "../../src/lib/subAgents.js";

function log(...a) {
  console.log("[sub-agents-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const line = (obj) => JSON.stringify(obj);
const transcript = [
  line({ type: "user", message: { role: "user", content: "go" } }),
  // two sub-agents launched
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: { description: "review dashboard", subagent_type: "general-purpose" } }] } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Task", input: { description: "audit css" } }] } }),
  // a non-Task tool_use (should be ignored)
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] } }),
  // t1 completed, t2 still running
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } }),
].join("\n");

const live = parseLiveSubAgents(transcript);
assert(live.length === 1, "only the still-running Task sub-agent is live (got " + live.length + ")");
assert(live[0].id === "t2" && live[0].description === "audit css", "the live one is t2 'audit css'");
assert(!live.some((s) => s.id === "b1"), "a non-Task tool_use is not counted as a sub-agent");
assert(!live.some((s) => s.id === "t1"), "a completed Task (has tool_result) is not live");

// none running
const allDone = [
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "x1", name: "Task", input: { description: "d" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x1" }] } }),
].join("\n");
assert(parseLiveSubAgents(allDone).length === 0, "all-completed -> no live sub-agents");
assert(parseLiveSubAgents("").length === 0 && parseLiveSubAgents("garbage\n{bad").length === 0, "empty/garbage transcript -> [] (tolerant)");

// The current CLI tool name ("Agent"), not the old "Task" - a real skiff
// transcript logs its Agent-tool dispatch this way, and a scan that only
// matched "Task" found it invisible (the bug this test was added to catch).
const agentNamed = [
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Review test coverage", subagent_type: "Explore" } }] } }),
].join("\n");
const agentLive = parseLiveSubAgents(agentNamed);
assert(agentLive.length === 1 && agentLive[0].id === "a1", "an 'Agent'-named tool_use (current CLI name) is detected as a live sub-agent");

log(exitCode === 0 ? "VERIFY OK: live sub-agent detection from transcript." : "VERIFY FAILED.");
process.exit(exitCode);
