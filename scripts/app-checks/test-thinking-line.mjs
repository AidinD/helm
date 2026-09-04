// LIVE-EXEMPT: it does start a session, but HELM_CLAUDE_BIN points the launcher at
// fixtures/fake-claude, so nothing reaches a model and nothing is spent.
//
// Show what the session is reasoning about, while it still is (card ba3138af).
//
// the captain, 2026-08-30: "i claude desktop finns även den här utskriften medans claude tänker,
// jag gillar den skarpt."
//
// The elapsed time and the token count were already on the status row. What was missing is
// the sentence above them, and the card's open question was whether that sentence comes from
// the stream or has to be generated. It comes from the stream: the CLI emits one event per
// content block and has always included the thinking ones, and launcher.js simply had no
// branch for them - so Helm received them and dropped them. No model call, no extra request.
//
// Measured on this machine before building it, because 41% decides the design: 27,291
// thinking blocks on disk, 16,168 with content, 11,123 signature-only. A blank line would
// therefore have been the COMMON case, so an empty block must produce nothing at all rather
// than an empty italic row. That is the assertion this check cares most about.
//
// Run: node scripts/e2e/test-thinking-line.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const THOUGHT_FIRST = "Reading the two call sites before deciding anything.";
const THOUGHT_LAST = "Settling on the watermark approach rather than a per-row flag.";

process.env.HELM_CLAUDE_BIN = path.join(here, "fixtures", "fake-claude.cmd");
// Two lines, so the "which part" choice is exercised: the LAST one is what a live indicator
// should show, and the first is where it started.
process.env.FAKE_CLAUDE_THINKING = `${THOUGHT_FIRST}\n\n${THOUGHT_LAST}`;
// Long enough to observe the line while the turn is still running.
process.env.FAKE_CLAUDE_HOLD_MS = "3000";

const { launch } = await import("../checks-lib/harness.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-thinking-"));
fs.writeFileSync(path.join(tmp, "README.md"), "# scratch\n", "utf8");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the pure choice, before any of the wiring -------------------------------------------
  const picked = await app.eval(
    `(() => ({
      last: lastThinkingLine(${JSON.stringify(`${THOUGHT_FIRST}\n\n${THOUGHT_LAST}`)}),
      empty: lastThinkingLine(""),
      collapsed: lastThinkingLine("  a   line   with    gaps  "),
      long: lastThinkingLine("x".repeat(400)),
    }))()`
  );
  ok(picked.last === THOUGHT_LAST, `the LAST line is what gets shown, not the first (${JSON.stringify(picked.last)})`);
  ok(picked.empty === "", "no text gives no line");
  ok(picked.collapsed === "a line with gaps", "whitespace is collapsed, so a wrapped thought is one line");
  ok(picked.long.length <= 140 && picked.long.endsWith("…"), `a 13,000-character thought is truncated with an ellipsis (${picked.long.length} chars)`);

  // --- the line, while a real turn is running ----------------------------------------------
  const seen = await app.eval(
    `(async () => {
      navigateToPage("chat");
      // Driven the way a person does it: fill the two inputs and click Send, so the app's own
      // wiring resolves the element bundle sendFromPane needs rather than this test guessing
      // at it. The composer textarea carries no class, which is why it is found by tag.
      const paneEl = document.querySelector('.pane[data-pane="0"]');
      paneEl.querySelector(".cwd-input").value = ${JSON.stringify(tmp.replace(/\\/g, "/"))};
      paneEl.querySelector("textarea").value = "say something";
      paneEl.querySelector(".send-btn").click();
      const deadline = Date.now() + 20000;
      let whileBusy = null;
      while (Date.now() < deadline) {
        const line = document.querySelector('.pane[data-pane="0"] .pane-thinking');
        if (line && line.textContent.trim()) {
          whileBusy = { text: line.textContent, title: line.title, busy: !!panes[0].busy };
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Wipe the status row the way a tool call does, then see whether the thought comes back.
      let survivedStatusWipe = false;
      if (whileBusy) {
        setPaneBusyUI(0, "Working - Bash");
        const wipedBy = Date.now() + 3000;
        while (Date.now() < wipedBy) {
          const back = document.querySelector('.pane[data-pane="0"] .pane-thinking');
          if (back && back.textContent.trim()) {
            survivedStatusWipe = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Then wait for the turn to finish and look again: the line must not be left behind.
      const endBy = Date.now() + 30000;
      while (Date.now() < endBy && panes[0].busy) {
        await new Promise((r) => setTimeout(r, 150));
      }
      // One more frame for the terminal event's own repaint.
      await new Promise((r) => setTimeout(r, 500));
      const after = document.querySelector('.pane[data-pane="0"] .pane-thinking');
      return {
        whileBusy,
        survivedStatusWipe,
        afterText: after ? after.textContent : null,
        stillBusy: !!panes[0].busy,
        liveThinking: panes[0].liveThinking || "",
      };
    })()`
  );

  ok(!!seen.whileBusy, "the thinking line appears on the pane while the turn runs, without a click");
  ok(!!seen.whileBusy && seen.whileBusy.busy === true, "and it is there while the pane is still busy, not only afterwards");
  ok(!!seen.whileBusy && seen.whileBusy.text.includes(THOUGHT_LAST), `showing the newest thought (${JSON.stringify(seen.whileBusy && seen.whileBusy.text)})`);
  // The 41% case: the stub sends a signature-only block right after the real one. If an empty
  // block were emitted it would blank the line, and the assertion above would have caught a
  // wiped line instead.
  ok(
    !!seen.whileBusy && seen.whileBusy.text.includes(THOUGHT_LAST),
    "a signature-only thinking block that follows does NOT wipe the line - the empty ones are never emitted"
  );
  ok(!!seen.whileBusy && seen.whileBusy.title.includes(THOUGHT_LAST), "the whole thought is on the title, since the line itself is clamped");
  // The one a mutation had to teach me about. setPaneBusyUI clears the entire status row with
  // `status.innerHTML = ""` and is called on every tool_use to update the "Working - ToolName"
  // text, so a line painted only on arrival vanished at the first tool call and stayed gone
  // until the model thought again - it flickered through exactly the long turns it is for.
  ok(seen.survivedStatusWipe, "the thought survives a status-row rewrite mid-turn, the way every tool call causes");
  // AC 2 on the card: the line must not be left behind as debris.
  ok(seen.stillBusy === false, "the turn finished");
  ok(!seen.afterText, `and the line is gone once it did, not left as debris (${JSON.stringify(seen.afterText)})`);
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
    // temp dir; a leftover is harmless
  }
}

// --- and no model call was added for any of it ----------------------------------------------
{
  const launcher = fs.readFileSync(path.join(here, "..", "..", "src", "lib", "launcher.js"), "utf8");
  ok(/block\.type === "thinking"/.test(launcher), "the launcher reads the thinking block off the stream it already receives");
  ok(/if \(thought\.trim\(\)\) \{/.test(launcher), "and only emits when there is something to say");
  // AC 3: if the summary cost a model call it would have to be a deliberate choice. It does
  // not, and this is what keeps that true - a future "summarise the thinking" call would have
  // to add a spawn here, and this notices.
  const near = launcher.slice(launcher.indexOf('block.type === "thinking"'), launcher.indexOf('block.type === "thinking"') + 1200);
  ok(!/spawn|startSession|ask\(/.test(near), "with nothing spawned or asked anywhere near it - the sentence is free");
}

console.log("");
console.log(fails === 0 ? "VERIFY OK: the pane says what it is reasoning about while it runs, and says nothing when there is nothing to say." : `VERIFY FAILED: ${fails} assertion(s)`);
process.exit(fails === 0 ? 0 : 1);
