import { spawn } from "node:child_process";

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
export function startSession({ cwd, prompt, model, effort, resumeSessionId, onEvent }) {
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
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const child = spawn("claude", args, {
    cwd,
    shell: true, // resolve the claude shim on Windows
    env: process.env,
  });

  let buffer = "";
  let sessionId = null;
  let sawResult = false;
  let lastQuota = null;

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
    emit({ kind: "stderr", text: chunk.toString("utf8") });
  });

  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      emit({ kind: "closed", code, sessionId, sawResult });
      resolve({ code, sessionId, sawResult, quota: lastQuota });
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
      const text = evt.message?.content?.map?.((c) => c.text).filter(Boolean).join("") ?? "";
      if (text) {
        emit({ kind: "assistant", text });
      }
    } else if (type === "result") {
      sawResult = true;
      emit({
        kind: "result",
        subtype: evt.subtype,
        costUsd: evt.total_cost_usd,
        numTurns: evt.num_turns,
      });
    } else if (type === "rate_limit_event") {
      lastQuota = evt.rate_limit_info || null;
      emit({ kind: "quota", quota: lastQuota });
    } else if (type === "system") {
      emit({ kind: "system", subtype: evt.subtype, model: evt.model });
    }
    // other event types are ignored for the lean slice
  }

  return { child, done };
}
