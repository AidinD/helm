// The script-run panel has to render a build tool's COLOURED output readably.
//
// the captain ran `npm run dev` on a Vite project through the panel on 2026-08-02 and got
//   [2m14:11:14[22m [36m[1mvite[22m[39m Re-optimizing dependencies...
// - every colour instruction printed as literal junk, the escape byte drawn as a
// box glyph. The same complaint the panel was built to fix ("terminalen ar inte
// tydlig"), just one layer further in: I had tested the panel with `node -e` and
// `npm`, neither of which colours its output.
//
// Run: node scripts/e2e/test-ansi-output.mjs
import { parseAnsi, newAnsiState, stripAnsi, collapseCarriageReturns } from "../../src/lib/ansi.js";

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};
const E = String.fromCharCode(27);
const text = (segs) => segs.map((s) => s.text).join("");

// --- the exact line from his screenshot ------------------------------------
const vite = `${E}[2m14:11:14${E}[22m ${E}[36m${E}[1mvite${E}[22m${E}[39m ${E}[35m${E}[2m(dinghy)${E}[22m${E}[39m Re-optimizing dependencies`;
const segs = parseAnsi(vite, newAnsiState());
ok(!text(segs).includes(E), "no escape byte survives into the page");
ok(!/\[\d+m/.test(text(segs)), `and no colour codes are shown as text (${JSON.stringify(text(segs))})`);
ok(text(segs) === "14:11:14 vite (dinghy) Re-optimizing dependencies", `the readable text is exactly what a terminal would show (${JSON.stringify(text(segs))})`);

const viteWord = segs.find((s) => s.text === "vite");
ok(!!viteWord, "the coloured word is its own segment");
ok(viteWord?.style.color && viteWord.style.bold === true, `and keeps its colour and weight (${JSON.stringify(viteWord?.style)})`);
const stamp = segs.find((s) => s.text.startsWith("14:11"));
ok(stamp?.style.dim === true, "the dim timestamp stays dim - the emphasis is the point of keeping colour at all");

// --- styles must not leak past their reset ---------------------------------
const afterReset = segs[segs.length - 1];
ok(!afterReset.style.bold && !afterReset.style.color, `text after a reset is unstyled (${JSON.stringify(afterReset.style)})`);

// --- state carries across chunks -------------------------------------------
// Streamed output splits at arbitrary offsets, so a sequence WILL be cut in half.
const st = newAnsiState();
const a = parseAnsi(`${E}[31mred start`, st);
const b = parseAnsi(` still red${E}[0m plain`, st);
ok(a[0].style.color && b[0].style.color === a[0].style.color, "a colour opened in one chunk still applies in the next");
ok(text(b).endsWith(" plain") && b[b.length - 1].style.color === undefined, "and the reset in the later chunk ends it");

const split = newAnsiState();
const p1 = parseAnsi(`before${E}[3`, split);
const p2 = parseAnsi(`6mcyan`, split);
ok(text(p1) === "before", `a chunk ending mid-sequence emits only the complete text (${JSON.stringify(text(p1))})`);
ok(text(p2) === "cyan" && !!p2[0].style.color, `and the sequence completes on the next chunk (${JSON.stringify(text(p2))})`);
ok(!text(p1).includes("[3") && !text(p2).includes("[3"), "the split sequence never leaks as visible junk");

// A stray escape must not swallow the log forever.
const stray = newAnsiState();
const long = parseAnsi(E + "x".repeat(200), stray);
ok(text(long).includes("x".repeat(100)), "a lone escape byte does not hold back the rest of the output");

// --- non-colour sequences are discarded, not printed ------------------------
const spinner = parseAnsi(`${E}[2K${E}[1Gbuilding...${E}[?25l`, newAnsiState());
ok(text(spinner) === "building...", `cursor and erase sequences are dropped (${JSON.stringify(text(spinner))})`);
const title = parseAnsi(`${E}]0;my title\x07done`, newAnsiState());
ok(text(title) === "done", `a window-title sequence is dropped (${JSON.stringify(text(title))})`);

// --- carriage-return spinners collapse --------------------------------------
const CR = String.fromCharCode(13);
ok(
  collapseCarriageReturns(`10%${CR}50%${CR}100%`) === "100%",
  "a progress line that overwrites itself keeps only its final state"
);
ok(collapseCarriageReturns(`a\nb${CR}c\nd`) === "a\nc\nd", "and it works per line, not across the whole log");

// --- the plain-text form, for copying ---------------------------------------
ok(stripAnsi(vite) === "14:11:14 vite (dinghy) Re-optimizing dependencies", "stripAnsi gives the same readable text with no styling");
ok(stripAnsi(null) === "" && text(parseAnsi(null, newAnsiState())) === "", "null input is empty, not the string 'null'");

// --- plain output stays cheap -----------------------------------------------
const plain = parseAnsi("just some ordinary build output\nsecond line\n", newAnsiState());
ok(plain.length === 1, `uncoloured output is ONE segment, not one per character (${plain.length})`);
ok(Object.keys(plain[0].style).length === 0, "with no styling attached");

console.log(
  code === 0
    ? "\nVERIFY OK: coloured build output renders as colour, not as escape-code junk, across chunk boundaries."
    : "\nVERIFY FAILED"
);
process.exit(code);
