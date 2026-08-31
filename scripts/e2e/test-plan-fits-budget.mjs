// A run must not spend its whole budget on a fraction of a plan it wrote itself.
//
// THE FAILURE, measured on three real crew runs 2026-08-30. DEFAULT_MAX_ITERATIONS is 5.
// Iteration 1 researches, iteration 2 plans, so three remain. Two separate runs each wrote
// an ELEVEN-step plan in iteration two and started executing it anyway - one reached step 4,
// the other step 3 - and between them spent $17 to arrive at "partial work". The third run,
// whose task was small, finished properly for $2.32.
//
// Nothing compared the plan to the budget, because nothing ever had. Setting maxIterations
// correctly in advance requires knowing the answer, which is what the research and plan
// phases exist to find out - so the check belongs after the plan is written and before the
// first implement iteration is paid for.
//
// The asymmetry is deliberate throughout: an unreadable plan does NOT block. A run stopped
// on a bad guess is worse than the failure this prevents, which at least produces commits.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-plan-fits-budget.mjs
import fs from "node:fs";
import { countPlanSteps, planFitsBudget } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- counting the shape a plan actually takes ------------------------------
console.log("-- counting steps --");
{
  const headings = ["# Plan", "", "## Step 1 - do a thing", "prose about steps", "## Step 2 - do another", "## Step 3 - last"].join("\n");
  ok(countPlanSteps(headings) === 3, `headings are counted (${countPlanSteps(headings)})`);

  // Prose says "step" freely; a heading is the author committing to a unit of work.
  const prosey = ["# Plan", "", "This plan has one step. Step by step we will step through it.", "", "## Step 1 - the only one"].join("\n");
  ok(countPlanSteps(prosey) === 1, `prose mentioning "step" is not a step (${countPlanSteps(prosey)})`);

  const deeper = ["### Step 1 - a", "### Step 2 - b"].join("\n");
  ok(countPlanSteps(deeper) === 2, `### headings count too - a real plan used them (${countPlanSteps(deeper)})`);

  const numbered = ["# Plan", "1. first", "2. second", "3. third", "4. fourth"].join("\n");
  ok(countPlanSteps(numbered) === 4, `a numbered list is the other shape a plan takes (${countPlanSteps(numbered)})`);

  ok(countPlanSteps("just some prose with no structure at all") === null, "an unstructured plan is null, not zero");
  ok(countPlanSteps("") === null && countPlanSteps(null) === null, "and so is nothing at all");
  // Two numbered items could be an aside rather than a plan; three is the floor.
  ok(countPlanSteps("1. a\n2. b") === null, "two numbered lines are not enough to call it a plan");
}

// --- the decision ----------------------------------------------------------
console.log("\n-- does it fit --");
{
  const eleven = Array.from({ length: 11 }, (_, i) => `## Step ${i + 1} - thing ${i + 1}`).join("\n");
  const v = planFitsBudget(eleven, 3);
  ok(v.fits === false, "eleven steps with three iterations left does NOT fit");
  ok(v.steps === 11 && v.left === 3, `and it reports both numbers (${v.steps} steps, ${v.left} left)`);
  ok(v.needed === 13, `and what it would actually need, research and planning included (${v.needed})`);

  ok(planFitsBudget(eleven, 11).fits === true, "exactly enough fits - the check is not a margin");
  ok(planFitsBudget(eleven, 40).fits === true, "and plenty obviously fits");

  const three = ["## Step 1 - a", "## Step 2 - b", "## Step 3 - c"].join("\n");
  ok(planFitsBudget(three, 3).fits === true, "a small plan in a small budget is untouched");
}

// --- every uncertain case must NOT block -----------------------------------
console.log("\n-- failing open, on purpose --");
{
  ok(planFitsBudget("free-form prose, no steps anywhere", 1).fits === true, "an uncountable plan never blocks a run");
  ok(planFitsBudget(null, 1).fits === true, "a missing plan never blocks a run");
  ok(planFitsBudget("", 0).fits === true, "an empty plan never blocks a run");
  const eleven = Array.from({ length: 11 }, (_, i) => `## Step ${i + 1} - x`).join("\n");
  ok(planFitsBudget(eleven, -1).fits === true, "a nonsensical budget never blocks a run either");
}

// --- against the two plans that actually caused this -----------------------
console.log("\n-- the real plans from 2026-08-30 --");
{
  // A synthetic fixture proves the arithmetic; a REAL plan proves the parser matches
  // what a plan phase actually writes, which is the half a fixture cannot show. So the
  // real one is kept as a fixture rather than read from the worktree it was written in.
  //
  // It used to read the worktrees directly, and on 2026-08-31 those were removed during
  // a cleanup - after which this whole section skipped itself, quietly, while the card
  // it was the evidence for had already been closed citing it. A check whose evidence
  // can be deleted by unrelated housekeeping is a check that will be green when it
  // matters least. Recovered from the tend repo's history (commit e6981fe) and pinned
  // here, where nothing else has a reason to touch it.
  const plan = fs.readFileSync(new URL("./fixtures/real-goal-plan-2026-08-30.md", import.meta.url), "utf8");

  const steps = countPlanSteps(plan);
  ok(steps !== null && steps >= 10, `a real plan parses to ${steps} steps - the parser matches what a plan phase writes`);
  const v = planFitsBudget(plan, 3);
  ok(v.fits === false, "and with the three iterations it really had, it would have been stopped");
  ok(v.needed >= 12, `telling the caller to give it ${v.needed} instead`);
}

// --- the wiring, since the decision is worthless unless it runs ------------
console.log("\n-- wired into the loop --");
{
  const src = fs.readFileSync(new URL("../../src/lib/goalOrchestrator.js", import.meta.url), "utf8");
  ok(/planFitsBudget\(readPlan\(worktreePath\), maxIterations - i\)/.test(src), "the loop calls it with the plan and the iterations that are left");
  ok(/iterationPhase === "plan" && phase === "implement"/.test(src), "only on the plan -> implement transition, not every iteration");
  ok(/signal: "plan_exceeds_budget"/.test(src), "and it ESCALATES rather than stopping silently");
  const at = src.indexOf('signal: "plan_exceeds_budget"');
  const breakAt = src.indexOf("break;", at);
  ok(at > 0 && breakAt > 0 && breakAt - at < 800, "the escalation actually ends the run - it is not just recorded");
  // Only one place decides, so there is only one place to get it wrong.
  ok((src.match(/planFitsBudget\(/g) || []).length === 2, "exactly one call site, plus the definition");
}

console.log(
  exit === 0
    ? "\nVERIFY OK: a plan that cannot fit its remaining iterations escalates before the first implement iteration is paid for, and every uncertain case runs anyway."
    : "\nVERIFY FAILED."
);
process.exit(exit);
