// A lane missing from the fetched page of runs is not automatically a gap - it might just have
// fallen off a 40-row page, or it might genuinely never run on this branch. readProjectCi (in
// src/main.js) asks `gh` directly about each missing lane and hands the answers here; this is
// the DECISION about what those answers mean, pulled out as a pure function so it is reachable
// from a test instead of only from a real `gh` process on a real machine.
//
// WHY THIS CHECK IS THE POINT. The first version left four permanent "not known" rows on the
// real machine: lanes that had a verdict but were never asked, forever unknown. The fix folds a
// targeted ask's answer back in - but a fix built to stop under-reporting can just as easily
// over-correct into its own mirror bug: rounding "could not ask" into "not applicable" would
// make a failed lookup disappear exactly the way a failed CI read must never disappear elsewhere
// in this module. So the case that matters most below is the one where the ask itself failed.
//
// Run: node scripts/pure-checks/test-resolve-missing-lanes.mjs
import { resolveMissingLanes } from "../../src/lib/ciHealth.js";

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

// --- a lane already on the fetched page is untouched, whatever `asked` says about it --------
{
  const rows = [run({ workflowName: "app-lane" })];
  const result = resolveMissingLanes({
    knownWorkflows: ["app-lane"],
    rows,
    asked: { "app-lane": { ok: true, rows: [] } },
  });
  ok(result.rows.length === 1 && result.rows[0] === rows[0], "the already-present row is not duplicated or replaced");
  ok(result.knownWorkflows.includes("app-lane"), "and the workflow stays known");
}

// --- missing lane, targeted ask found a run: folded into rows, a real verdict is now reachable
{
  const foundRun = run({ workflowName: "nightly-lane", url: "found-on-targeted-ask" });
  const result = resolveMissingLanes({
    knownWorkflows: ["app-lane", "nightly-lane"],
    rows: [run({ workflowName: "app-lane" })],
    asked: { "nightly-lane": { ok: true, rows: [foundRun] } },
  });
  ok(result.rows.some((r) => r.url === "found-on-targeted-ask"), "the run the targeted ask found is folded into rows");
  ok(result.knownWorkflows.includes("nightly-lane"), "and the lane it belongs to stays known so it gets classified");
}

// --- missing lane, targeted ask came back empty: this lane has never run here, so it is dropped
{
  const result = resolveMissingLanes({
    knownWorkflows: ["app-lane", "release-only"],
    rows: [run({ workflowName: "app-lane" })],
    asked: { "release-only": { ok: true, rows: [] } },
  });
  ok(!result.knownWorkflows.includes("release-only"), "a lane confirmed to have never run on this branch is dropped, not shown as a gap");
  ok(result.rows.length === 1, "and nothing was added to rows for it");
}

// --- missing lane, the targeted ask ITSELF FAILED: must stay known, so it still reads unknown -
// This is the guard against the feature's own sin with the sign flipped: a failed lookup must
// never be rounded down to "not applicable" just because asking failed instead of succeeding.
{
  const failedAsk = resolveMissingLanes({
    knownWorkflows: ["app-lane", "flaky-lane"],
    rows: [run({ workflowName: "app-lane" })],
    asked: { "flaky-lane": { ok: false } },
  });
  ok(failedAsk.knownWorkflows.includes("flaky-lane"), "a lane whose targeted ask failed stays in the known set");
  ok(failedAsk.rows.length === 1, "and nothing fabricated is added to rows for it");

  // Same outcome when the caller never got an answer for it at all (e.g. it threw before
  // recording anything) - absence from `asked` must not be silently treated as "never runs here".
  const noAnswer = resolveMissingLanes({
    knownWorkflows: ["app-lane", "flaky-lane"],
    rows: [run({ workflowName: "app-lane" })],
    asked: {},
  });
  ok(noAnswer.knownWorkflows.includes("flaky-lane"), "and a lane with no recorded answer at all also stays known");
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: a lane already on the page is untouched, a targeted ask that finds a run earns a verdict, one confirmed absent is dropped, and one the ask itself failed on stays unknown rather than being rounded to not-applicable."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
