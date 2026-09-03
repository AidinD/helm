// LIVE-EXEMPT: it launches the app but starts no session, so nothing reaches a model.
//
// Annotations on an artifact go back as ONE turn, to the session that WROTE it.
//
// The artifacts card asks for a turn-based loop: annotate several things, send once, one turn.
// What existed instead dropped the formatted text into whichever pane happened to be focused
// and left the sending to a human - so every round of design iteration cost a click you had to
// remember, and the feedback could land in a session that had never seen the page. A mis-send
// that looks exactly like a send.
//
// Three properties, and the middle one is the reason this is a check rather than a diff:
//
//   ORIGIN     the artifact remembers which session produced it, and the feedback follows
//              that rather than the focus. When the origin is unknown the button SAYS it is
//              guessing instead of guessing quietly.
//   ONE PATH   delivery goes through the pane's own composer and its own send button, not a
//              second sending route. Two ways to send one thing is how they drift.
//   NOT LOST   the text reaches the clipboard before delivery is attempted, because a page of
//              annotations is expensive to produce and a failed send must not eat it.
//
// Pure DOM and state, driven in the real renderer. No session is started: the check replaces
// the panes' state and asserts what the Plan page decides from it, which is where every one
// of these decisions is made.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-artifact-turn-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");

const { launch } = await import("./harness.mjs");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the target resolver, which is where the mis-send was ------------------------------
  const resolved = await app.eval(
    `(() => {
      const out = {};
      // No origin: it must fall back to WHICHEVER pane has focus, and say it is unsure. The
      // focused index is captured rather than assumed - the first draft of this check asserted
      // a literal 1 while focus was still 0, so it failed against correct behaviour.
      lavishState.origin = null;
      focusedPaneIndex = 0;
      out.noOriginAtZero = { target: lavishFeedbackTarget(), focused: focusedPaneIndex };

      // An origin whose session is open in a pane: that pane wins, whatever has focus.
      panes[0] = Object.assign(panes[0] || {}, { cliSessionId: "cli-writer", title: "the writer" });
      if (!panes[1]) { panes[1] = { cliSessionId: "cli-other", title: "somebody else" }; }
      panes[1].cliSessionId = "cli-other";
      focusedPaneIndex = 1;
      lavishState.origin = null;
      out.noOriginMoved = { target: lavishFeedbackTarget(), focused: focusedPaneIndex };

      lavishState.origin = { cliSessionId: "cli-writer", sessionId: null, paneIndex: 0, title: "the writer" };
      out.originOpen = lavishFeedbackTarget();

      // An origin whose session is NOT open: not a target at all.
      lavishState.origin = { cliSessionId: "cli-vanished", sessionId: null, paneIndex: 0, title: "a closed one" };
      out.originGone = lavishFeedbackTarget();
      return out;
    })()`
  );

  ok(resolved.noOriginAtZero.target.sure === false, "with no known origin the target is marked UNSURE, so the button can say so");
  ok(
    resolved.noOriginAtZero.target.index === resolved.noOriginAtZero.focused,
    `and it falls back to whichever pane has focus (${resolved.noOriginAtZero.target.index} with focus on ${resolved.noOriginAtZero.focused})`
  );
  ok(
    resolved.noOriginMoved.target.index === resolved.noOriginMoved.focused,
    `still true when focus moves, which is what makes it a fallback rather than a constant (${resolved.noOriginMoved.target.index} with focus on ${resolved.noOriginMoved.focused})`
  );

  ok(resolved.originOpen.sure === true, "a known origin whose session is open is a SURE target");
  ok(
    resolved.originOpen.index === 0,
    `and it wins over the focused pane - feedback follows the artifact's author, not the focus (${resolved.originOpen.index} while pane 1 had focus)`
  );

  ok(resolved.originGone.index === -1, "an origin whose session is gone is NOT a target");
  ok(resolved.originGone.gone === true, "and is flagged as gone, so the button can explain rather than fail silently");

  // --- delivery: idle sends now, busy queues ---------------------------------------------
  // Driven against the REAL composer and the REAL send button, with sending stubbed at the
  // button so nothing reaches a model. Stubbing the BUTTON rather than the delivery function
  // is deliberate: it proves delivery goes through the same control a person clicks.
  const delivered = await app.eval(
    `(async () => {
      navigateToPage("chat");
      await new Promise((r) => setTimeout(r, 400));
      const paneEl = document.querySelector('.pane[data-pane="0"]');
      if (!paneEl) { return { error: "no pane 0 in the DOM" }; }
      const promptEl = paneEl.querySelector(".pane-composer textarea");
      const sendBtn = paneEl.querySelector(".send-btn");
      if (!promptEl || !sendBtn) { return { error: "pane 0 has no composer or no send button" }; }

      let clicks = 0;
      const realClick = sendBtn.click.bind(sendBtn);
      sendBtn.click = () => { clicks += 1; };

      const out = {};

      // IDLE: the text lands in the composer and the pane's own send button is clicked.
      panes[0].busy = false;
      promptEl.value = "";
      out.idle = deliverLavishFeedback(0, "FEEDBACK-ONE");
      out.idleClicks = clicks;
      out.idleComposer = promptEl.value;

      // A DRAFT already in the composer is never overwritten.
      panes[0].busy = false;
      promptEl.value = "half a thought";
      clicks = 0;
      deliverLavishFeedback(0, "FEEDBACK-TWO");
      out.draftKept = promptEl.value.startsWith("half a thought") && promptEl.value.includes("FEEDBACK-TWO");

      // BUSY: nothing is sent; it is queued for when the run finishes.
      panes[0].busy = true;
      promptEl.value = "";
      clicks = 0;
      out.busy = deliverLavishFeedback(0, "FEEDBACK-THREE");
      out.busyClicks = clicks;
      out.queuedOnPane = panes[0].queuedPrompt;
      out.queuedInMap = queuedPromptBySession.get("cli-writer") || null;

      sendBtn.click = realClick;
      panes[0].busy = false;
      return out;
    })()`
  );

  ok(!delivered.error, `the real composer and send button were found (${delivered.error || "both"})`);
  if (!delivered.error) {
    ok(delivered.idle.ok === true && delivered.idle.queued === false, "an idle session is sent to immediately");
    ok(delivered.idleClicks === 1, `and it goes through the pane's OWN send button (${delivered.idleClicks} click) rather than a second sending path`);
    ok(delivered.idleComposer.includes("FEEDBACK-ONE"), "with the feedback in the composer, so what was sent is visible afterwards");

    ok(delivered.draftKept === true, "a half-typed draft is kept and the feedback appended - his own words are never overwritten");

    ok(delivered.busy.ok === true && delivered.busy.queued === true, "a BUSY session gets it queued instead");
    ok(delivered.busyClicks === 0, "and nothing is sent while it is busy, which would have stopped the run");
    ok(delivered.queuedOnPane === "FEEDBACK-THREE", `the queue holds it on the pane (${delivered.queuedOnPane})`);
    ok(
      delivered.queuedInMap === "FEEDBACK-THREE",
      `and in the by-session map, which is what survives navigating away and back (${delivered.queuedInMap})`
    );
  }

  // --- the clipboard comes FIRST, and this file claimed that without checking it -----------
  // The ingress above lists three properties. Two were driven; this one was prose, which is
  // the exact class of defect the rest of this week has been spent removing - so it is
  // asserted, and asserted on ORDER, because "it copies" and "it copies before it can fail"
  // are different promises. Read off the source rather than the clipboard: there is an IPC to
  // write the clipboard and none to read it back, and inventing a read for a test would be a
  // second mechanism to keep true.
  {
    const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
    const handler = rSrc.slice(
      rSrc.indexOf("sendBtn.disabled = noteCount === 0"),
      rSrc.indexOf("const clearBtn", rSrc.indexOf("sendBtn.disabled = noteCount === 0"))
    );
    const copyAt = handler.indexOf("copyToClipboard(text)");
    const deliverAt = handler.indexOf("deliverLavishFeedback(target.index");
    ok(copyAt > 0 && deliverAt > 0, "the send handler both copies and delivers");
    ok(
      copyAt < deliverAt,
      "and it copies BEFORE it tries to deliver, so a failed send cannot eat a page of annotations"
    );
    ok(
      /It is on the clipboard/.test(handler),
      "and a failed send says the feedback is on the clipboard, so the recovery is stated rather than left to be guessed"
    );
  }

  // --- a gone pane fails as an answer, not as a throw -------------------------------------
  const gone = await app.eval(`deliverLavishFeedback(97, "x")`);
  ok(gone.ok === false && typeof gone.error === "string", `delivering to a pane that does not exist returns a reason (${JSON.stringify(gone)})`);

  // --- and the page no longer describes the button it used to have ------------------------
  const described = await app.eval(
    `(() => {
      navigateToPage("lavish");
      return (document.getElementById("lavishPage") || document.body).textContent;
    })()`
  );
  ok(!/Send to composer/.test(described), "the Plan page does not still promise a 'Send to composer' button that is gone");
  ok(/ONE turn|one turn/.test(described), "and says what it does instead, in the copy a reader actually sees");

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (err) {
  fails += 1;
  console.log(`FAIL - the check threw: ${err && err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // a leftover temp dir is harmless
  }
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: annotations go back to the session that wrote the artifact, as one turn, queued if it is busy."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
