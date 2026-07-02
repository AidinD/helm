import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "../src/lib/launcher.js";

const claudePath = resolveClaudeBinary();
const child = spawn(
  claudePath,
  [
    "-p",
    "Use the Task tool to spawn a general-purpose subagent that reads the file D:\\Repo\\Tools\\maestro\\package.json and reports back its \"version\" field. Wait for it to finish and tell me the version.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-sonnet-5",
  ],
  { cwd: "D:\\Repo\\Tools\\maestro", shell: !claudePath.toLowerCase().endsWith(".exe"), env: process.env }
);

let buffer = "";
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
    if (evt.type === "system" && ["task_started", "task_progress", "task_updated", "task_notification"].includes(evt.subtype)) {
      console.log("---", evt.subtype, "---");
      console.log(JSON.stringify(evt, null, 2).slice(0, 800));
    }
  }
});
child.stderr.on("data", () => {});
child.on("close", () => console.log("\nDONE"));
