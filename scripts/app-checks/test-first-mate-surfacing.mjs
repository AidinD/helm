// E2E (real launched Helm via CDP): two first-mate surfacing fixes.
//  #1 A first-mate session shows as its mate ("1st mate · <name>") in the
//     needs-you queue, not the cryptic prompt-derived title it gets after its
//     first turn (the prompt title moves to the why line as context).
//  #2 A first-mate CARD reflects its bound session's status: a "needs you"
//     badge + a card accent when the session is waiting (previously the card
//     never showed a needs-you marker at all).
//
// Run:  node scripts/e2e/test-first-mate-surfacing.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[first-mate-surfacing-e2e]", ...a);
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
  await wait(800);

  // --- #1: needs-you queue row shows the mate identity, not the prompt title --
  const row = await app.eval(`(() => {
    state.sessions = [{ sessionId: "local_fm", cliSessionId: "cli_fm", cwd: "D:/Repo/Tools/helm", title: "fix the auth bug then refactor tokens", status: "waiting", lastActivityAt: 1 }];
    mateBySessionId = new Map([["cli_fm", { mateId: "m1", name: "Jack Sparrow", sessionId: "cli_fm" }]]);
    mateSessionIds = new Set(["cli_fm"]);
    const el = dashSessionRowEl(state.sessions[0]);
    return {
      tag: el.querySelector(".dash-goal-tag")?.textContent || "",
      title: el.querySelector(".dash-q-title")?.textContent || "",
      why: el.querySelector(".dash-q-why")?.textContent || "",
    };
  })()`);
  assert(row.tag === "1st mate", `queue row carries a "1st mate" tag (got "${row.tag}")`);
  assert(row.title === "Jack Sparrow", `queue row title is the mate name, not the prompt (got "${row.title}")`);
  assert(/fix the auth bug then refactor tokens/.test(row.why), "the prompt-derived title is kept as context on the why line");
  assert(/Waiting on you/.test(row.why), "still shows the waiting cue");

  // --- #2: first-mate card reflects its bound session status -----------------
  const card = await app.eval(`(() => {
    const mate = { mateId: "m1", name: "Jack Sparrow", sessionId: "cli_fm", persona: null, slot: 0 };
    // The card reads the FSM field (lifecycleState), not the raw status - that was
    // the point of Epic f3d096fa, and a fixture that only sets \`status\` tests a
    // reader that no longer exists. Set both, the way a real session carries both.
    const LS = { waiting: "waiting", active: "working", idle: "idle" };
    const make = (status) => {
      state.sessions = [{ sessionId: "local_fm", cliSessionId: "cli_fm", cwd: "P", title: "t", status, lifecycleState: LS[status], lastActivityAt: 1 }];
      const el = fleetMateCardEl(mate, [], {});
      return {
        badge: el.querySelector(".fleet-badge")?.textContent || "",
        needsAccent: el.classList.contains("fleet-mate-needs"),
      };
    };
    return { waiting: make("waiting"), active: make("active"), idle: make("idle") };
  })()`);
  assert(card.waiting.badge === "needs you", `waiting mate card shows a "needs you" badge (got "${card.waiting.badge}")`);
  assert(card.waiting.needsAccent === true, "waiting mate card gets the needs-you accent");
  assert(card.active.badge === "working" && card.active.needsAccent === false, "active mate card shows 'working', no needs accent");
  assert(card.idle.badge === "" && card.idle.needsAccent === false, "idle mate card shows no status badge and no accent");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: first-mate sessions are identifiable in the queue + cards show needs-you." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
