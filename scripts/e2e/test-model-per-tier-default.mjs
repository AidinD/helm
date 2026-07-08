// E2E: model-per-tier default - a first-mate/orchestrator session defaults its
// model pill to Sonnet (delegate/summarize tier), while a normal session stays
// "auto". Still user-overridable. Real launched Helm.
//
// Run:  node scripts/e2e/test-model-per-tier-default.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[model-per-tier-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof openFreshDraftInPane === "function"`)) {
      break;
    }
    await wait(100);
  }

  // A first-mate/orchestrator draft defaults the model pill to Sonnet.
  await app.eval(`(() => { openFreshDraftInPane("D:/Repo/Tools/helm", "test", { paneOverrides: { isOrchestrator: true, modelDefault: "claude-sonnet-5" } }); return true; })()`);
  await wait(400);
  const orchModel = await app.eval(`(panes.find(p => p && p.isOrchestrator)?.els?.modelDD?.value) || null`);
  assert(orchModel === "claude-sonnet-5", "orchestrator/first-mate session defaults model to Sonnet (got: " + JSON.stringify(orchModel) + ")");

  // A plain fresh draft (no override) stays "auto".
  await app.eval(`(() => { openFreshDraftInPane("D:/Repo/Tools/helm", "test2", {}); return true; })()`);
  await wait(400);
  const plainModel = await app.eval(`(() => { const p = panes.find(p => p && !p.isOrchestrator && p.els); return p?.els?.modelDD?.value || null; })()`);
  assert(plainModel === "auto", "a normal session stays on 'auto' (got: " + JSON.stringify(plainModel) + ")");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: first-mate defaults to Sonnet, others to auto." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
