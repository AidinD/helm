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

  // 5fda2a96 (round 2) - the SIDEBAR row names a mate-bound session by fleet name
  // too, not just the chat header.
  const sidebarLabel = await app.eval(`(() => {
    mateBySessionId = new Map([["c9", { mateId: "m9", name: "Captain Hook", sessionId: "c9" }]]);
    state.sessions.push({ sessionId: "s9", cliSessionId: "c9", cwd: "D:/x", title: "Jag vill jobba med beatdrop...", status: "idle", isArchived: false });
    const sess = state.sessions.find((s) => s.cliSessionId === "c9");
    const row = rowEl(sess);
    const el = row.querySelector(".row-title");
    return el && el.textContent;
  })()`);
  assert(sidebarLabel === "Captain Hook", `sidebar names a first-mate session by fleet name (got ${JSON.stringify(sidebarLabel)})`);

  // 2a5e6196 - openSessionInPane carries the resolved mate id, so a turn in a
  // RESUMED mate session attaches the dispatch config bound to THAT mate (not the
  // slot-0 active[0] fallback that stamped a second first mate's dispatches onto
  // the wrong mate).
  const paneMate = await app.eval(`(() => {
    mateBySessionId = new Map([["cDavy", { mateId: "mate_davy", name: "Davy Jones", sessionId: "cDavy" }]]);
    secondMateBySessionId = new Map([["cSm", { secondMateId: "sm_reg2", name: "SM", sessionId: "cSm", firstMateId: "mate_x" }]]);
    state.sessions.push({ sessionId: "sDavy", cliSessionId: "cDavy", cwd: "D:/x", title: "t", status: "idle", isArchived: false });
    state.sessions.push({ sessionId: "sSm", cliSessionId: "cSm", cwd: "D:/y", title: "t2", status: "idle", isArchived: false });
    openSessionInPane(state.sessions.find((s) => s.cliSessionId === "cDavy"), 0);
    const fmPane = { mateId: panes[0] && panes[0].mateId, secondMateId: panes[0] && panes[0].secondMateId };
    openSessionInPane(state.sessions.find((s) => s.cliSessionId === "cSm"), 0);
    const smPane = { mateId: panes[0] && panes[0].mateId, secondMateId: panes[0] && panes[0].secondMateId };
    return { fmPane, smPane };
  })()`);
  assert(paneMate.fmPane.mateId === "mate_davy", `resumed first-mate pane carries its own mateId (got ${JSON.stringify(paneMate.fmPane.mateId)})`);
  assert(!paneMate.fmPane.secondMateId, "a first-mate pane carries no secondMateId");
  assert(paneMate.smPane.secondMateId === "sm_reg2", `resumed second-mate pane carries its own secondMateId (got ${JSON.stringify(paneMate.smPane.secondMateId)})`);

  // c48a4a22 - a registered second mate whose id form differs from the session's
  // is NOT re-synthesized as a prompt-title node (so chat + fleet single-source
  // the same fleet name).
  const smDivergence = await app.eval(`(() => {
    secondMateBySessionId = new Map([["s8", { secondMateId: "sm-reg", name: "Beatdrop mate", sessionId: "s8", firstMateId: "mX" }]]);
    state.sessions.push({ sessionId: "s8", cliSessionId: "c8", cwd: "D:/beatdrop", title: "jag vill jobba...", status: "idle", isArchived: false });
    const reg = { secondMateId: "sm-reg", name: "Beatdrop mate", sessionId: "s8", firstMateId: "mX" };
    const out = augmentSecondMatesWithSessions([reg], []);
    return {
      synthetic: out.some((n) => n.secondMateId === "sess_c8"),
      registeredName: (out.find((n) => n.secondMateId === "sm-reg") || {}).name,
    };
  })()`);
  assert(smDivergence.synthetic === false, "a registered 2nd mate is NOT re-synthesized as a prompt-title node on id-form mismatch");
  assert(smDivergence.registeredName === "Beatdrop mate", "the 2nd mate keeps its registered fleet name (single-sourced with the chat header)");

  // b7f662fd - the redundant top proposals banner is gone, and the Fleet header
  // no longer shows the (confusing "0") live count.
  const fleetChrome = await app.eval(`(() => {
    const proposed = { secondMateId: "sm_prop", status: "proposed", sessionId: null, firstMateId: "direct", projectPath: "D:/p", name: "P", brief: "b", crew: [] };
    const section = dashboardFleetSection([], [proposed], {});
    return {
      hasBanner: !!section.querySelector(".fleet-proposals"),
      hasCount: !!section.querySelector(".dash-board-head .dash-count"),
    };
  })()`);
  assert(fleetChrome.hasBanner === false, "the top 'topics proposed' banner is removed");
  assert(fleetChrome.hasCount === false, "the Fleet header shows no count");

  log(exitCode === 0 ? "VERIFY OK: all Fleet/chat naming + gauge fixes behave as intended." : "VERIFY FAILED.");
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
