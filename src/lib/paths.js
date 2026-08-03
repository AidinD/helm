import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolves the on-disk locations that the Claude desktop app uses to store
 * session metadata and transcripts. All read-only.
 */

// The Claude desktop app is MSIX-packaged, so it writes its Roaming\Claude data
// (session metadata + desktop config) into its package's virtualized store, NOT
// the real %APPDATA%\Claude. A process running INSIDE Claude's sandbox (e.g. a
// dev Helm launched by Claude Code) sees %APPDATA%\Claude via the overlay and
// finds it populated; a STANDALONE installed Helm sees the real %APPDATA%\Claude
// which does not even exist, so it found zero sessions. Resolve the real root by
// preferring %APPDATA%\Claude when it actually has the sessions dir, else the
// physical MSIX location under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\
// Roaming\Claude (globbed so it's agnostic to the package-hash suffix). Verified
// 2026-07-11: the standalone path is Claude_pzs8sxrjxfjjc\LocalCache\Roaming\
// Claude, holding 65 real sessions.
function resolveClaudeRoot() {
  const candidates = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  candidates.push(path.join(appData, "Claude"));
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const pkgRoot = path.join(localAppData, "Packages");
  try {
    for (const entry of fs.readdirSync(pkgRoot)) {
      if (/^Claude_/i.test(entry)) {
        candidates.push(path.join(pkgRoot, entry, "LocalCache", "Roaming", "Claude"));
      }
    }
  } catch {
    // no Packages dir (non-Windows / no MSIX apps) - the %APPDATA% candidate stands
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "claude-code-sessions"))) {
      return c;
    }
  }
  return candidates[0];
}
const CLAUDE_ROOT = resolveClaudeRoot();

export const desktopConfigPath = path.join(CLAUDE_ROOT, "claude_desktop_config.json");
export const sessionsRoot = path.join(CLAUDE_ROOT, "claude-code-sessions");
// Transcripts live at the REAL ~/.claude/projects (written by the CLI, not the
// MSIX desktop app), which a standalone process can read directly - no
// virtualization fallback needed here (verified 2026-07-11).
// HELM_PROJECTS_ROOT is a TEST seam. Without it the transcript index could not be
// tested at all - the only available root was the real one, 292 directories of the
// user's own history, which a test must neither depend on nor write into. Resolved once
// at import time like every other seam in this codebase, so a test must set it BEFORE
// importing this module (ESM imports are hoisted; a static import reads the ambient
// value and the seam is silently ignored).
export const projectsRoot = process.env.HELM_PROJECTS_ROOT || path.join(os.homedir(), ".claude", "projects");

/**
 * The sessions metadata lives under a nested <accountId>/<deviceId> folder.
 * There is usually exactly one of each, but we discover them rather than
 * hardcode. Returns the directory that actually contains local_*.json files.
 */
export function findSessionsDir() {
  if (!fs.existsSync(sessionsRoot)) {
    return null;
  }
  const candidates = [];
  walkForSessionJson(sessionsRoot, candidates, 0);
  if (candidates.length === 0) {
    return null;
  }
  // Prefer the directory with the most session files (the live one).
  candidates.sort((a, b) => b.count - a.count);
  return candidates[0].dir;
}

function walkForSessionJson(dir, out, depth) {
  if (depth > 4) {
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const localCount = entries.filter(
    (e) => e.isFile() && e.name.startsWith("local_") && e.name.endsWith(".json")
  ).length;
  if (localCount > 0) {
    out.push({ dir, count: localCount });
  }
  for (const entry of entries) {
    // A symlinked directory reports isDirectory() true (following the link
    // target), so a symlink loop under this tree would keep re-walking the
    // same target on every level until the depth guard above finally saves
    // it. Skipping symlinks outright avoids that pointless re-walk — this
    // tree is app-owned, real subdirectories are never symlinks.
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walkForSessionJson(path.join(dir, entry.name), out, depth + 1);
    }
  }
}

/**
 * Locate a session's transcript .jsonl. The transcript filename is the
 * session's cliSessionId (a session may have had several over its life via
 * resumes; the caller passes the candidates in preference order). Transcripts
 * live under a project folder keyed by an encoded cwd, but we search all
 * project folders so we do not depend on the exact encoding scheme.
 */
// Mirrors the CLI's own ~/.claude/projects/<encoded-cwd>/ naming (verified
// against real project dirs, e.g. "D:\Repo\Tools\helm" ->
// "D--Repo-Tools-helm" — the colon becomes a hyphen, then every backslash
// becomes another hyphen, giving the double-hyphen right after the drive
// letter seen in practice). Used to switch a session's root folder: `claude
// --resume` scopes its lookup by cwd (verified in
// spike/test-cwd-switch.mjs — resuming from a different cwd fails outright
// with "No conversation found"), so making that work means placing a copy of
// the transcript into the TARGET folder's own encoded project directory.
// Every non-alphanumeric character becomes a literal hyphen (1:1, never
// collapsed) — verified 2026-07-03 against every real directory under
// ~/.claude/projects (none contain anything outside [a-zA-Z0-9-]), e.g.
// "D:\Dropbox\Mina Dokument\Claude" -> "D--Dropbox-Mina-Dokument-Claude".
// The previous version only handled ":" and "\\", silently producing a
// WRONG directory name (with a literal space preserved) for any path
// containing a space or other special character — found live when it broke
// orchestratorHelper.js's classifier-transcript cleanup for exactly this
// folder, which has a space in "Mina Dokument".
export function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// An index of transcript FILE NAME -> the project dirs that contain it.
//
// findTranscriptPath used to answer every lookup by stat-ing the same candidate path in
// every project directory: 292 statSync calls per id on this machine, measured at 25ms a
// lookup, and 938ms for the 40 lookups a session list does. Callers loop over sessions
// (session:liveSubAgents, the status classifier, the context-size estimate), so that cost
// multiplies - and it is all synchronous in the Electron main process, which is Aidin's
// "hela appen laggar faktiskt till ibland" (measured 2026-08-03: a trivial IPC took
// 1672ms in the first seconds after paint, against 3ms in a settled app).
//
// It also explains "mycket segare an tidigare" without any code having changed: the cost
// is proportional to how many project directories exist, and that grows every day. 419 MB
// across 1155 files in 292 directories here.
//
// One pass over the directories builds the whole map, and a lookup then stats only the
// one or two real candidates. Short TTL rather than a permanent cache: a transcript file
// appears the moment a new session starts, and a stale index must never make a live
// session look transcript-less. A MISS also forces one rebuild, so a brand-new session
// resolves immediately instead of waiting out the TTL.
const TRANSCRIPT_INDEX_TTL_MS = 5000;
// Cooldown between MISS-triggered rescans. Keyed on when a rescan last happened, NOT on
// the index's age: a freshly built index is exactly when a just-created transcript is
// most likely to be absent from it, so gating on age refused to rescan in the one case
// that needed it. Caught by test-transcript-index, which is why that test asserts a
// new file resolves rather than only that lookups are fast.
const TRANSCRIPT_MISS_RESCAN_COOLDOWN_MS = 1000;
let transcriptIndex = null; // { at, byFile: Map<string, string[]> }
let lastMissRescanAt = 0;

function buildTranscriptIndex() {
  const byFile = new Map();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return { at: Date.now(), byFile };
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(projectsRoot, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) {
        continue;
      }
      const list = byFile.get(f);
      if (list) {
        list.push(path.join(dir, f));
      } else {
        byFile.set(f, [path.join(dir, f)]);
      }
    }
  }
  return { at: Date.now(), byFile };
}

function transcriptIndexFresh() {
  if (!transcriptIndex || Date.now() - transcriptIndex.at > TRANSCRIPT_INDEX_TTL_MS) {
    transcriptIndex = buildTranscriptIndex();
  }
  return transcriptIndex;
}

/** Drop the cached index, e.g. right after creating a session whose transcript must resolve now. */
export function invalidateTranscriptIndex() {
  transcriptIndex = null;
  // Also clear the rescan cooldown: an explicit invalidation means the caller KNOWS the
  // filesystem changed, and it must not be throttled by a rescan that happened before it.
  lastMissRescanAt = 0;
}

export function findTranscriptPath(transcriptIds) {
  const ids = (Array.isArray(transcriptIds) ? transcriptIds : [transcriptIds])
    .filter(Boolean)
    .map((id) => String(id).replace(/^local_/, ""));
  if (ids.length === 0 || !fs.existsSync(projectsRoot)) {
    return null;
  }
  let index = transcriptIndexFresh();
  let rebuilt = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const id of ids) {
      const candidates = index.byFile.get(`${id}.jsonl`) || [];
      // Collect EVERY matching file rather than taking the first - after
      // switchSessionRootFolder copies a transcript into a new project dir, the SAME
      // session id briefly exists in two places until the next real turn is written.
      // Which one the directory happens to list first is enumeration order, not
      // meaningfully "correct"; the most recently MODIFIED copy is the one reflecting
      // the live conversation. Usually there is exactly one, so this stats once.
      let best = null;
      let bestMtime = -1;
      for (const candidate of candidates) {
        let stat;
        try {
          stat = fs.statSync(candidate);
        } catch {
          continue; // indexed but gone since - the rebuild below will drop it
        }
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = candidate;
        }
      }
      if (best) {
        return best;
      }
    }
    // Nothing found. If the index could be older than a brand-new session's transcript,
    // rebuild ONCE and look again - bounded so a genuinely unknown id cannot make every
    // caller pay for a rescan.
    if (rebuilt || Date.now() - lastMissRescanAt < TRANSCRIPT_MISS_RESCAN_COOLDOWN_MS) {
      break;
    }
    lastMissRescanAt = Date.now();
    transcriptIndex = buildTranscriptIndex();
    index = transcriptIndex;
    rebuilt = true;
  }
  return null;
}
