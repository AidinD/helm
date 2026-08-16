// The tier guard's TRANSPORT: src/hooks/tierGuardHook.mjs, run as the harness runs it.
//
// test-tier-guard.mjs covers the policy. This covers everything between the policy and
// the CLI, which is where a guard usually fails in practice rather than in principle:
// the payload shape, the deny envelope the harness actually reads, the exit code, and
// the per-turn counter that makes the second mate's budget a BUDGET rather than a
// lifetime allowance.
//
// It spawns the real hook file with real stdin. No model, no app, no tokens.
// Run:  node scripts/e2e/test-tier-guard-hook.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { turnCounterPath, SECOND_MATE_TURN_WRITE_BUDGET } from "../../src/lib/tierGuard.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, "..", "..", "src", "hooks", "tierGuardHook.mjs");
const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-tierhook-"));
const SESSION = "session-under-test";

function runHook(payload, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HELM_META_HOME: metaHome, HELM_TIER_SESSION: SESSION, ...env },
  });
  let parsed = null;
  try {
    parsed = res.stdout.trim() ? JSON.parse(res.stdout) : null;
  } catch {
    parsed = null;
  }
  return { code: res.status, stdout: res.stdout, decision: parsed?.hookSpecificOutput?.permissionDecision || "allow", reason: parsed?.hookSpecificOutput?.permissionDecisionReason || "" };
}

const WRITE = { tool_name: "Bash", tool_input: { command: "cat > x.md << 'EOF'\nhi\nEOF" }, session_id: SESSION };
const READ = { tool_name: "Bash", tool_input: { command: "git log --oneline -5" }, session_id: SESSION };

// --- 1. the envelope the harness reads ---------------------------------------
const denied = runHook(WRITE, { HELM_TIER: "first-mate" });
ok(denied.decision === "deny", "a first mate's shell write comes back as a deny decision");
ok(denied.code === 0, `and the hook still exits 0 (${denied.code}) - a non-zero exit is a hook CRASH to the harness, not a policy answer`);
ok(/helm_create_second_mate/.test(denied.reason), "the reason names the tool to reach for instead, so the refusal is a direction rather than a wall");
ok(/create: true/.test(denied.reason), "and tells it how to delegate work that has no project yet - the case that cornered Captain Haddock");

const allowed = runHook(READ, { HELM_TIER: "first-mate" });
ok(allowed.decision === "allow" && allowed.stdout.trim() === "", "a read prints nothing at all - silence is how a hook says allow");

// --- 2. no tier configured = not this guard's business -----------------------
ok(runHook(WRITE, { HELM_TIER: "" }).decision === "allow", "with no tier set the hook allows everything - the captain's own sessions must not inherit a mate's rules");

// --- 3. broken input must never take the turn down ---------------------------
const garbage = spawnSync(process.execPath, [HOOK], { input: "not json at all", encoding: "utf8", env: { ...process.env, HELM_TIER: "first-mate" } });
ok(garbage.status === 0 && !garbage.stdout.trim(), "an unparseable payload allows and exits 0 - a fence that falls over must not stop the ship");

// --- 4. the counter is what makes the budget per-TURN ------------------------
const counter = turnCounterPath(metaHome, SESSION);
fs.rmSync(counter, { force: true });

const decisions = [];
for (let i = 0; i < SECOND_MATE_TURN_WRITE_BUDGET + 2; i++) {
  decisions.push(runHook(WRITE, { HELM_TIER: "second-mate" }).decision);
}
const allowedCount = decisions.filter((d) => d === "allow").length;
ok(
  allowedCount === SECOND_MATE_TURN_WRITE_BUDGET,
  `a second mate gets exactly ${SECOND_MATE_TURN_WRITE_BUDGET} writes in a turn and is refused after (${decisions.join(", ")}) - if allowed writes did not advance the counter every call would see zero and the budget would never bind`
);
ok(/helm_dispatch/.test(runHook(WRITE, { HELM_TIER: "second-mate" }).reason), "and the refusal points at helm_dispatch");

// Reads never spend budget: a supervisor reads constantly, and a budget that
// counted reads would refuse it for doing its job.
fs.rmSync(counter, { force: true });
for (let i = 0; i < 10; i++) {
  runHook(READ, { HELM_TIER: "second-mate" });
}
ok(runHook(WRITE, { HELM_TIER: "second-mate" }).decision === "allow", "ten reads spend none of the budget");

// The reset is the app's job at launch; this proves the counter is what a reset acts on.
fs.rmSync(counter, { force: true });
ok(runHook(WRITE, { HELM_TIER: "second-mate" }).decision === "allow", "clearing the counter restores the full budget, which is how one launch = one turn is implemented");

// --- 5. a first mate's answer never depends on the counter -------------------
// The strictest tier must also be the least fragile: if a broken or missing counter
// could soften it, the guard would fail open exactly when the filesystem misbehaves.
fs.writeFileSync(counter, "{ this is not json", "utf8");
ok(runHook(WRITE, { HELM_TIER: "first-mate" }).decision === "deny", "a corrupt counter file does not soften the first mate's refusal");
fs.rmSync(counter, { force: true });
ok(
  runHook(WRITE, { HELM_TIER: "first-mate" }, {}).decision === "deny" &&
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify(WRITE), encoding: "utf8", env: { ...process.env, HELM_TIER: "first-mate" } }).stdout.includes("deny"),
  "and neither does having no meta-home to keep a counter in"
);

fs.rmSync(metaHome, { recursive: true, force: true });
console.log(
  exit === 0
    ? "VERIFY OK: the deny envelope is the shape the harness reads, allows are silent, broken input is harmless, and the budget is per turn."
    : "VERIFY FAILED."
);
process.exit(exit);
