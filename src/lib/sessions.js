import fs from "node:fs";
import path from "node:path";
import { findSessionsDir, findTranscriptPath } from "./paths.js";

// Default scoring weights for the attention ranking. Overridable via
// config.jot.weights. "review" is weighted highest because in the captain's Jot
// workflow a review task means "Claude finished, you must verify" — literally
// awaiting your attention.
export const DEFAULT_WEIGHTS = {
  waiting: 100, // assistant-ended and recent (open conversation loop)
  active: 60, // a turn is likely running right now
  review: 30, // per Jot review task
  inProgress: 20, // per Jot in-progress task
  open: 2, // per Jot open (backlog) task
};

// How recent lastActivityAt must be for a "user"-ended session to count as
// actively running rather than idle/parked.
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

// Default window within which an assistant-ended session counts as an open
// loop "waiting for you" rather than a parked/old session. Overridable via
// config.attentionWindowHours.
const DEFAULT_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Only the tail of a transcript is read to determine the last message role,
// since transcripts can be many megabytes.
const TAIL_BYTES = 96 * 1024;

/**
 * Reads every session's metadata file and derives a normalized status.
 * Pure read; never writes to the app's files.
 */
export function readAllSessions(options = {}) {
  const attentionWindowMs = options.attentionWindowMs || DEFAULT_ATTENTION_WINDOW_MS;
  const dir = findSessionsDir();
  if (!dir) {
    return { error: "Could not locate Claude session files.", sessions: [] };
  }
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith("local_") && f.endsWith(".json"));
  } catch (err) {
    return { error: `Failed to read sessions dir: ${err.message}`, sessions: [] };
  }
  const sessions = [];
  for (const file of files) {
    const meta = readMeta(path.join(dir, file));
    if (!meta || !meta.sessionId) {
      continue;
    }
    sessions.push(buildSession(meta, attentionWindowMs));
  }
  return { error: null, sessions };
}

/**
 * Attaches Jot work info to each session and computes an attentionScore that
 * blends conversation status with how much open work sits in the matched Jot
 * list. Also flags whether a session belongs in the attention spotlight.
 */
export function enrichWithJot(sessions, jotIndex, weightsOverride = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...weightsOverride };
  for (const session of sessions) {
    const cat = jotIndex.matchByTitle(session.title, session.sessionId);
    if (cat) {
      session.jot = {
        category: cat.name,
        color: cat.color,
        open: cat.open,
        inProgress: cat.inProgress,
        review: cat.review,
      };
    } else {
      session.jot = null;
    }

    let score = 0;
    if (session.status === "waiting") {
      score += weights.waiting;
    } else if (session.status === "active") {
      score += weights.active;
    }
    if (session.jot && session.status !== "archived") {
      score += session.jot.review * weights.review;
      score += session.jot.inProgress * weights.inProgress;
      score += session.jot.open * weights.open;
    }
    session.attentionScore = score;

    // Spotlight: genuine "your turn" signals — an open conversation loop, a
    // running turn, or Jot work that is yours to act on (review / in-progress).
    session.needsAttention =
      session.status !== "archived" &&
      (session.status === "waiting" ||
        session.status === "active" ||
        (session.jot && (session.jot.review > 0 || session.jot.inProgress > 0)));
  }
  return sessions;
}

function readMeta(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSession(meta, attentionWindowMs) {
  // The transcript file is named by cliSessionId; fall back to the bare
  // sessionId (true for early sessions where the two coincided).
  const transcriptIds = [meta.cliSessionId, meta.sessionId];
  const lastRole = readLastMessageRole(transcriptIds);
  const lastActivityAt = meta.lastActivityAt || meta.lastFocusedAt || meta.createdAt || 0;
  const status = deriveStatus({
    lastRole,
    lastActivityAt,
    isArchived: !!meta.isArchived,
    attentionWindowMs,
  });
  return {
    sessionId: meta.sessionId,
    title: meta.title || "(untitled)",
    cwd: meta.cwd || "",
    model: meta.model || "",
    effort: meta.effort || "",
    permissionMode: meta.permissionMode || "",
    completedTurns: meta.completedTurns || 0,
    isArchived: !!meta.isArchived,
    lastActivityAt,
    createdAt: meta.createdAt || 0,
    lastRole,
    status,
  };
}

/**
 * Status heuristic (no official "needs attention" flag exists in the files):
 *   - active: the last message is from the user AND activity is very recent,
 *     i.e. a turn is likely in progress right now.
 *   - waiting: the last message is from the assistant AND activity is within
 *     the attention window — an open loop genuinely awaiting your reply.
 *     Older assistant-ended sessions are parked, so they fall through to idle.
 *   - idle: anything else (parked, old, or indeterminate).
 */
function deriveStatus({ lastRole, lastActivityAt, isArchived, attentionWindowMs }) {
  if (isArchived) {
    return "archived";
  }
  const age = Date.now() - lastActivityAt;
  if (lastRole === "user" && age < ACTIVE_WINDOW_MS) {
    return "active";
  }
  if (lastRole === "assistant" && age < attentionWindowMs) {
    return "waiting";
  }
  return "idle";
}

/**
 * Reads only the tail of the transcript and returns the role ("user" |
 * "assistant") of the last real message line, ignoring metadata event lines.
 */
function readLastMessageRole(transcriptIds) {
  const transcriptPath = findTranscriptPath(transcriptIds);
  if (!transcriptPath) {
    return null;
  }
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        // Likely a partial first line from the tail window; skip it.
        continue;
      }
      if (obj && (obj.type === "user" || obj.type === "assistant")) {
        return obj.type;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
