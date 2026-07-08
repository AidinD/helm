import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findSessionsDir, findTranscriptPath, encodeProjectDir, projectsRoot } from "./paths.js";

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
    const cat = jotIndex.matchByTitle(session.title, session.sessionId, session.cwd);
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
/**
 * Shared safe-mutation path for the desktop app's OWN local_<uuid>.json
 * session metadata — the one place Helm writes into another app's live
 * state, so every caller goes through this same careful sequence: find the
 * file by sessionId, re-read it fresh right before writing (the desktop app
 * could still be flushing a turn to it — this can't fully eliminate the
 * race, but shrinks the window from "the whole directory scan" to "one read
 * + one write"), apply `patchFn` to just the fields it needs, then write via
 * a temp file + atomic rename rather than a direct writeFileSync (which
 * truncates before writing the new content — a crash/full-disk/killed
 * process mid-write would otherwise leave the desktop app's OWN session file
 * half-written and unparseable; fs.renameSync on the same volume is atomic,
 * so the real file is always either fully old or fully new, never a torn
 * mix). `patchFn(freshMeta)` mutates the object in place.
 */
function patchSessionMeta(sessionId, patchFn) {
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
      const freshMeta = readMeta(filePath) || scanMeta;
      patchFn(freshMeta);
      // Matches the app's own compact (non-pretty-printed) format, so this
      // write doesn't needlessly reformat a file another app owns.
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

export function setSessionArchived(sessionId, archived) {
  return patchSessionMeta(sessionId, (meta) => {
    meta.isArchived = archived;
  });
}

/**
 * "Rewind to here": creates a forked session transcript containing the
 * conversation UP TO (not including) the user message at `userMsgIndex`
 * (0-based, counting only real user-typed messages — string content, not
 * tool_results), and returns its new cliSessionId. Resuming that id via the
 * CLI continues from the truncated history — everything after the rewind
 * point is genuinely dropped, not just hidden (verified in
 * spike/test-rewind-fork.mjs: `claude --resume` reads a hand-authored
 * truncated transcript with no desktop metadata, and post-truncation turns
 * are gone from the model's context).
 *
 * Writes a new <uuid>.jsonl beside the original in the same projects dir —
 * never touches the original transcript. The fork has no desktop local_*.json
 * metadata, so it won't show in the sidebar's session list until (if ever)
 * the desktop app records it; it's a working branch, resumable by id.
 */
export function forkTranscriptAtUserMessage(cliSessionId, userMsgIndex) {
  const transcriptPath = findTranscriptPath([cliSessionId]);
  if (!transcriptPath) {
    return { ok: false, error: "Transcript not found for that session." };
  }
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim());
  } catch (err) {
    return { ok: false, error: `Failed to read transcript: ${err.message}` };
  }
  // Find the line where the userMsgIndex-th real user message begins; keep
  // everything before it. A rendered "turn" spans several jsonl lines
  // (user line, assistant thinking/tool_use/text lines, tool_result lines),
  // so we anchor on the user-message lines.
  //
  // CRITICAL: this must count EXACTLY what renders as a ".turn.user
  // .turn-bubble" in the UI — because the rewind button passes its index
  // among those bubbles. transcript.js's pushUserTurn only emits a
  // user/text turn when the string content is non-empty AND does NOT start
  // with "<task-notification>" (a subagent-completion notification, which it
  // routes to a system turn instead). Counting those here would desync the
  // index and truncate at the WRONG message in any session that ran a
  // background task — so mirror pushUserTurn's exact conditions.
  const isRenderedUserMessage = (obj) => {
    if (obj.type !== "user" || typeof obj.message?.content !== "string") {
      return false;
    }
    const trimmed = obj.message.content.trim();
    return trimmed !== "" && !trimmed.startsWith("<task-notification>");
  };
  let userIdx = -1;
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isRenderedUserMessage(obj)) {
      userIdx += 1;
      if (userIdx === userMsgIndex) {
        cutAt = i;
        break;
      }
    }
  }
  const truncated = lines.slice(0, cutAt);
  const forkId = crypto.randomUUID();
  const forkPath = path.join(path.dirname(transcriptPath), `${forkId}.jsonl`);
  try {
    fs.writeFileSync(forkPath, truncated.join("\n") + "\n", "utf8");
  } catch (err) {
    return { ok: false, error: `Failed to write fork transcript: ${err.message}` };
  }
  return { ok: true, forkId };
}

/**
 * "Switch root folder": lets a session continue in a DIFFERENT working
 * directory than the one it was created in. `claude --resume` scopes its own
 * session lookup by cwd — verified in spike/test-cwd-switch.mjs that
 * resuming from a different folder fails outright with "No conversation
 * found with session ID," even though Helm's own findTranscriptPath
 * searches every project dir. The fix, also spike-verified
 * (spike/test-cwd-switch-copy.mjs): copy the transcript into the TARGET
 * folder's own encoded project directory (same id, so --resume from there
 * finds it) — the exact same "copy the transcript to make --resume work
 * somewhere new" trick already used by the rewind-to-here fork, just copying
 * into a different project dir instead of a new file in the same one.
 *
 * Copies rather than moves: the original stays fully intact and resumable
 * from its original folder, matching every other "branch, don't destroy"
 * operation in this codebase (rewind, archive, hide).
 *
 * ALSO patches the desktop app's own local_<uuid>.json metadata (`cwd`
 * field) via patchSessionMeta — caught live (the captain tested this exact thing):
 * `session.cwd` (what the sidebar/pane read every time a session is opened,
 * see buildSession in this file) comes ONLY from that metadata file, never
 * from the transcript itself. Copying the transcript alone made --resume
 * WORK once, but the switch didn't stick: opening the session again (even
 * right after a successful send from the new folder) re-read the metadata's
 * still-OLD cwd and silently reverted. Without this patch, "switch root
 * folder" would only ever be a one-shot fix for the CURRENT message, not an
 * actual durable change to where Helm considers the session rooted.
 */
export function switchSessionRootFolder(cliSessionId, sessionId, newCwd) {
  const transcriptPath = findTranscriptPath([cliSessionId, sessionId]);
  if (!transcriptPath) {
    return { ok: false, error: "Transcript not found for that session." };
  }
  const targetDir = path.join(projectsRoot, encodeProjectDir(newCwd));
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Failed to create target project folder: ${err.message}` };
  }
  const targetPath = path.join(targetDir, path.basename(transcriptPath));
  // Only copy if not ALREADY rooted there (picking the same folder again) —
  // but the metadata patch below still needs to run regardless, since an
  // old switch performed before this patch existed could have a correctly-
  // located transcript with still-stale metadata.
  if (path.resolve(targetPath) !== path.resolve(transcriptPath)) {
    try {
      fs.copyFileSync(transcriptPath, targetPath);
      // fs.copyFileSync PRESERVES the source's mtime on the copy (verified —
      // Windows CopyFileW behavior carries through Node) — without this, the
      // fresh copy ties with the original on mtime, and findTranscriptPath's
      // "most recently modified wins" tie-break would inconsistently still
      // pick the OLD copy depending on directory-listing order (caught before
      // shipping: a standalone test found this exact failure). Explicitly
      // bumping the copy's mtime to now makes it unambiguously the winner.
      const now = new Date();
      fs.utimesSync(targetPath, now, now);
    } catch (err) {
      return { ok: false, error: `Failed to copy transcript: ${err.message}` };
    }
  }
  if (sessionId) {
    const metaRes = patchSessionMeta(sessionId, (meta) => {
      meta.cwd = newCwd;
    });
    if (!metaRes.ok) {
      // The transcript-level switch still succeeded (--resume will work from
      // the new folder for THIS session) — only the "stick on next open"
      // part failed, worth surfacing but not worth failing the whole action.
      return { ok: true, warning: `Folder switched, but couldn't persist it for next time: ${metaRes.error}` };
    }
  }
  return { ok: true };
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
