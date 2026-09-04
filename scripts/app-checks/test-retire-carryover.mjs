import { requireLive } from "../checks-lib/live-gate.mjs";
requireLive("starts a real session so a retire has something to carry over");

// E2E (LIVE): retire-with-carry-over runs the outgoing first mate's FINAL
// summarize turn and hands that summary into the respawned mate. Starts a real
// first-mate session (one cheap turn), retires it with carry-over (a real Sonnet
// summarize turn), and asserts the freshly-respawned mate in the same slot
// carries a non-empty handoff.
//
// Two real claude turns; can take a couple of minutes.
//
// SIBLING: test-retire-carry-over-stubbed.mjs asserts the same carry-over against a stubbed
// binary, so it runs in every sweep for free. This one is the only place the REAL CLI is
// exercised, which is why it still earns its keep - but it only runs under --live, and in
// practice had never run at all when the stubbed one was written (2026-08-12).
//
// Run:  node scripts/e2e/test-retire-carryover.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[retire-carryover-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-retire-"));
const metaHome = path.join(tmp, "meta-home");
const matesPath = path.join(tmp, "mates.json");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = matesPath;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The mate we'll retire: the app's slot-0 first mate.
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

  // Start a REAL first-mate session at the meta-home (so it's a first mate) with
  // a cheap directive turn, then wait for it to finish and grab its session id.
  const started = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    prompt: "Reply with exactly the word: ready. Do not call any tools.",
    model: "claude-haiku-4-5-20251001",
    effort: "low"
  })`);
  log("startSession:", JSON.stringify(started));
  assert(started && started.ok !== false, "the initial first-mate session started");

  // Poll state.sessions for a completed session rooted at the meta-home.
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

  // Retire the mate WITH carry-over: this runs the real summarize turn on that
  // session and stores the resulting handoff for the respawned mate.
  await app.eval(`(async () => {
    await window.helm.bindMateSession(${JSON.stringify(mate0.mateId)}, ${JSON.stringify(sessionId)});
    await retireMateWithCarryOver({ mateId: ${JSON.stringify(mate0.mateId)}, sessionId: ${JSON.stringify(sessionId)}, name: ${JSON.stringify(mate0.name || "TestMate")}, root: ${JSON.stringify(metaHome)} });
    return true;
  })()`);

  // retireMateWithCarryOver was awaited, so the fresh mate + its stored handoff
  // already exist. Find the respawned mate in the same slot and consume its
  // handoff once (consumeMateHandoff returns { ok, handoff }).
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
  assert(typeof handoff === "string" && handoff.trim().length > 0, `the respawned mate carries a non-empty handoff from the final summarize turn (len ${handoff ? handoff.length : 0})`);
  if (handoff) {
    log("handoff (first 160 chars):", handoff.slice(0, 160).replace(/\n/g, " "));
  }

  // Retire also ARCHIVES the outgoing mate's own session, so it doesn't resurface
  // as a stray "Archive finished session" proposal (bug a5178cbc). Confirm the
  // retired session is archived in the backend now.
  const archived = await app.eval(`(async () => {
    const raw = await window.helm.getSessions();
    const list = Array.isArray(raw) ? raw : (raw && raw.sessions) || [];
    const s = list.find((x) => (x.cliSessionId || x.sessionId) === ${JSON.stringify(sessionId)});
    return s ? !!s.isArchived : "session-not-found";
  })()`);
  assert(archived === true, `the retired mate's session is archived by retire (got ${JSON.stringify(archived)})`);

  log(exitCode === 0 ? "VERIFY OK: retire summarizes + carries over into the respawned mate, and archives the old session." : "VERIFY FAILED.");
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
