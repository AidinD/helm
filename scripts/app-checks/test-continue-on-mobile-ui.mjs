// E2E (real launched Helm): the "Continue on mobile" button wiring on a
// first-mate card. Asserts the 📱 button renders only when the mate has a bound
// session, and (if window.helm is stubbable in this build) that clicking it
// calls continueOnMobile with the session's cwd/cliSessionId/title. If the
// contextBridge method can't be stubbed, we DON'T click the real one (it would
// open a real terminal) - the launcher behaviour itself is covered by the pure
// unit test test-remote-control.mjs.
//
// Run:  node scripts/e2e/test-continue-on-mobile-ui.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[rc-ui-e2e]", ...a);
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
  await wait(600);

  // A first mate WITH a bound session -> the button should render.
  const withSession = await app.eval(`(() => {
    state.sessions = [{ sessionId: "l_x", cliSessionId: "cli_x", cwd: "D:/Repo/Tools/helm", title: "some prompt title", status: "idle", lastActivityAt: 1 }];
    mateBySessionId = new Map([["cli_x", { mateId: "mX", name: "Grace OMalley", sessionId: "cli_x" }]]);
    mateSessionIds = new Set(["cli_x"]);
    const mate = { mateId: "mX", name: "Grace OMalley", sessionId: "cli_x", persona: null, slot: 0 };
    const card = fleetMateCardEl(mate, [], {});
    const btn = card.querySelector(".fleet-mobile-btn");
    return { hasBtn: !!btn, text: btn?.textContent || "", title: btn?.title || "", svg: !!btn?.querySelector("svg") };
  })()`);
  assert(withSession.hasBtn === true, "first-mate card with a bound session shows the 📱 button");
  // The glyph became an inline WIFI svg (bug ca32567c: the phone/arrow glyphs were unreadable at
  // this size - "go with a wifi symbol"), which also follows the icons-over-emoji rule for
  // interactive controls. So the check is that it carries an icon and no emoji text, not which
  // emoji it is.
  assert(withSession.svg === true, "the button carries an inline icon rather than an emoji glyph");
  assert(withSession.text.trim() === "", `and no text content beside it (${JSON.stringify(withSession.text)})`);
  assert(/phone|Remote Control/i.test(withSession.title), "the button has a descriptive tooltip");

  // A first mate WITHOUT a bound session -> no button.
  const noSession = await app.eval(`(() => {
    state.sessions = [];
    const mate = { mateId: "mY", name: "Nobody", sessionId: null, persona: null, slot: 1 };
    const card = fleetMateCardEl(mate, [], {});
    return { hasBtn: !!card.querySelector(".fleet-mobile-btn") };
  })()`);
  assert(noSession.hasBtn === false, "a mate with no bound session shows no 📱 button");

  // Try to stub the contextBridge IPC so a click can be verified WITHOUT opening
  // a real terminal.
  const clickResult = await app.eval(`(async () => {
    let stubbed = false;
    try {
      window.helm.continueOnMobile = async (p) => { window.__rcCall = p; return { ok: true }; };
      stubbed = window.helm.continueOnMobile.toString().includes("__rcCall");
    } catch (e) {
      stubbed = false;
    }
    if (!stubbed) {
      return { stubbed: false };
    }
    window.__rcCall = null;
    state.sessions = [{ sessionId: "l_z", cliSessionId: "cli_z", cwd: "D:/Repo/Tools/helm", title: "z title", status: "idle", lastActivityAt: 1 }];
    const mate = { mateId: "mZ", name: "Zheng Yi Sao", sessionId: "cli_z", persona: null, slot: 0 };
    const card = fleetMateCardEl(mate, [], {});
    card.querySelector(".fleet-mobile-btn").click();
    await new Promise((r) => setTimeout(r, 50));
    return { stubbed: true, call: window.__rcCall };
  })()`);
  if (clickResult.stubbed) {
    assert(!!clickResult.call, "clicking the button invoked window.helm.continueOnMobile");
    assert(clickResult.call?.cliSessionId === "cli_z", "payload carries the session's cliSessionId");
    assert(clickResult.call?.cwd === "D:/Repo/Tools/helm", "payload carries the session cwd");
    assert(clickResult.call?.title === "Zheng Yi Sao", "payload carries the mate name as the session title");
  } else {
    log("NOTE - window.helm.continueOnMobile is not stubbable in this build; click not fired (would open a real terminal). Launcher behaviour covered by test-remote-control.mjs.");
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    log("  err:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Continue-on-mobile button renders on bound-session cards and wires to the IPC." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
