// E2E: a failed/escalated goal run is DISCOVERABLE - it shows as a needs-you
// row in the Dashboard queue (click -> Goal) and its block on the Goal page
// carries an attention accent. Real launched Helm via CDP. Injects runs into
// goalRuns and re-renders (no real goal run needed).
//
// Run:  node scripts/e2e/test-goal-attention-queue.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[goal-attn-queue-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const isHidden = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.classList.contains("hidden")`);
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Inject one errored run, one escalated run, one clean done run.
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("err", { goalRunId: "err", ordinal: ++goalRunSeq, goal: "Broken build goal", projectPath: "P", status: "error", iterations: [], result: null, error: "npm build failed", escalation: null, latestPlan: null });
    goalRuns.set("esc", { goalRunId: "esc", ordinal: ++goalRunSeq, goal: "Ambiguous goal", projectPath: "P", status: "running", iterations: [], result: null, error: null, escalation: { reason: "ambiguity" }, latestPlan: null });
    // A run that finished cleanly needs a REAL terminal shape: a stoppedReason and the
    // commits it produced. This used to be \`result: {}\`, which cannot occur - the goal
    // loop always sets a stoppedReason (it initialises to max_iterations_reached), and
    // all 42 runs in the real history carry one, rehydrated ones included. Once "the
    // loop ended" stopped meaning "the goal was met" (src/lib/runOutcome.js), a result
    // with no stoppedReason correctly classifies as \`unknown\` and asks to be looked at,
    // so the empty fixture was asserting that an unnameable outcome should be treated as
    // success - the exact thing that made 22 of 23 crew reports claim they had worked.
    goalRuns.set("ok", { goalRunId: "ok", ordinal: ++goalRunSeq, goal: "Finished fine", projectPath: "P", status: "done", iterations: [], result: { stoppedReason: "no_op_convergence", commitCount: 2, branchName: "helm/goal-ok" }, error: null, escalation: null, latestPlan: null });
    return true;
  })()`);

  // The needs-you queue survives as the Needs-you widget's body (widgetBodyNeedsYou
  // -> dashboardQueueSection). The classic #dashQueueSlot went with the section
  // stack (task 337895ce), so render the SAME content function into a probe and
  // scope the queue assertions to it - the clean done run legitimately appears
  // elsewhere on the Dashboard now (a captain report roll-up), so a whole-page
  // check would conflate the two. This mirrors test-direct-report-rollup's probe.
  await app.eval(`(() => {
    document.querySelectorAll("#queueProbe").forEach((n) => n.remove());
    const host = document.createElement("div");
    host.id = "queueProbe";
    document.body.append(host);
    host.append(dashboardQueueSection());
    return true;
  })()`);
  await app.waitForSelector("#queueProbe .dash-queue-row", 8000);
  const queueText = await app.eval(`document.querySelector("#queueProbe").innerText`);
  // Wording, not rule: the row says "Autopilot run" (the page it points at is called
  // Autopilot) with a plain hyphen, not "Goal run —". What is being tested is that a
  // failed run and an escalated one are both IN the needs-you queue.
  assert(/Autopilot run "Broken build goal" - failed/.test(queueText), "errored run shows a 'failed' needs-you row in the dashboard queue");
  assert(/Autopilot run "Ambiguous goal" - paused, needs you/.test(queueText), "escalated run shows a 'paused, needs you' row");
  assert(!/Finished fine/.test(queueText), "the clean done run is NOT in the needs-you queue");

  // Clicking a goal-run row navigates to the Goal facet.
  const clicked = await app.eval(`(() => {
    const rows = [...document.querySelectorAll('#queueProbe .dash-queue-row')];
    const r = rows.find((x) => /failed/.test(x.textContent));
    if (r) { r.click(); return true; }
    return false;
  })()`);
  assert(clicked, "found and clicked the failed-run queue row");
  await app.waitForSelector("#goalPage", 8000, { visible: true });
  assert(!(await isHidden("goalPage")), "clicking the row navigates to the Goal page");

  // On the Goal page the three seeded runs render, and the errored + escalated
  // ones carry the attention accent. NOTE: goalRuns is rehydrated from the real
  // goal-run-history.json on load, so on a machine with prior runs the page
  // legitimately shows MORE than the three seeded here (that's why we assert
  // presence + a lower bound, not exact totals - the exact-count version was
  // fragile to a populated history, unrelated to any feature).
  // A TERMINAL run renders collapsed to a one-line summary now (b72fcd1f, so the list
  // stays scannable) - only live/escalated/deep-linked runs expand. So the errored run
  // is a summary row and the escalated one is a detail block, and counting detail
  // accents alone would report the errored run as unmarked when it is marked in the
  // shape it actually has. What matters is that BOTH are marked, in whichever shape
  // they render.
  const attentionBlocks = await count("#goalPage .goal-run-detail-attention");
  const attentionSummaries = await count("#goalPage .goal-run-summary-needs");
  const totalBlocks = await count("#goalPage .goal-run-detail, #goalPage .goal-run-summary");
  const goalText = await app.eval(`document.getElementById("goalPage").innerText`);
  log(`goal blocks: ${totalBlocks}, attention: ${attentionBlocks} expanded + ${attentionSummaries} collapsed`);
  assert(
    ["Broken build goal", "Ambiguous goal", "Finished fine"].every((g) => goalText.includes(g)),
    "all three seeded runs render on the Goal page"
  );
  assert(
    attentionBlocks + attentionSummaries >= 2,
    `both the errored and the escalated run are marked as needing you (got ${attentionBlocks} expanded + ${attentionSummaries} collapsed)`
  );
  // An attention mark on everything marks nothing - so what matters is that the marks
  // DISCRIMINATE, which is what this now asserts.
  //
  // It used to assert the clean run carried no mark at all, with a `result: {}` fixture.
  // Two things changed. The fixture became a real terminal shape (see the seed above),
  // and a converged run with commits carries "ready for review" - which it did before
  // this too, from commitCount, so that half is not new. What IS new: a run that
  // converged having committed NOTHING no longer reads as done (runOutcome.js), because
  // "the loop ended" was being reported as "the goal was met" on 22 of 23 real crew
  // reports. That is a deliberate widening, per the standing rule that under-flagging an
  // attention signal is the worse failure.
  //
  // The load-bearing check is the one further up: the Dashboard's needs-you queue - the
  // surface actually scanned for "what wants me" - still excludes this run. The Goal page
  // is the per-run detail list, where "2 commits waiting" is information, not an alarm.
  const cleanMark = await app.eval(`(() => {
    const el = [...document.querySelectorAll("#goalPage .goal-run-summary-needs, #goalPage .goal-run-detail-attention")]
      .find((e) => /Finished fine/.test(e.textContent));
    return el ? el.textContent : null;
  })()`);
  assert(
    !cleanMark || /(commit|✓)/.test(cleanMark),
    `the run that finished fine is either unmarked or marked only as review-ready - the check glyph and its commit count, never an alarm (got: ${cleanMark ? cleanMark.slice(0, 70) : "unmarked"})`
  );
  assert(
    !cleanMark || !/(did NOT reach|failed|ran out|unrecognised)/i.test(cleanMark),
    "and its mark carries none of the failure language, so the kinds stay distinguishable at a glance"
  );

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: failed/paused runs are discoverable (queue row -> Goal) + accented." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
