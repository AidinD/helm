import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  findSessionsDir,
  findTranscriptPath,
  encodeProjectDir,
  projectsRoot,
  sessionStoreStatus,
  sessionStoreUnavailableMessage,
} from "./paths.js";
import { loadConfig } from "./config.js";
import { writeFileAtomicSync } from "./atomicWrite.js";

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
 * A missing Desktop store is REPORTED, not folded into an empty list - but this runs on
 * the 30-second poll, so it is said once per distinct state instead of every tick. The
 * returned `desktopStore` field carries the same fact to every caller on every read;
 * this log line exists so the fact is not lost when a caller drops the field.
 */
let lastReportedStoreState = "";
function reportUnavailableStore(status) {
  const key = `${status.reason}:${status.root}`;
  if (key === lastReportedStoreState) {
    return;
  }
  lastReportedStoreState = key;
  console.warn(`[helm] ${sessionStoreUnavailableMessage(status)}`);
}

/**
 * Reads every session's metadata file and derives a normalized status.
 * Pure read; never writes to the app's files.
 *
 * TWO INDEPENDENT STORES, and neither one's absence may take out the other. The Claude
 * Desktop app's local_*.json files are one; `config.helmSessions` - Helm's own record of
 * the sessions IT launched, which by design never get a Desktop metadata file - is the
 * other. This function used to return early the moment the Desktop store could not be
 * located, which meant a machine with no Claude Desktop data got an empty list and the
 * string "Could not locate Claude session files." even though Helm's own index was sitting
 * right there with sessions in it. That is a brand-new user's machine exactly: install
 * Helm, start a session in Helm, and the session Helm is running is invisible in Direct
 * and Fleet forever. Found by scripts/e2e/test-helm-session-index.mjs and
 * test-archive-overlay.mjs failing on a CI runner with no Claude installation while
 * passing on a developer machine - the tests were right and the app was wrong.
 *
 * So: the Desktop half degrades to "no Desktop sessions" and reports itself through
 * `desktopStore` (see sessionStoreStatus), and `error` is reserved for a store that is
 * there and cannot be READ - a real failure, as opposed to a store that legitimately
 * does not exist on this machine.
 */
export function readAllSessions(options = {}) {
  const attentionWindowMs = options.attentionWindowMs || DEFAULT_ATTENTION_WINDOW_MS;
  const desktopStore = sessionStoreStatus();
  let error = null;
  let files = [];
  if (desktopStore.available) {
    try {
      files = fs.readdirSync(desktopStore.dir).filter((f) => f.startsWith("local_") && f.endsWith(".json"));
    } catch (err) {
      // The directory is there and unreadable: a permissions or I/O fault, not an absent
      // app. That IS an error, and it does not stop Helm's own index from being listed.
      error = `Failed to read sessions dir: ${err.message}`;
    }
  } else {
    reportUnavailableStore(desktopStore);
  }
  // Helm-owned archive overlay: sessionIds Helm has archived, kept in its own
  // config on D:\ (NOT the desktop app's local_*.json, which that app owns and
  // rewrites - dropping an isArchived we'd written there = the "archive keeps
  // coming back" bug). A listed id is archived no matter what the desktop file
  // says. Applied to `meta` BEFORE buildSession so the derived status reflects
  // it too. options.archivedSessions lets tests inject without real config.
  let archivedList = options.archivedSessions;
  if (!archivedList) {
    try {
      archivedList = loadConfig().archivedSessions || [];
    } catch {
      archivedList = [];
    }
  }
  const archivedSet = new Set(archivedList);
  const applyArchiveOverlay = (meta) => {
    if (archivedSet.has(meta.sessionId) || (meta.cliSessionId && archivedSet.has(meta.cliSessionId))) {
      meta.isArchived = true;
    }
    return meta;
  };

  const sessions = [];
  for (const file of files) {
    const meta = readMeta(path.join(desktopStore.dir, file));
    if (!meta || !meta.sessionId) {
      continue;
    }
    sessions.push(buildSession(applyArchiveOverlay(meta), attentionWindowMs));
  }

  // Merge Helm-owned sessions. launcher.js starts every Helm session via a
  // headless `claude -p`, which writes the transcript (so status/last-role
  // still derive correctly below) but NEVER a Desktop local_*.json - so these
  // sessions have no Desktop metadata and were invisible here. They live in
  // config.helmSessions instead (see config.js). A Desktop file WINS on any id
  // collision (e.g. a Desktop session later resumed through Helm), so a session
  // is never listed twice. options.helmSessions lets tests inject a controlled
  // map without touching the real config.
  let helmSessions = options.helmSessions;
  if (!helmSessions) {
    try {
      helmSessions = loadConfig().helmSessions || {};
    } catch {
      helmSessions = {};
    }
  }
  const seenIds = new Set();
  for (const s of sessions) {
    seenIds.add(s.sessionId);
    if (s.cliSessionId) {
      seenIds.add(s.cliSessionId);
    }
  }
  for (const meta of Object.values(helmSessions)) {
    if (!meta || !meta.sessionId) {
      continue;
    }
    if (seenIds.has(meta.sessionId) || (meta.cliSessionId && seenIds.has(meta.cliSessionId))) {
      continue;
    }
    sessions.push(buildSession(applyArchiveOverlay(meta), attentionWindowMs));
  }

  // Ownership (Epic f3d096fa, the design's "hybrid" caveat): Helm only knows the
  // real lifecycle of sessions it LAUNCHED. For those, tracked signals (the live
  // registry, launch events) are authoritative; for a foreign Desktop session it
  // has nothing but the transcript heuristic. Marking it here makes that split
  // explicit instead of leaving every surface to assume the heuristic is truth.
  //
  // Keyed on presence in config.helmSessions, not on which source won the id
  // collision - a Desktop file can win the id and the session still be ours.
  //
  // KNOWN LIMITATION: a Desktop session RESUMED through Helm does not become
  // owned. session:start records with `createIfAbsent: !resumeSessionId`, so a
  // resume never creates an entry - a deliberate earlier rule ("a resumed Desktop
  // session isn't ours to index"), but it means Helm can be running a turn for a
  // session that still reads helmOwned:false, and therefore stateSource
  // "derived". That understates Helm's authority rather than overstating it,
  // which is the safe direction, but it is not the whole truth.
  const ownedIds = new Set();
  for (const meta of Object.values(helmSessions)) {
    if (meta?.sessionId) {
      ownedIds.add(meta.sessionId);
    }
    if (meta?.cliSessionId) {
      ownedIds.add(meta.cliSessionId);
    }
  }
  for (const s of sessions) {
    s.helmOwned = ownedIds.has(s.sessionId) || (!!s.cliSessionId && ownedIds.has(s.cliSessionId));
  }

  // `desktopStore` is part of the answer, not a debug extra: without it an empty
  // `sessions` array cannot be told apart from "the Claude Desktop app has never run
  // here", and any surface that renders the count would state the second as the first.
  //
  // The sentence travels WITH the status rather than being rebuilt by each surface. A
  // surface that has to import a message helper to explain a field is a surface that
  // will ship the field and forget the sentence, which is the same silence in a new
  // place; and this payload already crosses a process boundary (worker -> main -> the
  // renderer), where only plain data survives.
  return {
    error,
    sessions,
    desktopStore: { ...desktopStore, message: sessionStoreUnavailableMessage(desktopStore) },
  };
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
      // Shared atomic write with the transient-lock retry (task efcaf486). This one is
      // the most contended of the lot: it writes into the Desktop app's OWN live
      // session file, so the other app really can be holding it - which is exactly the
      // case the private rename dropped. Compact JSON, matching the app's own format,
      // so this write doesn't needlessly reformat a file another app owns.
      const res = writeFileAtomicSync(filePath, JSON.stringify(freshMeta));
      if (!res.ok) {
        return { ok: false, error: `Failed to write session file: ${res.error}` };
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
  let cutAt = -1;
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
  // The caller counts against the RENDERED turns it has on screen, which can include
  // a message sent moments ago that this file has not been written to yet (marked
  // `pending` in the renderer - see wireEditableUserTurns). Forking on a message
  // that isn't on disk here found no match above (cutAt never set) - silently
  // "succeeding" with the untouched whole file used to look like rewind quietly did
  // nothing, rather than the real reason (Jot 19096e2c). Fail loudly instead so it
  // surfaces as a toast, not a no-op.
  if (cutAt < 0) {
    return { ok: false, error: "That message hasn't been written to the transcript yet - try again in a moment." };
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
  // An ARCHIVED session's transcript is not read at all. deriveStatus returns "archived"
  // before it looks at lastRole, and nothing outside this file reads the field - so every
  // byte of that read was already being thrown away. It is not a rounding error: 80 of the
  // 90 sessions on the captain's machine are archived, and this ran on the 30-second poll.
  const lastRole = meta.isArchived ? null : readLastMessageRole(transcriptIds);
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
    // "auto" for an auto-captain run, null for anything the captain started. Read
    // by the Fleet's Auto column, which had no way to tell the two apart before.
    startedBy: meta.startedBy || null,
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
 * The last answer per transcript file, keyed on the file's own mtime+size.
 *
 * A transcript only gains a last message when it is WRITTEN to, so an unchanged file has
 * an unchanged answer - and re-deriving it means reading and UTF-8-decoding 96KB from
 * disk. On the 30-second poll that was 2.4MB of reading per tick to learn nothing, and
 * the sessions it was learning nothing about are the overwhelming majority: 85 of the captain's
 * 90 had no activity in 24 hours.
 *
 * Keyed on mtime AND size, not mtime alone: a filesystem timestamp can have coarse
 * resolution, and two writes inside the same tick would otherwise look identical. Both
 * changing is what the append this cares about always does.
 *
 * Bounded by the number of transcript files that exist, which is the same set the caller
 * is iterating anyway, and entries are replaced rather than accumulated per session - so
 * this cannot grow without bound in the long-lived worker process it now runs in.
 */
const lastRoleCache = new Map(); // transcriptPath -> { mtimeMs, size, role }

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
    const cached = lastRoleCache.get(transcriptPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === size) {
      // The fstat already cost us the open; the 96KB read and decode is what this skips.
      fs.closeSync(fd);
      fd = undefined;
      return cached.role;
    }
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    let role = null;
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
        role = obj.type;
        break;
      }
    }
    // A null answer is cached too. "This transcript's tail holds no user/assistant line"
    // is just as expensive to work out as a positive answer and just as stable, and NOT
    // caching it would leave exactly the oldest, least interesting files being re-read in
    // full on every single poll.
    lastRoleCache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size, role });
    return role;
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
