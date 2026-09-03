// The assistant seat's own two files, and nothing else (DECISIONS.md 2026-09-02,
// "An assistant seat is not a first mate with a different manual").
//
// WHY THIS EXISTS AT ALL. The assistant seat runs on the first-mate tier, whose
// PreToolUse hook denies Edit/Write/NotebookEdit and every non-read-only shell
// command BY TOOL, with no notion of a path anywhere in it. The seat's main
// output is "something he said, written down in the same turn", so on that tier
// it could not write its own daily log or the goals file it is the sole scribe
// of. Both routes out were on the table and the path-aware guard LOST: in one of
// the personal stores a note carrying the wrong tag silently resets a cadence and
// turns an overdue duty green, and a destination-aware guard would allow that
// write - the file is in an allowed root - with no error anywhere. Only a store
// with its own surface can refuse the invalid write. So this module holds the
// invariants, not just the file paths.
//
// WHY THE TOOL SET IS THIS SMALL. There is deliberately NO general file write.
// A `write_file(path, contents)` tool would put us straight back in the problem
// the decision above rejected: a path argument that the seat can point anywhere,
// enforced by a prefix check instead of by the store's own rules. Five tools,
// each of which knows exactly which file it touches, is the whole point.
//
// The pure logic lives here and the stdio JSON-RPC loop lives in
// assistantStoreServer.js, mirroring how helmDispatchServer.js separates its tool
// implementations from its transport - except that this half is exported, because
// the refusals are the part worth testing directly rather than only through a
// spawned process (scripts/e2e/test-assistant-store.mjs drives both).
import fs from "node:fs";
import path from "node:path";
import { isTransientLock, MAX_ATTEMPTS, backoffMs, sleepSync } from "keel/storage";
import { writeFileAtomicSync } from "../lib/atomicWrite.js";
import { normalizeFsPath } from "../lib/fsPath.js";
import { resolveMetaHome } from "../lib/metaHome.js";

// Per-day text budget in `changesSince`. A single real day already runs to 11KB
// of prose, so a wide window would otherwise hand the seat a small book on the
// first call of the morning. Truncated days are FLAGGED, with the tool to call
// for the rest, rather than silently shortened.
const DAY_TEXT_BUDGET = 12000;

// How far back `changesSince` will enumerate the gaps in the record day by day.
// The present days always come from one readdir, so a wide window still works;
// this only bounds the "which days have no log at all" list, which is worth
// having for a week and meaningless for a year.
const MISSING_DAY_WINDOW = 60;

// A whole-document write that drops more than this much of the existing goals
// file is refused unless the caller says it means it. See writeGoals.
const SHRINK_FLOOR = 0.5;

// Dated lines returned from GOALS.md by changesSince. A goals file that produces
// more than this many is not being read, it is being dumped.
const MAX_GOAL_MENTIONS = 40;

/**
 * Where the assistant seat's folder is.
 *
 * `HELM_ASSISTANT_STORE_DIR` is the test/relocation seam, named the way every
 * other store's seam is (HELM_CONFIG_PATH, HELM_IMAGES_DIR - see
 * src/lib/packagedPaths.js). The E2E check points it at a temp fixture so the
 * suite never touches the real store: this one is not a JSON file that can be
 * regenerated, it is his goals and the seat's memory.
 *
 * The default is derived, not hardcoded. resolveMetaHome() reads the
 * `~/.claude/CLAUDE.md` stub's import line and takes its directory, which is the
 * Dropbox-synced folder the seat is rooted in; the assistant folder is `assistant`
 * inside it. Hardcoding a drive letter would have been wrong on the machine where
 * Dropbox lives under the user profile instead of D:.
 *
 * NOT registered in packagedPaths.js, deliberately. That file exists because a
 * store's dev default resolves inside the read-only app bundle once packaged.
 * This default is an absolute path outside the bundle either way, so it resolves
 * identically in dev and installed - and adding a redirect would point the
 * installed app at an empty folder in ~/.helm, which is the opposite of the fix.
 */
export function resolveStoreDir() {
  const fromEnv = (process.env.HELM_ASSISTANT_STORE_DIR || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(resolveMetaHome(), "assistant");
}

/** The goals file: the only place his own goals live. */
export function goalsFile(dir) {
  return path.join(dir, "GOALS.md");
}

/** The daily log directory - one `YYYY-MM-DD.md` per day, matching the real store. */
export function logDir(dir) {
  return path.join(dir, "log");
}

/**
 * Is `day` a real calendar day in the exact `YYYY-MM-DD` shape the log uses?
 *
 * Strict on purpose, and it REFUSES rather than normalising. Normalising is how a
 * traversal gets through: `path.resolve` happily turns `../../CLAUDE.md` into a
 * real path, and a resolver that repairs its input cannot tell a typo from an
 * escape attempt. The only thing this store accepts as a day is a day.
 *
 * The round-trip through Date is what rejects `2026-13-45` - the regex alone
 * would take it, and a file named after an impossible date is a silent hole in
 * the record rather than an error anybody sees.
 */
export function isValidDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const [y, m, d] = day.split("-").map((n) => Number(n));
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * Is `candidate` a file sitting DIRECTLY inside `parent`?
 *
 * The second layer of the traversal refusal, and it is not redundant. isValidDay
 * is the gate a caller meets; this is the gate the filesystem meets, so a future
 * tool that builds a path from something looser than a day still cannot leave the
 * log folder. Both spellings are folded through normalizeFsPath first because
 * Windows paths are case-insensitive and mix separators, so `D:\...\log` and
 * `d:/.../log` are the same folder and a raw string compare would miss (the same
 * mismatch that made every path-keyed cache in this repo miss on 2026-08-12).
 *
 * Direct child, not "somewhere underneath": the log is flat, so a nested path is
 * already not a log file.
 */
export function isDirectChildOf(parent, candidate) {
  const parentNorm = normalizeFsPath(parent);
  const candidateNorm = normalizeFsPath(candidate);
  if (!parentNorm || !candidateNorm) {
    return false;
  }
  if (!candidateNorm.startsWith(parentNorm + "/")) {
    return false;
  }
  return normalizeFsPath(path.dirname(candidate)) === parentNorm;
}

/**
 * Resolves one day's log file, or refuses.
 *
 * Returns `{ file }` or `{ error }` - never a repaired path. The error names what
 * was passed so the seat can correct itself in the same turn instead of guessing.
 */
export function resolveDayFile(dir, day) {
  if (!isValidDay(day)) {
    return {
      error:
        `\`date\` must be one calendar day in YYYY-MM-DD form (got ${JSON.stringify(day)}). ` +
        "This store holds one file per day and nothing else, so anything that is not a day is refused rather than interpreted.",
    };
  }
  const logs = logDir(dir);
  const file = path.resolve(logs, `${day}.md`);
  if (!isDirectChildOf(logs, file)) {
    return { error: `Refused: ${JSON.stringify(day)} resolves outside the assistant log folder.` };
  }
  return { file };
}

/** Local calendar day as `YYYY-MM-DD`. Local, because the log is his day, not UTC's. */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function isoOrNull(stat) {
  return stat ? new Date(stat.mtimeMs).toISOString() : null;
}

/** Every day that actually has a log file, newest last. One readdir, not a per-day probe. */
function presentDays(dir) {
  let names = [];
  try {
    names = fs.readdirSync(logDir(dir));
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .map((n) => n.slice(0, -3))
    .filter((d) => isValidDay(d))
    .sort();
}

function nextDay(day) {
  const [y, m, d] = day.split("-").map((n) => Number(n));
  const probe = new Date(Date.UTC(y, m - 1, d + 1));
  const mm = String(probe.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(probe.getUTCDate()).padStart(2, "0");
  return `${probe.getUTCFullYear()}-${mm}-${dd}`;
}

// --- goals -----------------------------------------------------------------

/** Reads GOALS.md whole. `modifiedAt` is what write_goals wants back as `ifUnchangedSince`. */
export function readGoals() {
  const dir = resolveStoreDir();
  const file = goalsFile(dir);
  const stat = statOrNull(file);
  if (!stat) {
    return {
      path: file,
      exists: false,
      content: "",
      modifiedAt: null,
      note: "GOALS.md does not exist yet. Writing it creates it - but seed it from what he has actually said, not from inference, and mark inferred lines.",
    };
  }
  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { error: `Could not read ${file}: ${err?.message || String(err)}` };
  }
  return { path: file, exists: true, content, bytes: content.length, modifiedAt: isoOrNull(stat) };
}

/**
 * Replaces GOALS.md with `content`.
 *
 * WHOLE DOCUMENT on purpose. A patch-shaped tool (find/replace, insert-at-line)
 * needs the caller to already know the exact current text, which is the state a
 * disposable session cannot be trusted to hold - and a mis-anchored patch to a
 * goals file corrupts it in a way nobody notices until the file is consulted and
 * is wrong. Re-reading and re-writing the whole thing is the honest shape.
 *
 * The cost of that shape is the failure mode this refuses: a rewrite that drops
 * half the document. That is the store-specific invariant a destination-aware
 * guard could never have enforced - the write is in an allowed folder, so nothing
 * would have complained. Three checks, all of which name the numbers:
 *
 *   - empty or whitespace-only is always refused (there is no legitimate "clear
 *     his goals" operation, and `done is a joint decision` applies to his own
 *     goals too);
 *   - no top-level `# ` heading means the document lost its own shape;
 *   - shrinking past SHRINK_FLOOR needs `allowShrink: true`, so deleting a
 *     section stays possible but has to be deliberate.
 *
 * Rejected: keeping snapshots of every version to make the shrink recoverable.
 * The seat's own verdict was that a diff is worth more to it than any additional
 * storage, and a revision folder inside a Dropbox-synced store is a second thing
 * to keep consistent for a case the guard above already prevents.
 *
 * `ifUnchangedSince` is the optional lost-update guard: pass the `modifiedAt` from
 * read_goals and the write aborts if the file moved underneath you. It runs through
 * the atomic writer's onBeforeRename hook, so it is checked immediately before the
 * rename - and under the write lock, together with the rename, which is what makes
 * it a guard rather than a narrower window. The same guard jot.js uses, for the same
 * reason (its store is edited by a live app at the same time; this one is edited by
 * hand in an editor).
 *
 * DELIBERATELY NOT RETRIED, unlike jot.js's. It is asked exactly once (this comment
 * claimed "on every retry attempt" until 2026-09-03, when the shared writer stopped
 * spinning on a refusal). Retrying would mean re-reading and re-applying, and there
 * is nothing to re-apply here: the content is a whole document composed upstream
 * against the version the caller read, so a fresh read invalidates the write rather
 * than rebasing it. Refusing and making the caller re-read is the only correct
 * answer for this store.
 */
export function writeGoals(args = {}) {
  const dir = resolveStoreDir();
  const file = goalsFile(dir);
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) {
    return { error: "Refused: `content` is empty. This tool replaces the whole goals document, and there is no reason to blank it." };
  }
  if (!/^#\s+\S/m.test(content)) {
    return {
      error:
        "Refused: the document has no top-level `# ` heading, which means the rewrite lost its own shape. " +
        "Read it with assistant_read_goals, edit that text, and send the whole thing back.",
    };
  }
  const before = statOrNull(file);
  const beforeIso = isoOrNull(before);
  if (typeof args.ifUnchangedSince === "string" && args.ifUnchangedSince.trim()) {
    if (args.ifUnchangedSince.trim() !== beforeIso) {
      return {
        error:
          `Refused: GOALS.md changed since you read it (you saw ${args.ifUnchangedSince.trim()}, it is now ${beforeIso || "missing"}). ` +
          "Re-read it and re-apply your change, or your write would silently drop whoever edited it.",
      };
    }
  }
  if (before && !args.allowShrink) {
    const beforeBytes = before.size;
    if (beforeBytes > 0 && content.length < beforeBytes * SHRINK_FLOOR) {
      return {
        error:
          `Refused: this write would cut GOALS.md from ${beforeBytes} to ${content.length} characters. ` +
          "That is the shape of a rewrite that dropped sections rather than an edit. " +
          "Re-read the file and send back the whole document, or pass allowShrink:true if you really are deleting that much - and say so in the reply.",
      };
    }
  }
  const body = content.endsWith("\n") ? content : content + "\n";
  const res = writeFileAtomicSync(file, body, {
    onBeforeRename: () => {
      if (typeof args.ifUnchangedSince !== "string" || !args.ifUnchangedSince.trim()) {
        return null;
      }
      const now = isoOrNull(statOrNull(file));
      if (now !== args.ifUnchangedSince.trim()) {
        return `GOALS.md changed while this write was in flight (now ${now || "missing"})`;
      }
      return null;
    },
  });
  if (!res.ok) {
    return { error: `Could not write ${file}: ${res.error}` };
  }
  const after = statOrNull(file);
  return {
    ok: true,
    path: file,
    bytes: body.length,
    previousBytes: before ? before.size : 0,
    modifiedAt: isoOrNull(after),
    note: "Written. Say in your reply what changed and why - the file being current is only half of the contract.",
  };
}

// --- the daily log ---------------------------------------------------------

/**
 * Appends to one day's log without ever clobbering a concurrent append.
 *
 * DELIBERATELY NOT the atomic tmp+rename every other store here uses. A
 * tmp+rename replaces the whole file, which is the exact opposite of appending:
 * two sessions that both read, both add their paragraph and both rename leave one
 * paragraph, with nothing anywhere saying the other was lost. `appendFileSync`
 * cannot lose a sibling's line - the write goes at whatever the end of the file is
 * at the moment it lands. This is the same exemption `usage.js` and `helmUsage.js`
 * already hold, and scripts/e2e/test-atomic-write.mjs names them rather than
 * pattern-matching them, precisely so the exemption has to be argued.
 *
 * What appendFileSync does NOT get for free is the Dropbox lock retry, which the
 * shared writer only has because a sync client holding a file mid-write is the
 * normal operating condition on this machine (observed for real 2026-07-27, a
 * board update returned EPERM and the change was simply gone). So the retry is
 * reimplemented here on keel's own predicate and backoff rather than on a private
 * guess at which errno means "wait".
 *
 * The day heading is created with an EXCLUSIVE create ("wx"), not with
 * "if (!exists) write". Two processes appending to a fresh day would both see the
 * file missing and both seed it, leaving two `# 2026-09-02` headings. An exclusive
 * create makes exactly one of them win and the loser's EEXIST is the correct
 * answer, not an error.
 */
function withLockRetry(file, attempt) {
  for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
    try {
      attempt();
      return { ok: true };
    } catch (err) {
      if (err?.code === "EEXIST") {
        // Only reachable for the exclusive seed below: somebody else created the
        // day first, which is the outcome we wanted.
        return { ok: true, alreadyThere: true };
      }
      const last = n === MAX_ATTEMPTS - 1;
      if (!last && isTransientLock(err, fs.existsSync(file))) {
        sleepSync(backoffMs(n));
        continue;
      }
      return { ok: false, error: err?.message || String(err) };
    }
  }
  return { ok: false, error: "the file stayed locked" };
}

/** Creates the day's file with its `# YYYY-MM-DD` heading, or leaves the winner's alone. */
function seedDayFile(file, day) {
  return withLockRetry(file, () => fs.writeFileSync(file, `# ${day}\n`, { encoding: "utf8", flag: "wx" }));
}

/** The append itself. One call, so the write lands wherever the end of the file is. */
function appendToDayFile(file, chunk) {
  return withLockRetry(file, () => fs.appendFileSync(file, chunk, "utf8"));
}

/**
 * Appends an entry to a day's log (today unless `date` says otherwise).
 *
 * A future `date` is refused. The log is the seat's memory substitute and the
 * reason its session can be disposable, so a paragraph filed under tomorrow is
 * worse than no paragraph: "what changed since yesterday" would show work that
 * has not happened. Today's file is the default precisely so a date almost never
 * needs passing.
 */
export function appendLog(args = {}) {
  const dir = resolveStoreDir();
  const day = args.date === undefined || args.date === null || args.date === "" ? todayStamp() : args.date;
  const resolved = resolveDayFile(dir, day);
  if (resolved.error) {
    return { error: resolved.error };
  }
  if (day > todayStamp()) {
    return { error: `Refused: ${day} is in the future. The log records what happened, so an entry cannot be filed ahead of the day it happened on.` };
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) {
    return { error: "Refused: `text` is empty. An empty entry is indistinguishable from having written nothing, which is the failure mode the log exists to prevent." };
  }
  const heading = typeof args.heading === "string" ? args.heading.trim() : "";
  try {
    fs.mkdirSync(logDir(dir), { recursive: true });
  } catch (err) {
    return { error: `Could not create the log folder: ${err?.message || String(err)}` };
  }
  const seeded = seedDayFile(resolved.file, day);
  if (!seeded.ok) {
    return { error: `Could not start the log for ${day}: ${seeded.error}` };
  }
  const chunk = (heading ? `\n## ${heading}\n` : "") + `\n${text}\n`;
  const appended = appendToDayFile(resolved.file, chunk);
  if (!appended.ok) {
    return { error: `Could not append to the log for ${day}: ${appended.error}` };
  }
  const stat = statOrNull(resolved.file);
  return {
    ok: true,
    date: day,
    path: resolved.file,
    created: seeded.alreadyThere !== true,
    appendedChars: chunk.length,
    bytes: stat ? stat.size : null,
    note: "Appended. Say in your reply that you wrote it, in one line.",
  };
}

/** Reads one day's log (today by default). A missing day says which days DO exist. */
export function readLog(args = {}) {
  const dir = resolveStoreDir();
  const day = args.date === undefined || args.date === null || args.date === "" ? todayStamp() : args.date;
  const resolved = resolveDayFile(dir, day);
  if (resolved.error) {
    return { error: resolved.error };
  }
  const stat = statOrNull(resolved.file);
  if (!stat) {
    const days = presentDays(dir);
    return {
      date: day,
      path: resolved.file,
      exists: false,
      content: "",
      // Naming the neighbours turns "there is nothing" into "there is nothing for
      // THAT day", which are different answers and only one of them is alarming.
      availableDays: days.slice(-14),
      note: days.length === 0 ? "The log is empty - there is no record to start the day from." : `No entry for ${day}.`,
    };
  }
  let content = "";
  try {
    content = fs.readFileSync(resolved.file, "utf8");
  } catch (err) {
    return { error: `Could not read ${resolved.file}: ${err?.message || String(err)}` };
  }
  return { date: day, path: resolved.file, exists: true, content, bytes: content.length, modifiedAt: isoOrNull(stat) };
}

/**
 * What changed since a given day - a FIRST-CLASS read, not a convenience.
 *
 * The seat reconstructs its whole picture from the stores at the start of every
 * session, which is correct: the stores are the truth and its own context is not.
 * What it could not do was tell what had MOVED since it last looked, and it said
 * plainly that a diff would be worth more to it than any extra storage. Everything
 * else here is a way to read a file; this is the only tool that answers a question.
 *
 * What it can honestly report, given that this store keeps no version history:
 *
 *   - the log is already a diff. One file per day means "since Tuesday" is exactly
 *     the files from Tuesday on, so those come back in full (budgeted, flagged when
 *     truncated).
 *   - the GAPS in the log, because a day with no entry is the thing that makes a
 *     morning start blind, and it is invisible if you only list what exists.
 *   - for GOALS.md: whether the file changed inside the window at all (its mtime,
 *     which is a fact) plus the lines in it carrying a date in the window (which is
 *     the store's OWN convention - the real file writes `Confirmed 2026-09-02:` and
 *     `**Corrected 2026-09-02.**` inline). That is a lead, not a diff, and it is
 *     labelled as one: a date in the file can just as easily be a deadline or a
 *     scheduled event as a change stamp, so this
 *     over-reports rather than staying quiet. Missing a correction costs more than
 *     re-reading a line that turned out to be old news.
 *
 * `since` is INCLUSIVE. "Since yesterday" has to mean yesterday's late-evening
 * entry too: the last time the seat read that day's file, the correction written
 * after it was not there yet. Excluding the boundary day would drop exactly the
 * kind of entry the log exists to carry - the first day's log recorded three of the
 * seat's own mistakes, all of them written after the fact.
 */
export function changesSince(args = {}) {
  const dir = resolveStoreDir();
  const since = args.since;
  if (!isValidDay(since)) {
    return {
      error: `\`since\` must be one calendar day in YYYY-MM-DD form (got ${JSON.stringify(since)}). Pass the day you last looked; it is included in the answer.`,
    };
  }
  const today = todayStamp();
  const includeText = args.includeText !== false;
  if (since > today) {
    return { since, today, days: [], missingDays: [], goals: null, note: `${since} is after today (${today}), so nothing can have changed yet.` };
  }

  const present = presentDays(dir).filter((d) => d >= since && d <= today);
  const days = present.map((d) => {
    const file = path.join(logDir(dir), `${d}.md`);
    const stat = statOrNull(file);
    const entry = { date: d, path: file, bytes: stat ? stat.size : null, modifiedAt: isoOrNull(stat) };
    if (!includeText) {
      return entry;
    }
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (err) {
      return { ...entry, readError: err?.message || String(err) };
    }
    if (content.length > DAY_TEXT_BUDGET) {
      return { ...entry, text: content.slice(0, DAY_TEXT_BUDGET), truncated: true, note: `Truncated at ${DAY_TEXT_BUDGET} characters - call assistant_read_log for ${d} to get the rest.` };
    }
    return { ...entry, text: content };
  });

  // The gaps, enumerated only over a window where the list is still information.
  const missingDays = [];
  let gapsEnumerated = true;
  {
    const havePresent = new Set(present);
    let cursor = since;
    let steps = 0;
    while (cursor <= today) {
      if (steps >= MISSING_DAY_WINDOW) {
        gapsEnumerated = false;
        break;
      }
      if (!havePresent.has(cursor)) {
        missingDays.push(cursor);
      }
      cursor = nextDay(cursor);
      steps += 1;
    }
  }

  const gFile = goalsFile(dir);
  const gStat = statOrNull(gFile);
  let goals;
  if (!gStat) {
    goals = { path: gFile, exists: false, changedInWindow: false, note: "GOALS.md does not exist." };
  } else {
    const changedInWindow = todayStamp(new Date(gStat.mtimeMs)) >= since;
    let mentions = [];
    let scanError = null;
    try {
      const lines = fs.readFileSync(gFile, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && mentions.length < MAX_GOAL_MENTIONS; i += 1) {
        const found = lines[i].match(/\d{4}-\d{2}-\d{2}/g);
        if (!found) {
          continue;
        }
        const inWindow = found.filter((d) => isValidDay(d) && d >= since);
        if (inWindow.length > 0) {
          mentions.push({ line: i + 1, dates: inWindow, text: lines[i].trim() });
        }
      }
    } catch (err) {
      scanError = err?.message || String(err);
      mentions = [];
    }
    goals = {
      path: gFile,
      exists: true,
      bytes: gStat.size,
      modifiedAt: isoOrNull(gStat),
      changedInWindow,
      datedLines: mentions,
      scanError,
      note: notesForGoals(changedInWindow, mentions.length),
    };
  }

  return {
    since,
    today,
    days,
    missingDays,
    gapsEnumerated,
    goals,
    note:
      "The log days are a real diff (one file per day). GOALS.md is not versioned here, so `changedInWindow` is its file timestamp " +
      "and `datedLines` are lines carrying a date in the window - the store's own convention for marking a change, which also catches " +
      "deadlines and scheduled dates. Read them as leads, then read the file if it matters.",
  };
}

function notesForGoals(changedInWindow, mentionCount) {
  if (changedInWindow && mentionCount === 0) {
    // Worth saying out loud: the convention is to stamp the line you changed, so
    // a file that moved with nothing dated in it means the last writer skipped it
    // and there is now no way to see WHAT moved.
    return "GOALS.md changed in this window but carries no date in the window. Whoever wrote it did not stamp the line - stamp yours.";
  }
  if (!changedInWindow && mentionCount > 0) {
    return "GOALS.md has not been written in this window; the dated lines below are older text that mentions dates in it.";
  }
  if (!changedInWindow) {
    return "GOALS.md has not changed in this window.";
  }
  return "GOALS.md changed in this window; the dated lines are where to look first.";
}
