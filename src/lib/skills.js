import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Lists skills available to a session, split by origin — global (~/.claude/skills)
 * vs project-specific (<cwd>/.claude/skills) — since that's the actual
 * distinction Aidin asked for, not just a flat combined list.
 * A "skill" here is a directory containing SKILL.md, per this codebase's own
 * skill-authoring convention (flat .md files don't register).
 */
export function listSkills(cwd) {
  const global = listSkillDir(path.join(os.homedir(), ".claude", "skills"));
  const project = cwd ? listSkillDir(path.join(cwd, ".claude", "skills")) : [];
  return { global, project };
}

/**
 * Resolves a skill's SKILL.md path given its origin (global/project), for
 * opening it in the OS default app when a user clicks a skill chip.
 */
export function skillMdPath(name, origin, cwd) {
  const base = origin === "project" ? cwd : path.join(os.homedir(), ".claude");
  if (!base) {
    return null;
  }
  const dir = origin === "project" ? path.join(base, ".claude", "skills") : path.join(base, "skills");
  const file = path.join(dir, name, "SKILL.md");
  return fs.existsSync(file) ? file : null;
}

function listSkillDir(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}
