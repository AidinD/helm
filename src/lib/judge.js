import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "./launcher.js";

const VERDICT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["too_weak", "appropriate", "too_strong"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
});

// The judge is a cheap Haiku call with no tools/MCP — should resolve in a
// few seconds. Bounds a hang (network stall, an auth prompt with no TTY to
// answer it) so a stuck child doesn't linger forever unkilled and the
// fire-and-forget promise doesn't just dangle.
const JUDGE_TIMEOUT_MS = 30_000;
// A real verdict response easily fits in a few KB; this is just a backstop
// against unbounded accumulation if something unexpected keeps writing to
// stdout.
const MAX_OUTPUT_BYTES = 1024 * 1024;

const JUDGE_SYSTEM_PROMPT =
  "You are a terse model-selection quality judge for a coding assistant. " +
  "Given a task and which model/effort handled it, judge whether that choice was " +
  "appropriate, too_weak (task showed signs of struggle: excessive tool calls, " +
  "errors, vague or wrong-looking output for its complexity, or an explicit " +
  "user instruction about model/effort was not honored), or too_strong " +
  "(overkill — a cheaper/faster model would clearly have done just as well). " +
  "Respond only in the requested JSON schema. reason MUST be under 12 words, " +
  "one short clause, no filler — this is a compact UI label, not an explanation.";

/**
 * Judges whether a completed run's model/effort choice fit the task. Runs a
 * SEPARATE, minimal claude invocation — deliberately NOT --bare (that forces
 * API-key auth instead of the subscription). Cost was brought down from
 * ~$0.068 to ~$0.015/call by stripping MCP servers and tool definitions the
 * judge never needs (it only emits JSON, no tool use) — those, not CLAUDE.md,
 * turned out to be the bulk of the token overhead on a non-bare invocation.
 *
 * Resolves to { verdict, reason } or null on any failure (never throws —
 * this is a nice-to-have side report, not allowed to affect the real run).
 */
export function judgeModelFit({ cwd, taskPrompt, model, effort, toolsUsed, numTurns, finalText }) {
  return new Promise((resolve) => {
    const summary = [
      `Task: ${truncate(taskPrompt, 400)}`,
      `Model used: ${model || "unknown"}${effort ? ` (effort: ${effort})` : ""}`,
      `Tools used: ${toolsUsed?.length ? toolsUsed.join(", ") : "none"}`,
      `Turns: ${numTurns ?? "?"}`,
      finalText ? `Final response: ${truncate(finalText, 600)}` : "",
      "",
      "Judge whether this model+effort choice was appropriate, too weak, or too strong for this task.",
    ]
      .filter(Boolean)
      .join("\n");

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
      VERDICT_SCHEMA,
      "--system-prompt",
      JUDGE_SYSTEM_PROMPT,
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
    // Guards against resolving twice (e.g. the timeout fires and kills the
    // child, which then also emits its own "close") and always clears the
    // timer once a real outcome — success or failure — is known.
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
    }, JUDGE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT_BYTES) {
        out += d.toString("utf8");
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        const verdict = parsed.structured_output;
        if (verdict && verdict.verdict && verdict.reason) {
          finish({ verdict: verdict.verdict, reason: verdict.reason, costUsd: parsed.total_cost_usd || 0 });
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
