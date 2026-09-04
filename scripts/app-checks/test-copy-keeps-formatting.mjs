/**
 * Copying a reply keeps the formatting it had on screen.
 *
 * the captain, card a746f999: "kopiera ut output behåller inte formattering."
 *
 * The mechanism was one line: `clipboard.writeText(turn.text)`, and `turn.text` is the raw
 * markdown. Pasting into an editor was fine; pasting into a mail client or a document showed
 * literal `**bold**` and `#` headings. The formatting was on screen and nowhere in the paste.
 *
 * Two flavours fix it - text/plain stays the markdown, text/html carries the rendered
 * version - but the rich one cannot be the bubble's innerHTML verbatim, and that is what
 * this check is mostly about. The app's own affordances live INSIDE the bubble: a copy
 * button on every code block and a language label above it. Pasted verbatim they arrive as a
 * stray "⧉" and a floating word, which is a different wrong answer rather than a fix.
 *
 * Driven through the REAL renderer, because the thing being tested is what the DOM actually
 * contains after a reply is rendered - a hand-written HTML fixture would be testing my idea
 * of the markup rather than the markup.
 *
 * Run: node scripts/e2e/test-copy-keeps-formatting.mjs
 */
import { launch } from "../checks-lib/harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

// Every block shape this renderer can produce, because the translation is per-shape and a
// fixture that omits one proves nothing about that shape.
const MARKDOWN = [
  "# A heading",
  "",
  "First paragraph with **bold** text and a [link](https://example.com).",
  "Second line of the same paragraph.",
  "",
  "A new paragraph.",
  "",
  "- first bullet",
  "- second bullet",
  "",
  "1. numbered one",
  "2. numbered two",
  "",
  "> a quote line",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```bash",
  "echo hello",
  "```",
].join("\n");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const seen = await app.eval(
    `(() => {
      // Render a real assistant reply through the app's own path, then ask the copy helper
      // what it would put on the clipboard.
      const host = document.createElement("div");
      host.id = "copyProbe";
      document.body.append(host);
      const bubble = document.createElement("div");
      bubble.className = "bubble assistant";
      renderMarkdownInto(bubble, ${JSON.stringify(MARKDOWN)});
      host.append(bubble);
      const html = portableHtmlFrom(bubble);
      const onScreen = {
        hasCodeCopyButton: !!bubble.querySelector(".code-copy-btn"),
        hasLangLabel: !!bubble.querySelector(".md-code-head"),
      };
      host.remove();
      return { html, onScreen };
    })()`
  );

  // The premise: the affordances really are inside the bubble, or the sanitising below is
  // guarding against nothing and this check would pass for the wrong reason.
  ok(seen.onScreen.hasCodeCopyButton, "the rendered reply really does contain a code-block copy button on screen");

  ok(!!seen.html, "the copy helper produces a rich flavour at all");
  // The formatting itself - the whole point.
  ok(/<strong>|<b>/.test(seen.html), "bold survives as an element, not as asterisks");
  ok(!/\*\*bold\*\*/.test(seen.html), "and the markdown asterisks are gone from the rich flavour");
  ok(/<h1|<h2|<h3/.test(seen.html), "a heading survives as a heading");
  ok(/<li>/.test(seen.html), "list items survive as list items");
  ok(/<pre|<code/.test(seen.html), "a code block survives as a code block");
  ok(/href="https:\/\/example\.com"/.test(seen.html), "a link keeps its href - the one attribute worth keeping");

  // The half that needed the sanitiser.
  ok(!/⧉/.test(seen.html), "the per-code-block copy button does NOT come along as a stray glyph");
  ok(!/<button/.test(seen.html), "and neither does any other clickable affordance");
  ok(!/class=/.test(seen.html), "app class names are stripped - they mean nothing outside Helm");
  ok(!/data-/.test(seen.html), "and so are data attributes");

  // --- the four things only READING the output caught ---------------------------------------
  // Every assertion above was green while the markup still carried these. Pinned precisely
  // because a check cannot notice what nobody thought to ask about.
  ok(!/<p><br><\/p>|<p>\s*<\/p>/.test(seen.html), "no empty paragraph - a <p> holding only a break pastes as a stray blank line");
  ok(!/<br><\/p>/.test(seen.html), "no trailing break inside a paragraph - the paragraph already ends the line");
  ok(!/<span>/.test(seen.html), "no attribute-less span survives - it was a styling hook, and the hook is gone");
  ok(!/title=/.test(seen.html), "and no title attribute: this renderer sets it to the href, so it would paste as a tooltip duplicating the link");

  // Structure, not just presence: a run of bullets is ONE list, and ordered stays ordered.
  ok(/<ul><li>first bullet<\/li><li>second bullet<\/li><\/ul>/.test(seen.html), "consecutive bullets become one <ul>, not one list each");
  ok(/<ol><li>numbered one<\/li>/.test(seen.html), "and a numbered list becomes an <ol>");
  ok(/<blockquote>/.test(seen.html), "a quote line becomes a blockquote");
  ok(/<table><thead>/.test(seen.html), "a table keeps its head and body, which were already semantic");
  ok(/<p>A new paragraph\.<\/p>/.test(seen.html), "a blank line in the source becomes a real paragraph break");
  // The break AND the absence of one after it, in a single claim: the second source line
  // joins the first paragraph rather than starting its own, and the paragraph ends clean.
  ok(/<br>Second line of the same paragraph\.<\/p>/.test(seen.html), "while a single newline stays a hard break inside the same paragraph");
} catch (err) {
  fails += 1;
  console.log(`FAIL - the check threw: ${err && err.message}`);
} finally {
  if (app) {
    await app.close();
  }
}

// Source-level, for the two things the DOM cannot show: that the button sends BOTH flavours,
// and that a code block's own copy stays plain - a code block SHOULD paste as plain text, and
// wrapping it in HTML would be a regression dressed as a feature.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const renderer = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");
  const main = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");

  ok(
    /copyToClipboard\(html \? \{ text: turn\.text, html \} : turn\.text\)/.test(renderer),
    "the reply's Copy sends both flavours, and falls back to plain when there is no rich one"
  );
  ok(/window\.helm\.copyToClipboard\(pre\.textContent\)/.test(renderer), "a code block's own Copy stays plain text, which is correct for code");
  ok(/clipboard\.write\(\{ text: payload\.text, html: payload\.html \}\)/.test(main), "main writes both flavours when given both");
  ok(/clipboard\.writeText\(typeof payload === "string" \? payload : ""\)/.test(main), "and a bare string still works, for the callers copying a path or a sha");
}

console.log("");
console.log(fails === 0 ? "VERIFY OK: a copied reply pastes with its formatting, and none of the app's own buttons come with it." : `VERIFY FAILED: ${fails} assertion(s)`);
process.exit(fails === 0 ? 0 : 1);
