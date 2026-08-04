// A code block in a reply gets its own copy button.
//
// the captain, task 0a8afe16 ("en copy code knapp"), with a screenshot of a long markdown block he
// wanted to paste elsewhere. The reply already had a copy button, but it copies the WHOLE
// reply - the sentence of chat around the block comes with it - and selecting the block by
// hand means dragging through a box that scrolls.
//
// Run:  node scripts/e2e/test-code-block-copy.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-codecopy-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9508";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    const CODE = "# Hi, I'm the captain\\n\\n**Engineering Manager**\\n\\nline three with  spaces  kept";
    const bubble = document.createElement("div");
    bubble.className = "turn-bubble";
    document.body.append(bubble);
    renderMarkdownInto(bubble, "Here is the bio:\\n\\n\`\`\`markdown\\n" + CODE + "\\n\`\`\`\\n\\nTell me what you think.");

    const wraps = bubble.querySelectorAll(".md-code-wrap");
    const pre = bubble.querySelector(".md-code-block");
    const btn = bubble.querySelector(".code-copy-btn");
    const before = btn ? btn.textContent : null;
    const hasCopyFn = typeof window.helm.copyToClipboard === "function";
    // Read the resting opacity BEFORE clicking: the click both focuses the button and adds
    // .copied, each of which is SUPPOSED to reveal it. Measuring afterwards reported opacity
    // 1 and read as "the hover-only rule is broken" when it was the measurement that was.
    const hiddenAtRest = btn ? getComputedStyle(btn).opacity : null;
    if (btn) { btn.click(); }
    const after = btn ? btn.textContent : null;
    const copiedClass = btn ? btn.classList.contains("copied") : false;

    // The button must not live inside the scrolling <pre>: it would slide out of view
    // with the content on a wide line.
    const insidePre = btn ? !!btn.closest("pre") : null;
    const positioned = btn ? getComputedStyle(btn).position : null;
    const wrapPositioned = wraps[0] ? getComputedStyle(wraps[0]).position : null;

    // Two blocks in one reply must each get their own button, addressing their own text.
    const two = document.createElement("div");
    two.className = "turn-bubble";
    document.body.append(two);
    renderMarkdownInto(two, "one:\\n\\n\`\`\`\\nAAA\\n\`\`\`\\n\\ntwo:\\n\\n\`\`\`\\nBBB\\n\`\`\`");
    const twoBtns = two.querySelectorAll(".code-copy-btn");
    const twoTexts = [...two.querySelectorAll(".md-code-block")].map((p) => p.textContent.trim());

    // Plain prose must NOT sprout a button.
    const prose = document.createElement("div");
    prose.className = "turn-bubble";
    document.body.append(prose);
    renderMarkdownInto(prose, "Just a sentence with \`inline code\` in it.");
    const proseBtns = prose.querySelectorAll(".code-copy-btn").length;

    const out = {
      wraps: wraps.length,
      preText: pre ? pre.textContent : null,
      expected: CODE,
      before,
      after,
      copiedClass,
      hasCopyFn,
      insidePre,
      positioned,
      wrapPositioned,
      hiddenAtRest,
      twoBtns: twoBtns.length,
      twoTexts,
      proseBtns,
      // The language line of the fence must not end up in what gets copied.
      leaksFenceInfo: pre ? /^markdown/.test(pre.textContent) : null,
    };
    bubble.remove();
    two.remove();
    prose.remove();
    return out;
  })()`);

  ok(res.wraps === 1, `the block is wrapped so a button can be pinned to it (${res.wraps})`);
  // Compared with the trailing newline trimmed: the fence's own closing line leaves one
  // behind, which is not a difference anyone pasting the block would notice or want asserted.
  ok(
    String(res.preText).replace(/\n+$/, "") === res.expected,
    `the block's own text is intact (${JSON.stringify(String(res.preText))})`
  );
  ok(
    String(res.preText).includes("with  spaces  kept"),
    "with its interior whitespace preserved - a copied block that lost its spacing is not the block"
  );
  ok(res.leaksFenceInfo === false, "and the fence's language line is not part of it");
  ok(res.before === "⧉", `the button starts as the same glyph the reply-level copy uses (${JSON.stringify(res.before)})`);
  ok(res.hasCopyFn, "the clipboard bridge it calls exists");
  ok(res.after === "✓" && res.copiedClass, `clicking it confirms - the handler really ran (${JSON.stringify(res.after)}, copied=${res.copiedClass})`);
  ok(res.insidePre === false, "the button is NOT inside the scrolling <pre>, so a wide line cannot scroll it out of view");
  ok(res.positioned === "absolute" && res.wrapPositioned === "relative", `it is positioned against the wrapper (${res.positioned} in ${res.wrapPositioned})`);
  ok(res.hiddenAtRest === "0", `and hidden until the block is hovered, like the reply-level button (opacity ${res.hiddenAtRest})`);
  ok(res.twoBtns === 2, `two blocks in one reply get two buttons (${res.twoBtns})`);
  ok(res.twoTexts.join("|") === "AAA|BBB", `each addressing its own block (${JSON.stringify(res.twoTexts)})`);
  ok(res.proseBtns === 0, `prose with inline code gets none (${res.proseBtns})`);

  // A picture of it, when asked for one: the assertions above check position and visibility
  // rules, which is not the same as seeing that it looks right on the code.
  if (process.env.HELM_SHOT) {
    await app.eval(`(() => {
      navigateToPage("chat");
      const bubble = document.createElement("div");
      bubble.className = "turn-bubble";
      bubble.style.cssText = "margin:40px;max-width:640px";
      document.body.append(bubble);
      renderMarkdownInto(bubble, "Here is the bio:\\n\\n\`\`\`markdown\\n# Hi, I'm the captain\\n\\n**Engineering Manager | Software Architect**\\n\\nI build the tools that remove engineering friction.\\n\`\`\`");
      // Force the hover state the screenshot is meant to show.
      bubble.querySelector(".code-copy-btn").style.opacity = "1";
    })()`);
    const shot = path.join(process.env.HELM_SHOT_DIR || tmp, "code-copy.png");
    // The harness documents that this CDP call can hang, so it rejects on a timeout. A
    // picture is a convenience here, not the check - it must not be able to fail the test.
    try {
      await app.screenshot(shot);
      console.log("screenshot:", shot);
    } catch (err) {
      console.log("screenshot skipped:", err.message);
    }
  }

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 160));
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

// NOT VERIFIED here: that the CONTENTS of the clipboard end up correct. The bridge is a
// contextBridge object, so it cannot be stubbed to record what it was handed (that lesson cost
// a whole test once - a spy on window.helm is an assertion that cannot fail), and nothing in
// the renderer can read the clipboard back. What is checked is that the handler ran and what
// text it was reading from.
console.log(
  exit === 0
    ? "VERIFY OK: every fenced block carries its own copy button, pinned outside the scroll area, hidden until hover, addressing its own text."
    : "VERIFY FAILED."
);
process.exit(exit);
