#!/usr/bin/env node
// PreToolUse hook: the transport for src/lib/tierGuard.js.
//
// The policy lives in the library so it can be tested without a model, a session or
// a harness. This file does three things and no thinking: read the payload, ask the
// library, print the answer.
//
// Wired by main.js through --settings on EVERY launch. That is the point of using a
// hook rather than a manual: --append-system-prompt only reaches a FRESH session, so
// a running first mate kept whatever rules it booted with and a rule change did not
// take effect until the captain retired it. A hook is re-applied per launch, and
// every turn - including a --resume - is a launch. Verified against the real CLI on
// 2026-08-14: the same session that had happily written a file through `cat >` was
// refused on its next turn once the hook was attached.
//
// Environment (set by main.js when it builds the settings JSON):
//   HELM_TIER          the tier this session runs as
//   HELM_TIER_SESSION  session id, for the per-turn counter
//   HELM_META_HOME     where the counter lives
//   HELM_TIER_BUDGET   optional override of the second mate's per-turn write budget
//   HELM_TIER_OVERRIDE "1" switches the guard off entirely - see below
//
// Contract with the harness: exit 0 always. An allow prints nothing; a deny prints
// the PreToolUse hookSpecificOutput object on stdout. A hook that crashes must not
// take the turn with it, so every failure path here allows - the guard is a fence,
// not a tripwire, and a broken fence should not stop the ship.

import fs from "node:fs";
import path from "node:path";
import { decideToolCall, turnCounterPath, SECOND_MATE_TURN_WRITE_BUDGET, TIER_SECOND_MATE, TIER_FIRST_MATE, TIER_ASSISTANT } from "../lib/tierGuard.js";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readStdin() || "{}");
} catch {
  allow();
}

const tier = process.env.HELM_TIER || "";
if (!tier) {
  allow();
}

/*
 * The escape hatch, and why it is shaped like this.
 *
 * The policy is a positive list, which GUARANTEES false blocks - nine were measured and
 * fixed before it shipped, and the next one turns up in the middle of real work. Until
 * now the only way past one was to edit the source and restart. A guard with no way out
 * is a guard that gets deleted at the first irritation, and then everything built around
 * it was built for nothing.
 *
 * Read from the ENVIRONMENT, never from config or any other file. That is the whole
 * security property: main.js copies this in from HELM'S OWN process env when it builds a
 * launch, so switching it on means setting a variable and restarting Helm. A session
 * cannot reach it. An agent that can write files - which is most of them - could edit a
 * config value, and a guard a supervised agent can switch off is decoration.
 *
 * Exactly "1", not any truthy string: an empty or stray value must read as off.
 *
 * It expires by itself. A process env var lives as long as the Helm that was started with
 * it, so a hatch opened for one afternoon closes when Helm next restarts - unless it was
 * deliberately put in a shell profile, which is a different and equally deliberate act.
 *
 * And it is never silent. A guard that is off without saying so is worse than no guard,
 * because everything downstream still reads as supervised.
 */
if (process.env.HELM_TIER_OVERRIDE === "1") {
  process.stderr.write(
    `[helm-tier-guard] OVERRIDDEN - HELM_TIER_OVERRIDE is set, so this ${tier} call is NOT being checked. ` +
      "The guard is off for every session of this Helm until it restarts.\n"
  );
  allow();
}

const sessionId = process.env.HELM_TIER_SESSION || payload?.session_id || "";
const metaHome = process.env.HELM_META_HOME || "";
const budget = Number(process.env.HELM_TIER_BUDGET) || SECOND_MATE_TURN_WRITE_BUDGET;

// The counter is only consulted for the tier that has a budget. A first mate's
// answer does not depend on history, so it must not depend on a file being readable
// either - that would make the strictest tier the most fragile one.
let writesThisTurn = 0;
const counterFile = tier === TIER_SECOND_MATE && metaHome && sessionId ? turnCounterPath(metaHome, sessionId) : null;
if (counterFile) {
  try {
    writesThisTurn = JSON.parse(fs.readFileSync(counterFile, "utf8"))?.writes || 0;
  } catch {
    writesThisTurn = 0;
  }
}

/*
 * SUB-AGENT CONTEXT, and why this hook reads it at all.
 *
 * A PreToolUse hook fires for tool calls made INSIDE a sub-agent, not only for the
 * session's own - verified against claude 2.1.226 on 2026-09-02 by dumping raw payloads
 * from a real run. A call from a sub-agent carries two extra fields, `agent_id` and
 * `agent_type`; `session_id` stays the PARENT's, which is what lets the second mate's
 * per-turn counter keep working unchanged.
 *
 * That is the whole reason the assistant seat is allowed to consult a seat at all: the
 * guard can still see, and still refuse, a write attempted from inside one. Extra fields
 * in a payload must therefore never soften a decision, and the policy module is written
 * so they cannot - it reads the tier, the tool and the input, and this one named field.
 */
const agentType = typeof payload?.agent_type === "string" ? payload.agent_type : "";

let verdict;
try {
  verdict = decideToolCall({
    tier,
    tool: payload?.tool_name,
    input: payload?.tool_input || {},
    writesThisTurn,
    budget,
    agentType,
  });
} catch (err) {
  // FAIL CLOSED for every tier that has no write budget at all. The policy module fails
  // closed on syntax it cannot read; converting an exception here into a silent allow
  // reversed that doctrine one layer up, and nothing marked it (review, 2026-08-16). A
  // second mate may write anyway, so an allow there costs only an uncounted edit.
  //
  // The ASSISTANT was missing from this list until 2026-09-02, found while giving that seat
  // sub-agents. Its policy is a ban with no budget, exactly like a first mate's, so a
  // classifier exception was the one input shape that got it a write - and it was written as
  // a literal "first-mate" rather than the exported constant, which is how a tier added
  // later ended up on the open side by omission. Named constants now, so the next tier fails
  // to compile rather than failing open.
  process.stderr.write(`[helm-tier-guard] classifier threw: ${err?.message || err}
`);
  if (tier === TIER_FIRST_MATE) {
    deny("HELM TIER GUARD: this call could not be classified, and a first mate does not write files. Hand the work to a second mate with helm_create_second_mate or helm_relay_to_second_mate.");
  }
  if (tier === TIER_ASSISTANT) {
    deny(
      "HELM TIER GUARD: this call could not be classified, and the assistant seat does not write files with a tool or a shell. Your stores have their own MCP tools for writing; repository work goes to a session that owns the tree, with the context."
    );
  }
  allow();
}

if (verdict.decision === "deny") {
  deny(verdict.reason);
}

// An ALLOWED write still counts. Counting only denials would make the budget
// unreachable: every call would see zero and the third, tenth and hundredth write
// would all be the first one.
if (verdict.isWrite && counterFile) {
  try {
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, JSON.stringify({ writes: writesThisTurn + 1, at: Date.now() }), "utf8");
  } catch {
    // A counter that cannot be written means the budget silently stops binding.
    // That is the safe direction for a supervisor tier (it keeps working), and it is
    // logged rather than hidden so a broken counter is findable.
    process.stderr.write("[helm-tier-guard] could not update the turn counter; the second-mate budget is not binding this turn\n");
  }
}

allow();
