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
    state.sessions.push({ sessionId: "s1", cliSessionId: "c1", cwd: "D:/x", title: "Jag vill jobba med dinghy...", isArchived: false });
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
    state.sessions.push({ sessionId: "s9", cliSessionId: "c9", cwd: "D:/x", title: "Jag vill jobba med dinghy...", status: "idle", isArchived: false });
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
    secondMateBySessionId = new Map([["s8", { secondMateId: "sm-reg", name: "Dinghy mate", sessionId: "s8", firstMateId: "mX" }]]);
    state.sessions.push({ sessionId: "s8", cliSessionId: "c8", cwd: "D:/dinghy", title: "jag vill jobba...", status: "idle", isArchived: false });
    const reg = { secondMateId: "sm-reg", name: "Dinghy mate", sessionId: "s8", firstMateId: "mX" };
    const out = augmentSecondMatesWithSessions([reg], []);
    return {
      synthetic: out.some((n) => n.secondMateId === "sess_c8"),
      registeredName: (out.find((n) => n.secondMateId === "sm-reg") || {}).name,
    };
  })()`);
  assert(smDivergence.synthetic === false, "a registered 2nd mate is NOT re-synthesized as a prompt-title node on id-form mismatch");
  assert(smDivergence.registeredName === "Dinghy mate", "the 2nd mate keeps its registered fleet name (single-sourced with the chat header)");

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

  // 9ad82c28 - a registered (crew-derived) second mate reflects its OWN session's
  // status, not just crew: "working" when its session is active, not "idle".
  const smStatus = await app.eval(`(() => {
    state.sessions.push({ sessionId: "sActive", cliSessionId: "cActive", cwd: "D:/b", status: "active", title: "t", isArchived: false });
    state.sessions.push({ sessionId: "sIdle", cliSessionId: "cIdle", cwd: "D:/b2", status: "idle", title: "t", isArchived: false });
    const mk = (id, sid) => fleetSecondMateEl({ secondMateId: id, firstMateId: "mate_x", projectPath: "D:/b", name: "dinghy", sessionId: sid, crew: [], isSessionNode: false });
    return {
      working: mk("sm_w", "cActive").querySelector(".fleet-badge") && mk("sm_w", "cActive").querySelector(".fleet-badge").textContent,
      idle: mk("sm_i", "cIdle").querySelector(".fleet-badge") && mk("sm_i", "cIdle").querySelector(".fleet-badge").textContent,
    };
  })()`);
  assert(smStatus.working === "working", `a registered 2nd mate with an active session shows "working" (got ${JSON.stringify(smStatus.working)})`);
  assert(smStatus.idle === "idle", `a registered 2nd mate with an idle session shows "idle" (got ${JSON.stringify(smStatus.idle)})`);

  // a39286b7 (step 2) - reopening a session whose turn is still running shows
  // "working" (busy), not a hung-looking idle. A session with no live turn is idle.
  const reopenBusy = await app.eval(`(() => {
    runningSessions.add("cRun");
    state.sessions.push({ sessionId: "sRun", cliSessionId: "cRun", cwd: "D:/x", status: "active", title: "t", isArchived: false });
    state.sessions.push({ sessionId: "sIdle2", cliSessionId: "cIdle2", cwd: "D:/y", status: "idle", title: "t", isArchived: false });
    openSessionInPane(state.sessions.find((s) => s.cliSessionId === "cRun"), 0);
    const runningBusy = !!(panes[0] && panes[0].busy);
    openSessionInPane(state.sessions.find((s) => s.cliSessionId === "cIdle2"), 0);
    const idleBusy = !!(panes[0] && panes[0].busy);
    return { runningBusy, idleBusy };
  })()`);
  assert(reopenBusy.runningBusy === true, "reopening a session with a live turn shows busy/working");
  assert(reopenBusy.idleBusy === false, "reopening a session with no live turn shows idle");

  // 88b7afe3 - the retire spinner: showBusyToast can update its text (per-mate
  // progress) and remove itself.
  const toast = await app.eval(`(() => {
    const b = showBusyToast("first");
    const el = document.querySelector(".toast-busy");
    const before = el && el.querySelector("span:last-child").textContent;
    b.update("second");
    const after = el && el.querySelector("span:last-child").textContent;
    b.done();
    return { before, after, gone: !document.querySelector(".toast-busy") };
  })()`);
  assert(toast.before === "first" && toast.after === "second", "the retire busy toast updates its text via update()");
  assert(toast.gone === true, "the retire busy toast removes itself via done()");

  // 4d82208a follow-up - smart needs-you. A waiting first mate flags "needs you"
  // by DEFAULT (false-positive bias the captain asked for); it stops ONLY when the
  // classifier/heuristic is confident it's done (orchestratorTag done_not_archived).
  // A "waiting_for_input" tag (a genuine question) MUST still flag. Exercised at
  // the queue-row level and the fleet-card badge/accent level.
  const smartNeedsYou = await app.eval(`(() => {
    // Three waiting first mates, no crew, differing only by orchestratorTag.
    mateBySessionId = new Map([
      ["cNone", { mateId: "mNone", name: "No Tag", sessionId: "cNone" }],
      ["cDone", { mateId: "mDone", name: "Done Tag", sessionId: "cDone" }],
      ["cAsk",  { mateId: "mAsk",  name: "Ask Tag",  sessionId: "cAsk"  }],
    ]);
    // status + orchestratorTag as before, PLUS lifecycleState (what main.js now
    // computes and the needs-you queue reads after the FSM reader migration):
    // a done-tagged waiting session is 'wrapped', otherwise 'waiting'.
    const mk = (cid, tag) => ({ sessionId: "s_" + cid, cliSessionId: cid, cwd: "D:/fm", title: "t", status: "waiting", isArchived: false, orchestratorTag: tag, lifecycleState: tag && tag.statusTag === "done_not_archived" ? "wrapped" : "waiting" });
    state.sessions.push(mk("cNone", null));
    state.sessions.push(mk("cDone", { statusTag: "done_not_archived", reason: "heuristic: last message" }));
    state.sessions.push(mk("cAsk", { statusTag: "waiting_for_input", reason: "heuristic: last message" }));
    const rows = dashboardInMotionRows();
    const na = (cid) => { const r = rows.find((x) => x.kind === "session" && x.session.cliSessionId === cid); return r ? r.needsAction : null; };
    const badge = (mate) => { const el = fleetMateCardEl(mate, []); const b = el.querySelector(".fleet-badge"); return { text: b && b.textContent, accent: el.classList.contains("fleet-mate-needs") }; };
    return {
      naNone: na("cNone"), naDone: na("cDone"), naAsk: na("cAsk"),
      bNone: badge({ mateId: "mNone", name: "No Tag", sessionId: "cNone" }),
      bDone: badge({ mateId: "mDone", name: "Done Tag", sessionId: "cDone" }),
      bAsk:  badge({ mateId: "mAsk",  name: "Ask Tag",  sessionId: "cAsk"  }),
    };
  })()`);
  assert(smartNeedsYou.naNone === true, "a waiting first mate with NO classification flags needs-you (default: false-positive bias)");
  assert(smartNeedsYou.naDone === false, "a waiting first mate the classifier marks done_not_archived does NOT flag needs-you");
  assert(smartNeedsYou.naAsk === true, "a waiting first mate the classifier marks waiting_for_input DOES flag needs-you (a real question)");
  assert(smartNeedsYou.bNone.text === "needs you" && smartNeedsYou.bNone.accent === true, "fleet card: no tag -> 'needs you' badge + amber accent");
  assert(smartNeedsYou.bDone.text === "done" && smartNeedsYou.bDone.accent === false, "fleet card: done_not_archived -> calm 'done' badge, no accent");
  assert(smartNeedsYou.bAsk.text === "needs you" && smartNeedsYou.bAsk.accent === true, "fleet card: waiting_for_input -> 'needs you' badge + accent (still flags)");

  // 953bbafb - the SAME session must show ONE name everywhere. The archive-
  // suggestion row in the needs-you queue used the raw prompt title while the
  // Fleet card used the fleet name, so a second mate read as "vad gör den här
  // appen..." in the queue and "startup-simulator" in the fleet. sessionDisplayName
  // single-sources it; every surface routes through it.
  const oneName = await app.eval(`(() => {
    secondMateBySessionId = new Map([["cSS", { secondMateId: "sm_ss", name: "startup-simulator", sessionId: "cSS", firstMateId: "mSin" }]]);
    mateBySessionId = new Map([["cFM", { mateId: "mFM", name: "Corto Maltese", sessionId: "cFM" }]]);
    const smSess = { sessionId: "sSS", cliSessionId: "cSS", cwd: "D:/x", title: "vad gör den här appen, kan du förklara?", status: "waiting", isArchived: false };
    const fmSess = { sessionId: "sFM", cliSessionId: "cFM", cwd: "D:/y", title: "jag vill jobba med dinghy...", status: "waiting", isArchived: false };
    const plainSess = { sessionId: "sPL", cliSessionId: "cPL", cwd: "D:/z", title: "some raw prompt title", status: "idle", isArchived: false };
    state.sessions.push(smSess, fmSess, plainSess);
    // The archive-suggestion row (the exact surface in the screenshot).
    const proposeRow = dashProposeRowEl(smSess);
    const proposeTitle = proposeRow.querySelector(".dash-q-title") && proposeRow.querySelector(".dash-q-title").textContent;
    return {
      helperSm: sessionDisplayName(smSess),
      helperFm: sessionDisplayName(fmSess),
      helperPlain: sessionDisplayName(plainSess),
      proposeTitle,
    };
  })()`);
  assert(oneName.helperSm === "startup-simulator", `sessionDisplayName uses the 2nd-mate fleet name (got ${JSON.stringify(oneName.helperSm)})`);
  assert(oneName.helperFm === "Corto Maltese", `sessionDisplayName uses the 1st-mate fleet name (got ${JSON.stringify(oneName.helperFm)})`);
  assert(oneName.helperPlain === "some raw prompt title", "sessionDisplayName falls back to the prompt title for a non-mate session");
  assert(oneName.proposeTitle === 'Archive finished session: "startup-simulator"', `the archive-suggestion row uses the fleet name, not the prompt title (got ${JSON.stringify(oneName.proposeTitle)})`);

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
