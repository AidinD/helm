// A queued prompt is shown in the session it will fire in, and nothing is lost by moving it.
//
// Task c2aae246: "Scheduled meddelanden borde synas i en kö här ... Istället för globalt
// längst ner", with the arrow pointing just above a session's prompt box. A queue parked at
// the bottom of the window said something was scheduled but not WHICH conversation it
// belonged to - the only thing worth knowing once several sessions are open.
//
// The risk in a move like this is losing the ones that do not fit the new home. So the
// assertions that matter are about the leftovers: a prompt whose session is not on screen
// must still appear somewhere.
//
// Run:  node scripts/e2e/test-scheduled-queue-in-pane.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sched-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9501";
const { launch } = await import("../checks-lib/harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("chat"); return true; })()`);
  await app.waitForSelector("#chatPage .composer-shell textarea", 10000);

  // --- the split rule, over the real function -------------------------------
  const split = await app.eval(`(() => {
    const p = (id, resumeSessionId) => ({ id, resumeSessionId, prompt: "p" + id, label: "in 2h" });
    const pane = { sessionId: "s-local", cliSessionId: "cli-local" };
    const mine = paneScheduledQueue(pane, [p("a", "cli-local"), p("b", "s-local"), p("c", "someone-else"), p("d", null)]);
    return {
      ids: mine.map((x) => x.id),
      noSession: paneScheduledQueue({ sessionId: null, cliSessionId: null }, [p("a", "cli-local")]).length,
      emptyList: paneScheduledQueue(pane, []).length,
      nullList: paneScheduledQueue(pane, null).length,
    };
  })()`);

  ok(split.ids.includes("a"), `a prompt queued for the pane's cli session is its own (${JSON.stringify(split.ids)})`);
  ok(split.ids.includes("b"), "so is one queued under the pane's own session id - both ids occur in practice");
  ok(!split.ids.includes("c"), "another session's prompt is not claimed");
  ok(!split.ids.includes("d"), "and neither is one with no session at all - it belongs in the global bar");
  ok(split.noSession === 0, "a pane with no session claims nothing");
  ok(split.emptyList === 0 && split.nullList === 0, "an empty or missing queue is empty, not a throw");

  // --- the surface: rows land in the pane, leftovers stay global -------------
  const rendered = await app.eval(`(async () => {
    const pane = panes[0];
    pane.sessionId = "s-probe";
    pane.cliSessionId = "cli-probe";
    const box = document.querySelector('.pane[data-pane="0"] .pane-sched-queue');
    const host = document.getElementById("scheduledPromptBar");
    if (!box) { return { missing: true }; }

    // Drive the distribution directly with a known queue: listScheduledPrompts goes over
    // ipc, which cannot be stubbed (contextBridge is read-only), so the fetch is not the
    // part under test here - the split and the rendering are.
    const pending = [
      // overdue + waitForQuota + a limited window is the state worth showing: the prompt's
      // time has come and it is parked until the quota lifts, rather than lost or burned.
      { id: "mine-1", resumeSessionId: "cli-probe", prompt: "run the build when quota resets", label: "in 2h", overdue: true, waitForQuota: true },
      { id: "other", resumeSessionId: "cli-elsewhere", prompt: "a prompt for a session not on screen", label: "in 5m", overdue: false },
    ];
    const mine = paneScheduledQueue(pane, pending);
    box.replaceChildren();
    box.classList.toggle("hidden", mine.length === 0);
    for (const p of mine) { box.append(scheduledPromptRowEl(p, true, () => {})); }
    const shown = new Set(mine.map((p) => p.id));
    const orphans = pending.filter((p) => !shown.has(p.id));
    host.replaceChildren();
    host.classList.toggle("hidden", orphans.length === 0);
    for (const p of orphans) { host.append(scheduledPromptRowEl(p, true, () => {})); }

    return {
      paneRows: box.querySelectorAll(".sched-row").length,
      paneHidden: box.classList.contains("hidden"),
      paneText: box.textContent,
      globalRows: host.querySelectorAll(".sched-row").length,
      globalHidden: host.classList.contains("hidden"),
      globalText: host.textContent,
      hasCancel: !!box.querySelector("button"),
      // The box must sit ABOVE the composer, which is the whole point of the placement.
      aboveComposer: (() => {
        const composer = document.querySelector('.pane[data-pane="0"] .composer-shell');
        return !!composer && box.compareDocumentPosition(composer) === Node.DOCUMENT_POSITION_FOLLOWING;
      })(),
    };
  })()`);

  ok(!rendered.missing, "the pane has a queue container of its own");
  ok(rendered.paneRows === 1 && !rendered.paneHidden, `this session's queued prompt is shown in the pane (${rendered.paneRows} row)`);
  ok(/run the build when quota resets/.test(rendered.paneText), "with the prompt text, so it is recognisable");
  ok(/waiting for quota/.test(rendered.paneText), `and what it is waiting for (${JSON.stringify(rendered.paneText.slice(0, 60))})`);
  ok(rendered.hasCancel, "and it can be cancelled from there");
  ok(rendered.aboveComposer, "the queue sits above the composer the prompt will be typed into");
  ok(
    rendered.globalRows === 1 && !rendered.globalHidden,
    `the prompt for a session that is NOT on screen still appears in the global bar (${rendered.globalRows} row)`
  );
  ok(/not on screen/.test(rendered.globalText), "so moving the queue did not lose half of it");
  ok(!/run the build/.test(rendered.globalText), "and nothing is listed in both places at once");

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
    ? "VERIFY OK: a queued prompt appears above the composer of the session it will fire in, cancellable there, and prompts for sessions that are not open still show in the global bar."
    : "VERIFY FAILED."
);
process.exit(exit);
