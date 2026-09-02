// Assistant-store MCP server: the assistant seat's OWN two files, over stdio.
//
// WHY A SERVER AND NOT A GUARD EXEMPTION (DECISIONS.md 2026-09-02). The seat runs
// on the first-mate tier, whose PreToolUse hook denies every file-mutating tool by
// TOOL NAME and has no notion of a path. That guard exempts MCP tools by design,
// so an MCP surface is the only way the seat can write anything - and the
// alternative, teaching the guard about destinations, lost on a sharper argument
// than tidiness: a write in an allowed folder that violates the STORE's own rules
// would sail through a path check with no error anywhere. A surface can refuse it.
// This file is the small half of that work ("plus a small one for the seat's own
// two files"); the personal stores are a separate surface in a sibling app.
//
// SCOPE, and it is the whole design. Five tools, each hardwired to one file:
// GOALS.md, and `log/YYYY-MM-DD.md`. There is no general file write, no path
// argument that names a file, and nothing that reaches the persona file
// (`assistant/CLAUDE.md`) - the seat is the scribe of its goals and its log, not
// of its own instructions.
//
// TRANSPORT. Same minimal stdio JSON-RPC loop as helmDispatchServer.js, and for
// the same reason: @modelcontextprotocol/sdk is not a Helm dependency, and adding
// one to expose five tools is not a trade worth making. It handles `initialize`,
// `tools/list`, `tools/call` and `ping` - the subset the Claude Code MCP client
// actually drives for a tools-only server. If the SDK ever arrives, this can be
// reimplemented on top of it without changing a tool schema.
//
// CONFIG (from env, injected by main.js in the mcp-config payload):
//   HELM_ASSISTANT_STORE_DIR - the assistant folder. Optional: left unset, the
//                              store resolves it from the CLAUDE.md stub, which is
//                              the same answer. Set it to relocate or to test.
import process from "node:process";
import { readGoals, writeGoals, appendLog, readLog, changesSince, resolveStoreDir, todayStamp } from "./assistantStoreTools.js";

const PROTOCOL_VERSION = "2024-11-05";
// Named to match the key main.js gives this server in its mcp-config, the way
// helmDispatchServer.js and FIRST_MATE_MCP_SERVER match - a client shows the key,
// so two names for one server is a debugging tax for nothing.
const SERVER_INFO = { name: "assistant", version: "0.1.0" };

// EVERY tool name here begins `assistant_`, and that is load-bearing rather than
// cosmetic. The tier guard decides whether an MCP call is write-shaped from the
// BARE tool name after the `mcp__<server>__` prefix is stripped, and it exempts a
// short list of store prefixes (GUARD_EXEMPT_SERVERS in src/lib/tierGuard.js).
// Rename a tool out of that prefix and the seat silently loses the write access
// this whole server exists to give it - `assistant_write_goals` would start
// reading as a generic write and be denied. The E2E check asserts the prefix.

// Tool DESCRIPTIONS carry the operating rule, not just the signature. A seat that
// reads "appends to the log" will append at the end of the day; one that reads
// "write through in the same turn" does it while the fact is still true. The
// descriptions are the only part of this the model reliably reads.
const TOOLS = [
  {
    name: "assistant_read_goals",
    description:
      "Read GOALS.md whole - the ONLY place the captain's own goals live (Tend holds growth threads for the people he leads; nothing there holds his). " +
      "Read it before answering anything about priorities, and read it again rather than answering from what you remember of it: your context goes stale silently, the file does not. " +
      "Returns `modifiedAt`, which you pass back as `ifUnchangedSince` if you then write.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "assistant_write_goals",
    description:
      "Replace GOALS.md with the whole document. You are its sole scribe: if a goal changes in conversation and you do not write it here in the same turn, the file goes stale and stops being consulted, which is how it dies. " +
      "Read it first, edit that text, send all of it back - this is not a patch tool. " +
      "REFUSED: empty content, a document with no top-level `# ` heading, and a write that cuts the file by more than half (pass allowShrink:true if you really are deleting that much, and say so in your reply). " +
      "Propose the change and show it before writing; then say in one line what you wrote and what changed.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The complete new GOALS.md, markdown, including the parts you did not change." },
        ifUnchangedSince: {
          type: "string",
          description:
            "The `modifiedAt` you got from assistant_read_goals. Pass it and the write is refused if the file moved in between, rather than silently dropping whoever edited it (he edits this file by hand too).",
        },
        allowShrink: {
          type: "boolean",
          description: "Confirms a deliberate deletion of more than half the document. Without it a shrink that large is refused as a botched rewrite.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "assistant_append_log",
    description:
      "Append an entry to today's daily log (`log/YYYY-MM-DD.md`), or to `date` if given. " +
      "This log is your memory substitute and the reason your session is disposable: what is not in it did not happen, and every morning after a gap starts blind. " +
      "It is also where CORRECTIONS live - when you get something wrong and he corrects you, the entry is the correction plus the rule that would have prevented it, not an apology. " +
      "Write before the conversation goes quiet, not after. REFUSED: empty text, a malformed date, and any date in the future.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The entry, markdown. What happened, what was decided, what is open - compact, in the log's own voice." },
        heading: { type: "string", description: "Optional `## ` heading for this entry (e.g. 'Later the same day'). Use one when the day already has entries; it is what keeps a long day navigable." },
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today, which is almost always what you want." },
      },
      required: ["text"],
    },
  },
  {
    name: "assistant_read_log",
    description:
      "Read one day's log - today by default, or `date` for a given day. Yesterday's is the first thing to read before answering 'where am I'. " +
      "A day with no entry says so and lists the days that do exist, so 'nothing happened' and 'nothing was written down' stay distinguishable.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD. Omit for today." } },
    },
  },
  {
    name: "assistant_changes_since",
    description:
      "WHAT CHANGED since a given day - the read to open a session with. You rebuild your whole picture from the stores every time, which is right, but that tells you the current state and not what MOVED; this does. " +
      "Returns every log day from `since` onwards in full (one file per day, so the log is already a diff), the days in that window with NO entry at all (the gaps are the part you cannot see by listing what exists), " +
      "and for GOALS.md whether it changed in the window plus the lines in it carrying a date in the window. " +
      "`since` is INCLUSIVE, because an entry written late on the day you last looked is still news to you. " +
      "The goals half is a LEAD, not a textual diff: this store keeps no version history, and a date in the file can just as easily be a deadline or a scheduled event as a change stamp. It over-reports on purpose.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "YYYY-MM-DD - the day you last looked. Included in the answer." },
        includeText: { type: "boolean", description: "Set false for just the shape (which days moved, where the gaps are) without the prose. Defaults to true." },
      },
      required: ["since"],
    },
  },
];

function callTool(name, args) {
  switch (name) {
    case "assistant_read_goals":
      return readGoals();
    case "assistant_write_goals":
      return writeGoals(args || {});
    case "assistant_append_log":
      return appendLog(args || {});
    case "assistant_read_log":
      return readLog(args || {});
    case "assistant_changes_since":
      return changesSince(args || {});
    default:
      // Named explicitly rather than falling through to a generic failure: a
      // hallucinated tool name and a tool this server deliberately does not have
      // (there is no write_file here, and that is the design) look the same to the
      // caller otherwise.
      return { error: `Unknown tool: ${name}. This server exposes only: ${TOOLS.map((t) => t.name).join(", ")}.` };
  }
}

// --- Minimal stdio JSON-RPC MCP loop ---------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Wraps a tool result as an MCP tools/call content payload (JSON as text). */
function toolContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return;
  }
  const { id, method, params } = msg;
  // Notifications (no id) get no reply.
  if (id === undefined || id === null) {
    return;
  }
  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        // Where this server is pointed and what it thinks today is, answered once
        // at handshake. Both are things a seat has been wrong about: a relocated
        // store looks identical to an empty one, and a stale idea of "today" files
        // an entry under the wrong day.
        instructions:
          `The assistant store is ${resolveStoreDir()} and today is ${todayStamp()}. ` +
          "It holds two things: GOALS.md, which you are the sole scribe of, and log/YYYY-MM-DD.md, your daily record. " +
          "Open a session with assistant_changes_since to see what moved, and write through in the same turn as the conversation that produced the fact.",
      });
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const payload = await callTool(name, args);
      sendResult(id, toolContent(payload));
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, `Internal error: ${err?.message || String(err)}`);
  }
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON lines
      }
      handleMessage(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main();
