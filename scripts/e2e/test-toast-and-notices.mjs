// Toasts stack and wait to be read; events get a notice that has to be clicked away.
//
// Aidin, task 709e4b90: "toasten vid händelser är för snabb och syns inte tillräckligt
// väl - kanske lägga till en andra typ av toast också som kommer fram som en sidoruta
// eller något och som man måste klicka bort, med en kö".
//
// The measurable part of "syns inte tillräckligt väl" was that two toasts were each
// fixed to the same spot, so the second sat exactly on top of the first and the one
// underneath could not be read at all. That is what the geometry assertions below are
// for - not that a toast exists, but that a second one does not cover it.
//
// Run:  node scripts/e2e/test-toast-and-notices.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-toasts-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9520";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- two toasts at once do not overlap --------------------------------------
  const stacked = await app.eval(`(async () => {
    document.getElementById("toastHost")?.remove();
    showToast("first message");
    showToast("second message");
    await new Promise((r) => setTimeout(r, 120));
    const els = [...document.querySelectorAll(".toast")];
    const boxes = els.map((e) => e.getBoundingClientRect());
    const overlap = boxes.length === 2 && boxes[0].bottom > boxes[1].top && boxes[1].bottom > boxes[0].top;
    return {
      count: els.length,
      texts: els.map((e) => e.textContent),
      overlap,
      hostPointerEvents: getComputedStyle(document.getElementById("toastHost")).pointerEvents,
      toastPointerEvents: els[0] ? getComputedStyle(els[0]).pointerEvents : null,
    };
  })()`);
  ok(stacked.count === 2, `both toasts are on screen (${stacked.count})`);
  ok(!stacked.overlap, `and one does not sit on top of the other (${JSON.stringify(stacked.texts)})`);
  // The host spans the gaps between toasts; if it swallowed clicks it would block the
  // app underneath, so the host is transparent to the pointer and each toast is not.
  ok(stacked.hostPointerEvents === "none", `the stack itself does not eat clicks meant for the app (${stacked.hostPointerEvents})`);
  ok(stacked.toastPointerEvents === "auto", `while a toast is still clickable (${stacked.toastPointerEvents})`);

  // --- a toast can be dismissed, and hovering holds it ------------------------
  const timing = await app.eval(`(async () => {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    showToast("dismiss me", { ms: 400 });
    const el = document.querySelector(".toast");
    el.click();
    const goneOnClick = !document.querySelector(".toast");

    // Hover BEFORE the timer would fire, then stay: the message must still be there
    // well past its own lifetime.
    showToast("hold me while reading", { ms: 300 });
    const held = document.querySelector(".toast");
    held.dispatchEvent(new PointerEvent("pointerenter"));
    await new Promise((r) => setTimeout(r, 700));
    const stillThere = !!document.querySelector(".toast");
    held.dispatchEvent(new PointerEvent("pointerleave"));
    await new Promise((r) => setTimeout(r, 500));
    const goneAfterLeaving = !document.querySelector(".toast");
    return { goneOnClick, stillThere, goneAfterLeaving };
  })()`);
  ok(timing.goneOnClick, "clicking a toast dismisses it early");
  ok(timing.stillThere, "hovering holds it past its own lifetime, so a long sentence can be read");
  ok(timing.goneAfterLeaving, "and it leaves once the pointer does");

  // --- notices: persistent, stacked, queued -----------------------------------
  const notices = await app.eval(`(async () => {
    document.getElementById("noticeHost")?.remove();
    for (let i = 1; i <= 6; i++) {
      showNotice("event " + i);
    }
    await new Promise((r) => setTimeout(r, 900));
    const host = document.getElementById("noticeHost");
    const shown = [...host.querySelectorAll(".notice")];
    return {
      survivesItsOwnLifetime: shown.length,
      texts: shown.map((n) => n.querySelector(".notice-text").textContent),
      queued: host.querySelector(".notice-queued")?.textContent || "",
      hasClearAll: !!host.querySelector(".notice-clear"),
      side: host.getBoundingClientRect().right >= window.innerWidth - 40,
    };
  })()`);
  ok(notices.survivesItsOwnLifetime === 4, `at most four notices are shown at once (${notices.survivesItsOwnLifetime})`);
  ok(
    JSON.stringify(notices.texts) === JSON.stringify(["event 4", "event 3", "event 2", "event 1"]),
    `newest on top, and none of them disappeared on their own (${JSON.stringify(notices.texts)})`
  );
  ok(notices.queued === "+2 more waiting", `the rest are queued and say so (${JSON.stringify(notices.queued)})`);
  ok(notices.hasClearAll, "a pile gets one button to clear it");
  ok(notices.side, "and the column sits at the side of the window, not over the middle of the app");

  // Dismissing one lets the queue in - "med en kö" means in order, not dropped.
  const drained = await app.eval(`(async () => {
    const host = document.getElementById("noticeHost");
    host.querySelector(".notice .notice-close").click();
    await new Promise((r) => setTimeout(r, 120));
    return {
      texts: [...host.querySelectorAll(".notice")].map((n) => n.querySelector(".notice-text").textContent),
      queued: host.querySelector(".notice-queued")?.textContent || "",
    };
  })()`);
  ok(
    drained.texts.includes("event 5"),
    `dismissing one lets the oldest waiting notice in (${JSON.stringify(drained.texts)})`
  );
  ok(drained.queued === "+1 more waiting", `and the count follows (${JSON.stringify(drained.queued)})`);

  // An action runs and then clears the notice, since it has been dealt with.
  const acted = await app.eval(`(async () => {
    // Reset BOTH halves of the state: the host holds what is shown, noticeQueue holds
    // what is waiting, and a leftover queued notice would take the freed slot below and
    // look like the dismiss had failed.
    document.getElementById("noticeHost")?.remove();
    noticeQueue.length = 0;
    window.__ranAction = false;
    showNotice("a run failed", { actions: [{ label: "Open Autopilot", onClick: () => { window.__ranAction = true; } }] });
    await new Promise((r) => setTimeout(r, 80));
    const btn = [...document.querySelectorAll("#noticeHost .notice-actions button")].find((b) => b.textContent === "Open Autopilot");
    const had = !!btn;
    btn?.click();
    await new Promise((r) => setTimeout(r, 120));
    // A dismissed card flies out (.notice-leaving) before it is removed, so it still
    // matches ".notice" for ~180ms - count only the cards still occupying a slot.
    return { had, ran: window.__ranAction === true, left: document.querySelectorAll("#noticeHost .notice:not(.notice-leaving)").length };
  })()`);
  ok(acted.had, "a notice can carry an action button");
  ok(acted.ran, "clicking it runs the action");
  ok(acted.left === 0, `and the notice is gone once it has been dealt with (${acted.left} left)`);

  // A notice slides in from the side and carries a "good" success tone - the point of
  // the task was to SEE a save (e.g. a handoff) arrive, not have it fade like an ordinary
  // toast. Assert the enter animation is wired and the good tone paints its own stripe.
  const arriving = await app.eval(`(async () => {
    document.getElementById("noticeHost")?.remove();
    noticeQueue.length = 0;
    const { dismiss } = showNotice("Handoff saved to HANDOFF.md", { tone: "good" });
    await new Promise((r) => setTimeout(r, 20));
    const el = document.querySelector("#noticeHost .notice");
    const style = getComputedStyle(el);
    const result = {
      animates: style.animationName && style.animationName !== "none",
      goodTone: el.classList.contains("notice-good"),
    };
    // Dismissing adds .notice-leaving and defers removal until the exit animation ends.
    dismiss();
    result.leaving = !!document.querySelector("#noticeHost .notice.notice-leaving");
    return result;
  })()`);
  ok(arriving.animates, `a fresh notice slides in (animation-name ${JSON.stringify(arriving.animates)})`);
  ok(arriving.goodTone, "a good-tone notice carries the success stripe class");
  ok(arriving.leaving, "dismissing flies the card out before removing it");

  // The handoff-saved SUCCESS path must land in the notice column with the good tone, not
  // the fading bottom toast - that is the actual behaviour the task asked for. Reproducing
  // a real archive-with-handoff needs a live run, so check the wiring at the source.
  const rendererSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const archiveFn = rendererSrc.slice(
    rendererSrc.indexOf("async function archiveWithHandoff"),
    rendererSrc.indexOf("async function archiveWithHandoff") + 4000
  );
  const savedBlock = archiveFn.slice(archiveFn.indexOf("if (saved) {"));
  ok(
    /showNotice\(/.test(savedBlock) && /tone:\s*"good"/.test(savedBlock),
    "archiveWithHandoff's success path routes the save to showNotice with tone good"
  );
  ok(!/showToast\(/.test(savedBlock.slice(0, savedBlock.indexOf("archiveSession"))), "and no longer uses the fading showToast for it");

  // "Dismiss all" clears the queue too, not just what is on screen - otherwise the
  // pile would refill itself and look like the button did nothing.
  const cleared = await app.eval(`(async () => {
    document.getElementById("noticeHost")?.remove();
    noticeQueue.length = 0;
    for (let i = 0; i < 6; i++) {
      showNotice("burst " + i);
    }
    await new Promise((r) => setTimeout(r, 120));
    document.querySelector("#noticeHost .notice-clear").click();
    await new Promise((r) => setTimeout(r, 200));
    const host = document.getElementById("noticeHost");
    return { notices: host.querySelectorAll(".notice").length, queued: host.querySelector(".notice-queued")?.textContent || "" };
  })()`);
  ok(cleared.notices === 0 && cleared.queued === "", `"Dismiss all" clears the queue as well as the stack (${JSON.stringify(cleared)})`);

  // --- the events that were routed to notices ---------------------------------
  // Read from the SOURCE of the handlers, because reproducing each one needs a failing
  // config write, a failing handoff and a real autopilot run. Stated plainly: this
  // checks the wiring, not the behaviour of those flows.
  const wiring = await app.eval(`(() => ({
    stickyFlagRoutes: (() => {
      // showToast(text, {sticky:true}) must land in the notice column, so a call site can
      // be promoted with one word instead of being rewritten.
      document.getElementById("noticeHost")?.remove();
      showToast("promoted", { sticky: true });
      const n = document.querySelectorAll("#noticeHost .notice").length;
      document.getElementById("noticeHost")?.remove();
      return n === 1;
    })(),
    busyToastIsInTheStack: (() => {
      const b = showBusyToast("working");
      const inHost = !!document.querySelector("#toastHost .toast-busy");
      b.done();
      return inHost;
    })(),
  }))()`);
  ok(wiring.stickyFlagRoutes, "showToast(..., { sticky: true }) routes to the notice column");
  ok(wiring.busyToastIsInTheStack, "a busy toast shares the stack, so an ordinary toast cannot cover it");

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 200));
  }
} catch (err) {
  exit = 1;
  console.error("ERR", err.stack || err.message);
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
    ? "VERIFY OK: toasts stack, hold while read and dismiss on click; notices wait to be dismissed, stack four deep and queue the rest."
    : "VERIFY FAILED."
);
process.exit(exit);
