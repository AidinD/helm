// Standalone unit test for renderer.js's replaceVoiceSpan — the pure string
// helper behind continuous ("live") voice transcription. It replaces ONLY the
// voice-inserted span of the composer text, so a rolling partial ("vi ska")
// becoming a fuller one ("vi ska bygga") updates in place instead of
// appending duplicates, and text the user typed manually before recording is
// never clobbered.
//
// renderer.js runs in the browser (no module exports, uses DOM globals), so we
// can't `import` it in plain Node. Instead we read the source, extract the
// EXACT replaceVoiceSpan function text, and eval it — this tests the shipped
// code, not a hand-copied duplicate that could silently drift from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "renderer", "renderer.js"), "utf8");

const startMarker = "function replaceVoiceSpan(";
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  throw new Error("Could not find replaceVoiceSpan in renderer.js");
}
// Walk braces from the function's opening { to its matching close.
const braceStart = src.indexOf("{", startIdx);
let depth = 0;
let endIdx = -1;
for (let i = braceStart; i < src.length; i++) {
  if (src[i] === "{") {
    depth++;
  } else if (src[i] === "}") {
    depth--;
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }
}
if (endIdx === -1) {
  throw new Error("Could not find end of replaceVoiceSpan");
}
const fnText = src.slice(startIdx, endIdx);
// eslint-disable-next-line no-eval
const replaceVoiceSpan = eval(`(${fnText})`);

let passed = 0;
let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
  }
}

// --- First insert into an EMPTY composer: no separator, span == text length.
check(
  "empty composer, first partial",
  replaceVoiceSpan("", 0, 0, "vi ska"),
  { value: "vi ska", newVoiceLen: 6 }
);

// --- Partial grows in place, replacing the previous partial (the core case).
// Previous partial "vi ska" (len 6) at start 0 becomes "vi ska bygga".
check(
  "partial grows in place (no duplicate append)",
  replaceVoiceSpan("vi ska", 0, 6, "vi ska bygga"),
  { value: "vi ska bygga", newVoiceLen: 12 }
);

// --- Partial SHRINKS (whisper revised its guess to something shorter) — must
// still cleanly replace the whole old span, not leave a tail behind.
check(
  "partial shrinks in place",
  replaceVoiceSpan("vi ska bygga", 0, 12, "vi"),
  { value: "vi", newVoiceLen: 2 }
);

// --- User typed "hej" (no trailing space) before recording; caret at end (3).
// First voice partial must get a separator space, and that space is part of
// the voice span (newVoiceLen counts it) so a later shorter partial still
// replaces cleanly.
check(
  "preceding user text without trailing space -> separator added",
  replaceVoiceSpan("hej", 3, 0, "world"),
  { value: "hej world", newVoiceLen: 6 }
);

// --- Second partial after the separated first: old span " world" (len 6)
// starting at 3 gets replaced; separator re-derived (still needed), no
// double space, user's "hej" preserved.
check(
  "grow after separator, user text preserved, no double space",
  replaceVoiceSpan("hej world", 3, 6, "world peace"),
  { value: "hej world peace", newVoiceLen: 12 }
);

// --- Preceding user text that ALREADY ends in a space: no extra separator.
check(
  "preceding user text with trailing space -> no extra separator",
  replaceVoiceSpan("hej ", 4, 0, "world"),
  { value: "hej world", newVoiceLen: 5 }
);

// --- Preceding user text ending in a newline counts as whitespace too.
check(
  "preceding user text ending in newline -> no separator",
  replaceVoiceSpan("line1\n", 6, 0, "spoken"),
  { value: "line1\nspoken", newVoiceLen: 6 }
);

// --- FINAL empty result must cleanly REMOVE a stray partial (release with
// nothing recognized), leaving the user's original text intact incl. no
// dangling separator space.
check(
  "final empty result removes stray partial",
  replaceVoiceSpan("hej world", 3, 6, ""),
  { value: "hej", newVoiceLen: 0 }
);

// --- Empty result on an empty composer -> stays empty.
check(
  "final empty on empty composer",
  replaceVoiceSpan("spoken", 0, 6, ""),
  { value: "", newVoiceLen: 0 }
);

// --- Text AFTER the voice span (user moved caret / edge case) is preserved.
// "AB" with voice span at 1 len 0, text "x": the preceding "A" has no trailing
// whitespace so a separator space IS added (same rule as any other insert),
// and the trailing "B" is kept -> "A xB". This documents that the separator
// rule keys purely off the char before voiceStart, which is exactly right for
// the real flow where voiceStart is the caret at record start.
check(
  "text after the voice span is preserved (separator still applies)",
  replaceVoiceSpan("AB", 1, 0, "x"),
  { value: "A xB", newVoiceLen: 2 }
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
