// E2E: a first mate that dispatched crew and is waiting must NOT read as "needs
// input / needs you" (bug 9c0c7209 - Aidin: "1st mate needs you when it's really
// just waiting for its 2nd mates; it waits on me though I have nothing to do").
// This holds even when the crew ERRORED - the action then lives on the crew
// (its own attention rows), so the first mate shows a calm "crew needs a
// decision", stays out of the "N need a click" count, and shows no ⚠ / amber
// accent. A waiting mate with NO crew is still a genuine "needs input".
//
// Run:  node scripts/e2e/test-first-mate-crew-wait.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[fm-crew-wait-e2e]", ...a);
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

  const out = await app.eval(`(() => {
    state.config = state.config || {};
    state.config.acknowledgedGoalRuns = [];
    // A first mate (m0) with a waiting bound session + two ERRORED crew runs.
    const mateErr = { mateId: "m0", slot: 0, name: "Captain Ahab", sessionId: "s0" };
    const sessErr = { sessionId: "s0", cliSessionId: "s0", status: "waiting", title: "You are Captain Ahab", model: "claude-sonnet-5", lastActivityAt: 1 };
    // A second first mate (m1) with a waiting session and NO crew (genuine input).
    const mateBare = { mateId: "m1", slot: 1, name: "Hector Barbossa", sessionId: "s1" };
    const sessBare = { sessionId: "s1", cliSessionId: "s1", status: "waiting", title: "You are Barbossa", model: "claude-sonnet-5", lastActivityAt: 1 };
    mateBySessionId.set("s0", mateErr);
    mateBySessionId.set("s1", mateBare);
    state.sessions = [sessErr, sessBare];
    goalRuns.clear();
    goalRuns.set("e1", { goalRunId: "e1", dispatchedBy: "m0", projectPath: "P", status: "error", goal: "x", iterations: [{}] });
    goalRuns.set("e2", { goalRunId: "e2", dispatchedBy: "m0", projectPath: "P", status: "error", goal: "y", iterations: [{}] });

    const rowErr = dashSessionRowEl(sessErr);
    const rowBare = dashSessionRowEl(sessBare);
    const cardErr = fleetMateCardEl(mateErr, []);
    const inMotion = dashboardInMotionRows();
    const findRow = (sid) => inMotion.find((r) => r.kind === "session" && r.session.sessionId === sid);
    return {
      errMeta: (rowErr.querySelector(".dash-q-meta") || {}).textContent || "",
      errIconNeeds: !!rowErr.querySelector(".dash-state-needs"),
      errNeedsAction: !!findRow("s0")?.needsAction,
      errCardBadge: (cardErr.querySelector(".fleet-badge") || {}).textContent || "",
      errCardAccented: cardErr.classList.contains("fleet-mate-needs"),
      bareMeta: (rowBare.querySelector(".dash-q-meta") || {}).textContent || "",
      bareIconNeeds: !!rowBare.querySelector(".dash-state-needs"),
      bareNeedsAction: !!findRow("s1")?.needsAction,
    };
  })()`);

  log("state:", JSON.stringify(out));
  // Errored-crew first mate: calm, not "needs input".
  assert(out.errMeta === "crew needs a decision", `errored-crew mate reads "crew needs a decision" (got "${out.errMeta}")`);
  assert(out.errIconNeeds === false, "errored-crew mate row shows the calm working dot, NOT the ⚠ needs icon");
  assert(out.errNeedsAction === false, "errored-crew mate does NOT count as a 'need a click' on the first mate");
  assert(out.errCardBadge === "crew needs a decision", `fleet card badge reads "crew needs a decision" (got "${out.errCardBadge}")`);
  assert(out.errCardAccented === false, "the fleet card is NOT amber-accented for errored crew");
  // Genuine needs-input (no crew) still alarms.
  assert(out.bareMeta === "needs input", `a mate with NO crew still reads "needs input" (got "${out.bareMeta}")`);
  assert(out.bareIconNeeds === true, "a mate with no crew keeps the ⚠ needs icon");
  assert(out.bareNeedsAction === true, "a mate with no crew still counts as a genuine need-a-click");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: a crew-waiting first mate is calm; a crewless one still needs input." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
