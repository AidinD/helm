// E2E: a failed/escalated goal run is DISCOVERABLE - it shows as a needs-you
// row in the Dashboard queue (click -> Goal) and its block on the Goal page
// carries an attention accent. Real launched Helm via CDP. Injects runs into
// goalRuns and re-renders (no real goal run needed).
//
// Run:  node scripts/e2e/test-goal-attention-queue.mjs
import { launch } from "./harness.mjs";

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
    goalRuns.set("ok", { goalRunId: "ok", ordinal: ++goalRunSeq, goal: "Finished fine", projectPath: "P", status: "done", iterations: [], result: {}, error: null, escalation: null, latestPlan: null });
    return true;
  })()`);

  // Dashboard queue shows the two attention runs as needs-you rows.
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashboardPage .dash-queue-row", 8000);
  // Scope the "needs-you queue" assertions to the queue slot itself. The clean
  // done run legitimately appears elsewhere on the Dashboard now (the Report-back
  // section - see test-report-back.mjs), so checking against the whole page would
  // conflate the two. The point of THIS test is the queue slot's contents.
  const queueText = await app.eval(`document.querySelector("#dashQueueSlot").innerText`);
  // Wording, not rule: the row says "Autopilot run" (the page it points at is called
  // Autopilot) with a plain hyphen, not "Goal run —". What is being tested is that a
  // failed run and an escalated one are both IN the needs-you queue.
  assert(/Autopilot run "Broken build goal" - failed/.test(queueText), "errored run shows a 'failed' needs-you row in the dashboard queue");
  assert(/Autopilot run "Ambiguous goal" - paused, needs you/.test(queueText), "escalated run shows a 'paused, needs you' row");
  assert(!/Finished fine/.test(queueText), "the clean done run is NOT in the needs-you queue");

  // Clicking a goal-run row navigates to the Goal facet.
  const clicked = await app.eval(`(() => {
    const rows = [...document.querySelectorAll('#dashboardPage .dash-queue-row')];
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
  // And the clean one is NOT marked - an attention mark on everything marks nothing.
  const cleanMarked = await app.eval(`[...document.querySelectorAll("#goalPage .goal-run-summary-needs, #goalPage .goal-run-detail-attention")]
    .some((el) => /Finished fine/.test(el.textContent))`);
  assert(!cleanMarked, "and the run that finished fine is not marked");

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
