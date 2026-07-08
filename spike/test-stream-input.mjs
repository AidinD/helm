// Spike: verify --input-format stream-json supports a persistent, multi-turn
// process (needed for "stop mid-run" + "interject extra info while running").
import { spawn } from "node:child_process";

const child = spawn(
  "claude",
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
  { cwd: "D:\\Repo\\Tools\\helm", shell: true, env: process.env }
);

let buffer = "";
let turnsSeen = 0;

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
      console.log("[raw]", line);
      continue;
    }
    console.log("[evt]", evt.type, evt.subtype || "");
    if (evt.type === "result") {
      turnsSeen++;
      if (turnsSeen === 1) {
        console.log("→ First turn done. Sending a SECOND message on the SAME process...");
        sendUserMessage("Now say HELM_SECOND_OK and nothing else.");
      } else {
        console.log("→ Second turn done. Process stayed alive for multi-turn stdin. Closing stdin.");
        child.stdin.end();
      }
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write("[stderr] " + c.toString()));
child.on("close", (code) => console.log("\nexit code:", code, "| turns seen:", turnsSeen));
child.on("error", (e) => console.error("spawn error:", e.message));

function sendUserMessage(text) {
  const msg = { type: "user", message: { role: "user", content: text } };
  child.stdin.write(JSON.stringify(msg) + "\n");
}

sendUserMessage("Say HELM_FIRST_OK and nothing else.");
