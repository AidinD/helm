// A call to a lib function that the calling file no longer imports.
//
// This exists because it happened, and nothing caught it. Moving the review-queue build out
// of main.js on 2026-08-12 made several imports look unused, and they were removed - but
// `projectKey` was still called by `reviews:acknowledgeCommit`, 200 lines away from anything
// that moved. The result was a ReferenceError the moment the captain clicked "Reviewed" on a
// commit, and `node scripts/run-tests.mjs --fast` reported 84/84 green the whole time,
// because the check covering that handler launches the app and lives in the slow lane.
//
// Found by an independent reviewer, whose most useful observation was that this repo has no
// lint of any kind - no eslint config, no lint script, no devDependency - so a class of
// error a linter catches in milliseconds could only be caught by running the app.
//
// Deliberately NOT a general linter. A first attempt at "every bare call must resolve"
// produced 65 hits that were almost all noise (`async (` reads as a call, destructured
// parameters, object-method shorthand, names inside regex literals), and a check that cries
// wolf is worse than none. This asks one narrow question instead, which is the exact shape
// of the bug and has almost no room for a false positive:
//
//   does any file CALL a function that src/lib exports, without importing or defining it?
//
// Pure (no app/harness) - runs in the fast lane, in about a second.
// Run:  node scripts/e2e/test-no-undefined-calls.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const srcDir = path.join(repo, "src");
const libDir = path.join(srcDir, "lib");

// Comments, strings, template literals and regex literals all go, so a name merely MENTIONED
// in prose is never mistaken for a call. Two of the three hits in the original investigation
// were exactly that - a comment explaining what listUnboundCommits does.
function stripNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
    // Regex literals, after a character that cannot end an expression - so `a / b` is not
    // mistaken for one. Without this, the quota classifier's own regex contributed a hit.
    .replace(/([=(,:[!&|?{};+\-*%^~<>]|^|return|typeof)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g, "$1 //RE ");
}

/** Every function name src/lib/*.js exports. */
const libExports = new Map(); // name -> [module basenames that export it]
for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(libDir, file), "utf8");
  for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm)) {
    if (!libExports.has(m[1])) {
      libExports.set(m[1], []);
    }
    libExports.get(m[1]).push(file);
  }
}

const targets = [
  path.join(srcDir, "main.js"),
  ...fs.readdirSync(libDir).filter((f) => f.endsWith(".js")).map((f) => path.join(libDir, f)),
  ...fs.readdirSync(path.join(srcDir, "worker")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(srcDir, "worker", f)),
];

const problems = [];
for (const file of targets) {
  const raw = fs.readFileSync(file, "utf8");
  const code = stripNonCode(raw);

  const available = new Set();
  // Imported bindings, including `as` aliases.
  for (const m of raw.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/gm)) {
    for (const named of m[1].matchAll(/(?:^|[{,])\s*(?:(\w+)\s+as\s+)?(\w+)/g)) {
      available.add(named[2]);
      if (named[1]) {
        available.add(named[1]);
      }
    }
  }
  // Anything the file defines itself, under any callable shape.
  for (const re of [/\b(?:async\s+)?function\s*\*?\s*(\w+)/g, /\b(?:const|let|var)\s+(\w+)\s*=/g, /\bclass\s+(\w+)/g]) {
    for (const m of code.matchAll(re)) {
      available.add(m[1]);
    }
  }

  for (const m of code.matchAll(/(^|[^.\w$?])\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!libExports.has(name) || available.has(name)) {
      continue;
    }
    const line = code.slice(0, m.index).split("\n").length;
    problems.push(`${path.relative(repo, file).replace(/\\/g, "/")}:${line}  calls ${name}(), exported by lib/${libExports.get(name).join(", lib/")} but not imported here`);
  }
}

ok(libExports.size > 50, `the lib surface was actually parsed (${libExports.size} exported functions found) - a check that found nothing to compare against would pass trivially`);
ok(
  problems.length === 0,
  problems.length === 0
    ? `every lib function called across ${targets.length} files is imported or locally defined`
    : `${problems.length} call(s) to a lib function that is not in scope:\n       ${problems.join("\n       ")}`
);

console.log(
  exit === 0
    ? "VERIFY OK: no file calls a lib function it forgot to import."
    : "VERIFY FAILED - each of these throws a ReferenceError the moment that code path runs."
);
process.exit(exit);
