// Spike: can headless `claude -p` trigger the CLI's BUILT-IN /compact command
// the way it expands /skill-name slash commands, or is /compact interactive-
// only? This gates the Fas 3 auto-compact idea (auto-run /compact when a
// session is active-but-idle and has used a lot of context) — no point
// building the "when to fire it" logic if the CLI can't fire it headlessly.
//
// All against a THROWAWAY session in this repo's cwd; nothing sent to real
// sessions. Three signals distinguish the outcomes:
//   - WORKS: a stream-json event indicating compaction (system/compact-ish
//     event, or the transcript visibly collapses to a summary), AND a
//     follow-up still recalls earlier context (compaction preserves a summary).
//   - TREATED AS LITERAL TEXT: the assistant replies conversationally to the
//     string "/compact" as if it were a user message ("did you mean...").
//   - ERROR/UNRECOGNIZED: an explicit error, or nothing happens.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveClaudeBinary } from "../src/lib/launcher.js";

const claudePath = resolveClaudeBinary();
const cwd = process.cwd();
const projectsRoot = path.join(os.homedir(), ".claude", "projects");
const created = [];

function runClaude(args) {
  return new Promise((resolve) => {
    const child = spawn(claudePath, [...args, "--output-format", "stream-json", "--verbose"], {
      cwd,
      shell: !claudePath.toLowerCase().endsWith(".exe"),
      env: process.env,
    });
    let buf = "";
    let sessionId = null;
    let finalText = "";
    const eventTypes = [];
    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.session_id && !sessionId) sessionId = evt.session_id;
        eventTypes.push(`${evt.type}${evt.subtype ? "/" + evt.subtype : ""}`);
        // Surface anything mentioning compact anywhere in the event.
        const asStr = JSON.stringify(evt);
        if (asStr.toLowerCase().includes("compact")) {
          console.log("  ** COMPACT-MENTIONING EVENT:", asStr.slice(0, 300));
        }
        if (evt.type === "assistant") {
          for (const b of evt.message?.content || []) {
            if (b.type === "text") finalText += b.text;
          }
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", () => resolve({ sessionId, finalText: finalText.trim(), eventTypes, stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ error: e.message }));
  });
}

function findTranscript(id) {
  for (const dir of fs.readdirSync(projectsRoot)) {
    const p = path.join(projectsRoot, dir, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function lineCount(id) {
  const p = findTranscript(id);
  if (!p) return null;
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
}

console.log("1) Create a throwaway session with a memorable fact + a few turns of bulk...");
const s1 = await runClaude([
  "-p",
  "Remember for later: the project mascot is a purple otter named Waffles. Just acknowledge briefly.",
  "--model",
  "claude-haiku-4-5-20251001",
]);
console.log("   session:", s1.sessionId, "| reply:", s1.finalText.slice(0, 80));
if (!s1.sessionId) {
  console.log("ABORT: no session id");
  process.exit(0);
}
const tPath = findTranscript(s1.sessionId);
if (tPath) created.push(tPath);

console.log("2) Add a couple more turns so there's something to compact...");
const s2 = await runClaude(["--resume", s1.sessionId, "-p", "Now write two sentences about the weather, any weather.", "--model", "claude-haiku-4-5-20251001"]);
const s2b = await runClaude(["--resume", s1.sessionId, "-p", "And two sentences about your favorite kind of soup.", "--model", "claude-haiku-4-5-20251001"]);
const linesBefore = lineCount(s1.sessionId);
console.log("   transcript lines before compact:", linesBefore);

console.log("\n3) THE TEST: resume with -p \"/compact\" and see what the CLI does...");
const s3 = await runClaude(["--resume", s1.sessionId, "-p", "/compact", "--model", "claude-haiku-4-5-20251001"]);
console.log("   event types seen:", JSON.stringify(s3.eventTypes));
console.log("   assistant text (first 250):", JSON.stringify(s3.finalText.slice(0, 250)));
if (s3.stderr) console.log("   stderr:", s3.stderr.slice(0, 300));
const linesAfter = lineCount(s1.sessionId);
console.log("   transcript lines after compact:", linesAfter, "(before:", linesBefore + ")");

console.log("\n4) Verify context survived: does it still recall the mascot after compaction?...");
const s4 = await runClaude(["--resume", s1.sessionId, "-p", "What is the project mascot? One short line.", "--model", "claude-haiku-4-5-20251001"]);
console.log("   >>> RECALL:", s4.finalText.slice(0, 150));

console.log("\n===== VERDICT (interpret manually) =====");
const literalText = /did you mean|it looks like|you (typed|entered|wrote)|i (don't|do not) (have|see) a|not a (recognized |valid )?command|as a message/i.test(s3.finalText);
const recalled = /waffles|otter/i.test(s4.finalText);
console.log("- /compact treated as literal chat text?  ", literalText ? "YES (assistant replied as if it were a message)" : "no obvious sign of that");
console.log("- transcript line count dropped after?    ", linesAfter !== null && linesBefore !== null && linesAfter < linesBefore ? `YES (${linesBefore} -> ${linesAfter}, looks compacted)` : "no drop (not compacted, or compaction appends rather than shrinks the file)");
console.log("- context (mascot) still recalled after?  ", recalled ? "YES" : "NO");
console.log("\nIf line count dropped AND recall survived -> /compact works headlessly. If it was treated as literal text -> it does NOT.");

console.log("\n5) Cleanup...");
// Re-scan for the (possibly rotated) transcript id too.
for (const id of [s1.sessionId, s2.sessionId, s3.sessionId, s4.sessionId]) {
  const p = id && findTranscript(id);
  if (p && !created.includes(p)) created.push(p);
}
for (const f of created) {
  try {
    fs.unlinkSync(f);
    console.log("   deleted", path.basename(f));
  } catch (e) {
    console.log("   could not delete", path.basename(f), "-", e.message);
  }
}
