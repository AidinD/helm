// E2E: the Dashboard Fleet renders the corrected orchestration hierarchy as
// three columns - two named first mates (sessions) + Direct; second mates
// (project sessions) branch under a first mate; crew (autonomous runs) sit under
// a second mate; a dual-trigger retire nudge appears when a mate's work is
// wrapped. Drives dashboardFleetSection directly with controlled data (second
// mates are otherwise derived from persisted run history). Real launched Helm.
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
      { secondMateId: "s3", firstMateId: "direct", name: "helm", sessionId: "ds3", crew: [], isSessionNode: true },
      { secondMateId: "s4", firstMateId: "direct", name: "old-run", sessionId: null, crew: [] },
    ];
    document.getElementById("dashFleetSlot").replaceChildren(dashboardFleetSection(mates, secondMates));
    return true;
  })()`);
  await wait(250);

  assert((await count("#dashFleetSlot .fleet-cols")) === 1, "the fleet renders as a column grid");
  assert((await count("#dashFleetSlot .fleet-col")) === 3, "three columns (two first mates + Direct)");
  assert((await count("#dashFleetSlot .fleet-mate-card")) === 3, "three mate cards total");
  assert((await count("#dashFleetSlot .fleet-mate-card.direct")) === 1, "one of them is the Direct card");

  const names = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-mate-name")].map(e => e.textContent)`);
  assert(names.includes("Captain Nemo") && names.includes("Hector Barbossa"), "both first mates render by name (got: " + JSON.stringify(names) + ")");
  assert(names.includes("Captain"), "the Direct card is titled Captain");

  // Second mates branch under their first mate.
  const projs = await app.eval(`[...document.querySelectorAll("#dashFleetSlot .fleet-branch-proj")].map(e => e.textContent)`);
  assert(projs.includes("tgs-reinmaker") && projs.includes("jot") && projs.includes("helm"), "second mates + Direct session nodes render (got: " + JSON.stringify(projs) + ")");
  assert(!projs.includes("old-run"), "a run-only Direct node (no session) is NOT shown - Direct lists sessions only, no confusing duplicates");

  // Crew under a second mate (rendered even while collapsed).
  assert((await count("#dashFleetSlot .fleet-crew-item")) === 2, "crew items render under their second mates");
  // Bug cffdeeb8: a finished crew run gets a "Done" control right on the row, so
  // the captain can acknowledge it without deep-linking in. c2 is done -> one
  // Done button; c1 is still running -> none.
  assert((await count("#dashFleetSlot .fleet-crew-done")) === 1, "the finished crew run shows a Done button, the running one doesn't");
  assert((await count("#dashFleetSlot .fleet-badge.run")) >= 1, "a second mate with live crew shows a 'busy' badge");
  assert((await count("#dashFleetSlot .fleet-spin")) >= 1, "live crew shows the working spinner");

  // Dual-trigger nudge: Barbossa's crew is wrapped (done, no commits, nothing
  // awaiting) -> a 'work wrapped' retire nudge with a retire button.
  assert((await count("#dashFleetSlot .fleet-nudge.done")) === 1, "a work-wrapped mate shows the 'work wrapped' retire nudge");
  assert((await count("#dashFleetSlot .fleet-nudge.ctx")) === 0, "no context nudge when no session is open/saturated");
  assert((await count("#dashFleetSlot .fleet-btn-accent")) === 1, "the nudge carries a Retire & respawn button");

  // Jump-in handlers exist (clicking a mate card / second mate opens a session).
  assert(await app.eval(`typeof jumpIntoFirstMate === "function" && typeof jumpIntoSecondMate === "function"`), "jump-in handlers are wired");

  // Header controls + Direct start-session button.
  assert((await count("#dashFleetSlot .fleet-mate-card:not(.direct) .fleet-btn:not(.fleet-btn-accent)")) >= 4, "each first mate has rename + retire icons");
  assert((await count("#dashFleetSlot .fleet-mate-card.direct .fleet-btn")) === 1, "the Direct column has a start-session button");
  assert((await count("#dashFleetSlot .fleet-mate-card .fleet-btn-accent")) === 1, "the work-wrapped mate's nudge offers a retire button");

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
  assert((await count("#dashFleetSlot .fleet-nudge.hold .fleet-btn-accent")) === 0, "the dampened 'hold' nudge offers no retire button");
  assert((await count("#dashFleetSlot .fleet-nudge.done")) === 0, "the 'done' nudge is suppressed while urgent work is queued");

  // Jump-in bug fix: a second mate with no bound session resumes the most recent
  // EXISTING session in its project (not a fresh one). Verify the resolver.
  const mru = await app.eval(`(() => {
    const saved = state.sessions;
    state.sessions = [
      { sessionId:"S1", cliSessionId:"S1", cwd:"D:/Repo/jot", status:"idle", lastActivityAt:100 },
      { sessionId:"S2", cliSessionId:"S2", cwd:"D:/Repo/jot", status:"idle", lastActivityAt:200 },
      { sessionId:"S3", cliSessionId:"S3", cwd:"D:/Repo/jot", isArchived:true, lastActivityAt:999 },
    ];
    const hit = mostRecentSessionForCwd("D:/Repo/jot");
    const none = mostRecentSessionForCwd("D:/Repo/does-not-exist");
    state.sessions = saved;
    return { hit: hit && hit.sessionId, none };
  })()`);
  assert(mru.hit === "S2", "jump-in resolves the most recent NON-archived session for a project cwd (got " + JSON.stringify(mru) + ")");
  assert(mru.none === null, "an unknown cwd resolves to null (would then open fresh)");

  // A real project session becomes a resumable Direct second mate (the jump-in
  // fix: derived nodes alone dead-ended into fresh chats).
  const aug = await app.eval(`(() => {
    const saved = state.sessions;
    state.sessions = [
      { sessionId:"PS1", cliSessionId:"PS1", cwd:"D:/Repo/some-proj", title:"Fix the widget", status:"idle", lastActivityAt:500 },
      { sessionId:"PS2", cliSessionId:"PS2", cwd:"D:/Repo/some-proj", title:"Another topic", status:"idle", lastActivityAt:400 },
    ];
    const r = augmentSecondMatesWithSessions([]);
    state.sessions = saved;
    const directs = r.filter((s) => s.firstMateId === "direct");
    const d = directs.find((s) => s.sessionId === "PS1");
    return { directCount: directs.length, hasPS1: !!d, name: d && d.name };
  })()`);
  assert(aug.hasPS1 && aug.name === "Fix the widget", "each session becomes a resumable Direct node named by its title (got " + JSON.stringify(aug) + ")");
  assert(aug.directCount === 2, "two sessions in the same cwd list as TWO nodes (not collapsed) - 'list sessions, not projects'");

  // A session node reflects the SESSION's status (not "crew idle"), matching the
  // needs-you list above.
  const badges = await app.eval(`(() => {
    const saved = state.sessions;
    state.sessions = [
      { sessionId:"W1", cliSessionId:"W1", cwd:"D:/Repo/w", title:"Waiting one", status:"waiting", lastActivityAt:1 },
      { sessionId:"A1", cliSessionId:"A1", cwd:"D:/Repo/a", title:"Active one", status:"active", lastActivityAt:1 },
    ];
    const w = fleetSecondMateEl({ secondMateId:"sw", firstMateId:"direct", projectPath:"D:/Repo/w", name:"Waiting one", sessionId:"W1", crew:[], isSessionNode:true }).querySelector(".fleet-badge").textContent;
    const a = fleetSecondMateEl({ secondMateId:"sa", firstMateId:"direct", projectPath:"D:/Repo/a", name:"Active one", sessionId:"A1", crew:[], isSessionNode:true }).querySelector(".fleet-badge").textContent;
    state.sessions = saved;
    return { w, a };
  })()`);
  assert(badges.w === "needs you", "a session node with a waiting session shows 'needs you' (got " + JSON.stringify(badges) + ")");
  assert(badges.a === "working", "a session node with an active session shows 'working'");

  // Rename is inline (native window.prompt is disabled in Electron + unwanted):
  // clicking the rename icon shows an input, not a dialog.
  await app.eval(`document.querySelector("#dashFleetSlot .fleet-mate-card:not(.direct) .fleet-btn:not(.fleet-btn-accent)").click(); true`);
  await wait(120);
  assert((await count("#dashFleetSlot .fleet-rename-input")) === 1, "rename opens an inline input (not a native prompt)");

  // Retire offers a CHOICE, not a yes/no confirm: carrying the thread over to the
  // successor has to be a deliberate decision (DECISIONS.md, "Retire: carry-over is
  // a choice"). This test still expected the old confirm modal, so it had been
  // failing since that change - a stale assertion, not a regression. What matters
  // is that it is still not a native dialog and that both branches are offered.
  await app.eval(`document.querySelectorAll("#dashFleetSlot .fleet-mate-card:not(.direct) .fleet-btn:not(.fleet-btn-accent)")[1].click(); true`);
  await wait(120);
  const retireMenu = await app.eval(`(() => {
    const menu = document.getElementById("contextMenu");
    if (!menu || menu.classList.contains("hidden")) { return null; }
    return [...menu.querySelectorAll(".item")].map(el => el.textContent);
  })()`);
  assert(Array.isArray(retireMenu), "retire opens Helm's own menu, not a native dialog");
  assert(
    (retireMenu || []).some((l) => /start fresh/i.test(l)) && (retireMenu || []).some((l) => /carry over/i.test(l)),
    `both retire branches are offered (got ${JSON.stringify(retireMenu)})`
  );
  // Dismissing it must not retire anything.
  await app.eval(`closeContextMenu(); true`);
  await wait(80);
  const dismissed = await app.eval(`document.getElementById("contextMenu").classList.contains("hidden")`);
  assert(dismissed === true, "dismissing the menu leaves the mate alone");

  // A session-backed second mate offers an archive button (archive from Direct).
  const arch = await app.eval(`(() => {
    const saved = state.sessions;
    state.sessions = [{ sessionId:"AS1", cliSessionId:"AS1", cwd:"D:/Repo/x", status:"idle", lastActivityAt:1 }];
    const withSession = fleetSecondMateEl({ secondMateId:"sm_x", firstMateId:"direct", projectPath:"D:/Repo/x", name:"x", sessionId:"AS1", crew:[] }).querySelectorAll(".fleet-archive-btn").length;
    const noSession = fleetSecondMateEl({ secondMateId:"sm_y", firstMateId:"direct", projectPath:"D:/Repo/y", name:"y", sessionId:null, crew:[] }).querySelectorAll(".fleet-archive-btn").length;
    state.sessions = saved;
    return { withSession, noSession };
  })()`);
  assert(arch.withSession === 1, "a session-backed second mate shows an archive button");
  assert(arch.noSession === 0, "a run-only second mate (no session) shows no archive button");

  // Jumping into a first mate with no session titles the fresh chat after it.
  const title = await app.eval(`(() => {
    jumpIntoFirstMate({ mateId:"tm", name:"Captain Nemo", sessionId:null });
    const t = panes[0] && panes[0].title;
    navigateToPage("dashboard");
    return t;
  })()`);
  assert(title === "Captain Nemo", "jumping into a first mate titles the fresh chat after the mate (got " + JSON.stringify(title) + ")");

  // A session's live sub-agent renders as an "agent ·" crew item (no Follow -
  // the session node itself is the way in).
  const sub = await app.eval(`(() => {
    const el = fleetSecondMateEl({ secondMateId:"ss", firstMateId:"direct", projectPath:"D:/Repo/x", name:"x", sessionId:null, isSessionNode:true, crew:[{ isSubAgent:true, id:"a1", goal:"review dashboard", status:"running" }] });
    const it = el.querySelector(".fleet-crew-item");
    return { count: el.querySelectorAll(".fleet-crew-item").length, label: it?.querySelector(".fleet-crew-label")?.textContent, hasFollow: !!it?.querySelector(".fleet-btn"), run: it?.classList.contains("crew-run") };
  })()`);
  assert(sub.count === 1 && /^agent · review dashboard/.test(sub.label || ""), "a live sub-agent renders as an 'agent ·' crew item (got " + JSON.stringify(sub) + ")");
  assert(!sub.hasFollow, "a sub-agent crew item has no Follow button (the session node is the way in)");
  assert(sub.run === true, "a running sub-agent crew item is color-coded as running");

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
