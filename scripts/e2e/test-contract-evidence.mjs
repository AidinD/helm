// E2E: R7 - an Autopilot iteration surfaces its delegation contract (the exact
// prompt) and its verify evidence (command + output behind the pass/fail
// badge), and each run states it runs fresh-context per iteration. So a green
// result is backed by visible proof, not a bare badge. Real launched Helm/CDP.
//
// Run:  node scripts/e2e/test-contract-evidence.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[contract-evidence-e2e]", ...a);
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

const PROMPT = "Overall goal: add a dark-mode toggle. Work on the smallest next step.";

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // #pageToggle is static markup in index.html, so it can exist before
  // renderer.js has finished executing (and defined navigateToPage). Wait for
  // renderer readiness before driving it.
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof navigateToPage === "function"`)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });

  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("r1", {
      goalRunId: "r1", ordinal: ++goalRunSeq, goal: "Add a dark-mode toggle", projectPath: "P",
      status: "done", result: { success: true, summary: "done", stoppedReason: "completed" },
      error: null, escalation: null, latestPlan: null,
      iterations: [{
        iteration: 1, phase: "implement", ok: true, committed: true,
        result: { success: true, summary: "Added toggle", keyChanges: [], keyLearnings: [] },
        contract: ${JSON.stringify(PROMPT)},
        verify: { command: "npm test", passed: true, output: "12 tests passed" }
      }]
    });
    renderGoalPage();
    return true;
  })()`);
  await app.waitForSelector("#goalPage .goal-iter-card", 8000);

  assert((await count("#goalPage .goal-contract-block")) === 1, "the delegation contract block renders on the iteration");
  const contractText = await app.eval(`document.querySelector("#goalPage .goal-contract-content")?.textContent || ""`);
  assert(contractText === PROMPT, "the contract block shows the exact prompt sent to the iteration");

  assert((await count("#goalPage .goal-verify-block")) === 1, "the verify-evidence block renders");
  const verifySummary = await app.eval(`document.querySelector("#goalPage .goal-verify-block > summary")?.textContent || ""`);
  assert(/passed/.test(verifySummary), "verify evidence summary reflects pass/fail");
  const verifyOut = await app.eval(`document.querySelector("#goalPage .goal-verify-content")?.textContent || ""`);
  assert(/12 tests passed/.test(verifyOut), "verify evidence shows the captured command output");

  assert((await count("#goalPage .goal-fresh-context-note")) === 1, "the run states iterations run in fresh context");

  // Copy button on the contract copies without toggling the <details> open state.
  const beforeOpen = await app.eval(`document.querySelector("#goalPage .goal-contract-block").open`);
  await app.eval(`document.querySelector("#goalPage .goal-contract-block .copy-btn").click()`);
  const afterOpen = await app.eval(`document.querySelector("#goalPage .goal-contract-block").open`);
  assert(beforeOpen === afterOpen, "clicking copy does not toggle the contract details open/closed");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: contract + verify evidence + fresh-context note render." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
