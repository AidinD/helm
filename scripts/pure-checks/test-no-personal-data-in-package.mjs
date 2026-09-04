// Nothing personal may be packaged into the installer.
//
// Helm's data stores live in the repo root in dev - config.json holds session ids,
// title overrides and quota readings; second-mates.json holds project names;
// scheduled-prompts.json holds prompt TEXT. The packaged build's file list excludes
// them BY EXACT NAME, so the moment a new store is added the exclusion is one thing
// somebody has to remember.
//
// They had not: on 2026-08-02 the pre-release review found second-mates.json and
// scheduled-prompts.json were gitignored but NOT excluded from the package, and that
// the shared atomic write's leftover ".<name>.<hex>.tmp" files were neither. A build
// run while one of those existed would ship a snapshot of the local state inside a
// public installer.
//
// The rule this asserts: if a file is gitignored because it is local state, it is
// also excluded from the package. One list cannot drift from the other.
//
// Run: node scripts/e2e/test-no-personal-data-in-package.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const gitignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const files = pkg?.build?.files || [];

// Local-state files: gitignored, at the repo root, and a data file rather than a
// build artefact or a directory.
const BUILD_ARTEFACTS = new Set(["node_modules/", "dist/", "src/lib/build-version.json"]);
const ignored = gitignore
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .filter((l) => !l.endsWith("/") && !BUILD_ARTEFACTS.has(l))
  .filter((l) => /\.(json|jsonl)$/.test(l));

ok(ignored.length >= 8, `found the local-state files to check (${ignored.length}: ${ignored.join(", ")})`);

const excluded = new Set(files.filter((f) => f.startsWith("!")).map((f) => f.slice(1)));
const shipped = ignored.filter((f) => !excluded.has(f));
ok(
  shipped.length === 0,
  `every local-state file is kept out of the installer (would ship: ${shipped.join(", ") || "none"})`
);

// The atomic write's leftovers are not covered by any exact name.
ok(files.includes("!**/.*.tmp"), "leftover atomic-write temp files are excluded too");
ok(/^\.\*\.tmp$/m.test(gitignore), "and gitignored, so one can't be committed either");

// The stores that exist RIGHT NOW in this working copy, by their real filenames -
// catches a store whose name changed without either list following.
const present = fs
  .readdirSync(repo)
  .filter((f) => /\.(json|jsonl)$/.test(f))
  .filter((f) => f !== "package.json" && f !== "package-lock.json");
const presentButShipped = present.filter((f) => !excluded.has(f));
ok(
  presentButShipped.length === 0,
  `no data file sitting in the repo right now would be packaged (${presentButShipped.join(", ") || "none"})`
);

console.log(
  fails === 0
    ? "\nVERIFY OK: no local state can ride along into an installer."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
