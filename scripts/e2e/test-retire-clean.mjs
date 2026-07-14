// E2E (LIVE): retire "start fresh" (clean) is the no-carry-over path. Two checks:
//   1. offerRetireChoice renders a two-option menu ("start fresh" + "carry over"),
//      the dropdown that makes carry-over an explicit choice (menu-level, no turns).
//   2. retireMateClean respawns a fresh mate WITHOUT a handoff (blank composer) and
//      still archives the outgoing session - the opposite of carry-over, which
//      seeds the successor's composer (see test-retire-carryover.mjs).
//
// One cheap claude turn (no summarize turn - clean retire skips it), so this is
// faster than the carry-over test.
//
// Run:  node scripts/e2e/test-retire-clean.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[retire-clean-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-retire-clean-"));
const metaHome = path.join(tmp, "meta-home");
const matesPath = path.join(tmp, "mates.json");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = matesPath;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // 1) Menu-level: offerRetireChoice must render exactly the two options, with
  // "start fresh" first (the common case). No click -> nothing is retired.
  const menuItems = await app.eval(`(() => {
    offerRetireChoice(120, 120, { mateId: "fake-mate", name: "MenuProbe" });
    const menu = document.getElementById("contextMenu");
    const items = [...menu.querySelectorAll(".item")].map((el) => el.textContent);
    menu.classList.add("hidden");
    return items;
  })()`);
  log("retire menu items:", JSON.stringify(menuItems));
  assert(Array.isArray(menuItems) && menuItems.length === 2, `retire menu offers exactly two options (got ${menuItems.length})`);
  assert(menuItems[0] === "Retire (start fresh)", `first option is "Retire (start fresh)" (got ${JSON.stringify(menuItems[0])})`);
  assert(menuItems[1] === "Retire and carry over", `second option is "Retire and carry over" (got ${JSON.stringify(menuItems[1])})`);

  // 2) Backend clean-retire path. Find the slot-0 first mate.
  const mate0 = await app.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const r = await window.helm.listMates();
      const m = (r.active || []).find((x) => x.slot === 0) || (r.active || [])[0];
      if (m) return m;
      await new Promise(res => setTimeout(res, 150));
    }
    return null;
  })()`);
  assert(mate0 && mate0.mateId, `found the slot-0 first mate (${mate0?.mateId})`);
  const retiredSlot = mate0.slot;

  // Start a REAL first-mate session (one cheap turn) so there's a bound session to
  // archive - clean retire does NOT summarize, so one turn is all we need.
  const started = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    prompt: "Reply with exactly the word: ready. Do not call any tools.",
    model: "claude-haiku-4-5-20251001",
    effort: "low"
  })`);
  log("startSession:", JSON.stringify(started));
  assert(started && started.ok !== false, "the initial first-mate session started");

  let sessionId = null;
  for (let i = 0; i < 60 && !sessionId; i++) {
    await wait(3000);
    sessionId = await app.eval(`(() => {
      const norm = (p) => (p || "").replace(/[\\\\/]+$/,"").toLowerCase();
      const s = (state.sessions || []).find((x) => (x.cliSessionId || x.sessionId) && norm(x.cwd) === norm(${JSON.stringify(metaHome)}) && x.status !== "active");
      return s ? (s.cliSessionId || s.sessionId) : null;
    })()`);
  }
  assert(!!sessionId, `the initial session completed and got a session id (${sessionId})`);

  // Retire CLEAN: no summarize turn, no handoff carried over.
  await app.eval(`(async () => {
    await window.helm.bindMateSession(${JSON.stringify(mate0.mateId)}, ${JSON.stringify(sessionId)});
    await retireMateClean({ mateId: ${JSON.stringify(mate0.mateId)}, sessionId: ${JSON.stringify(sessionId)}, name: ${JSON.stringify(mate0.name || "TestMate")}, root: ${JSON.stringify(metaHome)} });
    return true;
  })()`);

  // The respawned mate in the same slot must carry NO handoff (blank composer).
  const outcome = await app.eval(`(async () => {
    const r = await window.helm.listMates();
    const m = (r.active || []).find((x) => x.slot === ${retiredSlot} && x.mateId !== ${JSON.stringify(mate0.mateId)});
    if (!m) return { freshMateId: null, handoff: null };
    const res = await window.helm.consumeMateHandoff(m.mateId);
    return { freshMateId: m.mateId, handoff: res && res.handoff };
  })()`);
  const freshMateId = outcome.freshMateId;
  const handoff = outcome.handoff;

  assert(!!freshMateId, `a fresh mate respawned in slot ${retiredSlot} (${freshMateId})`);
  assert(freshMateId !== mate0.mateId, "the respawned mate is a NEW identity, not the retired one");
  assert(!handoff || String(handoff).trim().length === 0, `the respawned mate carries NO handoff (clean retire; got ${JSON.stringify(handoff)})`);

  // Clean retire still archives the outgoing session (same as carry-over).
  const archived = await app.eval(`(async () => {
    const raw = await window.helm.getSessions();
    const list = Array.isArray(raw) ? raw : (raw && raw.sessions) || [];
    const s = list.find((x) => (x.cliSessionId || x.sessionId) === ${JSON.stringify(sessionId)});
    return s ? !!s.isArchived : "session-not-found";
  })()`);
  assert(archived === true, `the retired mate's session is archived by clean retire (got ${JSON.stringify(archived)})`);

  log(exitCode === 0 ? "VERIFY OK: retire menu offers both options; clean retire respawns with no handoff and archives the old session." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
