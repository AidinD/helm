import fs from "node:fs";

// Bounds how much of a transcript file is ever read into memory. Transcripts
// "can be many megabytes" (a long session with big tool outputs easily gets
// there) — reading the whole file with readFileSync + split("\n") doubles
// that in memory and blocks the main process for the duration. sessions.js
// already does an equivalent tail-read (96KB) for its own narrower need
// (just the last message's role); this is the same technique sized for
// actually rendering chat history.
const MAX_READ_BYTES = 8 * 1024 * 1024;

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
    return { turns: [], truncated: false, linesRead: 0 };
  }
  const size = fs.statSync(transcriptPath).size;
  const readFromTail = size > MAX_READ_BYTES;
  let raw;
  if (readFromTail) {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const start = size - MAX_READ_BYTES;
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      // readSync can return fewer bytes than requested (Node docs: "not safe
      // to assume the entire buffer was filled"). Decode only what was
      // actually read — otherwise the zero-filled tail of the Buffer.alloc
      // becomes NUL chars appended to the last line, which then fails
      // JSON.parse and silently drops the most recent turn(s).
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, start);
      raw = buffer.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    raw = fs.readFileSync(transcriptPath, "utf8");
  }
  const lines = raw.split("\n");
  if (readFromTail) {
    // The byte offset almost certainly lands mid-line — the first "line" is
    // a fragment of a longer one that started before our window. JSON.parse
    // would just fail on it anyway (already handled below), but dropping it
    // explicitly is clearer than relying on that as an accident of parsing.
    lines.shift();
  }
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
    } else if (entry.type === "system" && entry.subtype === "compact_boundary") {
      // A context compaction happened here — from the CLI's own auto-compact
      // when the window fills (trigger "auto"), or Helm's Fas 3
      // auto-compact / a manual /compact (trigger "manual"). Surfaced as a
      // marker turn so the chat shows WHERE the conversation was summarized,
      // the same way the desktop app does — uniform across all triggers.
      //
      // The two transcript formats name this differently: headless
      // stream-json (Helm-launched sessions) uses `compact_metadata` with
      // snake_case pre_tokens/post_tokens; the interactive desktop format
      // uses `compactMetadata` with camelCase preTokens (and no postTokens).
      // Accept either so the pill works for both.
      const meta = entry.compact_metadata || entry.compactMetadata || {};
      const preTokens = meta.pre_tokens ?? meta.preTokens;
      const postTokens = meta.post_tokens ?? meta.postTokens;
      turns.push({
        role: "system",
        kind: "compact_boundary",
        trigger: meta.trigger || null,
        preTokens: typeof preTokens === "number" ? preTokens : null,
        postTokens: typeof postTokens === "number" ? postTokens : null,
      });
    }
    // other types are structural noise for a chat view; skipped
  }

  const turnsExceedCap = turns.length > maxTurns;
  const truncated = turnsExceedCap || readFromTail;
  const sliced = turnsExceedCap ? turns.slice(turns.length - maxTurns) : turns;
  // hiddenCount must never go negative: if only the byte-cap kicked in
  // (turns.length is comfortably under maxTurns from the tail window alone),
  // "turns.length - maxTurns" would be negative — there IS earlier content
  // beyond what was read, we just don't know exactly how many turns' worth,
  // so fall back to a minimum of 1 rather than a nonsensical count.
  const hiddenCount = truncated ? Math.max(turns.length - maxTurns, readFromTail ? 1 : 0) : 0;
  // Named linesRead, not totalLines — when readFromTail is true this is only
  // the line count of the trailing window that was actually read, not the
  // real total in the file. The old name silently changed meaning (whole-
  // file count -> partial count) for any large transcript once the byte cap
  // above was added; nothing in this codebase consumes the field today
  // (verified), but the name itself was a trap for the next thing that does.
  return { turns: sliced, truncated, linesRead: lines.length, hiddenCount };
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
    } else if (block.type === "thinking" && (block.thinking || block.text || "").trim()) {
      // Carried, not dropped (Aidin: "Jag vill kunna expandera för att se thought process -
      // som i desktop appen"). It was omitted from the default view, which is still how it
      // RENDERS - the renderer draws a collapsed row you open - but omitting it here meant
      // the reasoning was unreachable from the app at all, even though it sits in the
      // transcript on disk.
      //
      // The field is `thinking` on the block; `text` is accepted as a fallback because this
      // parser is written against what is actually on disk rather than a published schema,
      // and that schema has changed shape before.
      turns.push({ role: "assistant", kind: "thinking", text: block.thinking || block.text });
    }
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
