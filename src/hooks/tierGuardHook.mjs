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
//
// Contract with the harness: exit 0 always. An allow prints nothing; a deny prints
// the PreToolUse hookSpecificOutput object on stdout. A hook that crashes must not
// take the turn with it, so every failure path here allows - the guard is a fence,
// not a tripwire, and a broken fence should not stop the ship.

import fs from "node:fs";
import path from "node:path";
import { decideToolCall, turnCounterPath, SECOND_MATE_TURN_WRITE_BUDGET, TIER_SECOND_MATE } from "../lib/tierGuard.js";

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

let verdict;
try {
  verdict = decideToolCall({
    tier,
    tool: payload?.tool_name,
    input: payload?.tool_input || {},
    writesThisTurn,
    budget,
  });
} catch (err) {
  // FAIL CLOSED for the tier that has no write budget at all. The policy module fails closed
  // on syntax it cannot read; converting an exception here into a silent allow reversed that
  // doctrine one layer up, and nothing marked it (review, 2026-08-16). A second mate may
  // write anyway, so an allow there costs only an uncounted edit.
  process.stderr.write(`[helm-tier-guard] classifier threw: ${err?.message || err}
`);
  if (tier === "first-mate") {
    deny("HELM TIER GUARD: this call could not be classified, and a first mate does not write files. Hand the work to a second mate with helm_create_second_mate or helm_relay_to_second_mate.");
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
