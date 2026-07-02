import { spawn, execSync } from "node:child_process";

// `shell: true` on Windows does NOT quote array args before handing them to
// cmd.exe — it just concatenates them, so any prompt containing a space gets
// split into separate shell tokens and truncated to its first word. Resolving
// the real claude.exe and spawning it directly avoids the shell entirely, so
// Node's own (correct) Windows argv escaping applies.
let resolvedClaudePath = null;
function resolveClaudeBinary() {
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
      const blocks = evt.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            emit({ kind: "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            // Lets the UI show a live "agent is running X" indicator while a
            // turn is in progress, ahead of the authoritative transcript.
            emit({ kind: "tool_use", toolName: block.name });
          }
        }
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
