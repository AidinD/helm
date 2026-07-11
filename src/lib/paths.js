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
export const projectsRoot = path.join(os.homedir(), ".claude", "projects");

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
// "<your-claude-home>" -> "D--Dropbox-Mina-Dokument-Claude".
// The previous version only handled ":" and "\\", silently producing a
// WRONG directory name (with a literal space preserved) for any path
// containing a space or other special character — found live when it broke
// orchestratorHelper.js's classifier-transcript cleanup for exactly this
// folder, which has a space in "Documents".
export function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function findTranscriptPath(transcriptIds) {
  const ids = (Array.isArray(transcriptIds) ? transcriptIds : [transcriptIds])
    .filter(Boolean)
    .map((id) => String(id).replace(/^local_/, ""));
  if (ids.length === 0 || !fs.existsSync(projectsRoot)) {
    return null;
  }
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const id of ids) {
    const fileName = `${id}.jsonl`;
    // Collect EVERY matching file across project dirs rather than returning
    // on the first hit — after switchSessionRootFolder copies a transcript
    // into a new project dir, the SAME session id briefly exists in two
    // places (old + new folder) until the next real turn is written. Which
    // one fs.readdirSync happens to list first is directory-enumeration
    // order, not meaningfully "correct" — picking the most recently
    // MODIFIED copy is the one actually reflecting the live conversation,
    // and costs nothing extra when (the overwhelmingly common case) only
    // one copy exists at all.
    let best = null;
    let bestMtime = -1;
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(projectsRoot, entry.name, fileName);
      let stat;
      try {
        stat = fs.statSync(candidate);
      } catch {
        continue;
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
  return null;
}
