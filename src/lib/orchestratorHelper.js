import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeBinary } from "./launcher.js";
import { findTranscriptPath, projectsRoot, encodeProjectDir } from "./paths.js";
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
// right now) — no persistent "helper session" per the captain's original ask,
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

// The orchestrator's own operating manual — a third layer distinct from
// the captain's global personal CLAUDE.md and each project's repo CLAUDE.md (see
// that file's own header comment, and PLAN.md's Phase 3 write-up, for the
// full rationale). Loaded at runtime rather than inlined so it can grow
// (dispatch/escalation/coaching instructions) without touching this module's
// code.
const INSTRUCTIONS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator-instructions.md");
// The file serves two audiences (see its own header): broad orchestrator
// guidance for a full-capability agent, PLUS the literal classifier system
// prompt fenced between these markers. Load ONLY the fenced region so the
// surrounding guidance (delegation heuristics, human-gating philosophy, etc.)
// never bloats or confuses this tiny Haiku status-classification call. Falls
// back to the whole file if the markers are ever absent, so a malformed edit
// degrades to the old behavior rather than an empty prompt.
const CLASSIFIER_SYSTEM_PROMPT = (() => {
  const raw = fs.readFileSync(INSTRUCTIONS_PATH, "utf8");
  const START = "<!-- classifier-prompt:start -->";
  const END = "<!-- classifier-prompt:end -->";
  const s = raw.indexOf(START);
  const e = raw.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    return raw.slice(s + START.length, e).trim();
  }
  return raw.trim();
})();

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
 * Cheap, synchronous first pass for "does this last message expect a reply from
 * the captain?" - the same distinction classifySessionStatus makes with Haiku,
 * but instant and free for the obvious cases (so a first mate that clearly
 * finished stops showing "needs you" immediately, without waiting for the next
 * sweep). Returns a statusTag ("done_not_archived" = clearly finished,
 * "waiting_for_input" = clearly a question/ask) or null (uncertain -> let the
 * Haiku classifier decide). BILINGUAL: mates reply in Swedish or English, so both
 * are matched. Bias toward flagging: only commit on a CLEAR signal, leave
 * anything ambiguous as null so nothing is under-flagged (the captain prefers false
 * positives over false negatives here).
 */
export function expectsUserInputHeuristic(text) {
  if (!text || !text.trim()) {
    return null;
  }
  // The ask or the sign-off almost always lands at the very end - weigh the last
  // non-empty line, plus the tail of the whole message.
  const lines = text
    .trim()
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  const low = (lastLine + " " + text.slice(-400)).toLowerCase();

  // Clear question / request for a decision -> expects input.
  if (/\?\s*$/.test(lastLine)) {
    return "waiting_for_input";
  }
  const ASKS = [
    // Swedish
    "vill du att", "ska jag", "ska vi", "vilken vill", "vilket vill", "vilka vill", "föredrar du",
    "säg till", "låt mig veta", "vad vill du", "hur vill du", "vad tycker du", "vad säger du",
    "bekräfta", "är det ok", "okej med dig", "ja eller nej", "vill du ha", "ska den", "vill du jag",
    // English
    "do you want", "should i ", "shall i ", "shall we", "which do you", "would you prefer",
    "let me know", "your call", "up to you", "what do you think", "please confirm", "is that ok",
    "yes or no", "want me to",
  ];
  if (ASKS.some((p) => low.includes(p))) {
    return "waiting_for_input";
  }

  // Clear completion / handoff -> no input expected.
  const DONE = [
    // Swedish
    "klart.", "klart -", "klart!", "klart,", "allt klart", "nu är det klart", "färdig",
    "hoppa in", "är uppsatt", "är upplagd", "pushat", "committat", "genomfört", "åtgärdat",
    "jag har lagt", "jag har fixat", "jag har skapat", "jag tog hand om", "då var det",
    // English
    "done.", "done -", "done!", "all done", "all set", "finished", "completed", "pushed and",
    "committed and", "jump into", "is set up", "i've added", "i've fixed", "i've created",
    "taken care of", "that's done",
  ];
  if (DONE.some((p) => low.includes(p))) {
    return "done_not_archived";
  }

  return null; // uncertain - let the Haiku classifier decide
}

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

    // Pre-generated rather than read back from `parsed.session_id` after the
    // fact: a killed-on-timeout or errored-before-valid-JSON subprocess never
    // reaches that parse, which would otherwise leave deleteOwnTranscript
    // with no ID to clean up and leak the file anyway (confirmed live during
    // review of the classifier's original leak fix, 2026-07-04) — with
    // --session-id supplied upfront, the transcript's filename is known
    // regardless of how the call ends.
    const classifierSessionId = randomUUID();
    const args = [
      "-p",
      summary,
      "--model",
      "claude-haiku-4-5-20251001",
      "--effort",
      "low",
      "--session-id",
      classifierSessionId,
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
      // This call's own transcript is pure disposable overhead — nothing
      // ever reads it again once `structured_output` is parsed out below.
      // Before this cleanup existed, every classification permanently left a
      // full session transcript on disk (one per session per sweep, forever)
      // in the SAME project directory as the real session it checked —
      // confirmed live 2026-07-03: 320 of these had piled up under one
      // project dir alone, indistinguishable from real sessions to Helm's
      // own directory-scanning sidebar. Runs here, in `finish`, rather than
      // only on the successful-parse path below, so a timeout-killed or
      // errored-before-valid-JSON call (which never reaches that parse)
      // still gets cleaned up instead of re-leaking on exactly that path —
      // confirmed live during review 2026-07-04. Best-effort — a failed
      // cleanup must never fail the classification itself, so this never
      // throws.
      deleteOwnTranscript(cwd, classifierSessionId);
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

// Structured output for the handoff categoriser (task 663ab4b6).
const HANDOFF_CATEGORY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    category: { type: "string" },
    reason: { type: "string" },
  },
  required: ["category", "reason"],
});

const HANDOFF_CATEGORY_PROMPT = [
  "You file a session's handoff note under a TOPIC so a later session on the same subject can find it.",
  "You are given the existing topics and the note.",
  "",
  "Rules:",
  "- STRONGLY prefer an existing topic. Only invent one when the note clearly does not belong to any of them.",
  "- A topic is a durable life/work subject (training, kombucha, job-search, finances), never a one-off task.",
  "- Answer with a short lowercase kebab-case slug in English, 1-3 words.",
  "- reason: one short sentence.",
].join("\n");

/**
 * Pick the topic a non-rooted session's handoff should be filed under (task
 * 663ab4b6). Same cost-optimised recipe as classifySessionStatus (Haiku, no
 * tools, no MCP) - this is a one-line classification, not a conversation.
 *
 * Returns { category, reason, costUsd } or null; the CALLER decides what to do
 * with it (see resolveHandoffCategory in handoffStore.js, which enforces the
 * match-an-existing-topic-first rule deterministically rather than trusting the
 * model to have obeyed it).
 */
export function classifyHandoffCategory({ cwd, title, text, existingCategories = [] }) {
  return new Promise((resolve) => {
    if (!text || !text.trim()) {
      resolve(null);
      return;
    }
    const summary = [
      `Existing topics: ${existingCategories.length > 0 ? existingCategories.join(", ") : "(none yet)"}`,
      `Session title: ${title || "(untitled)"}`,
      "",
      "Handoff note:",
      truncate(text, 2000),
      "",
      "Which topic should this be filed under?",
    ].join("\n");

    const classifierSessionId = randomUUID();
    const args = [
      "-p",
      summary,
      "--model",
      "claude-haiku-4-5-20251001",
      "--effort",
      "low",
      "--session-id",
      classifierSessionId,
      "--output-format",
      "json",
      "--json-schema",
      HANDOFF_CATEGORY_SCHEMA,
      "--system-prompt",
      HANDOFF_CATEGORY_PROMPT,
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
      deleteOwnTranscript(cwd, classifierSessionId);
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
        const result = parsed.structured_output;
        if (result && typeof result.category === "string" && result.category.trim()) {
          finish({ category: result.category, reason: result.reason || "", costUsd: parsed.total_cost_usd || 0 });
        } else {
          finish(null);
        }
      } catch {
        finish(null);
      }
    });
  });
}

const TRIAGE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    well_defined: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["well_defined", "reason"],
});

/**
 * The auto-captain's gate: is this task card specific enough to hand to an agent?
 *
 * Same cheap one-shot shape as the classifiers above - Haiku, low effort, NO tools
 * and no MCP servers, its own transcript deleted afterwards. Tool access matters
 * here beyond cost: this call reads a card the user wrote and decides whether real
 * work fires, so it must not be able to touch anything itself.
 *
 * Resolves { dispatchable, reason, costUsd } or null when the call could not be
 * made at all. A null is NOT "go ahead" - the caller treats it as "don't fire".
 *
 * @param {{cwd: string, systemPrompt: string, input: string}} args
 */
export function triageAutoTask({ cwd, systemPrompt, input }) {
  return new Promise((resolve) => {
    if (!input || !input.trim()) {
      resolve(null);
      return;
    }
    const triageSessionId = randomUUID();
    const args = [
      "-p",
      input,
      "--model",
      "claude-haiku-4-5-20251001",
      "--effort",
      "low",
      "--session-id",
      triageSessionId,
      "--output-format",
      "json",
      "--json-schema",
      TRIAGE_SCHEMA,
      "--system-prompt",
      systemPrompt,
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
      deleteOwnTranscript(cwd, triageSessionId);
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
        const result = parsed.structured_output;
        if (result && typeof result.well_defined === "boolean") {
          finish({
            dispatchable: result.well_defined,
            reason: typeof result.reason === "string" ? result.reason.trim() : "",
            costUsd: parsed.total_cost_usd || 0,
          });
        } else {
          finish(null);
        }
      } catch {
        finish(null);
      }
    });
  });
}

// Best-effort delete of a just-completed one-shot classifier call's own
// transcript. `cwd` + `sessionId` together resolve the exact file path the
// same way `findTranscriptPath` searches (paths.js's own `encodeProjectDir`
// naming), no directory scan needed since we know precisely which file we
// just created. Silently no-ops on any failure (missing session_id, file
// already gone, permission issue) — this is cleanup of the tool's own
// disposable output, never something a caller should have to handle.
function deleteOwnTranscript(cwd, sessionId) {
  if (!sessionId || !cwd) {
    return;
  }
  try {
    const filePath = path.join(projectsRoot, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best-effort only
  }
}

function truncate(text, max) {
  if (!text) {
    return "";
  }
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// How much of the transcript tail to scan for the most recent token-usage
// numbers. The last usage block is always near the end; 256KB is plenty
// without reading a possibly-huge whole file.
const CONTEXT_TAIL_BYTES = 256 * 1024;

/**
 * Best-effort estimate of a session's CURRENT context occupancy, for the
 * auto-compact threshold. Reads the transcript tail and takes the LAST
 * usage block's input + cache_creation + cache_read tokens — that final API
 * call of the most recent turn read the full accumulated context once, so
 * it's the freshest occupancy snapshot on disk.
 *
 * A proxy, not exact: it can over-count on turns with many internal tool
 * iterations, and the CLI's own /compact reports a somewhat smaller
 * `pre_tokens` for the same state. That's fine — the auto-compact threshold
 * is tunable and only needs a monotonic "this session is big" signal, and a
 * successful compact drops this number far below any sane threshold so it
 * won't immediately re-fire. Returns null if no usage is found (e.g. a
 * brand-new or unreadable session).
 */
export function estimateSessionContextTokens(cliSessionId, sessionId) {
  const transcriptPath = findTranscriptPath([cliSessionId, sessionId]);
  if (!transcriptPath) {
    return null;
  }
  let text;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= CONTEXT_TAIL_BYTES) {
      text = fs.readFileSync(transcriptPath, "utf8");
    } else {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(CONTEXT_TAIL_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, CONTEXT_TAIL_BYTES, size - CONTEXT_TAIL_BYTES);
        text = buffer.toString("utf8", 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return null;
  }
  // Anchor on the LAST cache_read_input_tokens (present in every usage
  // block), then pull its sibling fields from a small window around it.
  // Field-level regex rather than JSON.parse of the whole usage object,
  // which is brittle across the two transcript formats (interactive vs
  // headless stream-json) and the nested server_tool_use sub-object.
  const readMatches = [...text.matchAll(/"cache_read_input_tokens":(\d+)/g)];
  if (readMatches.length === 0) {
    return null;
  }
  const last = readMatches[readMatches.length - 1];
  const windowText = text.slice(Math.max(0, last.index - 400), last.index + 100);
  const cacheRead = parseInt(last[1], 10);
  const inputMatch = windowText.match(/"input_tokens":(\d+)/);
  const cacheCreationMatch = windowText.match(/"cache_creation_input_tokens":(\d+)/);
  const input = inputMatch ? parseInt(inputMatch[1], 10) : 0;
  const cacheCreation = cacheCreationMatch ? parseInt(cacheCreationMatch[1], 10) : 0;
  return input + cacheCreation + cacheRead;
}

/**
 * Current byte size of a session's transcript, or null if not found. Used as
 * the auto-compact "has anything happened since I last compacted this?"
 * signal: it's more reliable than lastActivityAt (a headless /compact APPENDS
 * to the transcript and may itself bump lastActivityAt) because the caller
 * samples it right AFTER its own compaction, so any later growth is
 * necessarily real new activity, not the compaction's own append.
 */
export function getTranscriptSize(cliSessionId, sessionId) {
  const transcriptPath = findTranscriptPath([cliSessionId, sessionId]);
  if (!transcriptPath) {
    return null;
  }
  try {
    return fs.statSync(transcriptPath).size;
  } catch {
    return null;
  }
}

// Compaction took ~13s in the spike; give it generous headroom for a large
// session before treating a silent hang as failure.
const COMPACT_TIMEOUT_MS = 90_000;

/**
 * Runs the CLI's built-in /compact on a session headlessly (verified
 * possible in spike/test-compact-headless.mjs). Resolves to
 * { ok:true, preTokens, postTokens } on a confirmed compaction, or null on
 * any failure — never throws. Success is keyed off the `compact_boundary`
 * stream event's metadata, NOT file size (compaction APPENDS to the
 * append-only transcript, so bytes go up, not down).
 */
export function compactSession({ cwd, cliSessionId, sessionId }) {
  return new Promise((resolve) => {
    const resumeId = cliSessionId || sessionId;
    if (!resumeId) {
      resolve(null);
      return;
    }
    const args = ["--resume", resumeId, "-p", "/compact", "--output-format", "stream-json", "--verbose"];
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
    // /compact with -p otherwise waits ~3s for stdin that never comes; close
    // it immediately so the compaction starts without that stall.
    try {
      child.stdin.end();
    } catch {
      // best-effort
    }

    let buf = "";
    let boundary = null;
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
    }, COMPACT_TIMEOUT_MS);

    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) {
          continue;
        }
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === "system" && evt.subtype === "compact_boundary" && evt.compact_metadata) {
          boundary = evt.compact_metadata;
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      if (boundary) {
        finish({ ok: true, preTokens: boundary.pre_tokens ?? null, postTokens: boundary.post_tokens ?? null });
      } else {
        finish(null);
      }
    });
  });
}
