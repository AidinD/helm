import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Lists the skills a session can actually reach, and preserves how they are
 * ORGANISED on disk rather than flattening everything into one run of names
 * (Aidin, task 3d0fe057: "Skillsen är kategoriserade i subfolders. kan vi
 * använda samma kategorisering i presentationen i analysis?").
 *
 * Three sources, because that is how many a real session has:
 *   - global   ~/.claude/skills
 *   - project  <cwd>/.claude/skills
 *   - plugins  an enabled plugin's own skills/ directory. This is the
 *              subfolder categorisation that already exists on his machine
 *              (rbx-core ships 61 of them) and that Analysis showed none of -
 *              a "what is in the room" view that omits most of the room.
 *
 * Each source returns CATEGORIES: one level of subfolders is read as a group,
 * so `skills/git/rebase/SKILL.md` shows under "git" as "rebase". A folder with
 * its own SKILL.md is a skill, never a category, so nesting cannot swallow one.
 *
 * @returns {{
 *   global: SkillSource,
 *   project: SkillSource,
 *   plugins: Array<SkillSource & { plugin: string, marketplace: string }>,
 * }}
 * where SkillSource = { dir: string|null, groups: Array<{ category: string|null, skills: Array<{ ref: string, label: string }> }>, count: number }
 */
export function listSkills(cwd) {
  return {
    global: listSkillSource(globalSkillsDir()),
    project: listSkillSource(cwd ? path.join(cwd, ".claude", "skills") : null),
    plugins: listPluginSkillSources(),
  };
}

/** ~/.claude, with a test seam so a suite never reads the real one. */
function claudeHome() {
  return process.env.HELM_CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function globalSkillsDir() {
  return path.join(claudeHome(), "skills");
}

/**
 * Resolves a skill's SKILL.md path from a (origin, ref[, plugin]) reference.
 *
 * The renderer never supplies a path - it is recomputed here, and a plugin id is
 * re-resolved through the enumerated plugin list, so a chip cannot point main at
 * an arbitrary file. `ref` may carry ONE category segment ("git/rebase"); any
 * "..", absolute path or deeper nesting is refused rather than normalised.
 */
export function skillMdPath(ref, origin, cwd, plugin) {
  const rel = safeSkillRef(ref);
  if (!rel) {
    return null;
  }
  let dir = null;
  if (origin === "project") {
    dir = cwd ? path.join(cwd, ".claude", "skills") : null;
  } else if (origin === "plugin") {
    dir = listPluginSkillSources().find((p) => p.plugin === plugin)?.dir || null;
  } else {
    dir = globalSkillsDir();
  }
  if (!dir) {
    return null;
  }
  const file = path.join(dir, rel, "SKILL.md");
  return fs.existsSync(file) ? file : null;
}

/**
 * A skill reference is at most `category/name`, both plain directory names.
 * Returns the safe relative path, or null.
 */
function safeSkillRef(ref) {
  const parts = String(ref || "")
    .split(/[\\/]/)
    .filter((s) => s.length > 0);
  if (parts.length === 0 || parts.length > 2) {
    return null;
  }
  if (parts.some((p) => p === "." || p === ".." || /[:*?"<>|]/.test(p))) {
    return null;
  }
  return path.join(...parts);
}

/** One skills root, read as categories. */
function listSkillSource(dir) {
  const groups = listSkillTree(dir);
  return { dir: dir || null, groups, count: groups.reduce((n, g) => n + g.skills.length, 0) };
}

/**
 * Reads a skills root into groups. Top-level skills come first under a null
 * category (the flat case, which is what every source on this machine looks like
 * today); each subfolder that holds skills becomes its own named group.
 */
function listSkillTree(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  const top = [];
  const categories = [];
  for (const name of subdirs(dir)) {
    if (isSkillDir(path.join(dir, name))) {
      top.push({ ref: name, label: name });
      continue;
    }
    // Not a skill itself - a category, if it holds any skills one level down.
    const inner = subdirs(path.join(dir, name))
      .filter((child) => isSkillDir(path.join(dir, name, child)))
      .map((child) => ({ ref: `${name}/${child}`, label: child }));
    if (inner.length) {
      categories.push({ category: name, skills: inner });
    }
  }
  const groups = [];
  if (top.length) {
    groups.push({ category: null, skills: top });
  }
  groups.push(...categories.sort((a, b) => a.category.localeCompare(b.category)));
  return groups;
}

function isSkillDir(dir) {
  return fs.existsSync(path.join(dir, "SKILL.md"));
}

/**
 * Immediate subdirectories, sorted.
 *
 * entry.isDirectory() reflects the raw OS dirent type and does NOT follow
 * symlinks/junctions on Windows (a junction reports as a reparse point) - and
 * ~/.claude/skills IS a link to Dropbox on this machine, so stat the resolved
 * target instead or the whole listing comes back empty.
 */
function subdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    try {
      if (fs.statSync(path.join(dir, entry.name)).isDirectory()) {
        out.push(entry.name);
      }
    } catch {
      // unreadable entry - skip it rather than failing the whole listing
    }
  }
  return out.sort();
}

/**
 * The skills that come from ENABLED plugins.
 *
 * Layout (Claude Code's own): settings.json lists `enabledPlugins` keyed
 * "<plugin>@<marketplace>". A marketplace is either a directory registered in
 * `extraKnownMarketplaces` or a clone under ~/.claude/plugins/marketplaces. Its
 * `.claude-plugin/marketplace.json` maps plugin name -> source directory, and the
 * plugin's skills live in `<source>/skills/<skill>/SKILL.md`.
 *
 * Best-effort by design: this reads another tool's on-disk layout, so anything
 * unexpected yields fewer plugins rather than an error - Analysis showing one
 * source too few is a smaller failure than Analysis not rendering.
 */
function listPluginSkillSources() {
  const settings = readJson(path.join(claudeHome(), "settings.json"));
  const enabled = settings?.enabledPlugins;
  if (!enabled || typeof enabled !== "object") {
    return [];
  }
  const out = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (on !== true) {
      continue;
    }
    const at = key.lastIndexOf("@");
    if (at <= 0) {
      continue;
    }
    const pluginName = key.slice(0, at);
    const marketplace = key.slice(at + 1);
    const root = marketplaceRoot(marketplace, settings);
    if (!root) {
      continue;
    }
    const manifest = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
    const entry = (manifest?.plugins || []).find((p) => p?.name === pluginName);
    if (!entry) {
      continue;
    }
    const source = typeof entry.source === "string" ? entry.source : entry.source?.path;
    if (!source) {
      continue;
    }
    const pluginDir = path.isAbsolute(source) ? source : path.resolve(root, source);
    const skillsDir = path.join(pluginDir, "skills");
    if (!fs.existsSync(skillsDir)) {
      continue;
    }
    out.push({ plugin: pluginName, marketplace, ...listSkillSource(skillsDir) });
  }
  return out.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

/** Where a marketplace's checkout lives, by registered path or by clone name. */
function marketplaceRoot(name, settings) {
  const registered = settings?.extraKnownMarketplaces?.[name]?.source?.path;
  if (registered && fs.existsSync(registered)) {
    return registered;
  }
  const clones = path.join(claudeHome(), "plugins", "marketplaces");
  const direct = path.join(clones, name);
  if (fs.existsSync(path.join(direct, ".claude-plugin", "marketplace.json"))) {
    return direct;
  }
  // A clone directory is not always named after the marketplace - match on the
  // manifest's own name instead of guessing from the folder.
  for (const dir of subdirs(clones)) {
    const full = path.join(clones, dir);
    if (readJson(path.join(full, ".claude-plugin", "marketplace.json"))?.name === name) {
      return full;
    }
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
