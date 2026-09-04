// LIVE-EXEMPT: it launches the app but starts no session, so nothing reaches a model.
//
// A card that claims commits SAYS so, and the claim can be taken back.
//
// Binding commits to a review card is a judgement a person makes after looking, and a wrong
// one sends the next reader to review the wrong diff while telling them it is the right one.
// Two things were missing and they compounded:
//
//   the payload has carried `boundCommitCount` since the binding feature shipped, and this
//   page never read it - so a binding was invisible;
//
//   `unbindReviewCommits` was bridged in the preload, handled in main, and called from
//   nowhere at all - so a wrong binding could not be undone in the app.
//
// Bind was buildable and undo was not, which is the wrong half to be missing when the action
// is fallible. Neither was found by anybody hitting it: the IPC-surface sweep found the second,
// and the first only surfaced while reading why the first had no caller.
//
// Driven through the REAL row builder (`reviewActionsEl`) rather than a reimplementation, so a
// change to that function cannot pass here. The row is hand-made, which is this check's weak
// spot - so it carries only the field the payload builder demonstrably sets
// (`row.boundCommitCount = binding ? binding.shas.length : 0` in reviewQueueBuild.js) and the
// check asserts the ZERO case too, or "it always renders" would pass every assertion below.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-unbind-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");

const { launch } = await import("../checks-lib/harness.mjs");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const seen = await app.eval(
    `(() => {
      const rowOf = (boundCommitCount) => ({
        taskId: "task-under-check",
        title: "A card that claims some commits",
        repoPath: "C:/work/widget-press",
        boundCommitCount,
        hasCommits: boundCommitCount > 0,
        record: null,
        status: "review",
      });
      const textOf = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
      const bound = reviewActionsEl(rowOf(3));
      const one = reviewActionsEl(rowOf(1));
      const none = reviewActionsEl(rowOf(0));
      const buttons = (el) => [...el.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
      return {
        boundText: textOf(bound),
        boundButtons: buttons(bound),
        oneText: textOf(one),
        noneText: textOf(none),
        noneButtons: buttons(none),
        unbindTitle: ([...bound.querySelectorAll("button")].find((b) => b.textContent.trim() === "Unbind") || {}).title || "",
      };
    })()`
  );

  // --- the binding is visible at all, which it was not ------------------------------------
  ok(/3 commits bound/.test(seen.boundText), `a card with three bound commits says so (${seen.boundText.slice(0, 90)})`);
  ok(/1 commit bound/.test(seen.oneText) && !/1 commits/.test(seen.oneText), `and one reads as singular (${seen.oneText.slice(0, 60)})`);

  // --- and it can be taken back -----------------------------------------------------------
  ok(seen.boundButtons.includes("Unbind"), `an Unbind control is offered (${seen.boundButtons.join(", ")})`);
  ok(
    /not touched|untouched/i.test(seen.unbindTitle),
    `and it says the commits themselves are not touched, so the button is not read as destructive (${seen.unbindTitle.slice(0, 90)})`
  );

  // --- the zero case, or every assertion above passes trivially ---------------------------
  ok(!/bound/.test(seen.noneText), `a card with NO binding says nothing about one (${seen.noneText.slice(0, 60) || "(empty)"})`);
  ok(!seen.noneButtons.includes("Unbind"), "and offers no Unbind, so the control is conditional rather than always drawn");

  // --- clicking it asks first --------------------------------------------------------------
  // window.helm is a contextBridge object and cannot be stubbed, so the bridge is left alone
  // and the check stops at the question. That the confirm appears is the property worth
  // holding anyway: a click that discards somebody's judgement must not go straight through.
  const asked = await app.eval(
    `(async () => {
      const el = reviewActionsEl({
        taskId: "task-under-check",
        title: "A card that claims some commits",
        repoPath: "C:/work/widget-press",
        boundCommitCount: 2,
        hasCommits: true,
        record: null,
        status: "review",
      });
      document.body.append(el);
      const btn = [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === "Unbind");
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const dialog = document.querySelector(".confirm-overlay, .modal-overlay, .custom-confirm, [class*='confirm']");
      const body = dialog ? (dialog.textContent || "").replace(/\\s+/g, " ") : "";
      // Cancel it, so nothing is left on screen for the next check.
      const cancel = dialog ? [...dialog.querySelectorAll("button")].find((b) => /cancel|avbryt|no/i.test(b.textContent)) : null;
      if (cancel) { cancel.click(); }
      el.remove();
      return { appeared: !!dialog, body: body.slice(0, 260), cancelled: !!cancel };
    })()`
  );
  ok(asked.appeared, `clicking Unbind asks before doing anything (${asked.appeared ? "" : "no dialog appeared"})`);
  ok(/2 commit/.test(asked.body), `and the question names how many are at stake (${asked.body.slice(0, 110)})`);
  ok(/diff/.test(asked.body), "and says what is lost - the diff goes away until something is bound again");

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
    ? "VERIFY OK: a bound card says so, offers an undo, asks before taking it, and an unbound card offers neither."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
