// Spike: does sending a message on stdin WHILE the model is still mid-turn
// (before the first "result" event) get incorporated into that same turn,
// queued for the next one, or rejected/ignored? test-stream-input.mjs only
// proved multi-turn works BETWEEN completed turns — this tests the actual
// "interject while running" case the Jot task is asking about.
import { resolveClaudeBinary } from "../src/lib/launcher.js";
import { spawn } from "node:child_process";

const claudePath = resolveClaudeBinary();
const child = spawn(
  claudePath,
  [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--model",
    "claude-sonnet-5",
  ],
  { cwd: "D:/Repo/Tools/helm", shell: !claudePath.toLowerCase().endsWith(".exe"), env: process.env }
);

let buffer = "";
let sentInterject = false;
let resultCount = 0;
const timeline = [];

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      timeline.push(`[raw] ${line}`);
      continue;
    }
    timeline.push(`[${Date.now()}] ${evt.type}${evt.subtype ? ":" + evt.subtype : ""}`);
    if (evt.type === "assistant") {
      for (const b of evt.message?.content || []) {
        if (b.type === "tool_use") {
          timeline.push(`  tool_use: ${b.name} ${JSON.stringify(b.input)}`);
          // Right as the sleep tool call is issued, interject a second
          // message — this is BEFORE the turn's "result" event, i.e. a real
          // mid-turn injection attempt, not a between-turns send.
          if (!sentInterject && b.name === "Bash") {
            sentInterject = true;
            timeline.push(`  >>> INTERJECTING now (before result) <<<`);
            sendUserMessage("Also say the exact word HELM_INTERJECT_SEEN somewhere in your next reply.");
          }
        }
        if (b.type === "text") {
          timeline.push(`  text: ${b.text}`);
        }
      }
    }
    if (evt.type === "result") {
      resultCount++;
      timeline.push(`  >>> result #${resultCount}, subtype=${evt.subtype} <<<`);
      if (resultCount >= 2 || (resultCount === 1 && sentInterject === false)) {
        child.stdin.end();
      } else if (resultCount === 1) {
        // interject wasn't picked up mid-turn (or fired too late) — end here,
        // the important data is already in the timeline.
        setTimeout(() => child.stdin.end(), 3000);
      }
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write("[stderr] " + c.toString()));
child.on("close", (code) => {
  console.log(timeline.join("\n"));
  console.log("\nexit code:", code, "| results seen:", resultCount, "| interject sent:", sentInterject);
});
child.on("error", (e) => console.error("spawn error:", e.message));

function sendUserMessage(text) {
  const msg = { type: "user", message: { role: "user", content: text } };
  child.stdin.write(JSON.stringify(msg) + "\n");
}

sendUserMessage(
  "Use your Bash tool to run exactly: sleep 6 && echo done. Wait for it to finish, then just say DONE1 and nothing else."
);
