import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Lists the slash-invokable items for the composer menu: skills (folder +
// SKILL.md) and custom commands (.claude/commands/*.md), from both the global
// (~/.claude) and project (cwd/.claude) scopes. Deliberately EXCLUDES built-in
// TUI commands (/clear, /compact, /model, ...): those are interactive-only and
// do nothing meaningful through Helm's `claude -p` invocation, so listing them
// would be a trap. Verified 2026-07-10 that `claude -p "/name"` DOES run both
// custom commands and skills, which is what makes this menu real.

// Parse a leading frontmatter block for the two fields the menu needs. Tolerant
// of no frontmatter (returns {}). Not a full YAML parser - name/description are
// always simple scalars in these files.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    return {};
  }
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function listSkillItems(skillsDir, origin) {
  if (!skillsDir || !fs.existsSync(skillsDir)) {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const md = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(md)) {
      continue;
    }
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(md, "utf8"));
    } catch {
      // best-effort - still list the skill by its folder name
    }
    items.push({ name: fm.name || entry.name, description: fm.description || "", kind: "skill", origin });
  }
  return items;
}

function listCommandItems(commandsDir, origin) {
  if (!commandsDir || !fs.existsSync(commandsDir)) {
    return [];
  }
  const items = [];
  // Nested command dirs namespace as `dir:name` (Claude Code convention).
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), prefix ? `${prefix}:${entry.name}` : entry.name);
        continue;
      }
      if (!entry.name.endsWith(".md")) {
        continue;
      }
      const base = entry.name.slice(0, -3);
      const name = prefix ? `${prefix}:${base}` : base;
      let fm = {};
      try {
        fm = parseFrontmatter(fs.readFileSync(path.join(dir, entry.name), "utf8"));
      } catch {
        // best-effort
      }
      items.push({ name, description: fm.description || "", kind: "command", origin });
    }
  };
  walk(commandsDir, "");
  return items;
}

/**
 * The de-duplicated, alphabetically-sorted slash items available to a pane.
 * Project scope overrides global on a name collision (matches Claude Code's
 * precedence). Global-only when no cwd.
 */
export function listSlashItems(cwd) {
  const home = os.homedir();
  const all = [
    ...listSkillItems(path.join(home, ".claude", "skills"), "global"),
    ...listCommandItems(path.join(home, ".claude", "commands"), "global"),
  ];
  if (cwd) {
    all.push(...listSkillItems(path.join(cwd, ".claude", "skills"), "project"));
    all.push(...listCommandItems(path.join(cwd, ".claude", "commands"), "project"));
  }
  const byName = new Map();
  for (const item of all) {
    const prev = byName.get(item.name);
    // Keep project over global on collision; otherwise first wins.
    if (!prev || (prev.origin === "global" && item.origin === "project")) {
      byName.set(item.name, item);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
