import { spawn, execSync } from "node:child_process";

// `shell: true` on Windows does NOT quote array args before handing them to
// cmd.exe — it just concatenates them, so any prompt containing a space gets
// split into separate shell tokens and truncated to its first word. Resolving
// the real claude.exe and spawning it directly avoids the shell entirely, so
// Node's own (correct) Windows argv escaping applies.
let resolvedClaudePath = null;
export function resolveClaudeBinary() {
  if (resolvedClaudePath) {
    return resolvedClaudePath;
  }
  try {
    const out = execSync(process.platform === "win32" ? "where claude" : "which claude", {
      encoding: "utf8",
    });
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Prefer a real .exe — it can be spawned directly without a shell. A
    // .cmd shim still needs shell:true, which reintroduces the quoting bug.
    resolvedClaudePath =
      candidates.find((c) => c.toLowerCase().endsWith(".exe")) || candidates[0] || "claude";
  } catch {
    resolvedClaudePath = "claude";
  }
  // If resolution didn't land on a real .exe, every launch falls back to
  // shell:true and the space-truncation bug fixed earlier tonight is live
  // again for this machine. Loud on purpose — this failure mode is silent
  // otherwise (prompts just quietly lose everything after the first word).
  if (!resolvedClaudePath.toLowerCase().endsWith(".exe")) {
    console.error(
      `[launcher] Could not resolve a direct claude.exe (got "${resolvedClaudePath}"). ` +
        "Falling back to shell:true, which re-exposes the prompt-truncation bug for any prompt with a space. " +
        "Check that 'claude' resolves to a real .exe via `where claude` / `which claude`."
    );
  }
  return resolvedClaudePath;
}

/**
 * Starts a real Claude Code session, rooted in `cwd` (a normal repo dir on its
 * current branch — no worktree), streaming events back via `onEvent`.
 *
 * This is the core of the "wrap the real CLI" approach proven in the Phase 0
 * spike: all skills, CLAUDE.md, settings and MCP load because we do NOT pass
 * --bare, and it runs on the user's subscription auth.
 *
 * Returns { child, done } where `done` resolves with a summary once the process
 * exits. Emits normalized events: { kind, ...fields }.
 */
export function startSession({ cwd, prompt, model, effort, permissionMode, resumeSessionId, onEvent }) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  // User-confirmed default is "auto" (matches what the captain already runs daily
  // in the desktop app); UI exposes the full mode list from the composer.
  // Maestro's -p invocation has no live channel to answer an interactive
  // approval prompt, so a stricter mode that genuinely needs to ask mid-run
  // could still stall — untested beyond "default" not blocking in this
  // environment's existing broad allowlists.
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const claudePath = resolveClaudeBinary();
  const child = spawn(claudePath, args, {
    cwd,
    // Only shell out if we couldn't resolve a real binary (unlikely) — a
    // direct .exe spawn needs no shell and keeps multi-word prompts intact.
    shell: !claudePath.toLowerCase().endsWith(".exe"),
    env: process.env,
  });

  let buffer = "";
  let sessionId = null;
  let sawResult = false;
  let lastQuota = null;
  // Accumulated for the "closed" summary, NOT emitted live per-chunk — a
  // failed run's real error (e.g. "No conversation found with session ID")
  // goes here, but plenty of benign stderr noise happens on every run too
  // (e.g. the "no stdin data received" warning), so the caller decides
  // whether it's worth surfacing based on whether the run actually failed
  // (summary.code !== 0 && !summary.sawResult), not on stderr output alone.
  // Capped so a runaway/looping process can't grow this unboundedly.
  let stderrText = "";
  const STDERR_CAP = 4000;
  // The CLI emits one "assistant" stream-json event PER CONTENT BLOCK when a
  // message has more than one (e.g. a thinking block + a tool_use block),
  // not one event per complete message — verified live (spike, 2026-07-03):
  // two consecutive events shared the same message.id and carried byte-
  // identical usage snapshots. Summing usage across every "assistant" event
  // therefore double-counts any multi-block message. Deduping by message.id
  // (only counting the first event seen for a given id) matched the CLI's
  // own authoritative final result.usage exactly for input/cache tokens in
  // that same spike.
  const seenUsageMessageIds = new Set();

  const emit = (evt) => {
    try {
      onEvent(evt);
    } catch {
      // never let a UI handler crash the launcher
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        handle(line);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderrText.length < STDERR_CAP) {
      stderrText = (stderrText + chunk.toString("utf8")).slice(0, STDERR_CAP);
    }
  });

  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      emit({ kind: "closed", code, sessionId, sawResult });
      resolve({ code, sessionId, sawResult, quota: lastQuota, stderrText });
    });
    child.on("error", (err) => {
      emit({ kind: "error", message: err.message });
      resolve({ code: -1, error: err.message });
    });
  });

  function handle(line) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      emit({ kind: "raw", text: line });
      return;
    }
    if (evt.session_id && !sessionId) {
      sessionId = evt.session_id;
      emit({ kind: "session", sessionId });
    }
    const type = evt.type;
    if (type === "assistant") {
      const blocks = evt.message?.content;
      // Per the CLI's own stream-json format, each assistant message event
      // carries its OWN usage snapshot (evt.message.usage) — not just the
      // final `result` event. This is what lets the "Nk tokens" readout tick
      // up live during a run instead of only appearing once at the very end.
      // Only counted once per distinct message.id (see seenUsageMessageIds
      // above) so a multi-block message's repeated usage snapshot isn't
      // added more than once; the caller (main.js/renderer) sums these
      // deduped per-message contributions across a turn's several messages.
      const msgId = evt.message?.id;
      const msgUsage = evt.message?.usage;
      if (msgId && msgUsage && typeof msgUsage === "object" && !seenUsageMessageIds.has(msgId)) {
        seenUsageMessageIds.add(msgId);
        const tokens =
          (msgUsage.input_tokens || 0) +
          (msgUsage.output_tokens || 0) +
          (msgUsage.cache_creation_input_tokens || 0) +
          (msgUsage.cache_read_input_tokens || 0);
        if (tokens > 0) {
          emit({ kind: "usage", totalTokens: tokens });
        }
      }
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            emit({ kind: "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            // Lets the UI show a live "agent is running X" indicator while a
            // turn is in progress, ahead of the authoritative transcript.
            // filePath (Write/Edit/MultiEdit's file_path, when present) lets the
            // renderer notice a generated mockup and offer to open it in Plan.
            emit({ kind: "tool_use", toolName: block.name, filePath: block.input?.file_path });
          }
        }
      }
    } else if (type === "result") {
      sawResult = true;
      // The CLI reports each model's real context-window size here, keyed by
      // model name (evt.modelUsage["claude-…"].contextWindow). This is the
      // authoritative source Maestro uses to learn model→window (far better
      // than a hardcoded guess) for the context gauge's percentage.
      const contextWindows = {};
      if (evt.modelUsage && typeof evt.modelUsage === "object") {
        for (const [model, usage] of Object.entries(evt.modelUsage)) {
          if (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
            contextWindows[model] = usage.contextWindow;
          }
        }
      }
      // evt.usage is the CLI's own aggregate token count for the whole turn
      // (input + output, cache reads/writes tracked separately) — the same
      // authoritative source as contextWindows above, just a different field
      // on the same result event. Used for the "12.3s · 1.2k tokens" readout
      // under a completed reply; no separate token-counting logic needed.
      const usage = evt.usage || {};
      const totalTokens =
        (usage.input_tokens || 0) +
        (usage.output_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0);
      emit({
        kind: "result",
        subtype: evt.subtype,
        costUsd: evt.total_cost_usd,
        numTurns: evt.num_turns,
        durationMs: evt.duration_ms,
        totalTokens: totalTokens > 0 ? totalTokens : null,
        contextWindows,
      });
    } else if (type === "rate_limit_event") {
      lastQuota = evt.rate_limit_info || null;
      emit({ kind: "quota", quota: lastQuota });
    } else if (type === "system" && evt.subtype === "task_started") {
      // A background Task-tool subagent was spawned — verified schema via
      // spike/test-task-events-shape.mjs. taskId links task_progress/
      // task_updated/task_notification for the SAME background task.
      emit({ kind: "task_started", taskId: evt.task_id, description: evt.description, subagentType: evt.subagent_type });
    } else if (type === "system" && evt.subtype === "task_progress") {
      emit({ kind: "task_progress", taskId: evt.task_id, lastToolName: evt.last_tool_name, tokens: evt.usage?.total_tokens });
    } else if (type === "system" && evt.subtype === "task_updated") {
      emit({ kind: "task_updated", taskId: evt.task_id, status: evt.patch?.status });
    } else if (type === "system" && evt.subtype === "task_notification") {
      emit({ kind: "task_done", taskId: evt.task_id, status: evt.status, summary: evt.summary });
    } else if (type === "system") {
      emit({ kind: "system", subtype: evt.subtype, model: evt.model });
    }
    // other event types are ignored for the lean slice
  }

  return { child, done };
}
