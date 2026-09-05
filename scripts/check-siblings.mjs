#!/usr/bin/env node
//
// Say at INSTALL time that a sibling package is missing, instead of at first launch.
//
// This repo depends on packages that are not published. One is still a `file:` sibling, and npm
// is happy to leave a DANGLING SYMLINK for it and exit 0 anyway, so `npm install` reports
// success and the app then dies on its first import with a module-resolution error - no window,
// no dialog, nothing. That is how somebody installed Helm and found it simply did not start.
//
// ## What is checked is what must RESOLVE, not what is spelled `file:`
//
// keel moved to a git tag on 2026-09-05, and the first version of this check lost sight of it
// the moment it did: the list was built by filtering the dependencies for `file:`, so changing
// how the package arrives silently emptied the check of the one package it calls fatal. Nothing
// failed. The test one directory over went on printing "so the check calls a missing keel
// FATAL" and passing, because it was reading a severity entry the script could no longer reach.
//
// The property is that node can LOAD the package. How it was specified is only how it got
// there, and it decides the DIAGNOSIS below - not whether the package is looked at.
//
// The runtime half of that is fixed: the optional package is imported lazily now and its
// absence degrades with a message. What was left is this - the install saying so, while
// somebody is still looking at a terminal and can act on it.
//
// ## Fatal versus degraded, and why the difference is not cosmetic
//
// `keel` is FATAL. It is imported at the top of main.js and of atomicWrite.js, and almost
// everything imports atomicWrite - so without it the process throws before any of the app's own
// code runs, and there is nothing left that could report it. An install that "succeeded" there
// is a lie.
//
// `@jot/core` DEGRADES. Since the sibling-app work of 2026-09-02 it is loaded lazily and its
// absence costs one tab and a sidebar badge, which the app says out loud. Failing an install
// over that would be wrong, and would train people to skip this check - so it warns and names
// exactly what is lost.
//
// A missing package and an UNBUILT one are also different problems with different fixes, and
// `@jot/core` is a build artefact rather than a checkout. Saying "not found" for a sibling that
// is cloned but not built sends somebody looking for the wrong thing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

/**
 * What each dependency costs when it is absent. Named rather than guessed: whether a missing
 * package kills the process or degrades a feature is a fact about the imports, and a check that
 * assumed one answer for both would be wrong in one direction or the other.
 *
 * `fix` answers the sibling states (a folder that is missing, unbuilt, or unlinked). `fixMissing`
 * answers a package that simply is not in node_modules, which is the only way a tagged
 * dependency can be absent - sending somebody to clone a sibling there would name a directory
 * the dependency no longer mentions.
 */
const SEVERITY = {
  keel: {
    fatal: true,
    why: "imported at the top of main.js and of lib/atomicWrite.js, which nearly everything imports - the process throws before any of Helm's own code can report it",
    fix: "clone it beside this repo: git clone https://github.com/AidinD/keel ../keel",
    fixMissing: "run npm install - it comes from the tag named in package.json; if you are developing both, npm link ../keel",
  },
  "@jot/core": {
    fatal: false,
    why: "loaded lazily since 2026-09-02, so Helm starts without it and says what is unavailable - you lose the embedded board tab and its sidebar badge",
    fix: "clone the sibling beside this repo and BUILD it (it is a build artefact, not a checkout): git clone https://github.com/AidinD/jot ../jot && cd ../jot && npm install && npm run build",
  },
};

const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
// Everything classified above, plus any `file:` sibling that is not - so adding a sibling
// without classifying it is still reported, and moving a classified one off `file:` does not
// quietly drop it out of the check.
const checked = Object.entries(deps).filter(([name, spec]) => name in SEVERITY || String(spec).startsWith("file:"));

const problems = [];
for (const [name, spec] of checked) {
  const isSibling = String(spec).startsWith("file:");
  const target = isSibling ? path.resolve(repo, String(spec).replace(/^file:/, "")) : null;
  const linked = path.join(repo, "node_modules", ...name.split("/"));

  // RESOLVABILITY FIRST, and this order is the whole correctness of the check.
  //
  // What matters is whether node can load the package, not where its source sits. Those two
  // coincide on a developer's machine - npm links node_modules/<name> at the file: target - and
  // they do NOT have to: a package placed directly into node_modules by other means resolves
  // perfectly well with no sibling directory anywhere.
  //
  // The first version tested the TARGET first and so failed a perfectly good tree, on CI, where
  // keel is checked out straight into node_modules and `../keel` does not exist. It reported
  // "not cloned" and failed the install for a package that was right there and loadable. A
  // check that refuses a working setup is worse than none: it gets switched off, and then it is
  // not there for the case it was written for.
  //
  // So the target states below are DIAGNOSIS, reached only when the package does not resolve.
  // They explain a failure; they do not define one.
  let state = null;
  if (fs.existsSync(path.join(linked, "package.json"))) {
    continue;
  }
  if (!isSibling) {
    // Nothing to diagnose: there is no folder this was meant to come from. It was declared and
    // it is not installed.
    state = "not-installed";
  } else if (!fs.existsSync(target)) {
    // "cloned but not built" only when the target's PARENT is itself a checkout - which is
    // what `../jot/dist-core` looks like when jot is cloned and unbuilt. Testing merely that
    // the parent exists was wrong and said so out loud: for `../keel` the parent is this
    // repo's own parent directory, which always exists, so a completely missing keel was
    // reported as "cloned but not built" and would have sent somebody to run a build in a
    // folder that is not there. Found by driving all five states rather than by reading.
    state = fs.existsSync(path.join(path.dirname(target), "package.json")) ? "not-built" : "not-cloned";
  } else if (!fs.existsSync(path.join(target, "package.json"))) {
    state = "not-built";
  } else {
    // The source is there and the package does not resolve - a dangling link, or npm never
    // made one. Reached only because the resolvability test above already said no.
    state = "not-linked";
  }
  if (!state) {
    continue;
  }
  const sev = SEVERITY[name] || {
    fatal: true,
    why: "declared as a dependency of this repo",
    fix: `provide it at ${target}`,
    fixMissing: "run npm install",
  };
  problems.push({ name, spec, target, state, ...sev });
}

if (problems.length === 0) {
  process.exit(0);
}

const label = {
  "not-installed": "it is not in node_modules - the install never put it there",
  "not-cloned": "its folder does not exist",
  "not-built": "the folder is there but has no package.json - it looks cloned but not built",
  "not-linked": "the source is there, but node_modules has no working link to it (npm exits 0 on a dangling one)",
};

const fatal = problems.filter((p) => p.fatal);
const degraded = problems.filter((p) => !p.fatal);

const out = [];
out.push("");
out.push("Helm depends on packages that are not published, and some are not reachable:");
out.push("");
for (const p of [...fatal, ...degraded]) {
  out.push(`  ${p.name}  (${p.spec})`);
  out.push(`      ${label[p.state]}`);
  if (p.target) {
    out.push(`      expected at: ${p.target}`);
  }
  out.push(`      ${p.fatal ? "WITHOUT IT HELM DOES NOT START" : "without it Helm starts, degraded"}: ${p.why}`);
  out.push(`      fix: ${p.state === "not-installed" ? p.fixMissing || p.fix : p.fix}`);
  out.push("");
}
if (fatal.length) {
  out.push("Failing the install rather than letting it report success: the app cannot start, and");
  out.push("finding that out from a module-resolution error at first launch is worse than reading");
  out.push("this now.");
} else {
  out.push("Not failing the install: everything above degrades rather than breaking, and the app");
  out.push("says what is unavailable when you open it.");
}
out.push("");

process.stderr.write(out.join("\n"));
process.exit(fatal.length ? 1 : 0);
