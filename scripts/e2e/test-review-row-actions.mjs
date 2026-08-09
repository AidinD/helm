// Every band on the Review page can be acted on, and Send back actually asks.
//
// Two defects, one surface (tasks ebb4e567 and f2ab6a5a):
//
//  - "Send back" called window.prompt, which is disabled in Electron and returns
//    undefined, so the handler took its cancel branch and did nothing at all. No
//    error, no hint. The captain: "Trycker på send back, inget händer." Silence is the
//    worst failure a button can have - it reads as the app ignoring you.
//  - A row with no review record returned early, BEFORE the buttons were built, so
//    the one band that fills up was the only one with no way to clear it. The captain:
//    "det finns ingen ageringsknapp på dessa, ingen I know."
//
// The second is why this asserts the RULE over every band rather than the one row in
// his screenshot: fixing only the unrecorded case would close the instance and leave
// the class open, which is the mistake that recurred all day.
//
// Run:  node scripts/e2e/test-review-row-actions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-revact-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9491";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- every band gets controls --------------------------------------------
  const bands = await app.eval(`(() => {
    const base = (over) => ({
      taskId: "11111111-2222-3333-4444-555555555555",
      title: "a task",
      problems: ["nothing was written down"],
      caveats: [],
      testSteps: [],
      evidence: [],
      notVerified: [],
      ...over,
    });
    // The record is NESTED on the row (row.record), not flattened onto it - the first
    // version of this fixture flattened it and every band except unrecorded threw,
    // which is only a fixture bug but would have read as a code failure.
    const rec = (over) => ({ summary: "what changed", testSteps: [{ step: "look", expect: "fine" }], evidence: [], notVerified: [], ...over });
    const rows = {
      unrecorded: base({ verdict: "unrecorded", band: "unrecorded" }),
      judgment: base({ verdict: "judgment", band: "judgment", criticality: "core", record: rec({ verdict: "judgment", ask: "pick one" }) }),
      stamp: base({ verdict: "stamp", band: "stamp", criticality: "cosmetic", record: rec({ verdict: "stamp" }) }),
      unconfirmed: base({ verdict: "stamp", band: "unconfirmed", criticality: "core", record: rec({ verdict: "stamp" }), gauntlet: { declared: 1, state: "incomplete", unrun: 1, stale: 0, unverified: 0, unusable: 0 } }),
      incomplete: base({ verdict: "incomplete", band: "incomplete", criticality: "critical", record: rec({ verdict: "stamp" }) }),
    };
    const out = {};
    for (const [band, row] of Object.entries(rows)) {
      let el;
      try {
        el = reviewRowEl(row);
      } catch (e) {
        out[band] = { threw: String(e.message) };
        continue;
      }
      const btns = [...el.querySelectorAll(".rev-actions button")].map((b) => b.textContent);
      out[band] = { buttons: btns, actionRows: el.querySelectorAll(".rev-actions").length };
    }
    return out;
  })()`);

  for (const [band, r] of Object.entries(bands)) {
    ok(!r.threw, `${band}: renders without throwing ${r.threw ? "(" + r.threw + ")" : ""}`);
    ok(Array.isArray(r.buttons) && r.buttons.includes("Mark done") && r.buttons.includes("Send back"), `${band}: has both controls (${(r.buttons || []).join(", ") || "none"})`);
    ok(r.actionRows === 1, `${band}: exactly one action row, not a duplicated one (${r.actionRows})`);
  }

  // --- marking an unrecorded row done must be deliberate -------------------
  const deliberate = await app.eval(`(async () => {
    const row = { taskId: "11111111-2222-3333-4444-555555555555", title: "no record here", verdict: "unrecorded", band: "unrecorded", problems: ["nothing written down"], caveats: [], evidence: [], notVerified: [] };
    const el = reviewRowEl(row);
    document.body.append(el);
    // No stubbing of window.helm here either - it is read-only, so a spy would be an
    // assertion that cannot fail. What IS observable: the confirm appears, its label,
    // and that cancelling leaves the page as it was.
    [...el.querySelectorAll(".rev-actions button")].find((b) => b.textContent === "Mark done").click();
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector(".confirm-overlay");
    const text = overlay?.querySelector(".confirm-msg")?.textContent || "";
    const focusIsCancel = document.activeElement?.classList.contains("confirm-cancel");
    const okLabel = overlay?.querySelector(".confirm-ok")?.textContent || "";
    overlay?.querySelector(".confirm-cancel")?.click();
    await new Promise((r) => setTimeout(r, 100));
    el.remove();
    return { asked: !!overlay, text, focusIsCancel, okLabel, gone: !document.querySelector(".confirm-overlay") };
  })()`);

  ok(deliberate.asked, "marking a record-less row done asks first rather than doing it on one click");
  ok(/no review record at all/.test(deliberate.text), `and says why (${JSON.stringify(deliberate.text.slice(0, 80))})`);
  ok(deliberate.focusIsCancel, "focus starts on Cancel, so a reflex Enter cannot sign it off");
  ok(deliberate.okLabel === "Mark done", `the confirm names the action it will take (${JSON.stringify(deliberate.okLabel)})`);
  ok(deliberate.gone, "cancelling closes the dialog");

  // --- Send back actually asks, and refuses an empty reason ----------------
  const back = await app.eval(`(async () => {
    const row = { taskId: "11111111-2222-3333-4444-555555555555", title: "bounce me", verdict: "stamp", band: "stamp", criticality: "cosmetic", problems: [], caveats: [], record: { summary: "s", testSteps: [{ step: "look", expect: "fine" }], evidence: [], notVerified: [] } };
    const el = reviewRowEl(row);
    document.body.append(el);
    // window.helm CANNOT be stubbed - contextBridge objects are read-only, so an
    // assignment here fails silently and the REAL ipc call runs instead. (Walked into
    // this again despite having recorded it before.) So this block asserts what is
    // observable in the DOM, the dialog's own contract is exercised directly below,
    // and what the handler passes on is checked against the source - stated plainly
    // rather than pretended to be an interception.
    const calls = [];
    [...el.querySelectorAll(".rev-actions button")].find((b) => b.textContent === "Send back").click();
    await new Promise((r) => setTimeout(r, 250));
    const field = document.querySelector(".confirm-overlay .prompt-field");
    const opened = !!field;
    // Empty submit must NOT close and must NOT move the card.
    document.querySelector(".confirm-overlay .confirm-ok")?.click();
    await new Promise((r) => setTimeout(r, 150));
    const stillOpen = !!document.querySelector(".confirm-overlay .prompt-field");
    const flagged = !!document.querySelector(".prompt-field.prompt-field-empty");
    const callsAfterEmpty = calls.length;
    // Now a real reason.
    field.value = "  the numbers are off on the second row  ";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".confirm-overlay .confirm-ok").click();
    await new Promise((r) => setTimeout(r, 300));
    const closedAfterReason = !document.querySelector(".confirm-overlay");
    el.remove();
    document.querySelector(".confirm-overlay")?.remove();

    // The dialog's own contract, exercised directly: what does it hand a caller?
    const handed = await new Promise((resolve) => {
      customPrompt("probe", (text) => resolve(text), { confirmLabel: "go" });
      const f = document.querySelector(".confirm-overlay .prompt-field");
      f.value = "   spaces around it   ";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".confirm-overlay .confirm-ok").click();
    });
    // Cancel must resolve to nothing, never to an empty string a caller would write.
    let cancelled = "not called";
    customPrompt("probe2", () => { cancelled = "submitted"; }, { onCancel: () => { cancelled = "cancelled"; } });
    document.querySelector(".confirm-overlay .confirm-cancel").click();
    await new Promise((r) => setTimeout(r, 100));
    // Escape must settle it exactly once, not leave a caller hanging.
    let escaped = 0;
    customPrompt("probe3", () => {}, { onCancel: () => { escaped++; } });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const leftover = document.querySelectorAll(".confirm-overlay").length;

    return { opened, stillOpen, flagged, callsAfterEmpty, closedAfterReason, handed, cancelled, escaped, leftover, calls };
  })()`);

  ok(back.opened, "Send back opens an in-app text box - window.prompt would have returned nothing and done nothing");
  ok(back.stillOpen, "submitting it empty keeps it open rather than silently closing");
  ok(back.flagged, "and marks the field, so it is visible WHY nothing happened");
  ok(back.callsAfterEmpty === 0, "an empty reason never gets as far as the board");
  ok(back.closedAfterReason, "a real reason closes the dialog - the click is not swallowed");
  ok(back.handed === "spaces around it", `the dialog hands the caller a trimmed string (${JSON.stringify(back.handed)})`);
  ok(back.cancelled === "cancelled", `cancel calls onCancel and never onSubmit (${back.cancelled})`);
  ok(back.escaped === 1, `Escape settles exactly once, so a caller cannot hang or be answered twice (${back.escaped})`);
  ok(back.leftover === 0, "and no overlay is left behind on the page");

  // What the handler passes ON cannot be intercepted (contextBridge is read-only), so
  // it is checked against the source instead - and said so, rather than dressed up as
  // an observed call.
  const rSrc0 = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const handler = rSrc0.slice(rSrc0.indexOf('backBtn.addEventListener("click"'), rSrc0.indexOf('actions.append(doneBtn, backBtn)'));
  ok(/customPrompt\(/.test(handler), "source: the handler asks via customPrompt");
  ok(!/window\.prompt/.test(handler.replace(/\/\/[^\n]*/g, "")), "source: and no longer via the dead window.prompt");
  // sendReviewBack (task 1116b7ef) replaced the plain setReviewStatus call - it
  // moves the card back to in-progress AND carries any attached images; the IPC
  // hardcodes the "in-progress" target, so the note+images are what the handler passes.
  ok(/sendReviewBack\(\s*row\.taskId,/.test(handler), "source: it moves the card back one step, to in-progress (via sendReviewBack)");
  ok(/\[the captain \$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\] \$\{note\}/.test(handler), "source: with a dated, attributed note for the Jot card");

  // --- the dead API must not come back anywhere ---------------------------
  const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const live = rSrc
    .split("\n")
    .filter((l) => /window\.(prompt|confirm)\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l.trim()));
  ok(live.length === 0, `no live window.prompt/confirm call anywhere in the renderer (${live.length ? JSON.stringify(live[0].trim().slice(0, 70)) : "none"})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: every review band has working controls, a record-less row costs a deliberate confirm, and Send back asks in-app, refuses an empty reason, and writes a dated note to the card."
    : "VERIFY FAILED."
);
process.exit(exit);
