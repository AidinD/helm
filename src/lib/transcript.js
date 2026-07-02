import fs from "node:fs";

/**
 * Parses a Claude Code session transcript (.jsonl) into a flat list of
 * renderable turns for a full chat-history view. Verified against a real
 * transcript file rather than assumed from the headless stream-json schema
 * (which is a different, unrelated format).
 *
 * Line shapes seen on disk:
 *   { type: "user", isSidechain, message: { role: "user", content: string | [{type:"tool_result", tool_use_id, content}] } }
 *   { type: "assistant", isSidechain, message: { content: [ {type:"thinking",...} | {type:"tool_use", id, name, input} | {type:"text", text} ] } }
 *   plus noise types (system, ai-title, queue-operation, attachment, last-prompt, mode) which are skipped.
 *
 * isSidechain === true marks subagent/Task-tool chatter, not the main thread —
 * skipped so the view shows the conversation the user actually had.
 */
export function readTranscript(transcriptPath, { maxTurns = 4000 } = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns: [], truncated: false, totalLines: 0 };
  }
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");
  const turns = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.isSidechain) {
      continue;
    }
    if (entry.type === "user") {
      pushUserTurn(turns, entry);
    } else if (entry.type === "assistant") {
      pushAssistantTurns(turns, entry);
    }
    // other types are structural noise for a chat view; skipped
  }

  const truncated = turns.length > maxTurns;
  const sliced = truncated ? turns.slice(turns.length - maxTurns) : turns;
  return { turns: sliced, truncated, totalLines: lines.length, hiddenCount: truncated ? turns.length - maxTurns : 0 };
}

function pushUserTurn(turns, entry) {
  const content = entry.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    // A background-task/subagent completion is delivered as a synthetic
    // "user" turn whose content is a raw <task-notification> XML string —
    // not something Aidin actually typed. Rendering it as a normal outgoing
    // message reads as "you said this XML," which is wrong; give it its own
    // kind so the UI can show a compact summary instead.
    if (trimmed.startsWith("<task-notification>")) {
      turns.push({ role: "system", kind: "task_notification", text: trimmed });
      return;
    }
    turns.push({ role: "user", kind: "text", text: content });
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : summarizeToolResult(block.content);
        turns.push({ role: "user", kind: "tool_result", text: truncateText(text, 400) });
      }
    }
  }
}

function pushAssistantTurns(turns, entry) {
  const blocks = entry.message?.content;
  if (!Array.isArray(blocks)) {
    return;
  }
  for (const block of blocks) {
    if (block.type === "text" && block.text?.trim()) {
      turns.push({ role: "assistant", kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      turns.push({
        role: "assistant",
        kind: "tool_use",
        toolName: block.name,
        toolInput: summarizeToolInput(block.name, block.input),
      });
    }
    // thinking blocks are intentionally omitted from the default view
  }
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") {
    return "";
  }
  if (input.file_path) {
    return input.file_path;
  }
  if (input.command) {
    return truncateText(input.command, 100);
  }
  if (input.pattern) {
    return input.pattern;
  }
  const firstKey = Object.keys(input)[0];
  return firstKey ? truncateText(String(input[firstKey]), 80) : "";
}

function summarizeToolResult(content) {
  if (Array.isArray(content)) {
    const textBlock = content.find((c) => c.type === "text");
    return textBlock?.text || "(non-text result)";
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content ?? "");
}

function truncateText(text, max) {
  if (!text) {
    return "";
  }
  return text.length > max ? text.slice(0, max) + "…" : text;
}
