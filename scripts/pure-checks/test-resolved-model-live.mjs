import { requireLive } from "../checks-lib/live-gate.mjs";
requireLive("runs a real goal iteration to see which model the CLI reports back");

// E2E (LIVE): does a real run record the model that ACTUALLY ran?
//
// Everything else about this fix is asserted against a captured payload, which proves the
// arithmetic but not the wiring. This runs the genuine article - one real `runGoal`
// iteration in a throwaway git repo - and reads back what the run recorded. It is the only
// check here that would notice if `model` stopped being threaded from runIteration into
// extractUsage, which is the exact seam the fix added.
//
// Deliberately dispatched on HAIKU: the old code returned the first modelUsage key, which is
// the internal helper and is ALSO Haiku, so a run on Opus was the only way to tell them
// apart. Asking for Haiku and getting "claude-haiku-4-5-20251001" would prove nothing. So we
// assert on the CONTEXT WINDOW instead - 200 000 is Haiku's own, 1 000 000 is Opus's - plus
// the model id, and run a second one on Opus to prove the two are distinguished at all.
//
// One cheap goal, two tiny iterations.
//
// Run:  HELM_LIVE_CLI_TESTS=1 node scripts/e2e/test-resolved-model-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGoal } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-model-live-"));
const repo = path.join(root, "scratch-repo");
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, "README.md"), "# scratch\n", "utf8");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init", "-q");
git("config", "user.email", "e2e@helm.local");
git("config", "user.name", "helm e2e");
git("add", "-A");
git("commit", "-qm", "seed");

async function runOn(model) {
  const res = await runGoal({
    projectPath: repo,
    goal: "Append a single line reading 'touched' to README.md. Nothing else.",
    maxIterations: 1,
    model,
  });
  return res;
}

console.log("running one real iteration on Haiku…");
const haiku = await runOn("claude-haiku-4-5-20251001");
ok(!!haiku.resolvedModel, `the run recorded a resolved model (${haiku.resolvedModel})`);
ok(haiku.resolvedModel === "claude-haiku-4-5-20251001", `asked for Haiku, recorded Haiku (${haiku.resolvedModel})`);
const haikuFill = haiku.iterations?.find((i) => typeof i.fillPct === "number");
ok(!!haikuFill, "and it recorded a context fill, so the window was resolved rather than left null");

console.log("running one real iteration on Opus…");
const opus = await runOn("claude-opus-4-8");
ok(opus.resolvedModel === "claude-opus-4-8", `asked for Opus, recorded Opus and NOT the internal Haiku helper (${opus.resolvedModel}) - this is the exact assertion the old code failed`);

// The window is the load-bearing half: it is what fillPct is measured against, and reading it
// from the wrong entry is what shredded twelve runs' notes.
const opusIter = opus.iterations?.find((i) => typeof i.totalTokens === "number" && i.totalTokens > 0 && typeof i.fillPct === "number");
if (opusIter) {
  const window = Math.round(opusIter.totalTokens / opusIter.fillPct);
  ok(
    window > 500000,
    `the Opus run measures fill against a window of ~${window.toLocaleString("en-US")} tokens, not Haiku's 200,000 - the old code used the helper's window here`
  );
} else {
  ok(false, "expected at least one Opus iteration carrying both totalTokens and fillPct");
}

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch (err) {
  console.log(`note: could not remove ${root} (${err.code || err.message}) - temp dir, harmless.`);
}
console.log(exit === 0 ? "VERIFY OK: a real run records the model that actually ran, and measures its context against that model's own window." : "VERIFY FAILED.");
process.exit(exit);
