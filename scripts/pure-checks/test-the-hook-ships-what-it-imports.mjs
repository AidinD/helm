// The tier-guard hook must ship EVERY file it imports, at the path the import expects.
//
// WHAT WENT WRONG. `src/lib/tierGuard.js` began importing `./personas.js` on 2026-09-02.
// `extraResources` shipped the hook and tierGuard.js, and nobody added the third file. So in
// every installed build from v0.2.268 onward, the claude CLI spawned the hook under plain node
// and got:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\tier-guard\lib\personas.js'
//   imported from '...\tier-guard\lib\tierGuard.js'
//
// exit 1, nothing on stdout. A PreToolUse hook that exits non-zero without the blocking code is
// a non-blocking error: the tool call proceeds. The guard did not deny anything and did not say
// it was not running - it FAILED OPEN, silently, for anything a first mate did in the installed
// app. A guard that is believed in and absent is worse than no guard, which is the reasoning
// already written down in test-packaged-build.mjs.
//
// WHY THAT CHECK DID NOT CATCH IT. It does catch it - it is where this was found - but only
// after somebody runs `npm run dist`, and it SKIPs cleanly when there is no build. CI never
// builds, so CI has never once run that assertion. A check that skips reports nothing, and
// nothing reads the same as fine.
//
// So this one asks the same question with no build at all: resolve the hook's local import
// graph from source, and require an `extraResources` entry for every file in it, mapping to the
// exact relative path its importer will look for. It is the class, not the one file - the next
// import added to tierGuard.js fails here on the commit that adds it.
//
// Run: node scripts/pure-checks/test-the-hook-ships-what-it-imports.mjs
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

const ENTRY = "src/hooks/tierGuardHook.mjs";

// --- what the hook actually needs, read from the source ------------------------------------
// COMMENTS ARE STRIPPED FIRST, and that is not a refinement. The first version of this file
// reported a node_modules import of "Task" - which was a line of prose explaining that the CLI
// renamed a tool from "Task" to "Agent". A source-scanning check that reads comments will both
// invent findings and, the other way round, pass when the guarded line is commented out. It is
// a known repeat offender in this repo's own review notes, and it caught this file on its first
// run.
const stripComments = (src) => {
  let out = "";
  let quote = null; // ' " or ` while inside a string
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
};

// Relative specifiers only. A bare specifier is a node_modules dependency, which is a different
// packaging question (and one the hook must not have - see the assertion below).
const localImports = (src) => [...src.matchAll(/(?:^|[\s{,])from\s+["'](\.[^"']+)["']/gm)].map((m) => m[1]);
const bareImports = (src) => [...src.matchAll(/(?:^|[\s{,])from\s+["']([^."'][^"']*)["']/gm)].map((m) => m[1]);

const needed = new Map(); // repo-relative posix path -> who imported it
const bare = new Map();
const queue = [ENTRY];
const seen = new Set();

while (queue.length > 0) {
  // Posix separators throughout: these strings are compared against package.json paths and used
  // as map keys, and a mixed-separator key silently misses - which produced a confident, wrong
  // failure message the first time this ran.
  const rel = queue.shift().split(String.fromCharCode(92)).join("/");
  if (seen.has(rel)) {
    continue;
  }
  seen.add(rel);
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) {
    ok(false, `${rel} exists to be read`);
    continue;
  }
  const src = stripComments(fs.readFileSync(abs, "utf8"));
  for (const spec of bareImports(src)) {
    if (!spec.startsWith("node:")) {
      bare.set(spec, rel);
    }
  }
  for (const spec of localImports(src)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (!needed.has(target)) {
      needed.set(target, rel);
    }
    queue.push(target);
  }
}

ok(seen.size > 1, `the hook's import graph was read from source (${seen.size} files)`);
ok(
  needed.has("src/lib/personas.js"),
  "the graph reaches personas.js - the file whose absence shipped a guard that could not start"
);

// --- and what the build ships ---------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const extra = pkg?.build?.extraResources || [];
const shippedTo = new Map(); // source path (posix) -> destination inside resources/
for (const item of extra) {
  if (item && typeof item.from === "string" && typeof item.to === "string") {
    shippedTo.set(item.from.split(path.sep).join("/"), item.to.split(path.sep).join("/"));
  }
}

ok(
  shippedTo.has(ENTRY),
  `the hook itself is shipped as extraResources (${shippedTo.get(ENTRY) || "MISSING"})`
);

const missing = [...needed.keys()].filter((f) => !shippedTo.has(f));
ok(
  missing.length === 0,
  missing.length === 0
    ? `every file the hook imports is shipped (${needed.size} of them)`
    : `these are imported by the hook but never shipped, so the guard cannot start in the installed app: ${missing.join(", ")}`
);

// --- shipped is not enough: it has to land where the IMPORTER looks --------------------------
// tierGuard.js does `from "./personas.js"`, so personas.js has to sit beside tierGuard.js inside
// resources. Shipping it to some other folder satisfies the check above and fails identically at
// runtime, which is exactly the shape of bug this file exists for.
for (const [file, importer] of needed.entries()) {
  const dest = shippedTo.get(file);
  if (!dest) {
    continue; // already reported above
  }
  const importerDest = shippedTo.get(importer) || shippedTo.get(ENTRY);
  const expected = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerDest), path.posix.relative(path.posix.dirname(importer), file))
  );
  ok(
    dest === expected,
    dest === expected
      ? `${file} lands where ${importer} will look for it (${dest})`
      : `${file} is shipped to ${dest}, but ${importer} resolves it as ${expected} - same crash, one folder over`
  );
}

// --- a node_modules import would be a fourth way to fail --------------------------------------
// Nothing outside the app bundle is on the hook's module path when the CLI spawns it, so a bare
// import cannot resolve no matter where the files are put.
ok(
  bare.size === 0,
  bare.size === 0
    ? "the hook's graph imports nothing from node_modules, which plain node could not resolve from resources/"
    : `these node_modules imports would not resolve when the CLI spawns the hook: ${[...bare.entries()].map(([s, f]) => `${s} (${f})`).join(", ")}`
);

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: everything the tier-guard hook imports is shipped, at the path its importer expects - checked without a build, which is the only way CI can check it at all."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
