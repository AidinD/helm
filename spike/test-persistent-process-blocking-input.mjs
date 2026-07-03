// Spike: can a long-lived `claude -p --input-format stream-json` process
// (a) receive a genuine mid-turn permission decision via stdin, and/or
// (b) accept a NEW user message via stdin WHILE an earlier turn is still
// running, and have it affect the CURRENT turn (not just queue for next)?
//
// This is the open question blocking BOTH "a real input box when Claude
// needs an answer" and "interject info into a running prompt" — both need
// the same persistent-process architecture, and neither is worth building
// if this comes back negative. Runs entirely against a THROWAWAY session in
// this repo's own cwd; nothing sent to the user's real sessions.
import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "../src/lib/launcher.js";

const claudePath = resolveClaudeBinary();
const cwd = process.cwd();

function startPersistent(args) {
  const child = spawn(claudePath, args, {
    cwd,
    shell: !claudePath.toLowerCase().endsWith(".exe"),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
        console.log("  <<", evt.type, evt.subtype || "", JSON.stringify(evt).slice(0, 160));
      } catch {
        console.log("  << (non-JSON line):", line.slice(0, 160));
      }
    }
  });
  child.stderr.on("data", (c) => console.log("  !! stderr:", c.toString("utf8").slice(0, 300)));
  return { child, events };
}

function writeUserMessage(child, text) {
  const line = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
  console.log("  >>", line.trim());
  child.stdin.write(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log("===== TEST A: does a mid-turn permission need even surface as an event in -p mode? =====");
console.log("Asking it to run a Bash command under --permission-mode default (NOT bypassPermissions), no --dangerously-skip-permissions.");
{
  const { child, events } = startPersistent([
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "default",
    "--model", "claude-haiku-4-5-20251001",
    "--allowed-tools", "Bash",
  ]);
  writeUserMessage(child, "Run the bash command: echo hello-from-spike");
  child.stdin.end(); // single message, then close stdin (still headless -p semantics)
  await new Promise((resolve) => child.on("close", resolve));
  const permissionEvents = events.filter((e) => JSON.stringify(e).toLowerCase().includes("permission"));
  console.log(`\nRESULT A: ${events.length} total events, ${permissionEvents.length} mention "permission".`);
  if (permissionEvents.length > 0) {
    console.log("Permission-related events found:", JSON.stringify(permissionEvents, null, 2).slice(0, 1000));
  } else {
    const toolResult = events.find((e) => e.type === "assistant" && JSON.stringify(e).includes("tool_use"));
    console.log("No permission event surfaced. Did the tool call happen anyway, or fail silently?");
    console.log("Assistant/tool-related events:", JSON.stringify(events.filter((e) => e.type === "assistant" || e.type === "user"), null, 2).slice(0, 1500));
  }
}

console.log("\n\n===== TEST B: does stdin stay open across multiple turns on ONE process (--input-format stream-json without closing stdin early)? =====");
{
  const { child, events } = startPersistent([
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--model", "claude-haiku-4-5-20251001",
    "--allowed-tools", "",
  ]);
  writeUserMessage(child, "Reply with exactly: FIRST-OK");
  await sleep(6000); // let the first turn fully complete
  writeUserMessage(child, "Now reply with exactly: SECOND-OK");
  await sleep(6000);
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const texts = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => (e.message?.content || []).filter((b) => b.type === "text").map((b) => b.text));
  console.log("\nRESULT B: assistant texts across the persistent process:", JSON.stringify(texts));
  const gotBoth = texts.some((t) => t.includes("FIRST-OK")) && texts.some((t) => t.includes("SECOND-OK"));
  console.log(gotBoth ? "PASS: one process handled two sequential turns via stdin." : "FAIL/UNCLEAR: see texts above.");
}

console.log("\n\n===== TEST C: does a SECOND stdin message written WHILE the first turn is still working get folded into the CURRENT turn, or ignored/queued? =====");
{
  const { child, events } = startPersistent([
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--model", "claude-haiku-4-5-20251001",
    "--allowed-tools", "",
  ]);
  writeUserMessage(child, "Count slowly from 1 to 5, writing one paragraph of filler commentary between each number so this takes a while.");
  await sleep(1500); // fire the interjection WHILE the above is very likely still generating
  writeUserMessage(child, "BTW also mention the word BANANA somewhere before you finish.");
  await sleep(10000);
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const texts = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => (e.message?.content || []).filter((b) => b.type === "text").map((b) => b.text));
  const joined = texts.join(" ");
  console.log("\nRESULT C: does the FIRST turn's own output contain BANANA (folded in live), or does it only show up in a SEPARATE second turn?");
  console.log("Number of distinct assistant messages:", texts.length);
  console.log("Contains BANANA at all:", joined.toUpperCase().includes("BANANA"));
}
