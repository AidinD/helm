// Jot 19096e2c (Helm): "rewind verkar inte fungera - iaf inte om man lämnar
// sessionen efter att ha skickat men innan svar."
//
// forkTranscriptAtUserMessage (src/lib/sessions.js) counts user messages straight
// off the transcript FILE on disk. The renderer's rewind button, though, counts
// against pane.turns in memory - which can include a message sent moments ago
// that the file hasn't been written to yet (marked `pending`, exactly the window
// this report describes: leaving right after sending, before a reply). Before this
// fix, rewinding to that not-yet-flushed message found no match in the file and
// silently forked the WHOLE untouched transcript instead of truncating - a no-op
// that reads as "rewind doesn't work," with no error to explain why.
//
// Two independent halves of the fix:
//   1. src/lib/sessions.js no longer silently no-ops on a miss - it returns an
//      explicit error.
//   2. src/renderer/renderer.js no longer offers the rewind button at all on a
//      `pending` user turn (the actual fix for the reported symptom - the button
//      simply isn't there to click on a message that can't be rewound to yet).
//
// Run:  node scripts/e2e/test-rewind-unflushed-message.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rewind-"));
process.env.HELM_PROJECTS_ROOT = tmp;
const { forkTranscriptAtUserMessage } = await import("../../src/lib/sessions.js");

const projectDir = path.join(tmp, "-D--fake-project");
fs.mkdirSync(projectDir, { recursive: true });
const sessionId = "11111111-1111-1111-1111-111111111111";
const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

const line = (obj) => JSON.stringify(obj);
const userMsg = (text) => line({ type: "user", message: { role: "user", content: text } });
const assistantMsg = (text) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });

// Two real exchanges actually written to disk - the only messages the FILE knows
// about (userMsgIndex 0 and 1).
const settledLines = [userMsg("first message"), assistantMsg("first reply"), userMsg("second message"), assistantMsg("second reply")];
fs.writeFileSync(transcriptPath, settledLines.join("\n") + "\n", "utf8");

try {
  // The reported case: userMsgIndex 2 is what the RENDERER thinks is the 3rd user
  // message (sent seconds ago, still pending) - the file only has two.
  const miss = forkTranscriptAtUserMessage(sessionId, 2);
  ok(miss.ok === false, `rewinding to a message not yet on disk fails loudly instead of silently no-opping (${JSON.stringify(miss)})`);
  ok(typeof miss.error === "string" && miss.error.length > 0, "and carries a real error message the UI can show in a toast");
  ok(!fs.existsSync(path.join(projectDir, "nonexistent-check")), "sanity: still looking at the right dir");
  // No fork file should be left behind by a failed attempt.
  const filesAfterMiss = fs.readdirSync(projectDir);
  ok(filesAfterMiss.length === 1, `a failed rewind leaves no stray fork file behind (${filesAfterMiss.length} files: ${filesAfterMiss.join(", ")})`);

  // A rewind to an ALREADY-FLUSHED message still works exactly as before -
  // this fix must not regress the normal, settled case.
  const hit = forkTranscriptAtUserMessage(sessionId, 1);
  ok(hit.ok === true, `rewinding to a message that IS on disk still works (${JSON.stringify(hit)})`);
  const forkPath = path.join(projectDir, `${hit.forkId}.jsonl`);
  const forkLines = fs.readFileSync(forkPath, "utf8").split("\n").filter((l) => l.trim());
  ok(forkLines.length === 2, `the fork is truncated to just before the 2nd user message (${forkLines.length} lines kept)`);
  ok(JSON.parse(forkLines[0]).message.content === "first message", "and it kept the right content");

  // Rewinding to the VERY FIRST message (index 0) is index 0, not a miss.
  const hitFirst = forkTranscriptAtUserMessage(sessionId, 0);
  ok(hitFirst.ok === true, "rewinding to the first message in the file works too");
  const forkFirstLines = fs
    .readFileSync(path.join(projectDir, `${hitFirst.forkId}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  ok(forkFirstLines.length === 0, `rewinding to the very first message truncates everything (${forkFirstLines.length} lines kept)`);

  // The renderer-side half of the fix: a pending user turn must not get a rewind
  // button attached at all.
  const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(
    /if \(pane\.cliSessionId && !pane\.transcriptTruncated && !turn\.pending\) {/.test(rSrc),
    "source: the rewind button is withheld from a pending (not-yet-flushed) user turn"
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: rewinding to a message not yet written to the transcript fails loudly (or, in the UI, offers no button at all) instead of silently forking nothing."
    : "VERIFY FAILED."
);
process.exit(exit);
