import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  deadline: 80, // MAX boost for a category's nearest deadline, scaled by urgency (see deadlineBoost)
};

// Tiered urgency boost from how soon (or how overdue) a session's matched Jot
// category's nearest deadline is. A hard deadline bearing down is a genuine
// "look at this" signal comparable to an open conversation loop, so overdue
// gets the full weight; it decays as the deadline recedes and is zero past a
// week out (a deadline that far off shouldn't reorder your board yet).
function deadlineBoost(nearestDeadline, maxWeight, now) {
  if (typeof nearestDeadline !== "number") {
    return 0;
  }
  const msLeft = nearestDeadline - now;
  const DAY = 24 * 60 * 60 * 1000;
  if (msLeft < 0) {
    return maxWeight; // overdue — most urgent
  }
  if (msLeft < DAY) {
    return maxWeight * 0.75;
  }
  if (msLeft < 3 * DAY) {
    return maxWeight * 0.45;
  }
  if (msLeft < 7 * DAY) {
    return maxWeight * 0.2;
  }
  return 0;
}

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
  const now = Date.now();
  for (const session of sessions) {
    const cat = jotIndex.matchByTitle(session.title, session.sessionId);
    if (cat) {
      session.jot = {
        category: cat.name,
        color: cat.color,
        open: cat.open,
        inProgress: cat.inProgress,
        review: cat.review,
        nearestDeadline: cat.nearestDeadline ?? null,
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
      score += deadlineBoost(session.jot.nearestDeadline, weights.deadline, now);
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

/**
 * Flips isArchived on a session's own local_*.json file — the one write this
 * module performs against the desktop app's live state, and only ever in
 * response to an explicit user action (a manual "Archive" click, or an
 * orchestrator-proposed suggestion the user approved), never automatically.
 */
export function setSessionArchived(sessionId, archived) {
  const dir = findSessionsDir();
  if (!dir) {
    return { ok: false, error: "Could not locate Claude session files." };
  }
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith("local_") && f.endsWith(".json"));
  } catch (err) {
    return { ok: false, error: `Failed to read sessions dir: ${err.message}` };
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    const scanMeta = readMeta(filePath);
    if (!scanMeta || scanMeta.sessionId !== sessionId) {
      continue;
    }
    try {
      // Re-reads right before writing, rather than reusing the copy from the
      // directory scan above — the desktop app owns this file and could still
      // be flushing a turn to it (idle sessions aren't guaranteed quiescent).
      // This can't fully eliminate the race, but shrinks the window from "the
      // whole scan" to "one read + one write," and only ever touches
      // isArchived instead of writing back a possibly-stale full object.
      const freshMeta = readMeta(filePath) || scanMeta;
      freshMeta.isArchived = archived;
      // Matches the app's own compact (non-pretty-printed) format, so this
      // write doesn't needlessly reformat a file another app owns.
      //
      // Written via a temp file + rename rather than a direct writeFileSync
      // (which truncates the file before writing the new content). A crash,
      // full disk, or killed process mid-write would leave the desktop
      // app's OWN session file half-written and unparseable — this is the
      // one place Maestro mutates another app's live state, so a torn write
      // there is a real risk, not a theoretical one. fs.renameSync is
      // atomic when the temp file is on the same volume (same directory),
      // so the real file is always either fully the old content or fully
      // the new content, never a partial mix of both.
      const tmpPath = path.join(dir, `.${file}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(freshMeta), "utf8");
        fs.renameSync(tmpPath, filePath);
      } catch (err) {
        // Don't leave a stray .tmp file sitting in the desktop app's own
        // session directory if the rename step is what failed.
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // best-effort; the write itself already failed, this is just cleanup
        }
        throw err;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Failed to write session file: ${err.message}` };
    }
  }
  return { ok: false, error: "Session file not found." };
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
    // The claude CLI's --resume flag needs cliSessionId (the transcript
    // filename), not the desktop app's local_ sessionId — they only
    // coincide for early sessions. Fall back to sessionId when absent.
    cliSessionId: meta.cliSessionId || meta.sessionId,
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
