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
