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
  // Test seam. The three transitions in the daily loop that have never had a test - a relay
  // and a jump-in resolving to ONE session, a relay actually reaching its second mate, and a
  // retiring mate really running its carry-over turn - all need a TURN to happen. Two of them
  // can lose data silently, so "probably fine" is not good enough, but running them for real
  // spends tokens on every suite run. Pointing this at a stub lets the surrounding machinery
  // (locks, bindings, session minting, carry-over) be exercised end to end for free.
  //
  // Honoured before `where claude` and never in production use: nothing sets it but a test.
  // It is NOT a HELM_*_PATH name on purpose - that suffix means "a data store" here, and
  // test-packaged-store-paths would then demand a packaged redirect for a binary path.
  if (process.env.HELM_CLAUDE_BIN) {
    resolvedClaudePath = process.env.HELM_CLAUDE_BIN;
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
export function startSession({ cwd, prompt, model, effort, permissionMode, resumeSessionId, onEvent, mcpConfig, allowedTools, disallowedTools, appendSystemPrompt, strictMcpConfig, agents, settings, extraEnv }) {
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
  // First-mate tier: main.js passes the first-mate operating manual here on a
  // FRESH first-mate turn, so the mate boots knowing its role (delegate,
  // prioritize, stay thin) without a pre-filled visible draft - the composer
  // stays empty for the captain's first prompt. Loaded as system context, not
  // a user message.
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  // Tier guard (src/lib/tierGuard.js). An inline settings JSON carrying a PreToolUse
  // hook, passed on EVERY launch - which is the whole reason the guard lives here
  // and not in the manual above. --append-system-prompt only reaches a fresh
  // session, so a rule change did not bind a running mate until it was retired; a
  // hook is re-applied per launch, and every turn is a launch. `--settings` is
  // additive, so the captain's own settings still apply underneath it.
  if (settings) {
    args.push("--settings", typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  // First-mate tier (docs/first-mate-tier-design.md section 5): main.js passes
  // an inline mcp-config JSON string ONLY when this launch is a first mate
  // (session rooted in the meta home), so ONLY first mates get the helm_*
  // dispatch tools. A dispatched second-mate run (a runGoal iteration, which
  // does not go through startSession at all) never gets them - the structural
  // depth cap. Passed exactly the way judge.js/orchestratorHelper.js already
  // pass --mcp-config to a spawned claude (an inline JSON string argv element).
  if (mcpConfig) {
    args.push("--mcp-config", mcpConfig);
  }
  // First-mate tier: strict isolation. A first mate should launch LEAN with
  // ONLY the helm_* dispatch tools from the inline mcpConfig above, not the
  // machine's other ~20 MCP servers - a developer workstation easily carries
  // twenty of them - which it would otherwise inherit from the user's global
  // config. Passed ONLY on the first-mate launch path in main.js - never for a
  // regular chat session, which still needs the user's full MCP set. Same flag
  // spelling already proven in scripts/e2e/test-first-mate-fleet-state.mjs.
  if (strictMcpConfig) {
    args.push("--strict-mcp-config");
  }
  // Pre-approve specific tools (first-mate dispatch tools) so a headless -p
  // session can call them without an unanswerable permission prompt. Passed as
  // SEPARATE argv values after the flag (`--allowedTools t1 t2 t3`) - a single
  // space-joined value is NOT split by the CLI and matches nothing (verified).
  if (allowedTools && allowedTools.length) {
    args.push("--allowedTools", ...allowedTools);
  }
  // First-mate tier guard: DENY the tools of doing work (file mutation) and
  // fanning out (sub-agents), so a coordinator structurally cannot slip into
  // hands-on project work - it must dispatch via helm_* instead. Passed as
  // separate argv values after the flag, same as --allowedTools. A deny beats an
  // allow, so this holds even under a permissive permission-mode.
  if (disallowedTools && disallowedTools.length) {
    args.push("--disallowedTools", ...disallowedTools);
  }
  // Advisory seats (personas.js): sub-agent definitions this session may consult
  // by name, injected per launch as ONE json argv value rather than written into
  // the machine's global agents directory. Each definition carries its own tool
  // list, and a sub-agent's tool list is an ALLOW list - which is why the seats
  // are genuinely read-only where a --disallowedTools spelling of the same intent
  // is not (measured; see the ADVISORY_TOOLS comment in personas.js).
  if (agents && Object.keys(agents).length) {
    args.push("--agents", JSON.stringify(agents));
  }
  // User-confirmed default is "auto" (matches what the captain already runs daily
  // in the desktop app); UI exposes the full mode list from the composer.
  // Helm's -p invocation has no live channel to answer an interactive
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
    // extraEnv carries the tier guard's context (which tier, which session, where
    // the meta home is) to the hook process the CLI spawns. It travels in the
    // environment rather than in the hook command line so a path with a space or a
    // quote cannot reshape the command the hook runs as.
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

  let buffer = "";
  let sessionId = null;
  let sawResult = false;
  // Whether that result was an ERROR result (see the "result" branch below). Carried out with
  // the summary so a caller can tell "the model answered" from "the run ended".
  let resultWasError = false;
  let resultErrorText = null;
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
  // Tracks in-flight file-writing tool calls (Write/Edit/MultiEdit) by their
  // tool_use id so the matching "user" stream-json message carrying that
  // tool's tool_result can be correlated back to the file it wrote. Used
  // only to emit the additive "tool_written" event below — the existing
  // "tool_use" event (which drives the live "Working — X" indicator) is
  // still emitted the moment the tool is REQUESTED, unchanged.
  const pendingFileWrites = new Map();

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
      emit({ kind: "closed", code, sessionId, sawResult, resultWasError, resultErrorText });
      resolve({ code, sessionId, sawResult, resultWasError, resultErrorText, quota: lastQuota, stderrText });
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
          // totalTokens (incl. cache_read) is kept for accounting; outputTokens is
          // what the UI shows. cache_read - the cached context re-fed to the model
          // every turn - dominated the displayed number (~99%), making it look like
          // a token explosion next to Desktop's leaner output-based count, when the
          // real generation is tiny and cache reads bill at a fraction (a39286b7
          // follow-up). Show what the model actually produced.
          emit({ kind: "usage", totalTokens: tokens, outputTokens: msgUsage.output_tokens || 0 });
        }
      }
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            emit({ kind: "assistant", text: block.text });
          } else if (block.type === "thinking") {
            // What the model is reasoning about, while it still is. The stream has always
            // carried these - the CLI emits one event per content block, which is the reason
            // the usage dedupe above exists - and this loop simply had no branch for them, so
            // Helm received them and threw them away. Nothing extra is requested and no model
            // call is made: the text is already in the event.
            //
            // ONLY when there is text. Measured across the transcripts on this machine:
            // 27,291 thinking blocks, 16,168 of them carrying content and the other 11,123
            // signature-only. Emitting those would put an empty italic line under the status,
            // which reads as a bug rather than as silence.
            const thought = String(block.thinking || block.text || "");
            if (thought.trim()) {
              emit({ kind: "thinking", text: thought });
            }
          } else if (block.type === "tool_use") {
            // Lets the UI show a live "agent is running X" indicator while a
            // turn is in progress, ahead of the authoritative transcript.
            // filePath (Write/Edit/MultiEdit's file_path, when present) lets the
            // renderer notice a generated mockup and offer to open it in Plan.
            // skillName (the Skill tool's `skill` input) captures a skill the model
            // invoked ON ITS OWN, so usage tracking sees autonomous skill use, not
            // just leading-"/skill" prompts (task aa9f5238).
            emit({
              kind: "tool_use",
              toolName: block.name,
              filePath: block.input?.file_path,
              skillName: block.name === "Skill" ? block.input?.skill || null : null,
            });
            // Remember this call's id -> file_path so that once the matching
            // tool_result comes back (in a later "user" message, see below)
            // we know the write actually completed before telling the
            // renderer about it. tool_use fires on REQUEST, not completion —
            // clicking "Open in Plan" right after tool_use can race the
            // actual file write, so the mockup banner instead waits for this
            // tool_written event.
            if (block.id && block.input?.file_path) {
              pendingFileWrites.set(block.id, block.input.file_path);
            }
          }
        }
      }
    } else if (type === "user") {
      // Claude Code emits a "user"-role message carrying tool_result block(s)
      // once a tool finishes executing, each tagged with the tool_use_id of
      // the call it answers. Only used here to detect completion of a
      // pending file write (see pendingFileWrites above) and emit the
      // additive "tool_written" event; everything else about "user" messages
      // is still ignored for this lean slice.
      const blocks = evt.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type !== "tool_result" || !block.tool_use_id) {
            continue;
          }
          const filePath = pendingFileWrites.get(block.tool_use_id);
          if (filePath === undefined) {
            continue;
          }
          pendingFileWrites.delete(block.tool_use_id);
          if (!block.is_error) {
            emit({ kind: "tool_written", filePath });
          }
        }
      }
    } else if (type === "result") {
      sawResult = true;
      // ...but a result event is not always an ANSWER. The CLI also ends with one for
      // `error_during_execution`, `error_max_turns`, and a run that hit the usage limit. Every
      // caller treating sawResult as "the model replied" was therefore wrong about those, and one
      // caller now WRITES PERSISTED STATE from it: a scheduled prompt fired into a spent quota
      // was recorded as delivered, which is the exact bug that recording exists to catch (found
      // by review, 2026-08-04). So the error-ness travels with it rather than being flattened.
      if (evt.is_error === true || (typeof evt.subtype === "string" && evt.subtype.startsWith("error"))) {
        resultWasError = true;
        resultErrorText = String(evt.subtype || evt.error || "the run ended in an error").slice(0, 400);
      }
      // The CLI reports each model's real context-window size here, keyed by
      // model name (evt.modelUsage["claude-…"].contextWindow). This is the
      // authoritative source Helm uses to learn model→window (far better
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
        // The turn's generated output - what the UI shows, instead of the
        // cache_read-dominated total (a39286b7 follow-up).
        outputTokens: usage.output_tokens || 0,
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
