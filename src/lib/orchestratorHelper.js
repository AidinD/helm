import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "./launcher.js";
import { findTranscriptPath } from "./paths.js";
import { readTranscript } from "./transcript.js";

// Fas 3's "sensor": a periodic, stateless classifier over sessions that
// today's status heuristic (deriveStatus in sessions.js — purely "who spoke
// last, how long ago") can't distinguish. E.g. a session sitting in
// "waiting" because the assistant's last message was a real open question
// looks IDENTICAL, heuristically, to one where the assistant gave a final
// answer that needs nothing further — both are just "assistant spoke last,
// recently." This reads the actual content to tell those apart.
//
// Deliberately a classifier, not a conversation: each check is stateless
// (given this session's recent messages + its Jot task, what's its status
// right now) — no persistent "helper session" per Aidin's original ask,
// which would have been a heavier, harder-to-reason-about mechanism for the
// same result (see DECISIONS.md 2026-07-02, PLAN.md Phase 3).
const STATUS_TAGS = ["waiting_for_input", "stuck", "done_not_archived", "blocked_external", "genuinely_active"];

const TAG_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    statusTag: { type: "string", enum: STATUS_TAGS },
    reason: { type: "string" },
  },
  required: ["statusTag", "reason"],
});

const CLASSIFIER_SYSTEM_PROMPT =
  "You are a terse session-status classifier for a coding assistant orchestrator dashboard. " +
  "Given the last few messages of a coding session and its linked task info, classify its CURRENT status:\n" +
  '- "waiting_for_input": the assistant asked a real question or is blocked on a decision only the human can make.\n' +
  '- "stuck": the assistant appears to be failing/erroring/looping without making progress.\n' +
  '- "done_not_archived": the assistant gave a final answer/result; nothing further is needed from either side.\n' +
  '- "blocked_external": waiting on something outside the conversation (a human reviewing a PR, a deploy, an external service).\n' +
  '- "genuinely_active": there is real unfinished work in flight that the human should know is still moving.\n' +
  "Respond only in the requested JSON schema. reason MUST be under 12 words, one short clause, no filler — this is a compact UI label, not an explanation.";

// This mirrors judgeModelFit's exact cost-optimized recipe (judge.js) almost
// line for line: --system-prompt + --allowed-tools "" + empty
// --strict-mcp-config strips the MCP/tool defs a structured-output-only call
// never needs, which is what actually drives the ~78% cost reduction (not
// --bare, which would also drop subscription auth). Deliberately the SAME
// recipe, not a new one — this is establishing that pattern's second user.
const CLASSIFIER_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// Enough for the assistant's own last message plus the user turn that
// prompted it — usually sufficient to tell "asked a real question" from
// "gave a final answer" without reading the whole conversation.
const RECENT_TURNS_FOR_CLASSIFIER = 6;
const MAX_SUMMARY_CHARS_PER_TURN = 500;

/**
 * Classifies a single session's current status from its recent transcript
 * tail + Jot task info. Resolves to { statusTag, reason, costUsd } or null
 * on any failure (never throws — this is an ambient background signal, not
 * allowed to affect anything else if it fails).
 */
export function classifySessionStatus({ cwd, cliSessionId, sessionId, title, jotSummary }) {
  return new Promise((resolve) => {
    const transcriptPath = findTranscriptPath([cliSessionId, sessionId]);
    if (!transcriptPath) {
      resolve(null);
      return;
    }
    const { turns } = readTranscript(transcriptPath, { maxTurns: RECENT_TURNS_FOR_CLASSIFIER });
    const recentText = turns
      .filter((t) => (t.role === "user" || t.role === "assistant") && t.kind === "text")
      .slice(-RECENT_TURNS_FOR_CLASSIFIER)
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${truncate(t.text, MAX_SUMMARY_CHARS_PER_TURN)}`)
      .join("\n\n");
    if (!recentText) {
      resolve(null);
      return;
    }

    const summary = [
      `Session: ${title || "(untitled)"}`,
      jotSummary ? `Linked task: ${jotSummary}` : "Linked task: none",
      "",
      "Recent conversation (most recent last):",
      recentText,
      "",
      "Classify this session's current status.",
    ].join("\n");

    const args = [
      "-p",
      summary,
      "--model",
      "claude-haiku-4-5-20251001",
      "--effort",
      "low",
      "--output-format",
      "json",
      "--json-schema",
      TAG_SCHEMA,
      "--system-prompt",
      CLASSIFIER_SYSTEM_PROMPT,
      "--allowed-tools",
      "",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
    ];

    const claudePath = resolveClaudeBinary();
    let child;
    try {
      child = spawn(claudePath, args, {
        cwd,
        shell: !claudePath.toLowerCase().endsWith(".exe"),
        env: process.env,
      });
    } catch {
      resolve(null);
      return;
    }

    let out = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finish(null);
    }, CLASSIFIER_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT_BYTES) {
        out += d.toString("utf8");
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        const tag = parsed.structured_output;
        if (tag && STATUS_TAGS.includes(tag.statusTag) && tag.reason) {
          finish({ statusTag: tag.statusTag, reason: tag.reason, costUsd: parsed.total_cost_usd || 0 });
        } else {
          finish(null);
        }
      } catch {
        finish(null);
      }
    });
  });
}

function truncate(text, max) {
  if (!text) {
    return "";
  }
  return text.length > max ? text.slice(0, max) + "…" : text;
}
