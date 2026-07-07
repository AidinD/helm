// E2E: the Dashboard Fleet renders the corrected orchestration hierarchy as
// three columns - two named first mates (sessions) + Direct; second mates
// (project sessions) branch under a first mate; crew (autonomous runs) sit under
// a second mate; a dual-trigger retire nudge appears when a mate's work is
// wrapped. Drives dashboardFleetSection directly with controlled data (second
// mates are otherwise derived from persisted run history). Real launched Maestro.
//
// Run:  node scripts/e2e/test-fleet-view.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[fleet-view-e2e]", ...a);
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
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof dashboardFleetSection === "function"`)) {
      break;
    }
    await wait(100);
  }

  // Land on the dashboard and let its async fill (IPC fetch of mates +
  // secondMates) settle FIRST - otherwise it lands ~300ms later and replaces
  // our controlled injection with the real derived fleet (a real race the first
  // run of this test caught).
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashFleetSlot", 8000);
  await wait(1200);

  // Render the fleet with controlled mates + second mates + crew:
  //  - Nemo (slot 0): one BUSY second mate (live crew) -> no retire nudge.
  //  - Barbossa (slot 1): one second mate whose crew is done with no commits and
  //    nothing awaiting the captain -> WORK WRAPPED -> a 'done' retire nudge.
  //  - Direct: one project session, no crew.
  await app.eval(`(() => {
    goalRuns.clear();
    const mates = [
      { mateId: "m0", slot: 0, name: "Captain Nemo", sessionId: null },
      { mateId: "m1", slot: 1, name: "Hector Barbossa", sessionId: null },
    ];
    const secondMates = [
      { secondMateId: "s1", firstMateId: "m0", name: "tgs-reinmaker", sessionId: null, crew: [
        { goalRunId: "c1", goal: "Antigravity auth spike", status: "running", iterations: [{},{}] } ] },
      { secondMateId: "s2", firstMateId: "m1", name: "jot", sessionId: null, crew: [
        { goalRunId: "c2", goal: "double-encoding self-heal", status: "done", commitCount: 0, iterations: [{},{}] } ] },
      { secondMateId: "s3", firstMateId: "direct", name: "maestro", sessionId: null, crew: [] },
    ];
    document.getElementById("dashFleetSlot").replaceChildren(dashboardFleetSection(mates, secondMates));
    return true;
  })()`);
  await wait(250);

  assert((await count("#dashFleetSlot .fleet-cols")) === 1, "the fleet renders as a column grid");
  assert((await count("#dashFleetSlot .fleet-col")) === 3, "three columns (two first mates + Direct)");
  assert((await count("#dashFleetSlot .fleet-mate-card")) === 3, "three mate cards total");
  assert((await count("#dashFleetSlot .fleet-mate-card.direct")) === 1, "one of them is the Direct card");

  const names = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-mate-name2")].map(e => e.textContent)`);
  assert(names.includes("Captain Nemo") && names.includes("Hector Barbossa"), "both first mates render by name (got: " + JSON.stringify(names) + ")");
  assert(names.includes("Captain"), "the Direct card is titled Captain");

  // Second mates branch under their first mate.
  const projs = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-branch-proj")].map(e => e.textContent)`);
  assert(projs.includes("tgs-reinmaker") && projs.includes("jot") && projs.includes("maestro"), "second mates render under their columns (got: " + JSON.stringify(projs) + ")");

  // Crew under a second mate (rendered even while collapsed).
  assert((await count("#dashFleetSlot .fleet-crew-item")) === 2, "crew items render under their second mates");
  assert((await count("#dashFleetSlot .fleet-badge.run")) >= 1, "a second mate with live crew shows a 'busy' badge");
  assert((await count("#dashFleetSlot .fleet-spin")) >= 1, "live crew shows the working spinner");

  // Dual-trigger nudge: Barbossa's crew is wrapped (done, no commits, nothing
  // awaiting) -> a 'work wrapped' retire nudge with a retire button.
  assert((await count("#dashFleetSlot .fleet-nudge.done")) === 1, "a work-wrapped mate shows the 'work wrapped' retire nudge");
  assert((await count("#dashFleetSlot .fleet-nudge.ctx")) === 0, "no context nudge when no session is open/saturated");
  assert((await count("#dashFleetSlot .fleet-retire-btn")) === 1, "the nudge carries a Retire & respawn button");

  // Jump-in handlers exist (clicking a mate card / second mate opens a session).
  assert(await app.eval(`typeof jumpIntoFirstMate === "function" && typeof jumpIntoSecondMate === "function"`), "jump-in handlers are wired");

  // Header controls + Direct start-session button.
  assert((await count("#dashFleetSlot .fleet-mate-card:not(.direct) .fleet-icon-btn")) >= 4, "each first mate has rename + retire icons");
  assert((await count("#dashFleetSlot .fleet-start-btn")) === 1, "the Direct column has a start-session button");
  assert((await count("#dashFleetSlot .fleet-mate-card .fleet-retire-btn")) === 1, "the work-wrapped mate's nudge offers a retire button");

  // Trigger layer 3: re-render with an URGENT queued task on the work-wrapped
  // mate's project -> the nudge dampens to 'hold' with no retire button.
  await app.eval(`(() => {
    const mates = [ { mateId:"m0", slot:0, name:"Captain Nemo", sessionId:null }, { mateId:"m1", slot:1, name:"Hector Barbossa", sessionId:null } ];
    const secondMates = [ { secondMateId:"s2", firstMateId:"m1", name:"jot", projectPath:"D:/Repo/jot", sessionId:null, crew:[ { goalRunId:"c2", goal:"self-heal", status:"done", commitCount:0, iterations:[{}] } ] } ];
    const board = { "D:/Repo/jot": { matched:true, category:"Jot", open:1, inProgress:0, minActivePriority:-3 } };
    document.getElementById("dashFleetSlot").replaceChildren(dashboardFleetSection(mates, secondMates, board));
    return true;
  })()`);
  await wait(200);
  assert((await count("#dashFleetSlot .fleet-nudge.hold")) === 1, "an urgent queued task dampens the work-wrapped nudge to 'hold'");
  assert((await count("#dashFleetSlot .fleet-nudge.hold .fleet-retire-btn")) === 0, "the dampened 'hold' nudge offers no retire button");
  assert((await count("#dashFleetSlot .fleet-nudge.done")) === 0, "the 'done' nudge is suppressed while urgent work is queued");

  // Jump-in bug fix: a second mate with no bound session resumes the most recent
  // EXISTING session in its project (not a fresh one). Verify the resolver.
  const mru = await app.eval(`(() => {
    const saved = state.sessions;
    state.sessions = [
      { sessionId:"S1", cliSessionId:"S1", cwd:"D:/Repo/jot", status:"idle", lastActivityAt:100 },
      { sessionId:"S2", cliSessionId:"S2", cwd:"D:/Repo/jot", status:"idle", lastActivityAt:200 },
      { sessionId:"S3", cliSessionId:"S3", cwd:"D:/Repo/jot", status:"archived", lastActivityAt:999 },
    ];
    const hit = mostRecentSessionForCwd("D:/Repo/jot");
    const none = mostRecentSessionForCwd("D:/Repo/does-not-exist");
    state.sessions = saved;
    return { hit: hit && hit.sessionId, none };
  })()`);
  assert(mru.hit === "S2", "jump-in resolves the most recent NON-archived session for a project cwd (got " + JSON.stringify(mru) + ")");
  assert(mru.none === null, "an unknown cwd resolves to null (would then open fresh)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: three-column fleet, second mates under first mates, crew, work-wrapped nudge." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
