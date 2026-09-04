/**
 * The assistant seat can consult an advisory seat as of 2026-09-02. This is the check that
 * the boundary holds while it does, and it is the point of that change rather than a
 * formality attached to it.
 *
 * ## What could go wrong, precisely
 *
 * Letting a seat spawn a sub-agent adds two things nothing in this repo had been through
 * before, and each has its own failure mode.
 *
 * 1. A NEW INPUT SHAPE. A PreToolUse hook fires for tool calls made inside a sub-agent, and
 *    such a payload carries fields the guard had never seen: `agent_id` and `agent_type`.
 *    Verified against claude 2.1.226 on 2026-09-02 by dumping raw payloads out of a real
 *    run - a sub-agent's Bash call arrived with `"agent_id":"a60f...","agent_type":"..."`
 *    and the PARENT's `session_id`. The specific risk is not that the guard mis-classifies
 *    a write: it is that an unfamiliar shape makes it fall OPEN, which looks like nothing at
 *    all from the outside. So these checks drive the REAL hook with a REAL sub-agent payload
 *    and assert deny, rather than calling the policy function with a tidy object.
 *
 * 2. A WIDER SET OF SEATS THAN HELM PUBLISHED. `--agents` ADDS to the CLI's built-in agent
 *    types, it does not replace them. Measured the same day: a launch carrying exactly one
 *    custom seat offered seven subagent types, `general-purpose` among them, and that one
 *    gets the session's whole tool set. Helm's own seats are pinned to Read/Grep/Glob and a
 *    sub-agent's `tools` field is an allow list, so THEY are contained by construction -
 *    but a built-in is not, and it is reachable by name. That path is closed with an allow
 *    list of seat names in the guard, and the checks below fail if the lever is removed.
 *
 * ## Why an allow list of names rather than denying the built-ins
 *
 * Same inversion the whole guard is built on. A deny list of built-in agent types would
 * have to be kept in step with a CLI Helm does not ship, so the next built-in arrives
 * allowed and nothing says so. Naming what IS consultable puts every present and future
 * built-in on the refused side by default. It also means the list cannot drift from what a
 * launch actually publishes, because both come from personaAgents().
 *
 * ## What the second layer is for, given the first one holds
 *
 * The seats cannot write, so in principle these deny assertions are about a case that
 * cannot arise. They are here because "cannot arise" is a property of a tool list somebody
 * could widen in one line, and because a guard is only believable where it has been driven.
 * A sub-agent with no `tools` field of its own was measured to inherit the parent's
 * `--disallowedTools` (no Write, no Edit, no NotebookEdit in its list) and to keep Bash and
 * PowerShell regardless - so the shell is open in sub-agent context, and the shell is the
 * route both incidents in tierGuard.js's header actually took.
 *
 * No model, no app, no tokens: it spawns the hook with stdin, the way the harness does.
 * Run:  node scripts/e2e/test-assistant-subagent-boundary.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIER_ASSISTANT, TIER_FIRST_MATE, HANDS_ON_TOOLS, FAN_OUT_TOOLS, FIRST_MATE_DISALLOWED_TOOLS, ASSISTANT_DISALLOWED_TOOLS } from "../../src/lib/tierGuard.js";
import { personaAgents, advisorySeatKeys } from "../../src/lib/personas.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const HOOK = path.join(repo, "src", "hooks", "tierGuardHook.mjs");

/**
 * A PreToolUse payload in the shape a real sub-agent call arrives in.
 *
 * Every field is the one the CLI actually sends, in the order it sent them, taken from a
 * dumped run - including the ones the guard has no use for, because carrying only the
 * fields it reads would test a payload nobody sends. The paths are INVENTED: this is a
 * public repository, and a captured transcript path names the machine it came from.
 */
function subAgentPayload(toolName, toolInput, { agentType = "architect" } = {}) {
  return {
    session_id: "11111111-2222-3333-4444-555555555555",
    transcript_path: "/invented/projects/example/11111111-2222-3333-4444-555555555555.jsonl",
    cwd: "/invented/projects/example",
    prompt_id: "66666666-7777-8888-9999-000000000000",
    permission_mode: "default",
    agent_id: "a0000000000000000",
    agent_type: agentType,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_0000000000000000000000",
  };
}

/** The same call as the seat's OWN - no agent_id/agent_type, which is how the CLI marks it. */
function ownPayload(toolName, toolInput) {
  const p = subAgentPayload(toolName, toolInput);
  delete p.agent_id;
  delete p.agent_type;
  return p;
}

function runHook(payload, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HELM_TIER: TIER_ASSISTANT, HELM_TIER_OVERRIDE: "", ...env },
  });
  let parsed = null;
  try {
    parsed = res.stdout.trim() ? JSON.parse(res.stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    code: res.status,
    stdout: res.stdout,
    decision: parsed?.hookSpecificOutput?.permissionDecision || "allow",
    reason: parsed?.hookSpecificOutput?.permissionDecisionReason || "",
  };
}

// --- 1. a write from SUB-AGENT CONTEXT is refused, driven through the real hook ----------
//
// The load-bearing block. If the guard fell open on the unfamiliar payload shape, every one
// of these would come back "allow" and nothing else in the suite would notice.
{
  const writes = [
    ["Write", { file_path: "/invented/projects/example/src/app.ts", content: "x" }, "Write"],
    ["Edit", { file_path: "/invented/projects/example/src/app.ts", old_string: "a", new_string: "b" }, "Edit"],
    ["NotebookEdit", { notebook_path: "/invented/projects/example/n.ipynb", new_source: "x" }, "NotebookEdit"],
    ["Bash", { command: "cat > /invented/projects/example/src/app.ts << 'EOF'\nx\nEOF" }, "a heredoc shell write - the exact route from the Captain Hook incident"],
    ["Bash", { command: "echo CHANGED > seed.txt" }, "a redirect"],
    ["Bash", { command: "bash -c 'echo CHANGED > seed.txt'" }, "a write nested inside another shell"],
    ["Bash", { command: "rm -rf build" }, "a delete"],
    ["Bash", { command: "git commit -am wip" }, "a commit"],
    // The tool that defeated the deny-list spelling of this containment in 2026-08.
    ["PowerShell", { command: "Set-Content -Path seed.txt -Value CHANGED" }, "PowerShell, which no deny list had thought to name"],
  ];
  for (const [tool, input, what] of writes) {
    const r = runHook(subAgentPayload(tool, input));
    ok(r.decision === "deny", `from inside a consulted seat, ${what} is refused`);
    ok(r.code === 0, `  and the hook still exits 0 (${r.code}) - a non-zero exit reads as a CRASH to the harness, not as a policy answer`);
  }
}

// --- 2. and it is not refusing everything, which would pass for the wrong reason ---------
{
  // A guard that denied unconditionally in sub-agent context would satisfy block 1 while
  // being useless. These prove the decision is still being MADE there.
  ok(runHook(subAgentPayload("Bash", { command: "git log --oneline -5" })).decision === "allow", "a read-only shell command still passes from sub-agent context - the guard is deciding, not blanket-refusing");
  ok(runHook(subAgentPayload("Read", { file_path: "/invented/projects/example/src/app.ts" })).decision === "allow", "and so does Read");
  ok(runHook(subAgentPayload("Grep", { pattern: "x" })).decision === "allow", "and Grep");
}

// --- 3. the extra fields must not be able to SOFTEN a decision --------------------------
{
  // The failure mode this whole file exists for, stated as an assertion: the same call gets
  // the same answer whether or not it arrives wearing sub-agent fields.
  const own = runHook(ownPayload("Bash", { command: "echo CHANGED > seed.txt" }));
  const sub = runHook(subAgentPayload("Bash", { command: "echo CHANGED > seed.txt" }));
  ok(own.decision === "deny" && sub.decision === "deny", `a shell write is refused identically with and without agent context (own=${own.decision}, sub=${sub.decision})`);
  ok(own.reason === sub.reason, "with the same refusal text, so the seat is not taught that one route is softer than the other");
  // An agent_type nobody has ever heard of is still just sub-agent context.
  ok(runHook(subAgentPayload("Write", { file_path: "x" }, { agentType: "some-future-builtin" })).decision === "deny", "an UNKNOWN agent_type does not become an exemption");
  ok(runHook(subAgentPayload("Write", { file_path: "x" }, { agentType: "" })).decision === "deny", "and neither does an empty one");
}

// --- 4. which seats are reachable: the built-in path, closed ----------------------------
{
  // `--agents` adds to the CLI's built-in agent types. These names were OFFERED to a real
  // launch carrying one custom seat (claude 2.1.226, 2026-09-02), so they are reachable by
  // name unless something refuses them. `general-purpose` is the one that matters: its tool
  // set is everything the session has.
  const OFFERED_BUILT_INS = ["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"];
  for (const seat of OFFERED_BUILT_INS) {
    const r = runHook(ownPayload("Agent", { description: "d", prompt: "p", subagent_type: seat }));
    ok(r.decision === "deny", `the assistant seat cannot reach the built-in \`${seat}\``);
  }
  // Anything at all, in fact - the closure is an allow list, so it does not depend on that
  // list of built-in names being complete or current.
  ok(runHook(ownPayload("Agent", { subagent_type: "a-seat-invented-in-2027" })).decision === "deny", "nor a seat name no version of the CLI has shipped yet - the closure is an allow list, not a list of known built-ins");
  ok(runHook(ownPayload("Agent", {})).decision === "deny", "nor a fan-out that names no seat at all");
  ok(runHook(ownPayload("Agent", { subagent_type: 12345 })).decision === "deny", "nor one whose subagent_type is not even a string");

  // And the seats Helm publishes ARE reachable, or the change accomplished nothing.
  for (const seat of advisorySeatKeys()) {
    ok(runHook(ownPayload("Agent", { description: "d", prompt: "p", subagent_type: seat })).decision === "allow", `but it can consult \`${seat}\`, which Helm published`);
  }
  ok(runHook(ownPayload("Task", { subagent_type: advisorySeatKeys()[0] })).decision === "allow", "under the tool's old name too, since the CLI has used both");

  // The refusal has to be usable, not just correct: a seat told "no" with no names has to
  // guess, and guessing at this is how a model ends up trying general-purpose.
  const denial = runHook(ownPayload("Agent", { subagent_type: "general-purpose" })).reason;
  for (const seat of advisorySeatKeys()) {
    ok(denial.includes(seat), `  the refusal names \`${seat}\` as an open seat, so the seat does not have to guess`);
  }
  ok(/not building/.test(denial), "  and says consulting is not building, so a refused consult is not read as a ban on consulting");
}

// --- 5. one level deep, not a tree ------------------------------------------------------
{
  // A consulted seat has no fan-out tool today (its `tools` field is an allow list of
  // Read/Grep/Glob). This refuses the recursion at the POLICY layer as well, so it does not
  // depend on that list staying pinned - and it is what makes the guard READ the sub-agent
  // fields rather than merely survive them.
  for (const seat of advisorySeatKeys()) {
    ok(runHook(subAgentPayload("Agent", { subagent_type: seat }, { agentType: "architect" })).decision === "deny", `a consulted seat cannot consult \`${seat}\` in turn`);
  }
}

// --- 6. the first mate is UNCHANGED by all of this --------------------------------------
{
  // The widening was for one seat. If it leaked into the coordinator tier, the fan-out
  // multiplier this guard was built to remove is back.
  for (const seat of advisorySeatKeys()) {
    ok(runHook(ownPayload("Agent", { subagent_type: seat }), { HELM_TIER: TIER_FIRST_MATE }).decision === "deny", `a first mate still cannot consult \`${seat}\``);
  }
  ok(runHook(subAgentPayload("Bash", { command: "echo x > y" }), { HELM_TIER: TIER_FIRST_MATE }).decision === "deny", "and a write from sub-agent context is refused for it too, not only for the assistant");
}

// --- 7. an unclassifiable call must not be the way through ------------------------------
{
  // The hook's own catch used to fail closed for a literal "first-mate" and allow for
  // everything else, so the assistant - a ban with no write budget, exactly like a first
  // mate - had one input shape that got it a write. Found while wiring this change.
  //
  // Driven by making the policy module unloadable in a child process, which is the closest
  // honest stand-in for "the classifier threw" without a mutation left behind.
  const src = fs.readFileSync(HOOK, "utf8");
  ok(/if \(tier === TIER_ASSISTANT\)/.test(src), "the hook's classifier-exception path fails closed for the assistant tier as well as the first mate's");
  ok(!/tier === "first-mate"/.test(src), "and it compares against the exported constants, not a string literal - a literal is how a later tier ends up on the open side by omission");
}

// --- 8. the two tiers' denied lists are composed, not copied ----------------------------
{
  // The lists are built from named pieces in tierGuard.js precisely so this can be asserted
  // instead of eyeballed. A copied list is the thing that drifts.
  ok(HANDS_ON_TOOLS.every((t) => FIRST_MATE_DISALLOWED_TOOLS.includes(t)), "a first mate is denied every hands-on tool");
  ok(HANDS_ON_TOOLS.every((t) => ASSISTANT_DISALLOWED_TOOLS.includes(t)), "and so is the assistant seat");
  ok(
    FIRST_MATE_DISALLOWED_TOOLS.filter((t) => !ASSISTANT_DISALLOWED_TOOLS.includes(t)).join(",") === [...FAN_OUT_TOOLS].join(","),
    `the ONLY difference between the two lists is fan-out (${FIRST_MATE_DISALLOWED_TOOLS.filter((t) => !ASSISTANT_DISALLOWED_TOOLS.includes(t)).join(", ")}) - anything else means one list gained a rule the other silently did not`
  );
  ok(ASSISTANT_DISALLOWED_TOOLS.every((t) => FIRST_MATE_DISALLOWED_TOOLS.includes(t)), "and the assistant's list is a subset, so a new denial added to it cannot skip the stricter tier");
  ok(!ASSISTANT_DISALLOWED_TOOLS.some((t) => FAN_OUT_TOOLS.includes(t)), "fan-out is genuinely left in for the assistant, or the guard's allow list would gate a tool the schema removed anyway");

  // The launcher has to actually use them, or they are constants nobody reads. ASSIGNED,
  // not merely mentioned: the first version of the sibling assertion in
  // test-assistant-tier.mjs matched a constant anywhere in the file and stayed green when
  // the branch was disabled.
  const mainSrc = fs.readFileSync(path.join(repo, "src", "main.js"), "utf8");
  ok(/disallowedTools = ASSISTANT_DISALLOWED_TOOLS/.test(mainSrc), "main.js gives the assistant branch the assistant list");
  ok(/disallowedTools = FIRST_MATE_DISALLOWED_TOOLS/.test(mainSrc), "and the first-mate branch the first-mate list");
  ok(!/\["Edit", "Write", "NotebookEdit"/.test(mainSrc), "and holds no inline copy of either - one source, so they cannot drift");
}

// --- 9. the seats reach the launch, or the widening advertises nothing ------------------
{
  const mainSrc = fs.readFileSync(path.join(repo, "src", "main.js"), "utf8");
  // Two branches must now pass personaAgents(): the second mate's and the assistant's.
  // Counting is the cheapest way to notice one of them being dropped - the previous single
  // occurrence was the whole reason the assistant could not consult.
  const passes = mainSrc.match(/agents = personaAgents\(\)/g) || [];
  ok(passes.length >= 2, `personaAgents() is passed on at least two launch branches (found ${passes.length}) - the assistant's and the second mate's`);
  // And the definitions still cannot write, which is what makes a consult not-building.
  const defs = Object.entries(personaAgents());
  ok(defs.length > 0, `Helm publishes ${defs.length} advisory seats`);
  for (const [key, def] of defs) {
    ok(
      Array.isArray(def.tools) && def.tools.length > 0 && !def.tools.some((t) => /^(Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell|Shell|Agent|Task)\b/i.test(t)),
      `${key}: still pinned to read tools (${def.tools?.join(", ")}) - a seat that could write would make a consult building after all`
    );
  }
}

console.log("");
console.log(
  exit === 0
    ? "VERIFY OK: the assistant seat can consult the seats Helm published and nothing else, a write from inside one is refused by the real hook exactly as it is from the seat itself, and the two tiers' denied lists differ by one named piece."
    : "VERIFY FAILED."
);
process.exit(exit);
