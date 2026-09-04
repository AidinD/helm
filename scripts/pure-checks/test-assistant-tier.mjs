/**
 * The assistant seat's tier: the same refusal as a first mate, and a different sentence.
 *
 * ## Why it is a tier at all
 *
 * The policy is deliberately identical to TIER_FIRST_MATE - no file-writing tool, no
 * non-read-only shell - so a tier that only duplicates a decision looks like waste. The
 * reason it exists is the TEXT, and the text is load-bearing here.
 *
 * The first-mate refusal opens: "a first mate does not write files. Anywhere - not a
 * project's, not the meta-home's, not a skill or a note." For this seat the meta-home clause
 * is exactly wrong. The goals file and the daily log ARE meta-home files it is the sole
 * scribe of; it writes them through MCP surfaces built for the purpose. Handing it a refusal
 * that says it may not touch its own store teaches it to stop trying - and a guard that
 * misleads is the one that gets routed around, which this guard's own header names as its
 * failure mode.
 *
 * ## What the checks are actually for
 *
 * Two things, and the second matters more than it looks.
 *
 * That the POLICY did not drift from the first mate's while nobody was looking: these two
 * tiers must refuse the same WRITES, and a change to one that misses the other is the shape
 * of bug this repo keeps finding (one path per concept, or a mirror that is tested).
 *
 * They are allowed to differ on exactly one thing, decided 2026-09-02: the assistant seat
 * may consult a read-only advisory seat and a first mate may not. That difference is checked
 * as its own block below rather than excepted out of the mirror, because an excepted probe
 * stops meaning anything. What the guard does with a call from INSIDE a consulted seat, and
 * with the CLI's own built-in agent types, is test-assistant-subagent-boundary.mjs.
 *
 * And that the seat's write access comes ENTIRELY from which MCP servers its launch attaches,
 * never from this guard relaxing. That was the decision on 2026-09-02: a path-aware guard
 * would have allowed any write inside an allowed folder, including an invalid one - in one of
 * these stores a note carrying the wrong tag silently resets a cadence and turns an overdue
 * duty green, with no error anywhere. So the guard must keep refusing Write and Edit even for
 * a path inside the assistant's own folder, and the checks below say so with that exact path.
 *
 * Run: node scripts/e2e/test-assistant-tier.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideToolCall, TIER_ASSISTANT, TIER_FIRST_MATE } from "../../src/lib/tierGuard.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const asst = (tool, input = {}) => decideToolCall({ tier: TIER_ASSISTANT, tool, input });
const fm = (tool, input = {}) => decideToolCall({ tier: TIER_FIRST_MATE, tool, input });

// --- it does not build ------------------------------------------------------------------
{
  ok(asst("Write", { file_path: "src/app.ts" }).decision === "deny", "the assistant cannot write a project file");
  ok(asst("Edit", { file_path: "src/app.ts" }).decision === "deny", "nor edit one");
  ok(asst("Bash", { command: "cat > src/app.ts << 'EOF'\nx\nEOF" }).decision === "deny", "nor reach for a shell to do the same thing");
  ok(asst("Bash", { command: "npm install lodash" }).decision === "deny", "nor install anything");
  ok(asst("Task", {}).decision === "deny", "and a fan-out that names no seat at all is refused rather than defaulted");
}

// --- consulting, which is the one thing it may do that a first mate may not --------------
{
  // 2026-09-02. Consulting a read-only seat is not building: it reads and answers, and the
  // caller stays under exactly the rules it already had. The seat that holds the
  // conversations was the only seat structurally unable to reach the advisory seat built
  // for reading a conversation before answering it.
  //
  // The full boundary - what the guard does with a call made from INSIDE a seat, and with
  // the CLI's own built-in agent types - is scripts/e2e/test-assistant-subagent-boundary.mjs.
  ok(asst("Agent", { subagent_type: "architect" }).decision === "allow", "it can consult a published advisory seat");
  ok(asst("Task", { subagent_type: "red-team" }).decision === "allow", "under the tool's old name too, since the CLI has used both");
  ok(asst("Agent", { subagent_type: "general-purpose" }).decision === "deny", "but NOT a general-purpose worker - that one comes with the tools of doing the job");
  ok(asst("Agent", { subagent_type: "architect" }).isWrite === false, "and a consult does not count as a file change, because it is not one");
  // The first mate keeps the ban. It dispatches through helm_*, which is the only route the
  // Fleet can see; a coordinator with its own workers is the fan-out multiplier this guard
  // was built to remove.
  ok(fm("Agent", { subagent_type: "architect" }).decision === "deny", "a first mate still cannot consult at all - fan-out is denied to it outright");
}

// --- its own folder is NOT an exception, and that is the whole design -------------------
{
  // The tempting shortcut was a destination-aware guard: allow writes under the assistant's
  // roots. It was rejected because a path check cannot tell a valid write from one that
  // silently corrupts the store it lands in. If this ever starts passing, that decision has
  // been undone by accident.
  // An invented path, not a real one. The guard is destination-blind by design, so the
  // string only has to LOOK like the seat's own goals file for the check to mean something -
  // and a real local path in a public repository leaks the machine it was written on.
  const own = "C:/synced/notes/assistant/GOALS.md";
  ok(asst("Write", { file_path: own }).decision === "deny", "writing its OWN goals file with Write is still refused - the guard has no notion of an allowed folder");
  ok(asst("Edit", { file_path: own }).decision === "deny", "and so is editing it");
  ok(asst("Bash", { command: `echo hi >> "${own}"` }).decision === "deny", "and appending to it from a shell");
}

// --- what it must still be able to do --------------------------------------------------
{
  ok(asst("Read", { file_path: "anything" }).decision === "allow", "it reads anywhere - that is most of the job");
  ok(asst("Grep", {}).decision === "allow", "and greps");
  ok(asst("Bash", { command: "cat todos.json" }).decision === "allow", "and uses a read-only shell");
  ok(asst("Bash", { command: "git log --oneline -5" }).decision === "allow", "including git for reading");
  // The write access, and the only route to it.
  ok(asst("mcp__tend__tend_log_touch", {}).decision === "allow", "a store's MCP write passes - this is where its write access lives");
  ok(asst("mcp__tend__tend_journal", {}).decision === "allow", "including the journal");
  ok(asst("mcp__jot__jot_set_status", {}).decision === "allow", "and the task board's");
  ok(asst("mcp__assistant__assistant_append_log", {}).decision === "allow", "and its own log's");
  // THIS is the pair that caught a real collision. The check strips the server prefix and
  // looks at the bare tool name, so "append" and "creat" were refused while "touch" and
  // "set_status" passed - the line fell wherever a tool name happened to land. Renaming the
  // tools until they slipped past would have been routing around the guard; naming the
  // servers it has no opinion about is the honest fix. See GUARD_EXEMPT_SERVERS.
  ok(asst("mcp__jot__jot_create_todo", {}).decision === "allow", "a store tool whose NAME contains a write word still passes - the exemption is by server, not by wording");
  ok(asst("mcp__assistant__assistant_write_goals", {}).decision === "allow", "including one that says write outright");
  // And the exemption must stay narrow, or it is a hole rather than a decision.
  ok(asst("mcp__filesystem__write_file", {}).decision === "deny", "a generic filesystem MCP is still refused - the exemption names the stores, not MCP as a category");
  ok(asst("mcp__github__create_pull_request", {}).decision === "deny", "and so is anything that would publish");
  // Delegation, which is the only thing it may do about repository work.
  ok(asst("helm_create_second_mate", {}).decision === "allow", "and it can hand work to a session");
  ok(asst("helm_dispatch", {}).decision === "allow", "and dispatch");
}

// --- the sentence, which is the reason this tier exists --------------------------------
{
  const reason = asst("Write", { file_path: "x" }).reason || "";
  ok(/MCP tools built for writing/.test(reason), "the refusal points at the MCP tools rather than just saying no");
  ok(!/not the meta-home/.test(reason), "and does NOT tell it the meta-home is off limits - its own two files live there");
  ok(/draft it in your reply/.test(reason), "it says what to do with a note or a plan instead");
  ok(/hand it to a session WITH the context/.test(reason), "and what to do with repository work");
  ok(/do NOT simply refuse/.test(reason), "and refuses to let it answer with a bare refusal, same discipline as the other tiers");
  // The first mate's own sentence must be untouched by all this.
  const fmReason = fm("Write", { file_path: "x" }).reason || "";
  ok(/helm_create_second_mate/.test(fmReason), "the first mate still gets its own dispatch-shaped answer");
  ok(fmReason !== reason, "the two refusals are genuinely different text, not one shared paragraph");
}

// --- the mirror: the two policies must not drift apart -----------------------------------
{
  // A change to one tier that misses the other is the shape of bug this repo keeps finding.
  // Nothing enforces that they agree except this.
  //
  // They agree on WRITING, which is the whole of what these two tiers are for, and they are
  // now allowed to differ on exactly one thing: consulting an advisory seat, checked in its
  // own block above. So fan-out is deliberately absent from the probes below - listing it
  // here would either force the two tiers back together or have to be excepted, and an
  // excepted probe is a probe that stops meaning anything.
  const probes = [
    ["Write", { file_path: "a.ts" }],
    ["Edit", { file_path: "a.ts" }],
    ["MultiEdit", { file_path: "a.ts" }],
    ["NotebookEdit", {}],
    ["Read", {}],
    ["Grep", {}],
    ["Glob", {}],
    ["Bash", { command: "ls -la" }],
    ["Bash", { command: "git status" }],
    ["Bash", { command: "rm -rf build" }],
    ["Bash", { command: "npm run build" }],
    ["Bash", { command: "bash -c 'echo x > y'" }],
    ["mcp__tend__tend_people", {}],
    ["helm_dispatch", {}],
  ];
  const drifted = [];
  for (const [tool, input] of probes) {
    const a = asst(tool, input).decision;
    const f = fm(tool, input).decision;
    if (a !== f) {
      drifted.push(`${tool} ${JSON.stringify(input)}: assistant=${a}, first-mate=${f}`);
    }
  }
  for (const d of drifted) {
    console.log(`     ${d}`);
  }
  ok(drifted.length === 0, `the assistant and first-mate policies agree on all ${probes.length} probes - only the wording differs`);
}

// --- the tier reaches the launch, or it is a constant nobody uses -------------------------
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainSrc = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");
  // The guard's own header says a future tier must not be addable to the manual without also
  // reaching the guard. The inverse is just as true: a tier the launcher never sets is a
  // sentence nobody will ever read.
  // ASSIGNED, not merely mentioned. The first version of this assertion matched the constant
  // anywhere in the file, so disabling the launch branch left it green while the tier became
  // a sentence nobody would ever read - the exact "assertion that cannot fail" shape.
  ok(/launchTier = TIER_ASSISTANT/.test(mainSrc), "main.js ASSIGNS this tier on a launch, so the guard can actually see it");
}

console.log("");
console.log(
  exit === 0
    ? "VERIFY OK: the assistant refuses exactly what a first mate refuses, says something true about its own stores instead, and gets its write access from MCP rather than from the guard."
    : "VERIFY FAILED."
);
process.exit(exit);
