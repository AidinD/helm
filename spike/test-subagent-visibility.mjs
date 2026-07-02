// Spike: when a session spawns a background Task-tool subagent, do the
// SUBAGENT's own tool calls surface as distinct events on the parent's
// stream, or only the top-level Task tool_use + eventual task-notification?
// Informs the "agent mode / background tasks panel" Jot task.
import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "../src/lib/launcher.js";

// NOTE: an earlier run of this exact spike used spawn("claude", args, {shell:
// true}) directly instead of the resolved-binary path — reintroduced the
// argument-truncation bug (prompt arrived as just "Use") and invalidated that
// run's results. Using the same safe helper the real app uses this time.
const claudePath = resolveClaudeBinary();
const child = spawn(
  claudePath,
  [
    "-p",
    "Use the Task tool to spawn a general-purpose subagent that reads the file D:\\Repo\\Tools\\maestro\\package.json and reports back its \"name\" field. Wait for it to finish and tell me the name.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-sonnet-5",
  ],
  { cwd: "D:\\Repo\\Tools\\maestro", shell: !claudePath.toLowerCase().endsWith(".exe"), env: process.env }
);

let buffer = "";
const started = Date.now();
const seenTypes = new Set();

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
      continue;
    }
    const key = `${evt.type}:${evt.subtype || ""}`;
    seenTypes.add(key);
    if (evt.type === "assistant") {
      const blocks = evt.message?.content || [];
      for (const b of blocks) {
        if (b.type === "tool_use") {
          console.log(`[${Date.now() - started}ms] tool_use: ${b.name} parent_tool_use_id=${evt.parent_tool_use_id ?? "null"}`);
        }
      }
    } else if (evt.type === "user") {
      const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          console.log(`[${Date.now() - started}ms] tool_result parent_tool_use_id=${evt.parent_tool_use_id ?? "null"}`);
        }
      }
    } else if (evt.type === "result") {
      console.log(`[${Date.now() - started}ms] RESULT:`, evt.result?.slice(0, 150));
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString().slice(0, 200)));
child.on("close", (code) => {
  console.log(`\nclosed, code=${code}`);
  console.log("all event type:subtype seen:", [...seenTypes].join(", "));
});
