// Spike: can `claude --resume <id>` resume a session whose transcript we
// hand-authored/truncated ourselves — i.e. is real "rewind to here"
// (fork the transcript up to turn N, resume that) actually buildable?
//
// Method, all against a THROWAWAY session (never the user's real data):
//   1. Create a session with a memorable fact (BANANA-42).
//   2. Resume it to overwrite that fact (CHERRY-99) — now 2 exchanges.
//   3. Fork: copy the transcript's lines up to (not incl) the 2nd user
//      message into a NEW <uuid>.jsonl in the same projects dir. This drops
//      the CHERRY exchange — simulating "rewind to before CHERRY".
//   4. `--resume <newUuid>` and ask what the code is.
//        BANANA-42  => fork worked: resume reads a hand-placed truncated
//                      transcript AND future context is genuinely dropped.
//        CHERRY-99  => truncation had no effect.
//        error/none => --resume won't touch a transcript with no desktop
//                      metadata; approach needs more than a bare .jsonl.
//   5. Delete every file we created.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { resolveClaudeBinary } from "../src/lib/launcher.js";

const claudePath = resolveClaudeBinary();
const cwd = process.cwd();
const projectsRoot = path.join(os.homedir(), ".claude", "projects");
const created = []; // transcript files we made, for cleanup

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
        if (evt.type === "assistant") {
          for (const b of evt.message?.content || []) {
            if (b.type === "text") finalText += b.text;
          }
        }
      }
    });
    child.on("close", () => resolve({ sessionId, finalText: finalText.trim() }));
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

console.log("1) Create throwaway session: favorite color is blue...");
const s1 = await runClaude(["-p", "For a preferences profile: my favorite color is blue. Just reply OK.", "--model", "claude-haiku-4-5-20251001"]);
console.log("   session_id:", s1.sessionId, "| reply:", s1.finalText.slice(0, 60));
if (!s1.sessionId) {
  console.log("SPIKE ABORT: no session_id from first run");
  process.exit(0);
}

console.log("2) Resume, change favorite color to red...");
const s2 = await runClaude(["--resume", s1.sessionId, "-p", "Update my profile: my favorite color is now red, not blue. Reply OK.", "--model", "claude-haiku-4-5-20251001"]);
console.log("   session_id:", s2.sessionId, "| reply:", s2.finalText.slice(0, 60));

// The transcript filename is the LATEST cliSessionId (resume may rotate it).
const transcriptId = s2.sessionId || s1.sessionId;
const transcriptPath = findTranscript(transcriptId);
console.log("   transcript:", transcriptPath);
if (!transcriptPath) {
  console.log("SPIKE ABORT: could not locate transcript");
  process.exit(0);
}
created.push(transcriptPath);

console.log("3) Fork-truncate to before the 2nd user message...");
const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim());
let userCount = 0;
let cutAt = lines.length;
for (let i = 0; i < lines.length; i++) {
  let o;
  try {
    o = JSON.parse(lines[i]);
  } catch {
    continue;
  }
  // Count real user-typed messages (string content), not tool_result users.
  if (o.type === "user" && typeof o.message?.content === "string") {
    userCount++;
    if (userCount === 2) {
      cutAt = i;
      break;
    }
  }
}
const truncated = lines.slice(0, cutAt);
console.log(`   kept ${truncated.length}/${lines.length} lines (cut at 2nd user msg, index ${cutAt})`);
const forkId = crypto.randomUUID();
const forkPath = path.join(path.dirname(transcriptPath), `${forkId}.jsonl`);
fs.writeFileSync(forkPath, truncated.join("\n") + "\n", "utf8");
created.push(forkPath);
console.log("   wrote fork transcript:", forkId);

console.log("4) Resume the FORK and ask my favorite color...");
const s3 = await runClaude(["--resume", forkId, "-p", "What's my favorite color? Reply with ONLY the color name.", "--model", "claude-haiku-4-5-20251001"]);
console.log("   fork session_id:", s3.sessionId, "| error:", s3.error || "none");
console.log("   >>> REPLY:", s3.finalText);
const forkTranscriptAfter = findTranscript(s3.sessionId || forkId);
if (forkTranscriptAfter && !created.includes(forkTranscriptAfter)) created.push(forkTranscriptAfter);

const reply = s3.finalText.toUpperCase();
console.log("\n===== VERDICT =====");
if (s3.error || !s3.finalText) {
  console.log("INCONCLUSIVE/FAIL: resume of hand-authored fork produced no answer — likely needs session metadata, not just a .jsonl.");
} else if (reply.includes("BLUE")) {
  console.log("PASS: fork resumed the TRUNCATED history (blue) — the later 'red' update was genuinely dropped. Real rewind-to-here (fork + truncate + resume) is buildable this way.");
} else if (reply.includes("RED")) {
  console.log("FAIL: got red — truncation had no effect / resume read the full/original transcript.");
} else {
  console.log("UNCLEAR: reply didn't contain either color. Inspect manually above.");
}

console.log("\n5) Cleanup...");
for (const f of created) {
  try {
    fs.unlinkSync(f);
    console.log("   deleted", path.basename(f));
  } catch (e) {
    console.log("   could not delete", path.basename(f), "-", e.message);
  }
}
