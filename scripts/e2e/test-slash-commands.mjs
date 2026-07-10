// Unit test (pure node): listSlashItems parses skills + custom commands from a
// project's .claude dir, reads name/description from frontmatter, namespaces
// nested commands, and excludes non-.md / dirs-without-SKILL.md. Uses a temp
// cwd so it's deterministic (the global ~/.claude scope is additive and not
// asserted on).
// Run:  node scripts/e2e/test-slash-commands.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const { listSlashItems } = await import("../../src/lib/slashCommands.js");

const root = path.join(os.tmpdir(), "slash-test-" + process.pid);
const mk = (rel, body) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body, "utf8");
};

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

try {
  // A skill (folder + SKILL.md) with frontmatter.
  mk(".claude/skills/deploy-thing/SKILL.md", "---\nname: deploy-thing\ndescription: Ships the thing.\n---\nbody");
  // A skill folder WITHOUT SKILL.md - must be ignored.
  fs.mkdirSync(path.join(root, ".claude/skills/not-a-skill"), { recursive: true });
  // A top-level custom command with a description.
  mk(".claude/commands/ship.md", "---\ndescription: Open a PR.\n---\nDo the ship.");
  // A nested command - namespaces as dir:name.
  mk(".claude/commands/git/sync.md", "Sync the repo.");
  // A non-md file - ignored.
  mk(".claude/commands/README.txt", "not a command");

  const items = listSlashItems(root);
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));

  assert(byName["deploy-thing"]?.kind === "skill", "a project skill is listed as a skill");
  assert(byName["deploy-thing"]?.origin === "project", "project skill has origin=project");
  assert(byName["deploy-thing"]?.description === "Ships the thing.", "skill description read from frontmatter");
  assert(!("not-a-skill" in byName), "a folder without SKILL.md is not listed");
  assert(byName["ship"]?.kind === "command", "a custom command is listed as a command");
  assert(byName["ship"]?.description === "Open a PR.", "command description read from frontmatter");
  assert(byName["git:sync"]?.kind === "command", "a nested command namespaces as dir:name");
  assert(!Object.keys(byName).some((n) => n.includes("README")), "a non-.md file is not listed");
  // Sorted alphabetically by name.
  const names = items.map((i) => i.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(names) === JSON.stringify(sorted), "items are alphabetically sorted");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: slash-item listing." : "VERIFY FAILED.");
process.exit(exit);
