import fs from "node:fs";

// Detects a session's IN-FLIGHT sub-agents (Claude Code's Task tool) from its
// transcript, so the Fleet can show them as crew under the session that spawned
// them (the crew tier for interactive sessions, alongside dispatched Autopilot
// runs). A sub-agent is launched as an assistant `tool_use` with name "Task"
// and completes as a `tool_result` carrying the same id - so a Task tool_use
// with no matching tool_result yet is a live sub-agent.
//
// Transcript line shapes (see transcript.js):
//   assistant: { message: { content: [ { type:"tool_use", id, name:"Task", input:{ description, subagent_type, ... } } ] } }
//   result:    { message: { content: [ { type:"tool_result", tool_use_id, ... } ] } }

const MAX_READ_BYTES = 2 * 1024 * 1024; // tail is enough - live sub-agents are recent

/**
 * Pure: given raw transcript text (JSONL), return the live sub-agents - Task
 * tool_use entries with no matching tool_result. Newest first.
 */
export function parseLiveSubAgents(text) {
  const tasks = new Map(); // id -> { id, description, subagentType, order }
  const doneIds = new Set();
  let order = 0;
  for (const line of (text || "").split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "tool_use" && block.name === "Task" && block.id) {
        tasks.set(block.id, {
          id: block.id,
          description: (block.input?.description || "sub-agent").toString(),
          subagentType: block.input?.subagent_type || null,
          order: order++,
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        doneIds.add(block.tool_use_id);
      }
    }
  }
  return [...tasks.values()]
    .filter((task) => !doneIds.has(task.id))
    .sort((a, b) => b.order - a.order)
    .map(({ id, description, subagentType }) => ({ id, description, subagentType }));
}

/** Reads a transcript file (tail for large files) and returns its live sub-agents. */
export function liveSubAgents(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }
  try {
    const size = fs.statSync(transcriptPath).size;
    let raw;
    if (size > MAX_READ_BYTES) {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(MAX_READ_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
        raw = buffer.toString("utf8", 0, bytesRead);
        raw = raw.slice(raw.indexOf("\n") + 1); // drop the partial first line
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(transcriptPath, "utf8");
    }
    return parseLiveSubAgents(raw);
  } catch {
    return [];
  }
}
