// Toasts stack and wait to be read; events get a notice that has to be clicked away.
//
// the captain, task 709e4b90: "toasten vid händelser är för snabb och syns inte tillräckligt
// väl - kanske lägga till en andra typ av toast också som kommer fram som en sidoruta
// eller något och som man måste klicka bort, med en kö".
//
// The measurable part of "syns inte tillräckligt väl" was that two toasts were each
// fixed to the same spot, so the second sat exactly on top of the first and the one
// underneath could not be read at all. That is what the geometry assertions below are
// for - not that a toast exists, but that a second one does not cover it.
//
// Run:  node scripts/app-checks/test-toast-and-notices.mjs
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
const { launch } = await import("../checks-lib/harness.mjs");

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
  // THE ANIMATION IS CONDITIONAL, AND SO IS THIS ASSERTION.
  //
  // This check was excluded from the CI app lane on the grounds that "animations do not appear
  // to run on a hosted runner - possibly because a hidden window has no compositor". That
  // diagnosis was wrong in a way that mattered: the rule lives inside
  // @media (prefers-reduced-motion: no-preference), so on a machine that asks for reduced
  // motion the app SUPPRESSES it on purpose and animation-name computes to none. The check was
  // asserting that a deliberate accessibility behaviour had not happened.
  //
  // So it asks the environment first and then asserts the matching half of the contract. Both
  // halves are real: where motion is allowed the animation must run, and where it is not it
  // must be absent. Neither is a skip, which is the point - a check that opts out on the
  // runner is a check that does not cover the runner.
  const arriving = await app.eval(`(async () => {
    document.getElementById("noticeHost")?.remove();
    noticeQueue.length = 0;
    const { dismiss } = showNotice("Handoff saved to HANDOFF.md", { tone: "good" });
    await new Promise((r) => setTimeout(r, 20));
    const el = document.querySelector("#noticeHost .notice");
    const style = getComputedStyle(el);
    const result = {
      motionAllowed: matchMedia("(prefers-reduced-motion: no-preference)").matches,
      animationName: style.animationName || "none",
      goodTone: el.classList.contains("notice-good"),
    };
    // DISMISSAL BRANCHES THE SAME WAY THE ARRIVAL DOES, and the app is the one that branches:
    // under reduced motion it calls el.remove() straight away, otherwise it adds
    // .notice-leaving and waits for animationend. So both facts are collected and the matching
    // half is asserted below - "it flew out" is the wrong question on a machine that asked for
    // no motion, and it was the question that kept the CI app lane red.
    dismiss();
    result.leaving = !!document.querySelector("#noticeHost .notice.notice-leaving");
    result.stillThere = !!document.querySelector("#noticeHost .notice");
    return result;
  })()`);
  if (arriving.motionAllowed) {
    ok(
      arriving.animationName !== "none",
      `motion is allowed here, so a fresh notice really slides in (animation-name ${JSON.stringify(arriving.animationName)})`
    );
  } else {
    ok(
      arriving.animationName === "none",
      `motion is not allowed here, so the slide-in is correctly suppressed (animation-name ${JSON.stringify(arriving.animationName)})`
    );
  }
  // AND THE RULE ITSELF EXISTS, asserted in both environments. Without this, the reduced-motion
  // branch above passes just as happily when somebody deletes the animation altogether - "it is
  // absent" would be satisfied by absence for the wrong reason, which is the failure this whole
  // suite keeps finding.
  const noticeRule = await app.eval(`(() => {
    const result = { found: false, animationName: null, leavingFound: false, leavingAnimationName: null };
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (!(rule instanceof CSSMediaRule)) continue;
        if (!/prefers-reduced-motion/.test(rule.conditionText) || !/no-preference/.test(rule.conditionText)) continue;
        for (const inner of rule.cssRules) {
          if (inner.selectorText === ".notice") {
            result.found = true;
            result.animationName = inner.style.animationName;
          }
          if (inner.selectorText === ".notice-leaving") {
            result.leavingFound = true;
            result.leavingAnimationName = inner.style.animationName;
          }
        }
      }
    }
    return result;
  })()`);
  ok(
    noticeRule.found && noticeRule.animationName === "notice-in",
    `the .notice rule behind the reduced-motion guard names the notice-in animation (found=${noticeRule.found}, animation-name=${JSON.stringify(noticeRule.animationName)})`
  );
  ok(
    noticeRule.leavingFound && noticeRule.leavingAnimationName === "notice-out",
    `and the .notice-leaving rule names the notice-out animation (found=${noticeRule.leavingFound}, animation-name=${JSON.stringify(noticeRule.leavingAnimationName)})`
  );
  ok(arriving.goodTone, "a good-tone notice carries the success stripe class");
  if (arriving.motionAllowed) {
    ok(arriving.leaving, "motion is allowed here, so dismissing flies the card out before removing it");
  } else {
    // The reduced-motion half is not "nothing happens" - the card must be GONE. Asserting only
    // the absence of the animation would pass just as well if dismiss stopped working, which is
    // the same absence-for-the-wrong-reason trap the rule check below exists for.
    ok(
      !arriving.leaving && !arriving.stillThere,
      `motion is not allowed here, so dismissing removes the card at once instead of flying it out (leaving=${arriving.leaving}, still on screen=${arriving.stillThere})`
    );
  }

  // AND THE OTHER HALF, ON PURPOSE, WHICHEVER HALF THIS MACHINE IS.
  //
  // Branching on the ambient setting means each environment only ever exercises its own side,
  // and the side nobody runs is the side that breaks. That is not hypothetical: this check sat
  // red in the CI app lane on every run for two days because a hosted runner reports reduced
  // motion and the assertion above was written for the other case - green on every workstation,
  // red on the only machine that reports to anyone.
  //
  // So the opposite setting is emulated and the matching contract asserted. Both halves are now
  // covered everywhere, and the ambient branch above stays because it is the one that runs
  // against the machine's real setting.
  const opposite = arriving.motionAllowed ? "reduce" : "no-preference";
  await app.cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: opposite }],
  });
  try {
    const emulated = await app.eval(`(async () => {
      document.getElementById("noticeHost")?.remove();
      noticeQueue.length = 0;
      const { dismiss } = showNotice("Handoff saved to HANDOFF.md", { tone: "good" });
      await new Promise((r) => setTimeout(r, 20));
      const el = document.querySelector("#noticeHost .notice");
      const result = {
        motionAllowed: matchMedia("(prefers-reduced-motion: no-preference)").matches,
        animationName: getComputedStyle(el).animationName || "none",
      };
      dismiss();
      result.leaving = !!document.querySelector("#noticeHost .notice.notice-leaving");
      result.stillThere = !!document.querySelector("#noticeHost .notice");
      return result;
    })()`);

    ok(
      emulated.motionAllowed === (opposite === "no-preference"),
      `the emulation took (asked for ${opposite}, page reports motionAllowed=${emulated.motionAllowed}) - without this the assertions below would just be the ambient case again`
    );
    if (emulated.motionAllowed) {
      ok(emulated.animationName !== "none", `emulating no-preference, the notice slides in (animation-name ${JSON.stringify(emulated.animationName)})`);
      ok(emulated.leaving, "emulating no-preference, dismissing flies the card out");
    } else {
      ok(emulated.animationName === "none", `emulating reduced motion, the slide-in is suppressed (animation-name ${JSON.stringify(emulated.animationName)})`);
      ok(
        !emulated.leaving && !emulated.stillThere,
        `emulating reduced motion, dismissing removes the card at once (leaving=${emulated.leaving}, still on screen=${emulated.stillThere})`
      );
    }
  } finally {
    // Put it back, or every assertion after this one runs under a setting it did not ask for.
    await app.cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }

  // The handoff-saved SUCCESS path must land in the notice column with the good tone, not
  // the fading bottom toast - that is the actual behaviour the task asked for. Reproducing
  // a real archive-with-handoff needs a live run, so check the wiring at the source.
  // SLICED TO THE FUNCTION'S END, not to a magic number.
  //
  // This read the first 4000 characters after the declaration. The function grew, and by
  // 2026-09-08 the token this assertion matches - tone: "good" - began at 3993 and ran past the
  // boundary, so the window contained `tone: "g` and the regex failed. Five characters. The
  // check reported that the success path no longer routes to showNotice, about code that does,
  // and it had been doing so unnoticed because the whole file was excluded from the CI lane for
  // an unrelated reason.
  //
  // A fixed window into source is a claim about a size nobody maintains. The end of a top-level
  // function is a thing the file actually contains, so that is what it reads to.
  const rendererSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const archiveStart = rendererSrc.indexOf("async function archiveWithHandoff");
  ok(archiveStart >= 0, "archiveWithHandoff is still in the renderer, under that name");
  const archiveEnd = rendererSrc.indexOf("\n}\n", archiveStart);
  ok(archiveEnd > archiveStart, "and its end can be found, so the slice below covers the whole function");
  const archiveFn = rendererSrc.slice(archiveStart, archiveEnd);
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
