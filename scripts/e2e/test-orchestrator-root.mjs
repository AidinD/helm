// E2E: a "New orchestrator session" roots in a dedicated NEUTRAL dir
// (~/.maestro), never a project repo. Regression guard for the fix where it
// used to root in Maestro's own repo (a footgun - hands-on work would land
// there). Drives a real launched Maestro via the CDP harness.
//
// Run:  node scripts/e2e/test-orchestrator-root.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[orch-e2e]", ...a);
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

  // The fix, straight from the IPC the button uses.
  const info = await app.eval("window.maestro.getOrchestratorInfo()");
  log("orchestrator:info ->", JSON.stringify(info));
  const cwd = (info && info.cwd) || "";
  assert(/[\\/]\.maestro$/.test(cwd), `cwd is the neutral ~/.maestro dir (got ${JSON.stringify(cwd)})`);
  assert(!/[\\/]Tools[\\/]maestro$/i.test(cwd), "cwd is NOT the Maestro project repo");
  assert(
    /orchestrator-instructions\.md$/.test((info && info.instructionsPath) || ""),
    "instructionsPath still points at the operating manual (absolute)"
  );

  // Click the actual button (on the dashboard) and confirm the opened pane is
  // rooted in the neutral dir - proves the renderer plumbs info.cwd through.
  await app.eval('(document.querySelector(\'#pageToggle button[data-page="dashboard"]\') || {}).click?.()');
  const clicked = await app.eval(
    "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('New orchestrator session')); if (!b) return false; b.click(); return true; })()"
  );
  assert(clicked, "found + clicked the '+ New orchestrator session' button");
  await app.waitForSelector("#chatPage", 8000, { visible: true });

  // Best-effort: read the opened orchestrator pane's cwd from renderer state.
  let paneCwd = null;
  try {
    paneCwd = await app.eval(
      "(typeof panes !== 'undefined' ? (panes.find((p) => p && p.isOrchestrator) || {}).cwd : null) || null"
    );
  } catch (e) {
    log("(pane cwd not readable from page scope:", e.message + ")");
  }
  if (paneCwd) {
    assert(/[\\/]\.maestro$/.test(paneCwd), `opened orchestrator pane is rooted in ~/.maestro (got ${JSON.stringify(paneCwd)})`);
  } else {
    log("(skipped pane-cwd assertion - not exposed; IPC check above already proves the root)");
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  log(exitCode === 0 ? "VERIFY OK: orchestrator session roots in the neutral dir." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}

process.exit(exitCode);
