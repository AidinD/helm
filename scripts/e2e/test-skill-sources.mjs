// Unit test: listSkills reports every source a session can reach, keeps the
// on-disk categorisation, and skillMdPath refuses to be pointed anywhere else.
//
// Aidin, task 3d0fe057: "Skillsen är kategoriserade i subfolders. kan vi använda samma
// kategorisering i presentationen i analysis?" - so a subfolder has to survive all the
// way from disk to the chip, and a chip has to be able to open what it names.
//
// The plugin half matters just as much: his machine has an enabled plugin shipping 61
// skills that Analysis listed none of, while claiming to show what is in the room.
//
// Run:  node scripts/e2e/test-skill-sources.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-skillsrc-"));
const home = path.join(tmp, "claude-home");
const skill = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n\nbody\n", "utf8");
};

// --- the organised catalog the flat skills root links into ------------------
// This is the real shape on Aidin's machine: ~/.claude/skills is flat, and each of
// its 33 entries is a junction into <meta-home>/skills-catalog, which is the tree
// that is actually organised (portfolio/dev-workflow, private/finance, ...). So the
// categorisation has to come from where a skill POINTS, not from the flat root.
const catalogDir = path.join(tmp, "skills-catalog");
skill(path.join(catalogDir, "copied-external", "handoff"));
skill(path.join(catalogDir, "portfolio", "dev-workflow", "catchup"));
skill(path.join(catalogDir, "portfolio", "orchestration", "council"));
// A skill sitting at the catalog's TOP level has no category there, which must not be
// confused with a skill the catalog has never heard of.
skill(path.join(catalogDir, "loose"));

// --- global: a flat root that mixes links into the catalog, real skills the catalog
// does not know, an on-disk category, and a folder that is neither.
fs.mkdirSync(path.join(home, "skills"), { recursive: true });
const linkedIn = (name, target) => {
  // "junction" so this needs no elevation on Windows, which is where it runs.
  fs.symlinkSync(target, path.join(home, "skills", name), "junction");
};
linkedIn("handoff", path.join(catalogDir, "copied-external", "handoff"));
linkedIn("catchup", path.join(catalogDir, "portfolio", "dev-workflow", "catchup"));
linkedIn("council", path.join(catalogDir, "portfolio", "orchestration", "council"));
linkedIn("loose", path.join(catalogDir, "loose"));
skill(path.join(home, "skills", "triage"));
skill(path.join(home, "skills", "git", "rebase"));
skill(path.join(home, "skills", "git", "blame"));
fs.mkdirSync(path.join(home, "skills", "notes"), { recursive: true });
fs.writeFileSync(path.join(home, "skills", "notes", "README.md"), "not a skill\n", "utf8");
// A folder that has BOTH its own SKILL.md and a nested one: it is a skill, and the
// nested folder must not be read as a category (that would invent a group that the
// CLI does not see either).
skill(path.join(home, "skills", "compound"));
skill(path.join(home, "skills", "compound", "inner"));

// --- project
const project = path.join(tmp, "repo");
skill(path.join(project, ".claude", "skills", "deploy"));

// --- a marketplace registered by path, one plugin enabled and one not
const mkt = path.join(tmp, "market");
fs.mkdirSync(path.join(mkt, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(mkt, ".claude-plugin", "marketplace.json"),
  JSON.stringify({ name: "mkt", plugins: [{ name: "demo", source: "./p/demo" }, { name: "hidden", source: "./p/hidden" }] }),
  "utf8"
);
skill(path.join(mkt, "p", "demo", "skills", "one"));
skill(path.join(mkt, "p", "demo", "skills", "grouped", "two"));
skill(path.join(mkt, "p", "hidden", "skills", "nope"));

// --- a marketplace CLONE whose folder name does not match its manifest name
const cloneDir = path.join(home, "plugins", "marketplaces", "some-git-clone-1234");
fs.mkdirSync(path.join(cloneDir, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(cloneDir, ".claude-plugin", "marketplace.json"),
  JSON.stringify({ name: "official", plugins: [{ name: "extra", source: "./plugins/extra" }] }),
  "utf8"
);
skill(path.join(cloneDir, "plugins", "extra", "skills", "helper"));

fs.writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify({
    enabledPlugins: { "demo@mkt": true, "hidden@mkt": false, "extra@official": true },
    extraKnownMarketplaces: { mkt: { source: { source: "directory", path: mkt } } },
  }),
  "utf8"
);

process.env.HELM_CLAUDE_HOME = home;
const { listSkills, skillMdPath } = await import("../../src/lib/skills.js");

try {
  const s = listSkills(project, { catalogDir });

  // --- global: grouped by where each skill really lives -----------------------
  const g = s.global;
  const groupNames = g.groups.map((x) => `${x.category}:${x.skills.map((y) => y.label).join("+")}`);
  ok(g.dir === path.join(home, "skills"), `global source names the folder it read (${g.dir})`);
  ok(g.count === 8, `counts every global skill - linked, real and nested (got ${g.count})`);
  ok(
    JSON.stringify(g.groups.find((x) => x.category === "copied-external")?.skills) === JSON.stringify([{ ref: "handoff", label: "handoff" }]),
    `a skill that LINKS into the catalog is grouped by the catalog path (${JSON.stringify(groupNames)})`
  );
  ok(
    JSON.stringify(g.groups.find((x) => x.category === "portfolio / dev-workflow")?.skills) === JSON.stringify([{ ref: "catchup", label: "catchup" }]),
    "a two-level catalog path becomes a two-level label"
  );
  ok(!!g.groups.find((x) => x.category === "portfolio / orchestration"), "and sibling categories under the same parent stay apart");
  ok(
    g.groups.find((x) => x.category === "portfolio / dev-workflow")?.skills[0].ref === "catchup",
    "the ref stays the name in the SKILLS root, which is the path a session actually loads - the catalog only groups"
  );
  // Sitting at the catalog's top level is not the same as being unknown to it.
  const uncat = g.groups.find((x) => x.category === "uncategorised");
  ok(
    JSON.stringify(uncat?.skills.map((x) => x.label)) === JSON.stringify(["compound", "triage"]),
    `only skills the catalog has never heard of are "uncategorised" (${JSON.stringify(uncat?.skills.map((x) => x.label))})`
  );
  ok(
    g.groups.some((x) => x.category === null && x.skills.some((y) => y.label === "loose")),
    `a skill at the catalog's own top level has no category, and is not lumped in with the unknown ones (${JSON.stringify(groupNames)})`
  );
  ok(
    g.groups[g.groups.length - 1].category === "uncategorised",
    `the remainder sorts last, after the real categories (${JSON.stringify(g.groups.map((x) => x.category))})`
  );
  const git = g.groups.find((x) => x.category === "git");
  ok(!!git, "a subfolder of skills becomes its own category");
  ok(
    JSON.stringify(git.skills) === JSON.stringify([{ ref: "git/blame", label: "blame" }, { ref: "git/rebase", label: "rebase" }]),
    `a grouped skill keeps a ref that includes its category and a label that does not (${JSON.stringify(git.skills)})`
  );
  ok(
    !g.groups.some((x) => x.category === "notes"),
    "a folder with no skills under it is not a category"
  );
  ok(
    !g.groups.some((x) => x.category === "compound"),
    "a folder that IS a skill is never also read as a category"
  );

  // Without a catalog nothing is invented: the same root is one ungrouped run plus
  // its on-disk category, and no skill is labelled "uncategorised".
  const noCat = listSkills(project).global;
  ok(noCat.groups[0].category === null, "with no catalog, the flat skills are simply ungrouped");
  ok(
    !noCat.groups.some((x) => x.category === "uncategorised"),
    `and nothing is called uncategorised, because nothing was categorised (${JSON.stringify(noCat.groups.map((x) => x.category))})`
  );
  ok(noCat.count === g.count, "the same skills are listed either way - the catalog groups them, it is not a source");

  // --- deeper nesting on disk ------------------------------------------------
  const deep = listSkills("", { catalogDir: null }).global;
  ok(
    deep.groups.some((x) => x.category === "git"),
    "an on-disk subfolder is still its own category when there is no catalog"
  );

  // --- project ---------------------------------------------------------------
  ok(s.project.count === 1 && s.project.groups[0].skills[0].ref === "deploy", "project skills come from <cwd>/.claude/skills");
  ok(s.project.dir === path.join(project, ".claude", "skills"), `project source names its folder too (${s.project.dir})`);
  ok(listSkills("").project.dir === null, "with no folder set, there is no project skills dir to name");

  // --- plugins ---------------------------------------------------------------
  const names = s.plugins.map((p) => `${p.plugin}@${p.marketplace}`);
  ok(
    JSON.stringify(names) === JSON.stringify(["demo@mkt", "extra@official"]),
    `only ENABLED plugins are listed, from a registered path and from a clone matched by manifest name (${JSON.stringify(names)})`
  );
  const demo = s.plugins.find((p) => p.plugin === "demo");
  ok(demo.count === 2, `a plugin's own skills are counted (got ${demo.count})`);
  ok(
    !!demo.groups.find((x) => x.category === "grouped"),
    "and a plugin's subfolders group the same way"
  );

  // --- opening: the reference resolves, and nothing else does ----------------
  ok(skillMdPath("git/rebase", "global") === path.join(home, "skills", "git", "rebase", "SKILL.md"), "a category ref opens the right SKILL.md");
  ok(skillMdPath("handoff", "global") === path.join(home, "skills", "handoff", "SKILL.md"), "so does a flat one");
  ok(skillMdPath("deploy", "project", project) === path.join(project, ".claude", "skills", "deploy", "SKILL.md"), "project refs resolve against the cwd");
  ok(
    skillMdPath("grouped/two", "plugin", project, "demo") === path.join(mkt, "p", "demo", "skills", "grouped", "two", "SKILL.md"),
    "a plugin ref resolves through the enumerated plugin list, not a renderer-supplied path"
  );
  ok(skillMdPath("grouped/two", "plugin", project, "hidden") === null, "a DISABLED plugin cannot be named to reach its files");
  ok(skillMdPath("grouped/two", "plugin", project, "made-up") === null, "nor can an unknown plugin id");
  // Traversal and shape guards. The old resolver joined the name straight in.
  ok(skillMdPath("../../settings", "global") === null, "a ref that climbs out is refused");
  ok(skillMdPath("a/b/c/d/e", "global") === null, "a ref deeper than the category levels this module lists is refused");
  ok(skillMdPath("", "global") === null, "an empty ref is refused");
  ok(skillMdPath("nope", "global") === null, "and a ref with no SKILL.md behind it resolves to nothing");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: global, project and enabled-plugin skills are listed with their on-disk grouping, and only a real skill can be opened."
    : "VERIFY FAILED."
);
process.exit(exit);
