// A missing sibling package is reported at INSTALL time, and its severity matches the imports.
//
// This repo depends on unpublished packages: one `file:` sibling and one git tag. npm leaves a
// dangling symlink for a missing sibling and still exits 0, so an install reports success and
// the app dies on its first import - no window, no dialog. That is how somebody installed Helm
// and found it simply did not start.
//
// THIS CHECK ITSELF FAILED THAT WAY ON 2026-09-05, which is why the scope is asserted below
// and not assumed. keel moved from `file:../keel` to a tag; the script picked what to check by
// filtering the dependencies for `file:`, so keel left the check silently - and this file went
// on printing "so the check calls a missing keel FATAL, and fails the install", and passing,
// because it was reading a severity entry the script could no longer reach. A green line
// describing something that is no longer happening is the defect, not the missing coverage.
//
// The point of this check is not that a script exists. It is that the script's JUDGEMENT still
// matches the code:
//
//   keel is FATAL because it is imported at the top of main.js and of atomicWrite.js, which
//   nearly everything imports. Make it lazy and this stops being fatal.
//
//   @jot/core DEGRADES because it is loaded lazily. Make it static again and an install that
//   only warns is a lie, exactly the one this whole thing was built to stop.
//
// So both severities are pinned to the import style they describe. A severity that outlives its
// reason is the same defect as prose describing a mechanism that moved - it just costs an
// install instead of a turn.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const script = read("scripts/check-siblings.mjs");

// --- it runs at install, or it runs never -------------------------------------------------
ok(
  (pkg.scripts?.postinstall || "").includes("check-siblings"),
  `the check is wired as postinstall (${pkg.scripts?.postinstall || "(not wired)"}) - a script nobody runs says nothing at install time`
);

// --- every unpublished dependency is IN SCOPE, however it is spelled -----------------------
// Driven against a fake tree further down rather than trusted from the filter here: what has
// to hold is that a declared package which does not resolve gets reported, and how the script
// picks what to look at is only one of the ways that can stop being true.
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const unpublished = Object.entries(deps).filter(([, spec]) =>
  ["file:", "github:", "git+"].some((prefix) => String(spec).startsWith(prefix))
);
ok(
  unpublished.length > 0,
  `there are unpublished dependencies to check (${unpublished.map(([n, v]) => `${n}=${v}`).join(", ")})`
);
for (const [name] of unpublished) {
  const classified = script.includes(`${name}: {`) || script.includes(`"${name}": {`);
  ok(classified, `${name} is classified in the check`);
}
// The line that makes the rest of this file honest. keel stopped being a file: dependency on
// 2026-09-05 and a check written against `file:` stopped looking at it that same minute, with
// nothing failing anywhere. If this assertion ever fails, the two below it need re-reading.
ok(
  !String(deps.keel || "").startsWith("file:"),
  `keel is not a file: sibling any more (${deps.keel}) - a check that selected on file: would not be looking at it`
);

// --- and the classification matches the imports -------------------------------------------
// The load-bearing half. Both directions, because a check that only asserted "keel is fatal"
// would pass just as happily if everything were marked fatal.
const mainJs = read("src/main.js");
const atomic = read("src/lib/atomicWrite.js");
const hostStore = read("src/lib/jotHostStore.js");

const keelStatic = /^import .*from "keel\//m.test(mainJs) || /^import[\s\S]{0,200}from "keel\//m.test(atomic);
ok(keelStatic, "keel really is imported statically at the top of a module nearly everything loads");
const keelEntry = script.slice(script.indexOf("  keel: {"), script.indexOf("},", script.indexOf("  keel: {")));
ok(/fatal: true/.test(keelEntry), "so the check calls a missing keel FATAL, and fails the install");

// `import("@jot/core")` inside a loader function, and NO static import of it at the top. The
// first version of this looked for `await import(` on the same line, which is not how the
// loader is written - so it failed against correct code, which is the same defect as passing
// against broken code and rather more annoying.
const jotLazy = /=\s*import\("@jot\/core"\)/.test(hostStore) && !/^import .*from "@jot\/core"/m.test(hostStore);
ok(jotLazy, "@jot/core really is loaded lazily, so its absence does not stop the app starting");
const jotEntry = script.slice(script.indexOf('  "@jot/core": {'), script.indexOf("},", script.indexOf('  "@jot/core": {')));
ok(/fatal: false/.test(jotEntry), "so the check does NOT fail the install for it - warning over failing, because failing over a degradation teaches people to skip the check");

// --- the three states are told apart, because they have three different fixes -------------
// Driven for real against a temp tree rather than asserted from the source: a message that
// sends somebody to build a folder that does not exist is worse than no message, and that is
// exactly what the first version of this script did.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-siblings-"));
// spawnSync, not execFileSync: the latter only surfaces stderr by THROWING, so a run that
// exits 0 came back with an empty message and four assertions about the warning text were
// quietly checking nothing at all. A warning is exactly the case that exits 0.
const runIn = (fakeRepo) => {
  const r = spawnSync(process.execPath, [path.join(fakeRepo, "scripts", "check-siblings.mjs")], { encoding: "utf8" });
  return { code: r.status, err: String(r.stderr || "") };
};
try {
  const fake = path.join(tmp, "helm");
  fs.mkdirSync(path.join(fake, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fake, "node_modules", "@jot"), { recursive: true });
  fs.copyFileSync(path.join(repo, "scripts", "check-siblings.mjs"), path.join(fake, "scripts", "check-siblings.mjs"));
  fs.writeFileSync(
    path.join(fake, "package.json"),
    JSON.stringify({ name: "helm", dependencies: { keel: "file:../keel", "@jot/core": "file:../jot/dist-core" } })
  );

  const nothing = runIn(fake);
  ok(nothing.code === 1, `with no siblings at all the install FAILS (exit ${nothing.code})`);
  ok(/does not exist/.test(nothing.err), "and says the folder does not exist rather than calling it unbuilt");
  ok(!/not built/.test(nothing.err.split("@jot")[0]), "so nobody is sent to run a build in a directory that is not there");
  ok(/git clone/.test(nothing.err), "and it names the command that fixes it");

  // keel present and linked: the fatal one is satisfied, so the install must SUCCEED while
  // still saying what is degraded.
  fs.mkdirSync(path.join(tmp, "keel"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "keel", "package.json"), "{}");
  fs.symlinkSync(path.join(tmp, "keel"), path.join(fake, "node_modules", "keel"), "junction");
  const degraded = runIn(fake);
  ok(degraded.code === 0, `with only the optional one missing the install SUCCEEDS (exit ${degraded.code})`);
  ok(/@jot\/core/.test(degraded.err), "and still says which package is missing");
  ok(/starts, degraded/.test(degraded.err), "and that the app starts without it, so the warning is not read as a failure");

  // THE LAYOUT THAT IS FINE AND USED TO FAIL. A package placed directly into node_modules
  // resolves perfectly well with no sibling directory anywhere - which is exactly how CI
  // provides keel. The first version of this check tested the file: TARGET first, so it
  // reported "not cloned" and failed the install for a package that was right there and
  // loadable. A check that refuses a working setup is worse than none: it gets switched off,
  // and then it is not there for the case it was written for.
  {
    const solo = path.join(tmp, "solo");
    fs.mkdirSync(path.join(solo, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(solo, "node_modules", "keel"), { recursive: true });
    fs.copyFileSync(path.join(repo, "scripts", "check-siblings.mjs"), path.join(solo, "scripts", "check-siblings.mjs"));
    fs.writeFileSync(path.join(solo, "package.json"), JSON.stringify({ name: "helm", dependencies: { keel: "file:../keel" } }));
    fs.writeFileSync(path.join(solo, "node_modules", "keel", "package.json"), JSON.stringify({ name: "keel" }));
    const resolvable = runIn(solo);
    ok(
      resolvable.code === 0,
      `a package sitting in node_modules with NO sibling directory passes (exit ${resolvable.code}) - resolvability is the rule, not where the source lives`
    );
    ok(resolvable.err.trim() === "", `and says nothing at all about it (${resolvable.err.trim().slice(0, 80) || "silent"})`);
  }

  // THE CASE THAT SILENTLY LEFT THE CHECK: a package declared by TAG that is not in
  // node_modules. There is no folder to diagnose and no sibling to clone, so the message has
  // to say the install never put it there and name npm install - and the exit code is still 1,
  // because a missing keel is fatal however it was going to arrive.
  {
    const tagged = path.join(tmp, "tagged");
    fs.mkdirSync(path.join(tagged, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tagged, "node_modules"), { recursive: true });
    fs.copyFileSync(path.join(repo, "scripts", "check-siblings.mjs"), path.join(tagged, "scripts", "check-siblings.mjs"));
    fs.writeFileSync(
      path.join(tagged, "package.json"),
      JSON.stringify({ name: "helm", dependencies: { keel: "github:AidinD/keel#v0.1.18" } })
    );
    const missing = runIn(tagged);
    ok(missing.code === 1, `a tagged keel that is not installed FAILS the install (exit ${missing.code})`);
    ok(/not in node_modules/.test(missing.err), "and says the install never put it there");
    ok(/npm install/.test(missing.err), "and names npm install rather than a clone that would not help");
    ok(!/expected at:/.test(missing.err), "and names no folder, because a tag does not come from one");

    // And it goes quiet once the package is loadable - the same rule as everywhere else here,
    // so this state cannot be satisfied by a sibling directory node never reads.
    fs.mkdirSync(path.join(tagged, "node_modules", "keel"), { recursive: true });
    fs.writeFileSync(path.join(tagged, "node_modules", "keel", "package.json"), JSON.stringify({ name: "keel" }));
    const installed = runIn(tagged);
    ok(installed.code === 0 && installed.err.trim() === "", `and passes once it is really there (exit ${installed.code})`);
  }

  // Cloned but not built is its own message, because its fix is a build and not a clone.
  fs.mkdirSync(path.join(tmp, "jot"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "jot", "package.json"), "{}");
  const unbuilt = runIn(fake);
  ok(/cloned but not built/.test(unbuilt.err), "a sibling that is cloned but not built is told apart from one that is absent");
  ok(/npm run build/.test(unbuilt.err), "and its fix names a build rather than a clone");

  // Built but not linked - the dangling-link case that started all of this.
  fs.mkdirSync(path.join(tmp, "jot", "dist-core"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "jot", "dist-core", "package.json"), "{}");
  const unlinked = runIn(fake);
  ok(/no working link/.test(unlinked.err), "and a source that node_modules cannot reach is told apart from both");

  fs.symlinkSync(path.join(tmp, "jot", "dist-core"), path.join(fake, "node_modules", "@jot", "core"), "junction");
  const healthy = runIn(fake);
  ok(healthy.code === 0 && healthy.err.trim() === "", `with everything in place it says nothing at all (exit ${healthy.code}, ${healthy.err.length} chars)`);
} catch (err) {
  fails += 1;
  console.log(`FAIL - the check threw: ${err && err.message}`);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // a leftover temp dir is harmless
  }
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: a missing sibling is named at install time, the three states are told apart, and each severity matches how the package is imported."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
