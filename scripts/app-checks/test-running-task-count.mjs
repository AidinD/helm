// A pane's status line counts ITS OWN background subagents, not the window's.
//
// WHY THIS IS THE PROPERTY AND NOT "A NUMBER APPEARS"
// `backgroundTasks` is app-wide - one registry for the whole window, feeding the toolbar badge.
// Printing its size inside a pane's status line would tell pane 2 about work pane 1 started,
// and it would look completely right: a plausible number, in the right place, updating live.
// That is the shape this project keeps being bitten by - a label written in the mechanism's
// voice that the mechanism does not support - so the check that matters is the pane with NO
// subagent showing nothing, not the pane with one showing "1".
//
// The owner is recorded as the launch that spawned the task and resolved through
// resolvePaneForLaunch, the same rule every other launch-to-pane lookup uses. That rule exists
// because a second copy of it once delivered a reply into an unrelated session; this check
// covers the counting, and the identity rule keeps its own coverage elsewhere.
//
// Driven through a real session start and a real Send, with the launcher pointed at the
// fake-claude stub - nothing reaches a model and nothing is spent. The stub emits a
// task_started in the shape launcher.js parses, so the event travels the real path rather
// than being poked into the renderer.
//
// Run:  node scripts/app-checks/test-running-task-count.mjs
// LIVE-EXEMPT: it does start a session, but HELM_CLAUDE_BIN points the launcher at the
// fake-claude stub, so no model is reached and nothing is spent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.HELM_CLAUDE_BIN = path.join(here, "..", "checks-lib", "fixtures", "fake-claude.cmd");
process.env.FAKE_CLAUDE_TASK = "task_stub_0001";
// Long enough that the turn is still running while the assertions look at it - the whole line
// only exists during a turn.
process.env.FAKE_CLAUDE_HOLD_MS = "6000";
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9533";

// A throwaway cwd for the session, so nothing is started in this repo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-taskcount-"));

const { launch } = await import("../checks-lib/harness.mjs");

function log(...a) {
  console.log("[running-task-count-e2e]", ...a);
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
  await app.eval('navigateToPage("chat")');
  await app.waitForSelector("#chatPage", 8000, { visible: true });

  // --- the counting rule, before any UI is involved -----------------------------------------
  // Asserted directly because the interesting cases are hard to stage through two live turns:
  // a task owned by another pane, and one whose launch cannot be resolved at all.
  const rule = await app.eval(`(() => {
    const paneA = panes[0];
    if (!paneA) { return { error: "no pane 0" }; }
    launchPaneHistory.set("launch_A", { index: 0, pane: paneA, startedAt: Date.now() });
    launchPaneHistory.set("launch_GONE", { index: 9, pane: { cliSessionId: null }, startedAt: Date.now() });
    backgroundTasks.set("t_mine", { description: "mine", status: "running", lastToolName: null, startedAt: Date.now(), launchId: "launch_A" });
    backgroundTasks.set("t_finished", { description: "done", status: "completed", lastToolName: null, startedAt: Date.now(), launchId: "launch_A" });
    backgroundTasks.set("t_orphan", { description: "orphan", status: "running", lastToolName: null, startedAt: Date.now(), launchId: "launch_GONE" });
    backgroundTasks.set("t_ownerless", { description: "no owner", status: "running", lastToolName: null, startedAt: Date.now(), launchId: null });
    const mine = runningTasksForPane(0);
    const other = runningTasksForPane(1);
    for (const id of ["t_mine", "t_finished", "t_orphan", "t_ownerless"]) { backgroundTasks.delete(id); }
    launchPaneHistory.delete("launch_A");
    launchPaneHistory.delete("launch_GONE");
    return { mine, other };
  })()`);

  assert(!rule.error, `the rule can be exercised (${JSON.stringify(rule.error || "ok")})`);
  assert(rule.mine === 1, `a pane counts its OWN running subagent, and only the running one (${rule.mine})`);
  assert(
    rule.other === 0,
    `and a DIFFERENT pane counts none of them (${rule.other}) - an app-wide number printed per pane would say 1 here, and look right`
  );

  // --- and it reaches the status line of a real turn ----------------------------------------
  // Driven the way a person does it - fill both inputs and click Send - so the app's own
  // wiring resolves what sendFromPane needs instead of this check guessing at it. The
  // composer textarea carries no class, which is why it is found by tag.
  const sent = await app.eval(`(() => {
    const paneEl = document.querySelector('.pane[data-pane="0"]');
    if (!paneEl) { return { error: "no pane 0 in the DOM" }; }
    const cwd = paneEl.querySelector(".cwd-input");
    const ta = paneEl.querySelector("textarea");
    const send = paneEl.querySelector(".send-btn");
    if (!cwd || !ta || !send) { return { error: "composer parts missing" }; }
    cwd.value = ${JSON.stringify(tmp.replace(/\\\\/g, "/"))};
    ta.value = "say something";
    send.click();
    return { ok: true };
  })()`);
  assert(!sent.error, `a real turn was started (${JSON.stringify(sent.error || "ok")})`);

  // Polled rather than read once: the line is painted by a 250ms ticker, so a single read
  // right after Send is a race the check would lose about as often as it won.
  let line = null;
  for (let waited = 0; waited < 12000 && line === null; waited += 250) {
    line = await app.eval(
      `(() => {
         const el = document.querySelector('.pane[data-pane="0"] .pane-status .pane-live-stats');
         const t = el ? el.textContent : "";
         return /running task/.test(t) ? t : null;
       })()`
    );
    if (line === null) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(
    typeof line === "string" && /1 running task\b/.test(line),
    `the live line names the pane's one running subagent, singular (${JSON.stringify(line)})`
  );
  assert(
    /\d+\.\ds/.test(String(line)),
    `and it sits beside the elapsed time rather than replacing it (${JSON.stringify(line)})`
  );

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  log(exitCode === 0 ? "VERIFY OK: a pane reports its own running subagents and none of anybody else's." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  log("cleanup:", killOut || "(nothing killed)");
}

process.exit(exitCode);
