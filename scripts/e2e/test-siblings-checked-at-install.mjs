// A missing sibling package is reported at INSTALL time, and its severity matches the imports.
//
// This repo depends on two unpublished packages by `file:` path. npm leaves a dangling symlink
// and still exits 0, so an install reports success and the app dies on its first import - no
// window, no dialog. That is how somebody installed Helm and found it simply did not start.
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

// --- every file: dependency is classified -------------------------------------------------
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const siblings = Object.entries(deps)
  .filter(([, spec]) => String(spec).startsWith("file:"))
  .map(([name]) => name);
ok(siblings.length > 0, `there are file: dependencies to check (${siblings.join(", ")})`);
for (const name of siblings) {
  ok(script.includes(`"${name}"`) || new RegExp(`^\\s*${name}:`, "m").test(script), `${name} is classified in the check`);
}

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
