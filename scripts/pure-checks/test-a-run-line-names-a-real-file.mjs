// Every "Run:" line in a check names a file that exists.
//
// WHY THIS IS NOT PEDANTRY. A check's `// Run:` line is the line somebody copies - it is how you
// run one check without running the suite, and it is the first thing anyone reaching for a
// single check touches. When it names a path that does not exist, it fails with ENOENT, which
// reads as "this check is broken" rather than "this comment is stale".
//
// It went wrong at scale. scripts/e2e was split into app-checks/, pure-checks/ and checks-lib/,
// and 293 references to the old folder were left behind across 287 files - nearly every check in
// the repository carried a run line that could not work. Three of them were fixed by hand first,
// which is the shape of the problem: the class stayed open while one instance closed.
//
// Two of them were wrong in a second way that a folder-rename sweep would never have caught:
// test-retire-carry-over-stubbed.mjs and test-retire-reparents-through-the-app.mjs each named a
// file they used to BE, so correcting the folder would have produced a tidy path to nothing.
// That is why this check resolves the whole path against the filesystem rather than grepping for
// the old folder name.
//
// WHAT IT DELIBERATELY DOES NOT DO. It only looks at run lines. Prose that mentions a deleted
// check, a fixture with a made-up path, or a historical note in DECISIONS.md is left alone: a
// statement about what happened in July is not made truer by pointing it at a file that exists
// today, and rewriting history to satisfy a linter is how a record stops being one.
//
// Run: node scripts/pure-checks/test-a-run-line-names-a-real-file.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${what}`);
  if (!cond) {
    fails += 1;
  }
};

const LANES = ["scripts/app-checks", "scripts/pure-checks", "scripts/checks-lib"];

const files = [];
for (const lane of LANES) {
  const dir = path.join(repo, lane);
  if (!fs.existsSync(dir)) {
    continue;
  }
  for (const name of fs.readdirSync(dir)) {
    if (/\.(mjs|js|cjs)$/.test(name)) {
      files.push(path.join(lane, name).split(path.sep).join("/"));
    }
  }
}

ok(files.length > 50, `there is a body of checks to look at (${files.length})`);

// A run line: a comment naming a command that starts a script under scripts/. Env prefixes and
// flags are allowed around it - the path is what is being checked.
const RUN_LINE = /^\s*(?:\/\/|#)\s*Run:?\s.*?\bnode\s+(?:[A-Z_][A-Z0-9_]*=\S+\s+)*((?:\.\/)?scripts\/[A-Za-z0-9_./-]+)/;

const broken = [];
let checked = 0;

for (const rel of files) {
  const src = fs.readFileSync(path.join(repo, rel), "utf8");
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(RUN_LINE);
    if (!m) {
      continue;
    }
    checked += 1;
    const target = m[1].replace(/^\.\//, "");
    // A glob is a description of a shape, not a path to open.
    if (target.includes("*")) {
      continue;
    }
    if (!fs.existsSync(path.join(repo, target))) {
      broken.push(`${rel} says "node ${target}"`);
    }
  }
}

ok(checked > 50, `and most of them carry a run line (${checked} found)`);
ok(
  broken.length === 0,
  broken.length === 0
    ? `every run line names a file that exists (${checked} checked)`
    : `these run lines name a path that is not there, so copying them fails with ENOENT:\n       ${broken.join("\n       ")}`
);

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: the line somebody copies to run one check actually runs it."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
