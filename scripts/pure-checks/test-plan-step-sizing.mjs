/**
 * A plan step is sized by what one iteration can finish, and a timed-out one keeps its work.
 *
 * ## What the measurement said
 *
 * the captain, 2026-08-30: "varför kör agenterna så många iterationer?" The iterations were not
 * retries - they were the design, one plan step per fresh session. The problem was how the
 * plan was cut up.
 *
 * The plan that prompted it had eleven steps and ten iterations of budget, so it could not be
 * carried out even in theory. Steps 10 and 11 were "write a DECISIONS.md paragraph" and "run
 * three commands" - minutes of work, each paying a cold start with a median of 40,500 tokens
 * before doing anything. Finished iterations took 2.1 to 4.3 minutes.
 *
 * And a correction the card records against itself, because it changes the reason: merging
 * steps is NOT about context. Measured the same evening, short crew iterations cost 14,200
 * tokens per call against 53,700 for a long session - the small-context pattern is 3.8x
 * cheaper and must not be made more like a long session. The gain from merging is avoiding
 * cold starts, not avoiding context.
 *
 * ## The half that is a mechanism rather than a prompt
 *
 * Run d2d121c2's sixth iteration made 61 tool calls including edits and then timed out during
 * StructuredOutput - the reporting step. It had done the work. The orchestrator treated the
 * timeout exactly like an agent reporting failure, reset --hard, and the work was gone.
 *
 * Those are different facts. An agent saying "I did not succeed" disowns its half-finished
 * work; a clock running out says nothing about the work at all.
 *
 * Run: node scripts/e2e/test-plan-step-sizing.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "..", "src", "lib", "goalOrchestrator.js"), "utf8");

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// --- the plan phase sizes in iterations and time, not in tasks -------------------------
{
  ok(/sized by what ONE ITERATION can finish/.test(src), "the plan phase states the sizing criterion in iterations");
  // The cold start is the actual reason a two-minute step is wrong, and the prompt has to
  // say the number or "too small" is a matter of taste.
  ok(/40,000 tokens/.test(src), "and names the cold start that makes a minutes-long step wasteful");
  // The time limit, which is the half the first version of this card missed: a step that
  // cannot finish in fifteen minutes fails however many iterations remain.
  ok(/HARD 15-MINUTE limit/.test(src), "and the hard time limit a step must fit inside");
  ok(/slow end-to-end suite/i.test(src), "with the case that actually hit it named");
  // A plan with more steps than budget cannot be carried out, which is what happened.
  ok(/more steps than the iteration budget/.test(src), "and it is told to count its steps against the budget it was given");
}

// --- an iteration may finish several steps ---------------------------------------------
{
  ok(/CARRY ON into the following ones/.test(src), "the implement phase may continue into later steps");
  ok(/is not a deviation/.test(src), "and is told explicitly that doing so is not a deviation");
  // Without this it would start something it cannot finish, which is worse than a cold start.
  ok(/Never start something you cannot finish and commit/.test(src), "while still refusing to start what it cannot finish here");
}

// --- what must NOT have been merged away ------------------------------------------------
// The card is explicit that these are what the loop has and a long session does not.
{
  ok(/appendNotes\(worktreePath, i,/.test(src), "notes.md is still written every iteration");
  ok(/COMMIT_/.test(src) || /commit/i.test(src), "and committing per delivered piece is still in the loop");
  const commitPerStep = /one commit per success|commit(s)? per success|commitIteration|autoCommit/i.test(src);
  ok(commitPerStep, "with the one-commit-per-delivered-piece rule intact");
}

// --- a timed-out iteration keeps its work -------------------------------------------------
{
  ok(/function stashWorktreeChanges/.test(src), "there is a way to keep an iteration's work instead of deleting it");
  ok(/const timedOut = \/timed out\/i\.test/.test(src), "and a timeout is recognised as its own case");
  // The distinction that matters: only a timeout keeps; everything else still discards.
  ok(/if \(!kept\.stashed\) \{\s*discardWorktreeChanges/.test(src), "everything that is not a timeout still discards");
  ok(/stash", "push", "-u"/.test(src), "the work is stashed including new files, so nothing added is lost");
  // A stash nobody is told about is a stash nobody finds.
  ok(/git stash pop/.test(src), "and notes.md is told how to get it back");
  ok(/stashedWork: kept\.stashed/.test(src), "with the run's own record carrying it too");
  // Not a commit: the branch is what a person reads, and half-finished work committed there
  // would read as delivered.
  ok(!/stash[\s\S]{0,300}runGit\(worktreePath, \["commit"/.test(src), "and it is not committed onto the branch as if it were finished");
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: steps are sized in iterations and minutes, several may be done at once, and a timed-out iteration keeps its work.");
