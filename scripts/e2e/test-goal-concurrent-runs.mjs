// E2E: the Goal page supports (a) model/effort selection on the launcher, and
// (b) several concurrent goal runs rendered as distinct blocks. Real launched
// Helm via CDP. To avoid spawning real autonomous claude subprocesses, this
// injects fake run entries into the renderer's goalRuns map and re-renders -
// exercising the concurrent-rendering path (goalRunDetailEl) directly.
//
// Run:  node scripts/e2e/test-goal-concurrent-runs.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[goal-concurrent-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });

  // (a) The launcher has a model + effort selector (two dropdown pills in the
  //     model row), reusing the composer's dropdownPill component.
  const modelRowPills = await count("#goalPage .goal-model-row .meta-pill");
  assert(modelRowPills === 2, `launcher has model + effort pills (got ${modelRowPills})`);

  // (b) Inject two concurrent runs and re-render; both must show as distinct
  //     run blocks with their own ordinal + cancel button.
  await app.eval(`(() => {
    goalRuns.clear();
    for (const [id, goal] of [["fake-1","First fake goal for E2E"],["fake-2","Second fake goal for E2E"]]) {
      goalRuns.set(id, { goalRunId: id, ordinal: ++goalRunSeq, goal, projectPath: "X", maxIterations: 5, model: undefined, effort: undefined, verifyCommand: "", escalationConfig: undefined, status: "running", iterations: [], result: null, error: null, escalation: null, latestPlan: null });
    }
    renderGoalPage();
    return true;
  })()`);

  const runBlocks = await count("#goalPage .goal-run-detail");
  assert(runBlocks === 2, `two concurrent run blocks rendered (got ${runBlocks})`);
  const cancelBtns = await count("#goalPage .goal-run-detail .goal-cancel-btn");
  assert(cancelBtns === 2, `each running run has its own cancel button (got ${cancelBtns})`);
  const titles = await app.eval(`[...document.querySelectorAll("#goalPage .goal-run-title")].map(e => e.textContent)`);
  log("run titles:", JSON.stringify(titles));
  assert(
    titles.length === 2 && titles.every((t) => /^Run \d+: /.test(t)),
    "run blocks are labelled 'Run N: <goal>' so concurrent runs are tellable apart"
  );

  // (c) The Agents page lists both in-motion goal runs.
  await app.eval(`(() => { navigateToPage("agents"); return true; })()`);
  await app.waitForSelector("#agentsPage", 8000, { visible: true });
  const agentNodes = await count("#agentsPage .tree-wrap > *");
  log(`agents tree top-level nodes: ${agentNodes}`);
  assert(agentNodes >= 2, "Agents page shows both concurrent goal runs (>= 2 nodes)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: model/effort selectors + concurrent goal runs render." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
