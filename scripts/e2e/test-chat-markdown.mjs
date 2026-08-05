// The chat renders the structure the model already sends.
//
// Aidin, task c6094e4f: "Formatera Helm-chatten mycket snyggare - både kod (IDE-färger)
// och vanlig text ... Ögonen blir trötta av den platta väggen av likadana textrader idag."
// And the scope note on the card: this is NOT just a font and width change - the
// structural rendering is the substance.
//
// So this drives the REAL renderer with one realistic reply and checks what a person
// would see: headings as headings, numbered items with their own markers, a quote, a rule,
// a link, italics, and a code block whose language survived and whose tokens are coloured.
// Every one of those was plain text before, which is why the assertions are about the
// elements produced rather than about the source being present.
//
// Run:  node scripts/e2e/test-chat-markdown.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-chatmd-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9523";
const { launch } = await import("./harness.mjs");

// A reply of the shape his sessions actually produce.
const REPLY = [
  "# Vad jag ändrade",
  "",
  "Kontextfilernas knappar frågade efter fel *sorts* post, så en ämnesöverlämning fick `Invalid project doc`.",
  "",
  "## Tre saker",
  "",
  "1. Knappen frågar efter den sort den **är**.",
  "2. Ämnesöverlämningarna fick en egen rad.",
  "3. `HANDOFF.md (none)` är borta vid roten.",
  "",
  "### Detaljer",
  "",
  "- första punkten",
  "- andra punkten",
  "",
  "> Vid den roten *är* ämnesfilerna överlämningarna.",
  "> Så appen motsade sig själv.",
  "",
  "---",
  "",
  "Se [dokumentationen](https://docs.claude.com/) och [testet](scripts/e2e/test-x.mjs).",
  "",
  "```javascript",
  'const docs = list.filter((d) => d.kind !== "handoffTopic"); // keep the real ones',
  "if (docs.length > 2) {",
  "  openDocViewer({ label: docs[0].name });",
  "}",
  "```",
  "",
  "```",
  "no language here",
  "```",
].join("\n");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const out = await app.eval(`(() => {
    document.querySelectorAll("#mdProbe").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "mdProbe";
    const bubble = document.createElement("div");
    bubble.className = "turn-bubble";
    renderMarkdownInto(bubble, ${JSON.stringify(REPLY)});
    wrap.append(bubble);
    document.body.append(wrap);
    const q = (sel) => [...bubble.querySelectorAll(sel)];
    const blocks = q(".md-code-wrap");
    return {
      headings: q(".md-h").map((h) => ({ cls: h.className, text: h.textContent })),
      ordered: q(".md-oli").map((li) => ({ marker: li.querySelector(".md-marker")?.textContent, text: li.textContent })),
      bullets: q(".md-li:not(.md-oli)").map((li) => ({ marker: li.querySelector(".md-marker")?.textContent, text: li.textContent })),
      quotes: q(".md-quote").map((x) => x.textContent),
      rules: q(".md-hr").length,
      links: q("a.md-link").map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent })),
      plainLinks: q(".md-link-plain").map((s) => ({ text: s.textContent, title: s.title })),
      italics: q("em").map((e) => e.textContent),
      bolds: q("strong").map((e) => e.textContent),
      inlineCode: q("code").map((c) => c.textContent),
      langTags: blocks.map((b) => b.querySelector(".md-code-lang")?.textContent || null),
      tokenClasses: [...new Set(q(".md-code-block span").map((s) => s.className))].sort(),
      firstBlockText: blocks[0]?.querySelector("pre")?.textContent || "",
      secondBlockSpans: blocks[1]?.querySelectorAll("pre span").length ?? -1,
      hashesLeft: (bubble.textContent.match(/^#{1,3} /gm) || []).length,
      asterisksLeft: (bubble.textContent.match(/\\*\\*/g) || []).length,
      rawLinkLeft: /\\]\\(https/.test(bubble.textContent),
    };
  })()`);

  // --- headings ---------------------------------------------------------------
  ok(out.headings.length === 3, `all three heading levels render as headings (${out.headings.length})`);
  ok(
    JSON.stringify(out.headings.map((h) => h.cls)) === JSON.stringify(["md-h md-h1", "md-h md-h2", "md-h md-h3"]),
    `each at its own level (${JSON.stringify(out.headings.map((h) => h.cls))})`
  );
  ok(out.headings[0].text === "Vad jag ändrade", `with the hashes stripped (${JSON.stringify(out.headings[0].text)})`);
  ok(out.hashesLeft === 0, `and no "# " left anywhere in the rendered text (${out.hashesLeft})`);

  // --- lists ------------------------------------------------------------------
  ok(out.ordered.length === 3, `the numbered list renders as three items (${out.ordered.length})`);
  ok(
    JSON.stringify(out.ordered.map((o) => o.marker)) === JSON.stringify(["1.", "2.", "3."]),
    `each with the author's own number as its marker (${JSON.stringify(out.ordered.map((o) => o.marker))})`
  );
  ok(
    out.bullets.length === 2 && out.bullets.every((b) => b.marker === "•"),
    `and the bullets keep their own marker (${JSON.stringify(out.bullets.map((b) => b.marker))})`
  );

  // --- quote, rule ------------------------------------------------------------
  ok(out.quotes.length === 2, `both quote lines render as quote rows (${out.quotes.length})`);
  ok(!out.quotes.some((x) => x.trim().startsWith(">")), `with the ">" gone (${JSON.stringify(out.quotes[0])})`);
  ok(out.rules === 1, `the --- renders as a rule rather than three hyphens (${out.rules})`);

  // --- inline -----------------------------------------------------------------
  ok(out.italics.includes("sorts"), `italics render as italics (${JSON.stringify(out.italics)})`);
  ok(out.bolds.includes("är"), `bold still works (${JSON.stringify(out.bolds)})`);
  ok(out.asterisksLeft === 0, "and no ** is left in the text");
  ok(out.inlineCode.includes("Invalid project doc"), `inline code still works (${JSON.stringify(out.inlineCode.slice(0, 2))})`);
  ok(out.links.length === 1, `an http link becomes a real link (${JSON.stringify(out.links)})`);
  ok(out.links[0]?.href === "https://docs.claude.com/", "pointing where it said");
  ok(out.links[0]?.target === "_blank" && /noopener/.test(out.links[0]?.rel || ""), "opened out of the app, with noopener");
  ok(
    out.plainLinks.length === 1 && out.plainLinks[0].title === "scripts/e2e/test-x.mjs",
    `while a non-http target renders as its label with the path on hover (${JSON.stringify(out.plainLinks)})`
  );
  ok(!out.rawLinkLeft, "and no markdown link source is left visible");

  // --- code -------------------------------------------------------------------
  ok(out.langTags[0] === "javascript", `the fence's language survives and is shown (${JSON.stringify(out.langTags)})`);
  ok(out.langTags[1] === null, "an unlabelled fence gets no language tag");
  ok(
    out.firstBlockText.startsWith("const docs = list.filter"),
    `the code itself is unchanged - the language line is not part of it (${JSON.stringify(out.firstBlockText.slice(0, 40))})`
  );
  ok(!/^javascript/.test(out.firstBlockText), "and the language line is not left inside the block");
  ok(out.secondBlockSpans === 0, `an unknown language renders as plain text rather than guessed colours (${out.secondBlockSpans} spans)`);
  for (const cls of ["tok-kw", "tok-str", "tok-com", "tok-num", "tok-fn"]) {
    ok(out.tokenClasses.includes(cls), `${cls} is coloured in the javascript block (${JSON.stringify(out.tokenClasses)})`);
  }

  // --- the measure, and the weight --------------------------------------------
  const type = await app.eval(`(() => {
    const b = document.querySelector("#mdProbe .turn-bubble");
    const parent = document.createElement("div");
    parent.className = "turn assistant";
    parent.style.width = "1600px";
    document.body.append(parent);
    parent.append(b);
    const s = getComputedStyle(b);
    return { width: b.getBoundingClientRect().width, maxWidth: s.maxWidth, fontSize: parseFloat(s.fontSize), weight: s.fontWeight };
  })()`);
  ok(type.fontSize >= 14.5, `the reply text is 15px-ish, not 13px (${type.fontSize})`);
  ok(
    type.width <= 700,
    `and a reply in a 1600px pane is held to a readable column rather than the pane's width (${Math.round(type.width)}px)`
  );

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
    ? "VERIFY OK: headings, numbered lists, quotes, rules, links and italics render as themselves, and a code block keeps its language and gets coloured."
    : "VERIFY FAILED."
);
process.exit(exit);
