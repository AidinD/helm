import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolves the on-disk locations that the Claude desktop app uses to store
 * session metadata and transcripts. All read-only.
 */

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const CLAUDE_ROOT = path.join(APPDATA, "Claude");

export const desktopConfigPath = path.join(CLAUDE_ROOT, "claude_desktop_config.json");
export const sessionsRoot = path.join(CLAUDE_ROOT, "claude-code-sessions");
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
    if (entry.isDirectory()) {
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
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(projectsRoot, entry.name, fileName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
