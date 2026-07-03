// Follow-up: Test A showed an ALLOWED tool runs with no permission event at
// all. Does a tool NOT in --allowed-tools, under --permission-mode default
// (no bypass), silently deny/fail, or does it actually pause and emit a
// blocking event to ask? Confirms whether headless -p mode has ANY
// pause-and-ask primitive, or purely allow/deny-by-flag with no live
// round-trip.
import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "../src/lib/launcher.js";

const claudePath = resolveClaudeBinary();
const child = spawn(
  claudePath,
  [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "default",
    "--model", "claude-haiku-4-5-20251001",
    "--allowed-tools", "", // Bash NOT allowed
  ],
  { cwd: process.cwd(), shell: !claudePath.toLowerCase().endsWith(".exe"), env: process.env, stdio: ["pipe", "pipe", "pipe"] }
);
const events = [];
let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      events.push(evt);
      console.log("  <<", evt.type, evt.subtype || "", JSON.stringify(evt).slice(0, 200));
    } catch {
      console.log("  << (non-JSON):", line.slice(0, 200));
    }
  }
});
child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Run the bash command: echo hello-from-spike" } }) + "\n");
child.stdin.end();

const timeoutMs = 25000;
const timedOut = await Promise.race([
  new Promise((resolve) => child.on("close", () => resolve(false))),
  new Promise((resolve) => setTimeout(() => resolve(true), timeoutMs)),
]);
if (timedOut) {
  console.log(`\nRESULT: TIMED OUT after ${timeoutMs}ms — process is HANGING, waiting for something (possibly a real blocking prompt with no way to answer it headlessly). Killing it.`);
  child.kill();
} else {
  console.log("\nRESULT: process exited on its own (did not hang).");
  const resultEvt = events.find((e) => e.type === "result");
  console.log("Final result event:", JSON.stringify(resultEvt, null, 2));
  const assistantTexts = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => (e.message?.content || []).filter((b) => b.type === "text").map((b) => b.text));
  console.log("Assistant said:", JSON.stringify(assistantTexts));
}
