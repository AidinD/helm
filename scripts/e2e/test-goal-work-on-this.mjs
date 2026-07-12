// E2E: a goal's breakdown offers "Work on this", which opens a fresh session
// pre-rooted at the goal's project (resolved from its Jot category) with the
// goal text seeded - the goal -> session launch the Goals surface lacked
// (flow review P1). Real launched Helm; spies on the renderer-global
// openFreshDraftInPane (not the frozen window.helm bridge).
//
// Run:  node scripts/e2e/test-goal-work-on-this.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[goal-work-e2e]", ...a);
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

  // Do everything in ONE eval so a periodic dashboard refresh can't reset
  // state.sessions between steps: seed a repo whose basename matches the goal's
  // category, stub the two side-effecting globals, render the breakdown, click
  // "Work on this", and read what got opened. workOnGoal has no await before
  // openFreshDraftInPane when the project resolves, so the capture is synchronous.
  const out = await app.eval(`(() => {
    state.sessions = state.sessions || [];
    state.sessions.push({ id: "s-testproj", cwd: "D:/Repo/Tools/testproj", title: "t", cliSessionId: "x" });
    window.__opened = null;
    openFreshDraftInPane = (cwd, text) => { window.__opened = { cwd, text }; };
    navigateToPage = () => {};
    const resolved = resolveProjectForGoal({ category: "testproj" });
    const goal = { id: "g1", text: "Wire the thing", category: "testproj", subtaskTotal: 0, subtasks: [] };
    const el = focusGoalBreakdown(goal);
    el.id = "__test_breakdown";
    document.body.appendChild(el);
    const btn = el.querySelector(".focus-work-btn");
    const hasBtn = !!btn && /work on this/i.test(btn.textContent);
    if (btn) { btn.click(); }
    return { resolved, hasBtn, opened: window.__opened };
  })()`);
  assert(/testproj$/.test(out.resolved || ""), `resolveProjectForGoal maps category -> repo (got ${out.resolved})`);
  assert(out.hasBtn, "the breakdown shows a 'Work on this' button");
  assert(out.opened && /testproj$/.test(out.opened.cwd), `Work on this opens a session in the goal's project (got ${JSON.stringify(out.opened)})`);
  assert(out.opened && out.opened.text === "Wire the thing", `the goal text is seeded into the composer (got "${out.opened?.text}")`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Goals can launch work (pre-rooted, seeded)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
