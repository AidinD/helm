// Spike: unit-level proof of the ship-review cluster-A/B/C fixes in
// goalOrchestrator.js, exercised deterministically (no claude calls):
//   - producedRealChanges: true only for changes OUTSIDE .maestro-goal/
//   - detectNoNetProgress: keys off producedChanges, implement-phase only
//   - advancePhaseAfterSuccess: gates plan -> implement on plan.md content
//   - extractKeyLearnings: rescues learnings from truncated notes middle
// Uses a real scratch git repo where git state is needed; pure functions are
// tested directly. Scratch dir removed at the end (including on failure).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  producedRealChanges,
  detectNoNetProgress,
  advancePhaseAfterSuccess,
  extractKeyLearnings,
} from "../src/lib/goalOrchestrator.js";

function log(msg) {
  console.log(`[spike] ${msg}`);
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`OK - ${msg}`);
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-progress-spike-"));
const repo = path.join(scratchRoot, "repo");

function cleanup() {
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

try {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "spike@example.com"]);
  git(repo, ["config", "user.name", "Spike"]);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  fs.mkdirSync(path.join(repo, ".maestro-goal"), { recursive: true });

  // --- producedRealChanges ---
  assert(producedRealChanges(repo) === false, "clean tree -> producedRealChanges false");

  fs.writeFileSync(path.join(repo, ".maestro-goal", "notes.md"), "# notes\n");
  fs.writeFileSync(path.join(repo, ".maestro-goal", "plan.md"), "# plan\n");
  assert(
    producedRealChanges(repo) === false,
    "changes ONLY inside .maestro-goal/ -> producedRealChanges false (bookkeeping is not real work)"
  );

  fs.writeFileSync(path.join(repo, "src.js"), "console.log(1)\n");
  assert(
    producedRealChanges(repo) === true,
    "a change OUTSIDE .maestro-goal/ (src.js) -> producedRealChanges true"
  );

  // --- detectNoNetProgress: implement-phase only, keys off producedChanges ---
  const impl = (n, produced) => ({ iteration: n, ok: true, phase: "implement", result: { success: true }, producedChanges: produced });
  const research = (n) => ({ iteration: n, ok: true, phase: "research", result: { success: true }, producedChanges: false });

  assert(detectNoNetProgress([research(1), research(2)], 2) === null, "two research successes never trip no-progress");
  assert(detectNoNetProgress([impl(1, true), impl(2, true)], 2) === null, "two productive implement successes -> no signal");
  assert(detectNoNetProgress([impl(1, false)], 2) === null, "single no-op implement below streak -> no signal");
  assert(typeof detectNoNetProgress([impl(1, false), impl(2, false)], 2) === "string", "two consecutive no-op implements -> signal fires");
  assert(
    detectNoNetProgress([impl(1, false), impl(2, true), impl(3, false)], 2) === null,
    "a productive iteration in the middle breaks the no-op streak"
  );

  // --- advancePhaseAfterSuccess: plan -> implement gated on plan.md ---
  assert(advancePhaseAfterSuccess(repo, "research") === "plan", "research always advances to plan");
  // plan.md currently has "# plan\n" (non-empty) -> advance allowed
  assert(advancePhaseAfterSuccess(repo, "plan") === "implement", "plan with real content advances to implement");
  fs.writeFileSync(path.join(repo, ".maestro-goal", "plan.md"), "   \n\n");
  assert(advancePhaseAfterSuccess(repo, "plan") === "plan", "whitespace-only plan.md keeps phase in plan (deliverable gate)");
  fs.rmSync(path.join(repo, ".maestro-goal", "plan.md"));
  assert(advancePhaseAfterSuccess(repo, "plan") === "plan", "missing plan.md keeps phase in plan");
  assert(advancePhaseAfterSuccess(repo, "implement") === "implement", "implement stays implement");

  // --- extractKeyLearnings: rescue learnings from a notes block ---
  const notesMiddle = [
    "## Iteration 1 — success",
    "Summary: did a thing",
    "",
    "Key learnings:",
    "- Auth lives in src/auth.js",
    "- The DB migration must run before seeding",
    "",
    "## Iteration 2 — success",
    "Summary: another",
    "",
    "Key learnings:",
    "- Auth lives in src/auth.js",
    "- Retries need a jittered backoff",
    "",
  ].join("\n");
  const learnings = extractKeyLearnings(notesMiddle);
  assert(learnings.includes("Auth lives in src/auth.js"), "extracts a learning bullet");
  assert(learnings.includes("The DB migration must run before seeding"), "extracts multiple bullets across iterations");
  assert(learnings.includes("Retries need a jittered backoff"), "extracts learnings from later iterations too");
  assert(learnings.filter((l) => l === "Auth lives in src/auth.js").length === 1, "duplicate learnings are deduped");
  assert(!learnings.some((l) => l.startsWith("Summary")), "does not misclassify Summary lines as learnings");

  log("ALL CHECKS PASSED");
} finally {
  cleanup();
  assert(!fs.existsSync(scratchRoot), "scratch dir fully removed after cleanup");
}
