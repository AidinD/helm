// The chat renders the structure the model already sends.
//
// the captain, task c6094e4f: "Formatera Helm-chatten mycket snyggare - både kod (IDE-färger)
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

  // ===================================================================================
  // What an independent review found wrong in the first version. Every one of these
  // passed the assertions above, which is why they are here now: a review's findings are
  // only fixed once something would notice them coming back.
  // ===================================================================================
  const regressions = await app.eval(`(() => {
    const render = (md) => {
      const b = document.createElement("div");
      b.className = "turn-bubble";
      renderMarkdownInto(b, md);
      return b;
    };
    const tokensOf = (b) => [...b.querySelectorAll(".md-code-block span")].map((s) => ({ cls: s.className, text: s.textContent }));

    // 1. Arithmetic is not emphasis. "2 * 3 * 4" was rendered as "2  3  4".
    const math = render("Räkna: 2 * 3 * 4 = 24");
    // 2. Nested emphasis left literal asterisks.
    const nested = render("**fet *och* kursiv**");
    // 3. A link whose href contains parentheses pointed somewhere else.
    const parens = render("Se [wiki](https://example.com/a_(b)_c) nu");
    // 4. Ordinary members were tinted as keywords.
    const members = render(["\`\`\`js", "res.set(name, value);", "const t = obj.type;", "str.match(/x/);", "\`\`\`"].join("\\n"));
    // 5. A fence info string with attributes leaked into the code.
    const info = render(["\`\`\`js title=\\"x\\"", "const a = 1;", "\`\`\`"].join("\\n"));
    return {
      mathText: math.textContent,
      mathEms: math.querySelectorAll("em").length,
      nestedHtmlHasStars: /\\*\\*/.test(nested.textContent),
      nestedStrong: nested.querySelector("strong")?.textContent || null,
      nestedEmInsideStrong: nested.querySelector("strong em")?.textContent || null,
      parensHref: parens.querySelector("a.md-link")?.getAttribute("href") || null,
      parensTail: parens.textContent,
      memberTokens: tokensOf(members).filter((t) => ["set", "type", "match"].includes(t.text)),
      infoLang: info.querySelector(".md-code-lang")?.textContent || null,
      infoCode: info.querySelector(".md-code-block")?.textContent || "",
    };
  })()`);
  ok(regressions.mathText.includes("2 * 3 * 4"), `arithmetic keeps its asterisks (${JSON.stringify(regressions.mathText)})`);
  ok(regressions.mathEms === 0, "and is not read as an italic");
  ok(!regressions.nestedHtmlHasStars, "nested emphasis leaves no literal ** behind");
  ok(regressions.nestedEmInsideStrong === "och", `with the italic INSIDE the bold (${JSON.stringify(regressions.nestedEmInsideStrong)})`);
  ok(
    regressions.parensHref === "https://example.com/a_(b)_c",
    `a link href keeps its parentheses instead of pointing somewhere else (${regressions.parensHref})`
  );
  ok(!/_c\)/.test(regressions.parensTail.replace("https://example.com/a_(b)_c", "")), "and leaves no stray tail text");
  ok(
    regressions.memberTokens.every((t) => t.cls !== "tok-kw"),
    `res.set / obj.type / str.match are members, not keywords (${JSON.stringify(regressions.memberTokens)})`
  );
  ok(regressions.infoLang === "js", `a fence info string with attributes still yields its language (${regressions.infoLang})`);
  ok(!/title=/.test(regressions.infoCode), `and does not leak into the code (${JSON.stringify(regressions.infoCode)})`);

  // 6. The card asks for 65-75 characters per line. The first version shipped 76ch, which
  // MEASURES 87 - so this measures characters, not the css unit.
  const chars = await app.eval(`(() => {
    const parent = document.createElement("div");
    parent.className = "turn assistant";
    parent.style.cssText = "width:1600px;position:fixed;left:0;top:0;visibility:hidden";
    const b = document.createElement("div");
    b.className = "turn-bubble";
    renderMarkdownInto(b, "Kontextfilernas knappar frågade efter fel sorts post, så en ämnesöverlämning bad om ett projektdokument och fick ett fel tillbaka igen och igen tills kontrollen ändrades.");
    parent.append(b);
    document.body.append(parent);
    const node = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    const perLine = [];
    let start = 0;
    let lastTop = null;
    for (let i = 1; i <= node.textContent.length; i++) {
      r.setStart(node, i - 1);
      r.setEnd(node, i);
      const top = Math.round(r.getBoundingClientRect().top);
      if (lastTop === null) {
        lastTop = top;
      } else if (top !== lastTop) {
        perLine.push(i - 1 - start);
        start = i - 1;
        lastTop = top;
      }
    }
    const width = b.getBoundingClientRect().width;
    parent.remove();
    return { perLine, width: Math.round(width) };
  })()`);
  const longest = Math.max(...chars.perLine);
  ok(
    longest >= 60 && longest <= 78,
    `a full line measures ${longest} characters - the card asks for ~65-75 (column ${chars.width}px, lines ${JSON.stringify(chars.perLine)})`
  );

  // 7. Colouring code must not make it HARDER to read than leaving it alone. On the light
  // theme the first version's keywords were 2.20:1 against the code ground, where the
  // uncoloured text they replaced was 11.80:1.
  const contrast = await app.eval(`(async () => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s) => (s.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
    const ratio = (a, b) => {
      const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const before = document.documentElement.getAttribute("data-theme");
    const out = {};
    for (const theme of ["dark", "brass"]) {
      document.documentElement.setAttribute("data-theme", theme);
      await new Promise((r) => setTimeout(r, 60));
      const holder = document.createElement("div");
      holder.className = "turn-bubble";
      const pre = document.createElement("pre");
      pre.className = "md-code-block";
      const spans = {};
      for (const cls of ["tok-kw", "tok-str", "tok-com", "tok-num", "tok-fn", "tok-prop", "tok-tag"]) {
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = "x";
        pre.append(s);
        spans[cls] = s;
      }
      holder.append(pre);
      document.body.append(holder);
      const bg = getComputedStyle(pre).backgroundColor;
      const ground = parse(bg === "rgba(0, 0, 0, 0)" ? getComputedStyle(holder).backgroundColor : bg);
      out[theme] = {};
      for (const [cls, el] of Object.entries(spans)) {
        out[theme][cls] = Math.round(ratio(parse(getComputedStyle(el).color), ground) * 100) / 100;
      }
      holder.remove();
    }
    if (before) {
      document.documentElement.setAttribute("data-theme", before);
    }
    return out;
  })()`);
  for (const theme of ["dark", "brass"]) {
    const worst = Math.min(...Object.values(contrast[theme]));
    ok(
      worst >= 4.5,
      `every token colour clears 4.5:1 on the ${theme} theme - worst is ${worst} (${JSON.stringify(contrast[theme])})`
    );
  }

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
