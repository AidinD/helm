// E2E: the crew report-back nudge only carries work that landed SINCE the mate's last turn.
//
// THE INCIDENT, 2026-08-18. Aidin opened his crewline second mate and found this pasted
// into it: "Your dispatched crew reported back 27 runs ... MERGE the solid ones into the
// main branch", followed by 27 crew briefs quoted in full - several of them page-length.
// Most of those runs were days old and already merged to master. An instruction to
// re-merge finished work is not noise, it is a hazard.
//
// Three separate faults in one function: it filtered on "unacknowledged" (which nobody
// ever clears) rather than on recency, it quoted r.goal untruncated, and its headline
// counted ALL matches while listing only REPORT_BACK_LIMIT of them - so it announced 27
// and showed 6 with no hint the rest existed.
//
// Real launched Helm via CDP, calling the renderer's own function against seeded state -
// the nudge is a pure function of goalRuns + state.sessions, so this exercises the real
// code path rather than a re-implementation of it.
//
// Run:  node scripts/e2e/test-crew-nudge-scoped.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[crew-nudge-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const P = "D:\\\\Repo\\\\Fake\\\\proj";
  const LAST_LOOK = 2000000;
  const LONG_GOAL = "x".repeat(4000);

  // Ten runs finished BEFORE the mate's last turn, three after it. Ten is above
  // REPORT_BACK_LIMIT on purpose: if recency were ignored, the old ones alone would fill
  // the list and the assertions below could not tell the two failures apart.
  const seeded = await app.eval(`(() => {
    goalRuns.clear();
    const mk = (id, finishedAt, goal) => goalRuns.set(id, {
      goalRunId: id, ordinal: ++goalRunSeq, goal, projectPath: ${JSON.stringify(P)},
      status: "done", iterations: [], error: null, escalation: null, latestPlan: null,
      finishedAt,
      result: { stoppedReason: "no_op_convergence", commitCount: 2, branchName: "helm/goal-" + id },
    });
    for (let i = 0; i < 10; i++) { mk("old" + i, ${LAST_LOOK} - 100000 - i, "old work " + i); }
    mk("new1", ${LAST_LOOK} + 1000, ${JSON.stringify(LONG_GOAL)});
    mk("new2", ${LAST_LOOK} + 2000, "recent work two");
    mk("new3", ${LAST_LOOK} + 3000, "recent work three");
    state.sessions = [{ sessionId: "S-mate", cliSessionId: "S-mate", cwd: ${JSON.stringify(P)}, lastActivityAt: ${LAST_LOOK}, isArchived: false }];
    return goalRuns.size;
  })()`);
  assert(seeded === 13, `seeded 13 runs (got ${seeded})`);

  const SM = `{ secondMateId: "sm_test", firstMateId: "direct", projectPath: ${JSON.stringify(P)}, sessionId: "S-mate" }`;
  const nudge = await app.eval(`pendingSecondMateReviewNudge(${SM})`);

  assert(typeof nudge === "string" && nudge.length > 0, "a mate with fresh crew still gets a nudge");
  for (const id of ["new1", "new2", "new3"]) {
    assert(nudge.includes("helm/goal-" + id), `the run that landed after its last turn IS included (${id})`);
  }
  const oldLeaks = ["old0", "old1", "old2", "old3", "old4", "old5", "old6", "old7", "old8", "old9"].filter((id) => nudge.includes("helm/goal-" + id));
  assert(oldLeaks.length === 0, `NOTHING it has already sat through leaks in (leaked: ${oldLeaks.join(", ") || "none"})`);

  // The count in the sentence must equal what is actually listed - the old one did not.
  const claimed = Number((nudge.match(/(\d+) crew runs? reported back/) || [])[1]);
  const listed = (nudge.match(/^- /gm) || []).length;
  assert(claimed === 3 && listed === 3, `the headline count matches the list (says ${claimed}, lists ${listed})`);
  assert(!/\b27\b/.test(nudge) && !/reported back 13/.test(nudge), "and it never counts runs it is not showing");

  // A page-length brief must not be pasted whole.
  assert(!nudge.includes("x".repeat(200)), `a 4000-character crew brief is truncated, not quoted whole (nudge is ${nudge.length} chars)`);
  assert(nudge.includes("…"), "and the truncation is visible rather than silent");
  assert(nudge.length < 4000, `the whole nudge stays small (${nudge.length} chars)`);

  // The dangerous instruction, made safe.
  assert(/already merged/i.test(nudge), "it tells the mate to skip branches that are already merged - the specific hazard that fired");
  assert(/don't trust the run's own claim/i.test(nudge), "and still refuses to take a run's self-report at face value");

  // Overflow must be declared, not silently dropped.
  const overflow = await app.eval(`(() => {
    for (let i = 0; i < 8; i++) {
      goalRuns.set("burst" + i, { goalRunId: "burst" + i, ordinal: ++goalRunSeq, goal: "burst " + i, projectPath: ${JSON.stringify(P)},
        status: "done", iterations: [], error: null, escalation: null, latestPlan: null, finishedAt: ${LAST_LOOK} + 5000 + i,
        result: { stoppedReason: "no_op_convergence", commitCount: 1, branchName: "helm/goal-burst" + i } });
    }
    return pendingSecondMateReviewNudge(${SM});
  })()`);
  const burstListed = (overflow.match(/^- /gm) || []).length;
  assert(burstListed === 6, `at most REPORT_BACK_LIMIT runs are listed (got ${burstListed})`);
  assert(/older ones? not listed/.test(overflow), "and the ones it left out are declared rather than silently dropped");

  // A mate that has never had a turn is the blank-session case this nudge exists for:
  // everything unacknowledged is genuinely news to it, so recency must not empty it.
  const fresh = await app.eval(`pendingSecondMateReviewNudge({ secondMateId: "sm_fresh", firstMateId: "direct", projectPath: ${JSON.stringify(P)}, sessionId: null })`);
  assert(typeof fresh === "string" && fresh.length > 0, "a mate with no session yet still gets briefed - scoping by recency must not reintroduce the blank second mate");

  // And nothing waiting means nothing said.
  const empty = await app.eval(`(() => { goalRuns.clear(); return pendingSecondMateReviewNudge(${SM}); })()`);
  assert(empty === "", "no crew waiting -> no nudge at all");

  const errs = await app.eval(`(window.__helmConsoleErrors || []).length`);
  assert(!errs, `no console errors (got ${errs})`);
} finally {
  await app.close();
}

log(exitCode === 0 ? "VERIFY OK: the nudge carries only what landed since the mate's last turn, truncated, counted honestly, and never asks it to re-merge finished work." : "VERIFY FAILED.");
process.exit(exitCode);
