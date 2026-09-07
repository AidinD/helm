// A CI reader that answers pass/fail has to put "could not ask" somewhere, and both places lie.
//
// WHY THIS CHECK IS THE POINT OF THE MODULE. The app lane ran on a schedule, went red the night
// after the tier merge and again the night after, named seven checks, and nobody read it for two
// days. The fix is to show it in Helm - and a widget that shows CI is one careless boolean away
// from being worse than the silence it replaces: a failed look rendered as the all-clear is
// exactly the docs-drift bug this repo already paid for once, and a failed look rendered as red
// cries wolf every time a laptop is offline until he stops believing it.
//
// So every assertion below is about the SEAM between the three states, not about the happy path.
//
// Run: node scripts/pure-checks/test-ci-health-tells-three-states-apart.mjs
import {
  CI_STATES,
  newestFinishedPerWorkflow,
  classifyWorkflow,
  projectCiHealth,
  ciHealthSummary,
} from "../../src/lib/ciHealth.js";

let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${what}`);
  if (!cond) {
    fails += 1;
  }
};

const run = (over = {}) => ({
  workflowName: "app-lane",
  headBranch: "main",
  status: "completed",
  conclusion: "success",
  createdAt: "2026-09-07T06:00:00Z",
  url: "https://github.com/AidinD/helm/actions/runs/1",
  ...over,
});

// --- newest by TIME, not by the order the caller happened to gather them -------------------
{
  const rows = [
    run({ createdAt: "2026-09-05T06:00:00Z", conclusion: "success", url: "old" }),
    run({ createdAt: "2026-09-07T06:00:00Z", conclusion: "failure", url: "new" }),
  ];
  const [entry] = newestFinishedPerWorkflow(rows, { branch: "main" });
  ok(entry.run.url === "new", `the newest finished run wins by createdAt (${entry.run.url})`);
  // Reversed input, same answer. The API returns newest-first today; a reader that leans on
  // that is a reader that breaks silently the day a caller gathers rows differently.
  const [reversed] = newestFinishedPerWorkflow([...rows].reverse(), { branch: "main" });
  ok(reversed.run.url === "new", "and the same answer whichever order the rows arrive in");
}

// --- the branch filter ----------------------------------------------------------------------
{
  const rows = [
    run({ headBranch: "some-feature", conclusion: "failure", url: "branch" }),
    run({ headBranch: "main", conclusion: "success", url: "main" }),
  ];
  const entries = newestFinishedPerWorkflow(rows, { branch: "main" });
  ok(entries.length === 1 && entries[0].run.url === "main", "a run on another branch is not the default branch's verdict");
  ok(
    newestFinishedPerWorkflow(rows).length === 1,
    "and with no branch asked for, every row is in scope rather than none"
  );
}

// --- IN FLIGHT IS NOT A VERDICT -------------------------------------------------------------
{
  const [entry] = newestFinishedPerWorkflow([run({ status: "in_progress", conclusion: null })], { branch: "main" });
  ok(entry.run === null && entry.inFlight === true, "a workflow whose only run is in progress has no finished run");
  const verdict = classifyWorkflow(entry);
  ok(verdict.state === CI_STATES.unknown, `and it classifies as unknown, not passing (${verdict.state})`);
  ok(/running now/.test(verdict.why), `and says why in words (${verdict.why})`);

  // A workflow with runs but none of them finished must still be REPORTED, not dropped: a repo
  // that looks like it has fewer opinions about itself than it does is a quieter lie.
  const health = projectCiHealth({ name: "helm", rows: [run({ status: "queued", conclusion: null })], branch: "main" });
  ok(health.workflows.length === 1, "a mid-flight workflow is still listed");
  ok(health.unknown.length === 1 && health.failing.length === 0, "as unknown, and not as a failure");
}

// --- CANCELLED IS NOT RED, AND THAT IS A DECISION -------------------------------------------
// A cancellation does not say who cancelled: a maintainer stopping a job, a concurrency rule
// superseding it, and a runner dying all arrive as the same word. Calling it red would light
// the widget up every time he pushes twice in a minute, and a widget that cries wolf gets
// ignored - which is the exact failure being fixed here.
{
  for (const conclusion of ["cancelled", "skipped", "neutral", "stale", "action_required"]) {
    const verdict = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion }) });
    ok(verdict.state === CI_STATES.unknown, `"${conclusion}" is unknown, neither pass nor fail (${verdict.state})`);
  }
  const cancelled = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion: "cancelled" }) });
  ok(/does not say by whom/.test(cancelled.why), `and a cancellation says why it is not a verdict (${cancelled.why})`);

  // action_required means a run is paused on a maintainer's approval (e.g. a first-time
  // contributor's fork PR) - it says nothing about the code, so it must not read as red.
  const pending = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion: "action_required" }) });
  ok(
    /approval/.test(pending.why),
    `and a pending approval says why it is not a code verdict (${pending.why})`
  );
}

// --- AN UNRECOGNISED CONCLUSION CANNOT FALL THROUGH TO GREEN --------------------------------
// The load-bearing order inside classifyWorkflow. GitHub can add a conclusion string tomorrow;
// a reader whose last branch is "else it passed" would report that as green forever.
{
  const verdict = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion: "something_new_from_github" }) });
  ok(verdict.state === CI_STATES.unknown, `a conclusion this reader does not know is unknown (${verdict.state})`);
  ok(/does not know/.test(verdict.why), `and admits that in words rather than guessing (${verdict.why})`);
  const empty = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion: null }) });
  ok(empty.state === CI_STATES.unknown, "and a completed run with no conclusion at all is unknown too");
}

// --- what IS red, and what IS green ---------------------------------------------------------
{
  for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
    const verdict = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion }) });
    ok(verdict.state === CI_STATES.failing, `"${conclusion}" is a failure (${verdict.state})`);
  }
  const green = classifyWorkflow({ workflow: "app-lane", run: run({ conclusion: "success" }) });
  ok(green.state === CI_STATES.passing, "and success is the only thing that passes");
}

// --- "no workflows" AND "could not ask" ARE DIFFERENT ANSWERS -------------------------------
// They cannot be told apart by an empty array, which is why reachable is its own field. The
// docs nudge made exactly this conflation and rendered "docs are current" for projects it had
// failed to read.
{
  const quiet = projectCiHealth({ name: "pompom", rows: [], branch: "main" });
  ok(quiet.reachable === true && quiet.workflows.length === 0, "a repo with no workflows is reachable and quiet");
  const unasked = projectCiHealth({ name: "loom", reachable: false, error: "gh is not authenticated" });
  ok(unasked.reachable === false, "a repo we could not ask is not reachable");
  ok(unasked.workflows.length === 0 && !!unasked.error, `and carries the reason (${unasked.error})`);
  ok(
    quiet.reachable !== unasked.reachable,
    "so the two are distinguishable by a field, not by the emptiness of a list"
  );
}

// --- A WORKFLOW THE REPO HAS, BUT WHOSE RUN FELL OFF THE FETCHED PAGE, IS UNKNOWN - NOT ABSENT
// The workflow SET has to come from the repo itself (`gh workflow list`), not from whichever
// names happen to appear in the rows this reader was handed - otherwise a workflow that runs
// rarely on the default branch can have its one relevant run pushed off a fixed-size page by
// unrelated churn, and simply vanish from the readout instead of being reported as unmeasured.
{
  const knownWorkflows = ["app-lane", "nightly-app-lane"];
  const health = projectCiHealth({
    name: "helm",
    rows: [run({ workflowName: "app-lane", conclusion: "success" })],
    branch: "main",
    knownWorkflows,
  });
  ok(health.workflows.length === 2, `both known workflows are reported, not just the one with a fetched row (${health.workflows.length})`);
  const missing = health.workflows.find((w) => w.workflow === "nightly-app-lane");
  ok(!!missing, "the workflow with no fetched row is present, not dropped");
  ok(missing?.state === CI_STATES.unknown, `and it is unknown rather than silently absent (${missing?.state})`);
  ok(
    /no run of this workflow was found on main/.test(missing?.why || ""),
    `and says why in words naming the branch it looked on (${missing?.why})`
  );
  ok(health.failing.length === 0, "the fetched row's own verdict is unaffected");

  const summary = ciHealthSummary([health]);
  ok(summary.allClear === false, "a workflow this reader could not find a run for withholds the all-clear");
}

// --- THE ALL-CLEAR IS A CLAIM ABOUT HAVING LOOKED -------------------------------------------
{
  const greenProject = projectCiHealth({ name: "helm", rows: [run({ conclusion: "success" })], branch: "main" });
  ok(ciHealthSummary([greenProject]).allClear === true, "one green project is an all-clear");

  const withUnknown = projectCiHealth({ name: "nib", rows: [run({ status: "in_progress", conclusion: null })], branch: "main" });
  ok(
    ciHealthSummary([greenProject, withUnknown]).allClear === false,
    "a single unknown withholds it - the sentence claims a look, so an unfinished look must not earn it"
  );

  const unreachable = projectCiHealth({ name: "brief", reachable: false, error: "offline" });
  ok(
    ciHealthSummary([greenProject, unreachable]).allClear === false,
    "and so does a single project we could not reach"
  );

  ok(ciHealthSummary([]).allClear === false, "and nothing at all is not an all-clear either - it is nothing measured");

  // THE SIZE OF THE CLAIM IS THE SIZE OF THE EVIDENCE. On the real machine 11 of 14 projects
  // have no workflows at all, so a sentence counting everything considered would offer eleven
  // projects' worth of reassurance that nothing measured.
  const noLanes = projectCiHealth({ name: "pompom", rows: [], branch: "main" });
  const mixed = ciHealthSummary([greenProject, noLanes]);
  ok(mixed.considered === 2, `two projects were considered (${mixed.considered})`);
  ok(mixed.withLanes === 1, `and exactly one of them had a lane to look at (${mixed.withLanes})`);
  ok(mixed.allClear === true, "the all-clear still holds - a project with no CI is quiet, not unmeasured");

  const red = projectCiHealth({
    name: "helm",
    rows: [run({ conclusion: "failure" }), run({ workflowName: "pure-tests", conclusion: "failure" })],
    branch: "main",
  });
  const summary = ciHealthSummary([red, greenProject]);
  ok(summary.failing.length === 1, `one project is failing (${summary.failing.length})`);
  // A count of WORKFLOWS, because "3 red" meaning three projects with one red lane each and
  // "3 red" meaning one project with three is the same phrase for different news.
  ok(summary.failingWorkflows === 2, `and two lanes inside it are red (${summary.failingWorkflows})`);
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: passing, failing and could-not-ask are three states, an unknown conclusion never reads as green, and the all-clear requires having looked everywhere."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
