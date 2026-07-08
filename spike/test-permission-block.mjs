// Spike: does a stricter --permission-mode actually BLOCK mid-turn waiting for
// an answer under --input-format stream-json, and if so, what event signals
// it, and can a second stdin message answer it? Informs the "real interactive
// input UI" Jot task — verify before building any UI for this.
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
    "--permission-mode",
    "default",
    "--model",
    "claude-haiku-4-5-20251001",
  ],
  { cwd: "D:\\Repo\\Tools\\helm", shell: true, env: process.env }
);

let buffer = "";
let sawResult = false;
const started = Date.now();

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
    console.log(`[${Date.now() - started}ms] type=${evt.type} subtype=${evt.subtype || ""}`);
    if (evt.type === "result") {
      sawResult = true;
    }
    // Look for anything permission/question shaped
    if (JSON.stringify(evt).toLowerCase().includes("permission") && evt.type !== "system") {
      console.log("  ^ PERMISSION-RELATED EVENT:", JSON.stringify(evt).slice(0, 300));
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString()));
child.on("close", (code) => {
  console.log(`\nclosed after ${Date.now() - started}ms, code=${code}, sawResult=${sawResult}`);
});
child.on("error", (e) => console.error("spawn error", e.message));

function send(text) {
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
}

send(
  "Run this exact bash command and show me the output: echo hello-from-bash-that-needs-approval"
);

// Give it a few seconds to (maybe) block on a permission question, then try
// sending a second message to see if it's queued, ignored, or answers a
// pending question.
setTimeout(() => {
  console.log(`\n[${Date.now() - started}ms] --- sending a second message while the first may still be pending ---`);
  send("If you were waiting for permission, please proceed / approve.");
}, 4000);

// Hard timeout so this spike can't hang forever.
setTimeout(() => {
  console.log("\n--- 20s timeout reached, killing ---");
  child.kill();
}, 20000);
