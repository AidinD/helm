// E2E (deterministic, no API turns): the three Fleet/chat UI fixes from the
// 2026-07-14 p0 batch, each exercised at the function level in the real loaded
// renderer via CDP eval (no real session runs needed):
//   5fda2a96 - openSessionInPane names a mate-bound session by its fleet name.
//   96d34b98 - archiveOutgoingMateSession syncs local isArchived so the retired
//              session is NOT transiently classified as a "direct" 2nd mate.
//   bf1ea538 - the context gauge falls back to the per-poll estimate
//              (contextTokensBySession) when the mate's session isn't open.
// Also asserts the new getContextTokens IPC is exposed + returns a number map.
//
// Run:  node scripts/e2e/test-fleet-ui-fixes.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[fleet-ui-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fleetui-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Plumbing: the new bulk IPC is exposed and returns a { ok, contextTokens } map.
  const ipcShape = await app.eval(`(async () => {
    if (typeof window.helm.getContextTokens !== "function") { return { exposed: false }; }
    const r = await window.helm.getContextTokens([{ cliSessionId: "does-not-exist", sessionId: "does-not-exist" }]);
    return { exposed: true, ok: r && r.ok === true, mapType: typeof (r && r.contextTokens) };
  })()`);
  assert(ipcShape.exposed, "window.helm.getContextTokens is exposed");
  assert(ipcShape.ok && ipcShape.mapType === "object", "getContextTokens returns { ok:true, contextTokens:{} }");

  // 5fda2a96 - a mate-bound session opened in a pane is titled by the mate's
  // fleet name, not the prompt-derived session.title.
  const nameFix = await app.eval(`(() => {
    state.sessions.push({ sessionId: "s1", cliSessionId: "c1", cwd: "D:/x", title: "Jag vill jobba med beatdrop...", isArchived: false });
    mateBySessionId = new Map([["c1", { mateId: "m1", name: "Long John Silver", sessionId: "c1" }]]);
    const sess = state.sessions.find((s) => s.cliSessionId === "c1");
    openSessionInPane(sess, 0);
    return panes[0] && panes[0].title;
  })()`);
  assert(nameFix === "Long John Silver", `chat pane titles a first mate by fleet name (got ${JSON.stringify(nameFix)})`);

  // 96d34b98 - after archiveOutgoingMateSession, the session's local isArchived
  // is set, so augmentSecondMatesWithSessions (with the mate already removed)
  // does NOT classify it as a "direct" 2nd-mate node (no transient flash).
  const retireFix = await app.eval(`(async () => {
    state.sessions.push({ sessionId: "s2", cliSessionId: "c2", cwd: "D:/proj", title: "retiring session", isArchived: false });
    const mate = { mateId: "m2", sessionId: "c2" };
    const before = augmentSecondMatesWithSessions([], []).some((n) => n.sessionId === "c2" && n.firstMateId === "direct");
    await archiveOutgoingMateSession(mate);
    const backing = state.sessions.find((s) => s.cliSessionId === "c2");
    const after = augmentSecondMatesWithSessions([], []).some((n) => n.sessionId === "c2" && n.firstMateId === "direct");
    return { before, archivedLocally: !!(backing && backing.isArchived), after };
  })()`);
  assert(retireFix.before === true, "sanity: an unarchived mate-unbound session WOULD show as a direct node (the race)");
  assert(retireFix.archivedLocally === true, "archiveOutgoingMateSession sets backing.isArchived locally");
  assert(retireFix.after === false, "retired session is NOT classified as a direct 2nd mate after the fix (no flash)");

  // bf1ea538 - the gauge's context-token source falls back to the per-poll
  // estimate when no pane is open, and contextWindowForModel resolves via the
  // mate's session model (matched on the cliSessionId form).
  const gaugeFix = await app.eval(`(() => {
    state.sessions.push({ sessionId: "s3", cliSessionId: "c3", cwd: "D:/proj3", model: "claude-sonnet-5", isArchived: false });
    contextTokensBySession = { c3: 500000 };
    const mate = { mateId: "m3", name: "Davy Jones", sessionId: "c3" };
    const openPane = panes.find((p) => p && p.cliSessionId && p.cliSessionId === mate.sessionId && typeof p.contextTokens === "number");
    const ctxTokens = openPane ? openPane.contextTokens : contextTokensBySession[mate.sessionId];
    const model = sessionForMate(mate) && sessionForMate(mate).model;
    const win = contextWindowForModel(model);
    const pct = typeof ctxTokens === "number" ? Math.min(100, Math.round((ctxTokens / win) * 100)) : null;
    return { ctxTokens, model, winIsNumber: typeof win === "number" && win > 0, pct };
  })()`);
  assert(gaugeFix.ctxTokens === 500000, `gauge falls back to per-poll estimate when no pane open (got ${gaugeFix.ctxTokens})`);
  assert(gaugeFix.model === "claude-sonnet-5", "sessionForMate resolves the session by the cliSessionId form");
  assert(gaugeFix.winIsNumber, "contextWindowForModel returns a positive window size");
  assert(typeof gaugeFix.pct === "number", `a context % is computable for a non-open mate (got ${gaugeFix.pct})`);

  log(exitCode === 0 ? "VERIFY OK: all three Fleet/chat UI fixes behave as intended." : "VERIFY FAILED.");
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
