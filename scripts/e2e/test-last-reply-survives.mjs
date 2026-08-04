// Does the newest reply stay on screen after a turn finishes?
//
// the captain, task bee52369 (his most urgent): "ibland försvinner det senaste jag och
// claude outputat. Måste starta om appen för att få tillbaka den."
//
// A completed turn triggers loadTranscriptInto immediately, and the CLI does not
// always have its last lines on disk by then - measured twice while building the
// advisory seats, where a transcript read at the instant a session finished was
// missing the tool_result that had definitely happened. If a reload in that window
// can drop what streamed live, this is where it shows.
//
// So this drives REAL turns through the app and, after each one, records three
// things at the same instant: what the pane holds, what the DOM shows, and whether
// the transcript file had caught up at reload time. Several turns in one launch,
// because "ibland" means one green run proves nothing.
//
// OUTCOME so far (2026-08-04): three real turns could NOT reproduce it. Each time the
// transcript file had already caught up by the time the post-completion reload ran, so the
// window the protection covers never even opened. That is worth knowing and worth keeping -
// it rules out the simple case and leaves the harness in place for the harder one (a long
// reply, tool calls, a session open for hours) - but it is not a fix, and the task stays open.
//
// It spends real tokens on every run, so it is OPT-IN, same convention as the containment
// check: without --live it skips loudly instead of passing quietly.
//
// Run:  node scripts/e2e/test-last-reply-survives.mjs --live
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[last-reply-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.argv.includes("--live") && process.env.HELM_LIVE_CLI_TESTS !== "1") {
  console.log("SKIPPED - this reproduction drives real turns through the app and spends tokens.");
  console.log("          Run it deliberately:  node scripts/e2e/test-last-reply-survives.mjs --live");
  console.log("          It is the harness for bee52369 (a reply vanishing from the pane), which is not reproduced yet.");
  process.exit(0);
}

const TURNS = Number(process.env.HELM_REPRO_TURNS || 3);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-lastreply-"));
const projectDir = path.join(tmp, "proj");
fs.mkdirSync(projectDir, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
  fs.mkdirSync(process.env.HELM_META_HOME_OVERRIDE, { recursive: true });
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Open a chat pane rooted in the temp project, so the turns are cheap and
  // isolated from any real session. openFreshDraftInPane takes (cwd, draftText,
  // opts) - forceIndex pins it to pane 0 instead of letting it pick.
  await app.eval(`(async () => {
    navigateToPage("chat");
    openFreshDraftInPane(${JSON.stringify(projectDir)}, "", { forceIndex: 0 });
  })()`);
  await wait(1500);

  for (let n = 1; n <= TURNS; n++) {
    // A marker the reply is forced to contain, so "is the newest reply on screen"
    // is a string search rather than a judgement.
    const marker = `MARKER-${n}-${String(n * 7919).slice(0, 4)}`;
    // Drive the real composer through the real send path (sendFromPane reads the
    // cwd input and the textarea), so this exercises what a keypress does.
    await app.eval(`(async () => {
      const pane = panes[0];
      pane.model = "claude-haiku-4-5-20251001";
      pane.effort = "low";
      pane.els.promptEl.value = ${JSON.stringify(`Reply with exactly this and nothing else: ${marker}`)};
      await sendFromPane(0, pane.els);
    })()`);

    // Wait for the turn to finish, then give the post-done reload a moment.
    let busy = true;
    for (let i = 0; i < 90 && busy; i++) {
      await wait(2000);
      busy = await app.eval(`!!panes[0]?.busy`);
    }
    assert(!busy, `turn ${n}: finished`);
    await wait(2500); // the reload on "done" is async; let it land

    const state = await app.eval(`(async () => {
      const pane = panes[0];
      const scroll = document.querySelector('.pane[data-pane="0"] .pane-scroll');
      const file = await window.helm.getTranscript({ cliSessionId: pane.cliSessionId, sessionId: pane.sessionId });
      const marker = ${JSON.stringify(marker)};
      return {
        inPane: (pane.turns || []).some((t) => String(t.text || "").includes(marker)),
        inDom: !!scroll && scroll.textContent.includes(marker),
        inFile: (file.turns || []).some((t) => String(t.text || "").includes(marker)),
        paneTurns: (pane.turns || []).length,
        fileTurns: (file.turns || []).length,
        pendingHeld: (pane.turns || []).filter((t) => t.pending).length,
        lastPaneText: String((pane.turns || [])[(pane.turns || []).length - 1]?.text || "").slice(0, 60),
      };
    })()`);

    log(
      `turn ${n}: pane=${state.paneTurns} file=${state.fileTurns} pending=${state.pendingHeld} ` +
        `| marker in pane=${state.inPane} dom=${state.inDom} file=${state.inFile}`
    );
    // The file lagging is EXPECTED and fine on its own - it is only a bug if the
    // screen loses what the file has not caught up with yet. Reported either way,
    // because whether the race happens at all is the thing worth knowing.
    if (!state.inFile) {
      log(`turn ${n}: NOTE - the transcript file had not caught up at this point; the pane is the only copy`);
    }
    assert(state.inPane, `turn ${n}: the reply is still in the pane's turns`);
    assert(state.inDom, `turn ${n}: and still on screen (last pane turn: ${JSON.stringify(state.lastPaneText)})`);

    // Leaving the session and coming back is the path his earlier report followed,
    // and it rebuilds the pane from scratch - so a turn that survives in memory can
    // still be lost here.
    await app.eval(`(async () => {
      const sid = panes[0].sessionId;
      const cli = panes[0].cliSessionId;
      openFreshDraftInPane(${JSON.stringify(projectDir)}, "", { forceIndex: 0 });
      await new Promise((r) => setTimeout(r, 400));
      await refresh();
      const s = (state.sessions || []).find((x) => x.sessionId === sid || x.cliSessionId === cli);
      if (s) { openSessionInPane(s, 0); }
      return !!s;
    })()`);
    await wait(3000);
    const afterReturn = await app.eval(`(() => {
      const scroll = document.querySelector('.pane[data-pane="0"] .pane-scroll');
      return {
        inDom: !!scroll && scroll.textContent.includes(${JSON.stringify(marker)}),
        inPane: (panes[0].turns || []).some((t) => String(t.text || "").includes(${JSON.stringify(marker)})),
      };
    })()`);
    assert(afterReturn.inPane && afterReturn.inDom, `turn ${n}: survives leaving the session and coming back`);
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    log("   ", e.text.slice(0, 200));
  }

  log(
    exitCode === 0
      ? `VERIFY OK: ${TURNS} real turns, each still on screen after the post-completion reload and after leaving and re-entering the session.`
      : "VERIFY FAILED: a reply that was produced is no longer on screen - this is the report in bee52369, now reproduced."
  );
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
  delete process.env.HELM_SECOND_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
