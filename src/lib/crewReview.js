/**
 * A crew run does not get to be the only thing that read its own work.
 *
 * ## What was wrong
 *
 * The loop ends when the agent's own structured output says `goalReached: true`. That is the
 * builder marking its own homework, and this project already knows what that produces: on
 * 2026-08-18, 22 of 23 crew reports said done without having reached the goal.
 *
 * There is an outside signal - `verifyCommand` - and it is opt-in. Measured on the real
 * store 2026-09-01: 56 runs in the history, 108 review records on disk, and NOT ONE carries
 * the check that a declared verify gate writes. Three separate places that would show it
 * (the dispatch requests, the reports, the records) show nothing. An optional control with no
 * observed use across a whole history is not a control, it is a setting.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is the review half of the round trip the firstmate skill does: when the run finishes,
 * its own diff is read by a model that did not write it, and the finding is attached to the
 * run. It is NOT the whole round trip. The skill sends the finding back to the BUILDER, with
 * its context intact, and re-verifies - and Helm cannot do that today at all: a crew run is a
 * finished process, `helm_resume_crew` takes no arguments and only touches runs marked
 * resumable, and a `goal_reached` run is not one. Making that possible is an architectural
 * change, not a feature, so it is left as a decision rather than guessed at.
 *
 * So this closes the gap that can be closed honestly: the run no longer ends with nobody but
 * itself having looked.
 *
 * ## Where it runs, and why that is not a detail
 *
 * Inside the run, against its own worktree, before cleanup. The skill warns about exactly
 * this: review from the coordinator's directory and the main tree is clean, the review finds
 * nothing and stops correctly having seen no work - "a silent no-op, not a review". Helm has
 * the same trap with an extra edge, measured here: a finished run's worktree is not
 * guaranteed to survive, so a review scheduled for afterwards can find nothing to read.
 *
 * ## A different model, enforced rather than hoped for
 *
 * Independence is the whole point, and "a second opinion from the same model" is not one.
 * The reviewer is picked from the change's own risk by reviewerModel.js, and if that lands on
 * the model that just built, it steps to the next tier instead. Better to spend a little more
 * than to file the builder's own opinion as a second one.
 */
import { execFileSync } from "node:child_process";
import { buildAttentionPrompt, shapeAttentionAnswer, ATTENTION_SCHEMA, ATTENTION_SYSTEM } from "./diffAttention.js";
import { recommendReviewer, diffStats, REVIEWER_MODELS } from "./reviewerModel.js";

function git(cwd, args) {
  // stderr swallowed: a missing worktree is a case this handles and reports, so letting git
  // print "fatal: cannot change to ..." into the main process log makes a handled path look
  // like a crash to whoever reads the terminal.
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * A model that is not the one that wrote the code.
 *
 * Steps UP rather than down when the recommendation collides with the builder: the reason to
 * pick a tier was the change's risk, and answering that risk with something cheaper because
 * of a name collision would be the wrong trade in the one direction that matters.
 *
 * @param {string} recommended
 * @param {string | null} builderModel
 * @returns {{ model: string, steppedUp: boolean }}
 */
export function independentModel(recommended, builderModel) {
  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  if (!builderModel || !same(recommended, builderModel)) {
    return { model: recommended, steppedUp: false };
  }
  // REVIEWER_MODELS is ordered strongest first.
  const index = REVIEWER_MODELS.findIndex((m) => same(m.value, recommended));
  const stronger = index > 0 ? REVIEWER_MODELS[index - 1] : null;
  if (stronger) {
    return { model: stronger.value, steppedUp: true };
  }
  // Already at the top and the builder used it too. Nothing stronger exists, so say so
  // rather than quietly filing a same-model read as an independent one.
  return { model: recommended, steppedUp: false };
}

/**
 * Read a finished run's own diff with a model that did not write it.
 *
 * Never throws. A review that can break a run is a review that gets switched off, and the run
 * itself already succeeded or failed on its own terms before this is called.
 *
 * @param {object} input
 * @param {string} input.worktreePath
 * @param {string} input.baseCommit the commit the worktree forked from
 * @param {string} [input.goal] what the run was for - a diff read without its intent
 *   produces findings about style
 * @param {string | null} [input.builderModel] the model the run actually used
 * @param {(opts: object) => Promise<any>} input.ask keel's one-shot, injected so a test never
 *   spends a token
 * @param {(cwd: string, args: string[]) => string} [input.run]
 * @returns {Promise<{ reviewed: boolean, why: string|null, model: string|null, steppedUp: boolean,
 *   findings: any[], unanchored: number, nothingStandsOut: string|null, costUsd: number|null,
 *   changedLines: number }>}
 */
export async function reviewCrewRun({ worktreePath, baseCommit, goal = "", builderModel = null, ask, run = git }) {
  const nothing = {
    reviewed: false,
    why: null,
    model: null,
    steppedUp: false,
    findings: [],
    unanchored: 0,
    nothingStandsOut: null,
    costUsd: null,
    changedLines: 0,
  };

  if (!worktreePath || !baseCommit) {
    return { ...nothing, why: "the run left no worktree or no baseline to diff against" };
  }

  let diff;
  try {
    diff = run(worktreePath, ["diff", `${baseCommit}..HEAD`]);
  } catch (err) {
    // The worktree is gone, or the baseline is unreachable after a rebase. Reported, because
    // "no findings" and "could not look" must never read the same.
    return { ...nothing, why: `could not read the run's diff: ${err.message}` };
  }
  if (!String(diff).trim()) {
    return { ...nothing, why: "the run produced no diff against its baseline" };
  }

  const stats = diffStats(diff);
  const recommendation = recommendReviewer({
    // No record exists at this point, so the run is treated as core rather than cosmetic:
    // under-scoping the reviewer on work nobody has looked at is the wrong default.
    criticality: "core",
    files: stats.files,
    changedLines: stats.changedLines,
    commits: 1,
    paths: stats.paths,
  });
  const { model, steppedUp } = independentModel(recommendation.model, builderModel);

  const { prompt } = buildAttentionPrompt(diff, { title: goal, description: null });
  let answer;
  try {
    answer = await ask({
      prompt,
      model,
      system: ATTENTION_SYSTEM,
      schema: ATTENTION_SCHEMA,
      effort: recommendation.effort,
      timeoutMs: 240_000,
    });
  } catch (err) {
    return { ...nothing, model, steppedUp, why: `the reviewer could not be reached: ${err.message}` };
  }
  if (!answer?.ok) {
    return { ...nothing, model, steppedUp, why: answer?.reason || "the reviewer returned nothing" };
  }

  const shaped = shapeAttentionAnswer(answer.value, diff);
  return {
    reviewed: true,
    why: null,
    model: answer.model || model,
    steppedUp,
    findings: shaped.findings,
    unanchored: shaped.unanchored,
    nothingStandsOut: shaped.nothingStandsOut,
    costUsd: answer.costUsd ?? null,
    changedLines: stats.changedLines,
  };
}
