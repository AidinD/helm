// "Jag vill kunna expandera för att se thought process - som i desktop appen" (Aidin,
// 2026-08-12).
//
// The reasoning was in the transcript on disk the whole time; the parser saw it and threw it
// away with one comment: "thinking blocks are intentionally omitted from the default view".
// Omitted from the VIEW is right - it renders collapsed - but omitting it from the parse made
// it unreachable from the app at all.
//
// The load-bearing risk is not the parsing, it is what a new assistant-role turn does to
// everything that hunts for "the last reply". The Done button, the turn stats and the
// needs-input flag all attach to the LAST `.turn.assistant .turn-bubble`. If a thinking block
// were a bubble, those would quietly start landing on the reasoning instead of the answer. So
// the last check here is that a thinking turn produces no bubble at all.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-thinking-turns.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTranscript } from "../../src/lib/transcript.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-thinking-"));
const file = path.join(dir, "t.jsonl");
const write = (lines) => fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

try {
  write([
    { type: "user", message: { role: "user", content: "why is the sky blue?" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Rayleigh scattering.\n\nShorter wavelengths scatter more." },
          { type: "text", text: "Because shorter wavelengths scatter more." },
        ],
      },
    },
  ]);
  const { turns } = readTranscript(file);
  const kinds = turns.map((t) => `${t.role}/${t.kind}`);
  ok(kinds.includes("assistant/thinking"), `a thinking block is carried through the parse (${JSON.stringify(kinds)})`);
  const thinking = turns.find((t) => t.kind === "thinking");
  ok(/Rayleigh scattering/.test(thinking.text), "with its text intact");
  ok(
    kinds.indexOf("assistant/thinking") < kinds.indexOf("assistant/text"),
    "and in order - the reasoning comes before the answer it led to, as it does on disk"
  );

  // --- the other field shape -----------------------------------------------
  // This parser is written against what is actually on disk, not a published schema, and
  // that schema has changed before - so `text` is accepted as a fallback for `thinking`.
  write([{ type: "assistant", message: { content: [{ type: "thinking", text: "carried on the other field" }] } }]);
  ok(
    readTranscript(file).turns.some((t) => t.kind === "thinking" && /other field/.test(t.text)),
    "a thinking block whose payload sits on `text` rather than `thinking` is still carried"
  );

  // --- nothing worth showing -------------------------------------------------
  write([
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "   " }, { type: "text", text: "the answer" }] } },
  ]);
  const blankish = readTranscript(file).turns;
  ok(!blankish.some((t) => t.kind === "thinking"), "an empty thinking block produces no row - it would be a toggle that opens onto nothing");
  ok(blankish.some((t) => t.kind === "text"), "and the answer beside it is untouched");

  // --- the decoration hazard, at the source ---------------------------------
  // turnEl gives every `kind === "thinking"` turn to thinkingTurnEl, which builds a
  // .turn-thinking element and never a .turn-bubble. Asserted against the renderer source
  // because the renderer is a classic script this file cannot import - so this pins the
  // branch and the element, which is what the hazard actually depends on.
  const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(
    /if \(turn\.kind === "thinking"\) \{\s*return thinkingTurnEl\(turn\);/.test(rSrc),
    "turnEl routes a thinking turn to its own element rather than falling through to the bubble path"
  );
  const fn = rSrc.slice(rSrc.indexOf("function thinkingTurnEl("), rSrc.indexOf("function turnEl("));
  ok(!/turn-bubble/.test(fn), "and that element never creates a .turn-bubble - the Done button and turn stats attach to the LAST assistant bubble, and reasoning must not be able to become it");
  ok(/turn-thinking-body hidden/.test(fn), "the body starts hidden, so the answer is not buried under the working that led to it");
  ok(/renderMarkdownInto\(body/.test(fn), "and the reasoning is rendered as prose rather than one flat block");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: reasoning survives the parse and renders as a collapsed row that cannot steal the reply's decorations."
    : "VERIFY FAILED."
);
process.exit(exit);
