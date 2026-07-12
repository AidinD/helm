// One-off UX inspection: boot Helm, capture the main daily-loop surfaces both
// empty and with a representative seeded fleet, and dump their rendered text so
// a reviewer can judge flow + copy. NOT a pass/fail test - it screenshots and
// prints. Run: node scripts/e2e/inspect-flow.mjs
import { launch } from "./harness.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "screenshots", "flow-review");

function log(...a) {
  console.log("[inspect]", ...a);
}

const app = await launch();
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  // Give the dashboard a beat to fill from IPC.
  await app.eval("new Promise(r => setTimeout(r, 800))");

  // 1) Dashboard as it boots (likely mostly empty - the start-of-day view).
  await app.screenshot(path.join(OUT, "01-dashboard-boot.png"));
  const dashText = await app.eval(`document.getElementById("dashboardPage").innerText`);
  log("=== DASHBOARD (boot) innerText ===\n" + dashText + "\n=== end ===");

  // 2) Seed a representative daily-loop fleet and render it into the fleet slot.
  //    Two first mates (one busy, one with proposed + created second mates), a
  //    Direct session, crew in every meaningful state (running / done+commits /
  //    escalated / error), plus a PROPOSED (not yet created) second mate.
  await app.eval(`(() => {
    goalRuns.clear();
    const mates = [
      { mateId: "m0", slot: 0, name: "Captain Nemo", sessionId: "s-nemo" },
      { mateId: "m1", slot: 1, name: "Hector Barbossa", sessionId: null },
    ];
    const secondMates = [
      { secondMateId: "sm-helm", firstMateId: "m0", name: "helm", sessionId: "ds-helm", isSessionNode: true, crew: [
        { goalRunId: "c-run", goal: "Bug fix: fleet crew rows have no Done affordance", status: "running", iterations: [{},{}] },
        { goalRunId: "c-done", goal: "Bug fix: collapse button floats mid-head in autopilot", status: "done", commitCount: 5, iterations: [{},{},{}] },
      ] },
      { secondMateId: "sm-jot", firstMateId: "m0", name: "jot", sessionId: null, crew: [
        { goalRunId: "c-esc", goal: "double-encoding self-heal on save", status: "running", escalation: { reason: "needs a design decision" }, iterations: [{},{}] },
        { goalRunId: "c-err", goal: "migrate todos.json schema", status: "error", error: "verify failed", iterations: [{}] },
      ] },
      { secondMateId: "sm-prop", firstMateId: "m1", name: "halyard", sessionId: null, crew: [], status: "proposed", brief: "look at the Antigravity auth spike" },
      { secondMateId: "sm-dir", firstMateId: "direct", name: "loom", sessionId: "ds-loom", isSessionNode: true, crew: [] },
    ];
    document.getElementById("dashFleetSlot").replaceChildren(dashboardFleetSection(mates, secondMates));
    return true;
  })()`);
  await app.eval("new Promise(r => setTimeout(r, 400))");
  await app.screenshot(path.join(OUT, "02-dashboard-fleet.png"));
  const fleetText = await app.eval(`document.getElementById("dashFleetSlot").innerText`);
  log("=== FLEET innerText ===\n" + fleetText + "\n=== end ===");

  // 3) Goal / Autopilot page with runs in several states (expanded).
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("g-run", { goalRunId: "g-run", ordinal: 1, goal: "Wire the crew Done button", projectPath: "D:/Repo/Tools/helm", status: "running", iterations: [{ phase: "implement" }], result: null, error: null, escalation: null, latestPlan: null });
    goalRuns.set("g-done", { goalRunId: "g-done", ordinal: 2, goal: "Force-discard a dirty worktree", projectPath: "D:/Repo/Tools/helm", status: "done", iterations: [{},{},{}], result: { worktreePath: "D:/Repo/Tools/helm-worktrees/goal-x", branchName: "helm/goal-x", stoppedReason: "completed", commitCount: 3 }, error: null, escalation: null, latestPlan: null });
    goalRuns.set("g-esc", { goalRunId: "g-esc", ordinal: 3, goal: "Rework the deriveSecondMates grouping", projectPath: "D:/Repo/Tools/helm", status: "running", iterations: [{},{}], result: null, error: null, escalation: { reason: "ambiguous: two valid groupings, needs the captain" }, latestPlan: null });
    for (const id of goalRuns.keys()) { goalRunExpanded.add(id); }
    navigateToPage("goal");
    renderGoalPage();
    return true;
  })()`);
  await app.waitForSelector("#goalPage", 8000, { visible: true });
  await app.eval("new Promise(r => setTimeout(r, 400))");
  await app.screenshot(path.join(OUT, "03-goal-page.png"));
  const goalText = await app.eval(`document.getElementById("goalPage").innerText`);
  log("=== GOAL PAGE innerText ===\n" + goalText + "\n=== end ===");

  const errors = app.getConsoleErrors();
  log(`console errors: ${errors.length}`);
  for (const e of errors) {
    log("  err:", e.text);
  }
  log("screenshots written to", OUT);
} catch (err) {
  log("ERROR:", err.message);
} finally {
  await app.close();
}
process.exit(0);
