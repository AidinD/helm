import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Read-only view over Claude Code's OWN scheduled-tasks folder
 * (~/.claude/scheduled-tasks/<taskId>/SKILL.md). The captain's routines already run
 * there via Claude's own scheduler — this module does NOT implement a
 * scheduler, cron, or any run-triggering of its own. It only lists what
 * exists on disk so the Routines page has something real to show.
 *
 * Each task folder's SKILL.md carries YAML-ish frontmatter (--- delimited)
 * with at least `name` and `description`. Schedule/cadence, next-run, and
 * last-run are NOT persisted in that frontmatter on disk (verified against
 * real task folders) — that state lives behind Claude's own scheduled-tasks
 * tooling, not in a plain file this process can read. So only name/description
 * are parsed here; a `schedule` key is read too in case a future task ever
 * carries one, but its absence is the normal case, not an error.
 */

/** Returns the scheduled-tasks root folder path. */
export function scheduledTasksDir() {
  return path.join(os.homedir(), ".claude", "scheduled-tasks");
}

/**
 * Lists every scheduled task found on disk. Never throws — a missing or
 * empty folder, or a task folder without a readable SKILL.md, just yields
 * fewer entries rather than an error.
 */
export async function listScheduledTasks() {
  const dir = scheduledTasksDir();
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(dir, entry.name, "SKILL.md");
    let raw;
    try {
      raw = await fs.promises.readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    tasks.push({
      taskId: entry.name,
      name: frontmatter.name || entry.name,
      description: frontmatter.description || "",
      schedule: frontmatter.schedule || null,
      skillPath,
    });
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  return tasks;
}

/**
 * Minimal "--- ... ---" YAML frontmatter parser for flat string key: value
 * pairs — the only shape these SKILL.md files actually use. Not a general
 * YAML parser; deliberately kept small since the real schema is this simple.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      result[kv[1]] = kv[2].trim();
    }
  }
  return result;
}
