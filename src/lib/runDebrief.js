import { countPlanSteps } from "./goalOrchestrator.js";

/**
 * What a run that did not reach its goal should have said.
 *
 * ## The failure this replaces
 *
 * On 2026-08-30 a crew run stopped and reported this, and nothing else:
 *
 *   two_consecutive_failures
 *   Iteration timed out after 900000ms
 *
 * Both true. Neither usable. What actually mattered - that step 9 of 11 required
 * running an E2E suite, that a suite does not fit inside a 15-minute iteration, and
 * that therefore every remaining attempt would have died the same way - took half an
 * hour of reading transcripts to work out. The captain's words the next morning: "jag har
 * ingen aning om hur jag ska fixa det eller ens fortsätta jobbet".
 *
 * The information was already there. Nothing assembled it.
 *
 * ## What this does and does not claim
 *
 * Three questions, answered only where the run's own record can answer them:
 *
 *   blocked   - why it stopped, INCLUDING the underlying iteration error. A stopped
 *               reason names the rule that fired; the error names the thing that went
 *               wrong, and only the second one is actionable.
 *   where     - the branch and how many commits are on it, so the work is findable.
 *   remaining - how big the plan was against how much of it got committed.
 *
 * `remaining` deliberately does NOT say WHICH steps are left. The plan text names its
 * steps, but nothing in the run record says which were completed - only notes.md holds
 * that, in prose the agent wrote for itself. Counting is honest; naming would be a
 * guess dressed as a fact, which is the failure mode this whole module exists to end.
 *
 * A process that died and a model that reported failure are told apart, because they
 * need different responses: the first is usually an environment or budget problem, the
 * second is usually the work itself.
 */

/** The stopped reasons that mean the run finished what it set out to do. */
const SUCCEEDED = new Set(["goal_reached"]);

/**
 * @param {object} opts
 * @param {object} opts.result The runGoal result: { iterations, stoppedReason, branchName, commitCount, ... }
 * @returns {{ blocked: string|null, where: string|null, remaining: string|null, lines: string[] }}
 *   `lines` is the whole thing as plain sentences, ready to put in front of a person.
 */
export function buildRunDebrief({ result } = {}) {
  const iterations = Array.isArray(result?.iterations) ? result.iterations : [];
  const stoppedReason = result?.stoppedReason || null;
  const commitCount = typeof result?.commitCount === "number" ? result.commitCount : 0;
  const branchName = result?.branchName || null;

  if (!stoppedReason || SUCCEEDED.has(stoppedReason)) {
    return { blocked: null, where: null, remaining: null, lines: [] };
  }

  const blocked = describeBlockage(stoppedReason, iterations);
  const where = describeWhere(branchName, commitCount);
  const remaining = describeRemaining(iterations, commitCount);

  return { blocked, where, remaining, lines: [blocked, where, remaining].filter(Boolean) };
}

/**
 * Why it stopped, in words, with the underlying error when there is one.
 *
 * The stopped reason alone names the RULE that fired ("two failures in a row"), which
 * tells a reader nothing they can act on. The failing iterations carry the actual
 * error, and when several failed the same way that repetition is the finding: it means
 * retrying is not the answer.
 */
function describeBlockage(stoppedReason, iterations) {
  const rule = {
    max_iterations_reached: "It ran out of iterations before reaching the goal.",
    two_consecutive_failures: "It stopped after two iterations failed in a row.",
    quota_exhausted: "It stopped because the token quota ran out. This one is resumable.",
    no_op_convergence: "It stopped because two iterations in a row changed nothing.",
    cancelled: "It was cancelled before finishing.",
    escalated: "It paused and asked for a decision.",
    interrupted: "It was interrupted, probably by the app restarting.",
  }[stoppedReason] || `It stopped: ${stoppedReason}.`;

  // A process that died and a model that ran and reported failure need different
  // responses, so they are never merged into "failed".
  const died = iterations.filter((it) => it && it.ok === false && it.error);
  const reportedFailure = iterations.filter((it) => it && it.ok === true && it.result?.success === false);

  if (died.length > 0) {
    const errors = [...new Set(died.map((it) => String(it.error).trim()))];
    if (errors.length === 1 && died.length > 1) {
      // The same wall, more than once. This is the sentence that was missing.
      return `${rule} All ${died.length} of them died the same way: ${errors[0]}. Retrying as-is will hit the same wall - something about the step or the budget has to change first.`;
    }
    return `${rule} The process itself died on ${died.length === 1 ? "an iteration" : `${died.length} iterations`}: ${errors.join("; ")}.`;
  }

  if (reportedFailure.length > 0) {
    const last = reportedFailure[reportedFailure.length - 1];
    const said = String(last.result?.summary || "").trim();
    return said
      ? `${rule} The work itself did not succeed - the last attempt reported: ${said}`
      : `${rule} The work ran but reported failure, without saying why.`;
  }

  return rule;
}

/** Where the work is, so it can be found without knowing how Helm names things. */
function describeWhere(branchName, commitCount) {
  if (commitCount === 0) {
    return "Nothing was committed, so there is no partial work to pick up.";
  }
  const what = `${commitCount} commit${commitCount === 1 ? "" : "s"}`;
  return branchName
    ? `The work that did land is ${what} on branch ${branchName}.`
    : `${what} landed, but the run did not record which branch they are on.`;
}

/**
 * How much of the plan was paid for.
 *
 * Counted, never named. See the module comment: which steps remain lives only in the
 * agent's own notes, and inferring it from commit count would be a guess.
 */
function describeRemaining(iterations, commitCount) {
  const withPlan = [...iterations].reverse().find((it) => it && typeof it.plan === "string" && it.plan.trim());
  if (!withPlan) {
    return null;
  }
  const steps = countPlanSteps(withPlan.plan);
  if (steps === null || steps === 0) {
    return null;
  }
  if (commitCount >= steps) {
    return `Its plan had ${steps} steps and ${commitCount} commits landed, so most of it is probably done - read the branch.`;
  }
  return `Its plan had ${steps} steps; ${commitCount} commit${commitCount === 1 ? "" : "s"} landed. The plan itself is in .helm-goal/plan.md in the worktree, and notes.md says what the last iteration thought was left.`;
}
