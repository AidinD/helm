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
 * Each source returns CATEGORIES, from either of the two ways they exist here:
 *
 *   1. Subfolders of the skills root, up to MAX_CATEGORY_DEPTH levels, joined
 *      with " / ". A folder with its own SKILL.md is a skill, never a category,
 *      so nesting cannot swallow one.
 *   2. WHERE THE SKILL REALLY LIVES. ~/.claude/skills is flat here, but its 33
 *      entries are links into `<meta-home>/skills-catalog`, which is the real
 *      tree and is organised (copied-external, personal-tools, portfolio/
 *      dev-workflow, private/finance, vendor-reference/cloudflare, ...). That
 *      catalog is the categorisation Aidin meant (task 3d0fe057, "jag tänkte på
 *      hur de är strukturerade i skills-catalog"), so a flat root whose entries
 *      point into it is grouped by the path they point at. Nothing new is read
 *      as a SOURCE: the skills listed are still the ones a session loads, only
 *      grouped by where they come from.
 *
 * @param {string} cwd focused pane's project folder, for its project skills.
 * @param {object} [opts]
 * @param {string} [opts.catalogDir] the organised tree the global skills link
 *   into. main passes <meta-home>/skills-catalog; omitted means no such
 *   grouping and every skill stays in the ungrouped run.
 * @returns {{
 *   global: SkillSource,
 *   project: SkillSource,
 *   plugins: Array<SkillSource & { plugin: string, marketplace: string }>,
 * }}
 * where SkillSource = { dir: string|null, groups: Array<{ category: string|null, skills: Array<{ ref: string, label: string }> }>, count: number }
 */
export function listSkills(cwd, { catalogDir } = {}) {
  const catalog = catalogCategories(catalogDir);
  return {
    global: listSkillSource(globalSkillsDir(), catalog, catalogDir),
    project: listSkillSource(cwd ? path.join(cwd, ".claude", "skills") : null, catalog, catalogDir),
    plugins: listPluginSkillSources(),
  };
}

/** How many levels of subfolder are read as a category before it is just depth. */
const MAX_CATEGORY_DEPTH = 3;

/**
 * Where a real skill directory sits inside the organised catalog: a map from the
 * skill's real path to its category label ("portfolio / dev-workflow").
 *
 * Keyed by real path rather than by name, so it cannot mis-attribute two skills
 * that happen to share a name, and lowercased because Windows paths are
 * case-insensitive while string keys are not.
 */
function catalogCategories(catalogDir) {
  if (!catalogDir || !fs.existsSync(catalogDir)) {
    return null;
  }
  const map = new Map();
  const walk = (dir, trail) => {
    for (const name of subdirs(dir)) {
      const full = path.join(dir, name);
      if (isSkillDir(full)) {
        // The skill's own folder is not part of its category - the trail above it is.
        map.set(realPathKey(full), trail.join(" / ") || null);
        continue;
      }
      if (trail.length < MAX_CATEGORY_DEPTH) {
        walk(full, [...trail, name]);
      }
    }
  };
  walk(catalogDir, []);
  return map.size > 0 ? map : null;
}

/** A comparable key for a path, following links, or null if it cannot be resolved. */
function realPathKey(p) {
  try {
    return fs.realpathSync(p).toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
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
  // At most one segment per category level plus the skill's own folder. Bounded
  // rather than open-ended: a ref is a reference to something this module listed,
  // and nothing it lists is deeper than that.
  if (parts.length === 0 || parts.length > MAX_CATEGORY_DEPTH + 1) {
    return null;
  }
  if (parts.some((p) => p === "." || p === ".." || /[:*?"<>|]/.test(p))) {
    return null;
  }
  return path.join(...parts);
}

/** One skills root, read as categories. */
function listSkillSource(dir, catalog = null, catalogDir = null) {
  const groups = listSkillTree(dir, catalog);
  return {
    dir: dir || null,
    groups,
    count: groups.reduce((n, g) => n + g.skills.length, 0),
    // Where the grouping came from, when it did not come from this root's own
    // subfolders. The page says so out loud: a flat folder rendering as eleven
    // labelled groups is otherwise unexplainable from what is on screen.
    groupedBy: groups.some((g) => g.fromCatalog) && catalogDir ? catalogDir : null,
  };
}

/** A skill's category comes from its own subfolder trail, or from the catalog. */
const UNCATEGORISED = "uncategorised";

/**
 * Reads a skills root into groups.
 *
 * Two sources of a category, and a root can use both:
 *  - the skill's own trail of subfolders under the root ("git / worktrees");
 *  - for a skill sitting DIRECTLY in the root, where it really lives, if that is
 *    inside the organised catalog. ~/.claude/skills is flat but every entry is a
 *    link into skills-catalog, so this is what puts the 33 into their real
 *    categories without reading the catalog as a second source of skills.
 *
 * When some skills in a root map to a catalog category and others do not, the
 * leftovers become an explicit "uncategorised" group rather than an unlabelled
 * run - beside labelled groups, an unlabelled one reads like a rendering bug.
 */
function listSkillTree(dir, catalog = null) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  // Collected flat first, WITH whether the catalog knew each one, because those are
  // two different states that both end up with no category: a skill sitting at the
  // catalog's own top level (known, deliberately uncategorised there) and a skill the
  // catalog has never heard of. Bucketing during the walk collapsed them.
  const found = [];
  let anyFromCatalog = false;
  const walk = (current, trail) => {
    for (const name of subdirs(current)) {
      const full = path.join(current, name);
      const ref = [...trail, name].join("/");
      if (isSkillDir(full)) {
        // A skill nested under the root is categorised by that nesting. A skill
        // directly in the root can still have a category - where it points.
        const nested = trail.join(" / ") || null;
        let category = nested;
        let mapped = false;
        if (!nested && catalog) {
          const fromCatalog = catalog.get(realPathKey(full));
          if (fromCatalog !== undefined) {
            mapped = true;
            anyFromCatalog = true;
            category = fromCatalog;
          }
        }
        found.push({ ref, label: name, category, known: mapped || !!nested, fromCatalog: mapped });
        continue;
      }
      if (trail.length < MAX_CATEGORY_DEPTH) {
        walk(full, [...trail, name]);
      }
    }
  };
  walk(dir, []);

  const byCategory = new Map();
  for (const s of found) {
    // Only a skill NOTHING placed becomes the remainder, and only in a root where
    // something else was placed - otherwise an ordinary flat folder would grow a
    // label that says nothing.
    const category = s.category === null && anyFromCatalog && !s.known ? UNCATEGORISED : s.category;
    const key = category === null ? "" : category;
    if (!byCategory.has(key)) {
      byCategory.set(key, { category, skills: [], fromCatalog: s.fromCatalog === true });
    }
    byCategory.get(key).skills.push({ ref: s.ref, label: s.label });
  }
  const groups = [...byCategory.values()];
  // Ungrouped first (the plain flat case), then categories alphabetically, with
  // "uncategorised" last since it is a remainder rather than a category.
  return groups.sort((a, b) => {
    const rank = (c) => (c === null ? 0 : c === UNCATEGORISED ? 2 : 1);
    const d = rank(a.category) - rank(b.category);
    return d !== 0 ? d : String(a.category).localeCompare(String(b.category));
  });
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
