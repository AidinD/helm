// What the machines that vouch for a repo are currently saying, and - the whole point - the
// difference between "they say it is fine" and "they have not said".
//
// WHY THIS EXISTS. The app lane runs on a schedule on GitHub's runners. It went red the night
// after the tier merge and again the night after that, naming seven checks, and nobody read it
// for two days (2026-09-07). Every one of those seven was a check describing a mechanism that
// had moved, so the lane was doing its job perfectly: something was wrong and it said so, out
// loud, to nobody.
//
// A signal nobody reads is worse than no signal, because it also supplies the feeling of being
// covered. So the result comes to where he already looks instead of waiting to be visited.
//
// THE CLASSIFICATION IS THE WHOLE MODULE, and it is deliberately three-valued. A CI reader that
// answers pass/fail has to put "could not ask" somewhere, and both places are lies: as a pass
// it is the docs-drift bug again (a failed look rendered as the all-clear), and as a failure it
// cries wolf every time a laptop is offline until he stops believing it. Unknown is a state
// with its own name here, and the renderer is required to show it as itself.
//
// Pure on purpose: given rows, decide. No spawning, no network, no clock beyond what is passed
// in - so every branch below is reachable from a test instead of from a weather condition.

/** A conclusion that really means the machines are unhappy about the CODE. */
const FAILING_CONCLUSIONS = Object.freeze(["failure", "timed_out", "startup_failure"]);

/**
 * A conclusion that says nothing either way, and must never be read as either.
 *
 * `cancelled` is here and not in FAILING_CONCLUSIONS on purpose, and the reason is the same one
 * no-mistakes gives for refusing to re-run a cancelled check by default: a cancellation does not
 * say WHO cancelled. A maintainer stopping a job, a concurrency rule superseding it, and a
 * runner dying all arrive as the same word. Calling that red would mean the widget lights up
 * every time somebody pushes twice in a minute.
 *
 * `skipped` is a workflow that decided this commit was not for it, which is neither news nor a
 * verdict.
 *
 * `action_required` is here for the same shape of reason: GitHub emits it when a run is paused
 * pending a maintainer's manual approval (e.g. a first-time contributor's fork PR), which is
 * waiting for a person, not a verdict about the code. Calling that red would light the widget up
 * for an approval gate nobody has gotten to yet.
 */
const UNKNOWN_CONCLUSIONS = Object.freeze(["cancelled", "skipped", "neutral", "stale", "action_required"]);

/** The states a workflow can be in, as this module reports them. */
export const CI_STATES = Object.freeze({
  failing: "failing",
  passing: "passing",
  unknown: "unknown",
});

function isFinished(row) {
  // GitHub reports `status` as queued | in_progress | completed (plus `waiting`/`requested` on
  // some events). Only a completed run has a verdict; anything else is still happening, and a
  // run in flight is the single most tempting thing to round to "fine".
  return String(row?.status || "").toLowerCase() === "completed";
}

function millis(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * The newest FINISHED run per workflow, on one branch.
 *
 * Newest by `createdAt` rather than by list order: the API returns newest-first today, and a
 * check that relies on that is a check that breaks silently when a caller passes rows it
 * gathered differently. Sorting costs nothing and removes the assumption.
 *
 * A workflow with runs but none finished is kept, with `run: null`, because "this workflow is
 * mid-flight and has no verdict yet" is a real answer and dropping it would report the repo as
 * having fewer opinions about it than it does.
 */
export function newestFinishedPerWorkflow(rows, { branch = null } = {}) {
  const wanted = branch ? String(branch).toLowerCase() : null;
  const byWorkflow = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.workflowName || "").trim();
    if (!name) {
      continue;
    }
    if (wanted && String(row?.headBranch || "").toLowerCase() !== wanted) {
      continue;
    }
    const seen = byWorkflow.get(name) || { workflow: name, run: null, inFlight: false };
    if (!isFinished(row)) {
      seen.inFlight = true;
      byWorkflow.set(name, seen);
      continue;
    }
    if (!seen.run || millis(row.createdAt) > millis(seen.run.createdAt)) {
      seen.run = row;
    }
    byWorkflow.set(name, seen);
  }
  return [...byWorkflow.values()];
}

/**
 * What one workflow's newest finished run means.
 *
 * Note the order: an unknown CONCLUSION is decided before success is, so a run that finished
 * with something this module does not recognise can never fall through to "passing". A new
 * GitHub conclusion string appearing in a future API is then reported as unknown, which is
 * true, instead of as green, which would be the failure this file exists to prevent.
 */
export function classifyWorkflow(entry) {
  const run = entry?.run || null;
  if (!run) {
    return {
      workflow: entry?.workflow || "",
      state: CI_STATES.unknown,
      why: entry?.inFlight ? "running now, and has no finished run to report" : "has never finished a run here",
      run: null,
    };
  }
  const conclusion = String(run.conclusion || "").toLowerCase();
  if (!conclusion) {
    return {
      workflow: entry.workflow,
      state: CI_STATES.unknown,
      why: "finished without saying how",
      run,
    };
  }
  if (UNKNOWN_CONCLUSIONS.includes(conclusion)) {
    let why = `reported "${conclusion}"`;
    if (conclusion === "cancelled") {
      why = "was cancelled, and a cancellation does not say by whom";
    } else if (conclusion === "action_required") {
      why = "is waiting on a maintainer's approval, which says nothing about the code";
    }
    return { workflow: entry.workflow, state: CI_STATES.unknown, why, run };
  }
  if (FAILING_CONCLUSIONS.includes(conclusion)) {
    return { workflow: entry.workflow, state: CI_STATES.failing, why: conclusion, run };
  }
  if (conclusion === "success") {
    return { workflow: entry.workflow, state: CI_STATES.passing, why: "success", run };
  }
  return { workflow: entry.workflow, state: CI_STATES.unknown, why: `reported "${conclusion}", which this reader does not know`, run };
}

/**
 * DECIDE what to do about workflow lanes missing from a fetched page of runs, given the answer
 * (if any) a targeted, per-workflow ask returned for each one.
 *
 * Pure on the same terms as the rest of this module: `asked` is the RESULT of the targeted
 * lookups (one entry per lane missing from `rows`), not a live call this function makes itself -
 * the caller does the spawning, this decides what it means. Three shapes for a missing lane:
 *
 *   `asked[wf]` absent, or `{ ok: false }` - the targeted ask itself failed (or was never made).
 *   Left in `knownWorkflows` untouched, so it still reads as unknown rather than being rounded
 *   to "not applicable" - a failure to ask must never look like an answer.
 *
 *   `{ ok: true, rows: [...] }` with at least one row - the lane HAS runs on this branch; the
 *   page of `rows` just did not reach back far enough. Its run is folded into `rows` so it gets
 *   a real verdict, same as any lane that was on the page already.
 *
 *   `{ ok: true, rows: [] }` - asked directly and confirmed the lane has never run on this
 *   branch. Dropped from `knownWorkflows` rather than displayed as a permanent gap.
 *
 * A lane already present in `rows` is untouched regardless of what `asked` says about it.
 */
export function resolveMissingLanes({ knownWorkflows, rows, asked } = {}) {
  const knownList = Array.isArray(knownWorkflows) ? knownWorkflows : [];
  const baseRows = Array.isArray(rows) ? rows : [];
  const askedMap = asked && typeof asked === "object" ? asked : {};
  const seen = new Set(baseRows.map((r) => String(r?.workflowName || "").trim()).filter(Boolean));
  const missing = knownList.filter((wf) => !seen.has(wf));
  const outRows = [...baseRows];
  const neverOnThisBranch = new Set();
  for (const wf of missing) {
    const result = askedMap[wf];
    if (!result || !result.ok) {
      continue;
    }
    const found = Array.isArray(result.rows) ? result.rows : [];
    if (found.length > 0) {
      outRows.push(...found);
    } else {
      neverOnThisBranch.add(wf);
    }
  }
  return {
    rows: outRows,
    knownWorkflows: knownList.filter((wf) => !neverOnThisBranch.has(wf)),
  };
}

/**
 * One project's CI standing, ready to render.
 *
 * `reachable: false` is its own field rather than an empty `workflows` array, because those two
 * mean opposite things and an array cannot tell them apart: a repo with no workflows is quiet
 * and fine, and a repo we could not ask is unmeasured. The first version of the docs nudge made
 * exactly that conflation and rendered "docs are current" for projects it had failed to read.
 */
export function projectCiHealth({ name, path, rows, branch, knownWorkflows = null, reachable = true, error = null } = {}) {
  if (!reachable) {
    return {
      name: name || "",
      path: path || "",
      reachable: false,
      error: error || "could not ask",
      workflows: [],
      failing: [],
      unknown: [],
    };
  }
  const fetched = newestFinishedPerWorkflow(rows, { branch });
  const byName = new Map(fetched.map((entry) => [entry.workflow, entry]));
  // The WORKFLOW SET comes from the repo itself when the caller has asked it (via
  // `gh workflow list`), not from whichever names happen to appear in the fetched run rows.
  // Deriving the set from the rows is the truncation bug this shape exists to close: a workflow
  // that runs rarely on the default branch can fall off a page of runs and simply be absent from
  // `rows`, and a reader that only knows about names it was handed reports that as nothing to
  // say - green by omission - instead of as a lane it could not find a verdict for.
  const names = Array.isArray(knownWorkflows) && knownWorkflows.length > 0 ? knownWorkflows : [...byName.keys()];
  const workflows = names.map((wf) => {
    const entry = byName.get(wf);
    if (entry) {
      return classifyWorkflow(entry);
    }
    // Known to the repo, but no row for it came back even though rows were already scoped to
    // this branch - a real absence, not a page-size accident, so it is reported as unknown
    // rather than silently dropped from the list.
    return {
      workflow: wf,
      state: CI_STATES.unknown,
      why: `no run of this workflow was found on ${branch || "the default branch"}`,
      run: null,
    };
  });
  // Sorted by name so the rendered order does not wobble between refreshes for no reason - a
  // list that reshuffles reads as new information when nothing has changed.
  workflows.sort((a, b) => a.workflow.localeCompare(b.workflow));
  return {
    name: name || "",
    path: path || "",
    reachable: true,
    error: null,
    workflows,
    failing: workflows.filter((w) => w.state === CI_STATES.failing),
    unknown: workflows.filter((w) => w.state === CI_STATES.unknown),
  };
}

/**
 * The whole board's standing, and what the widget is allowed to say about it.
 *
 * `allClear` is computed here rather than left to the renderer, and it requires that every
 * project was reachable AND that nothing is unknown. That is stricter than "no failures", which
 * is the point: the sentence a green widget shows is a claim about having looked, so one project
 * we could not reach is enough to withhold it. There is a separate, weaker sentence for that.
 */
export function ciHealthSummary(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const failing = list.filter((p) => p.reachable && p.failing.length > 0);
  const unreachable = list.filter((p) => !p.reachable);
  const unknown = list.filter((p) => p.reachable && p.failing.length === 0 && p.unknown.length > 0);
  const measured = list.filter((p) => p.reachable);
  const green = measured.filter((p) => p.failing.length === 0 && p.unknown.length === 0);
  // HOW MANY WERE ACTUALLY MEASURED, which is not the same as how many were considered.
  // Pointing this at a real machine found 11 of 14 projects with no workflows at all - so a
  // sentence counting `considered` would have read "every lane green across 14 projects" while
  // eleven of them have no lanes to be green. The claim has to be the size of the evidence.
  const withLanes = measured.filter((p) => p.workflows.length > 0);
  return {
    considered: list.length,
    withLanes: withLanes.length,
    failing,
    unknown,
    unreachable,
    green,
    allClear: list.length > 0 && unreachable.length === 0 && unknown.length === 0 && failing.length === 0,
    // A count of workflows, not of projects: "3 red" meaning three projects each with one red
    // lane and "3 red" meaning one project with three is the same phrase for different news.
    failingWorkflows: failing.reduce((n, p) => n + p.failing.length, 0),
  };
}
