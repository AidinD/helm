// Maestro Phase 0 spike — prove we can wrap the real `claude` CLI.
//
// Goal: spawn the real Claude Code CLI headlessly, rooted in a chosen repo
// folder (on main, no worktree), stream its output, and confirm it runs on the
// existing subscription auth with no extra setup. Throwaway / diagnostic only.
//
// Usage:
//   node spike/run-spike.mjs [cwd] [model]
// Defaults: cwd = this repo, model = claude-sonnet-5
//
// It sends a trivial prompt so it costs almost nothing, and prints every
// stream-json event so we can see the shape of the data a future UI would consume.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const cwd = process.argv[2] || repoRoot;
const model = process.argv[3] || "claude-sonnet-5";
const prompt =
  "Respond with exactly this token and nothing else: MAESTRO_SPIKE_OK";

console.log("── Maestro spike ──────────────────────────────");
console.log("cwd   :", cwd);
console.log("model :", model);
console.log("prompt:", prompt);
console.log("───────────────────────────────────────────────\n");

// Headless, streaming JSON. --verbose is required for stream-json to emit the
// full event stream. We do NOT pass --bare, so skills/CLAUDE.md/MCP still load.
const args = [
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  model,
];

const started = Date.now();
const child = spawn("claude", args, {
  cwd,
  shell: true, // resolve the `claude` shim on Windows (claude.cmd)
  env: process.env,
});

let sawResult = false;
let sessionId = null;
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) {
      continue;
    }
    handleEvent(line);
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write("[stderr] " + chunk.toString("utf8"));
});

child.on("close", (code) => {
  const ms = Date.now() - started;
  console.log("\n───────────────────────────────────────────────");
  console.log("exit code :", code);
  console.log("duration  :", ms + "ms");
  console.log("session id:", sessionId || "(none captured)");
  console.log("result seen:", sawResult);
  console.log(
    code === 0 && sawResult
      ? "\n✅ SPIKE PASS — subscription auth + rooting + streaming work."
      : "\n❌ SPIKE INCOMPLETE — inspect output above (auth? model id? claude on PATH?)."
  );
});

child.on("error", (err) => {
  console.error("\n❌ Failed to spawn `claude`:", err.message);
  console.error("Is the Claude Code CLI installed and on PATH?");
});

function handleEvent(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    console.log("[raw]", line);
    return;
  }
  // Capture session id from the init/system event.
  if (evt.session_id && !sessionId) {
    sessionId = evt.session_id;
  }
  const type = evt.type || "?";
  if (type === "system") {
    console.log(`[system] subtype=${evt.subtype || "?"} model=${evt.model || "?"}`);
  } else if (type === "assistant" || type === "text") {
    const text =
      evt.message?.content?.map?.((c) => c.text).join("") ?? evt.text ?? "";
    if (text) {
      console.log(`[assistant] ${text}`);
    }
  } else if (type === "result") {
    sawResult = true;
    console.log(
      `[result] ${evt.subtype || ""} cost_usd=${evt.total_cost_usd ?? "?"} turns=${evt.num_turns ?? "?"}`
    );
  } else {
    console.log(`[${type}]`, JSON.stringify(evt).slice(0, 160));
  }
}
