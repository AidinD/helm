// Class-level check: EVERY durable store is redirected in a packaged build.
//
// The bug this exists to stop coming back (the captain, task 7d9d2188): each store lib
// resolves its file as `process.env.HELM_<X>_PATH || <repo root>/<file>.json`.
// In dev the fallback is the repo root and everything works. In the INSTALLED
// app that same fallback lands inside the read-only application bundle, so every
// write throws - unless packagedPaths.js sets the env var.
//
// scheduledPrompts.js was added with its seam but never added to packagedPaths.js.
// Result: scheduling a prompt worked flawlessly in dev and failed in the installed
// app with "Could not write the scheduled-prompt queue". Nine of ten stores were
// redirected; the tenth was the newest one. That is the recurring shape - a class
// with one member added later and the registry not updated - so the guard has to
// be a sweep, not another single case.
//
// Run: node scripts/pure-checks/test-packaged-store-paths.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, "..", "..", "src", "lib");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

// The REGISTRY, imported rather than regexed out of packagedPaths.js. The list moved to its
// own module on 2026-09-11 so the E2E harness could read it too (it cannot import
// packagedPaths.js, which imports electron) - see storeSeams.js.
//
// The two sides of this check stay INDEPENDENT, which is the whole reason it works: one side
// is a sweep of the store libs' own source for `process.env.HELM_*_PATH|DIR`, the other is
// this registry. Deriving both from the registry would make it confirm itself.
const { REPO_ROOT_STORES } = await import("../../src/lib/storeSeams.js");

// Every HELM_*_PATH / HELM_*_DIR a store lib reads as its file location.
const declared = new Map(); // env var -> file that declares it
for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith(".js") && f !== "packagedPaths.js")) {
  const src = fs.readFileSync(path.join(libDir, file), "utf8");
  for (const m of src.matchAll(/process\.env\.(HELM_[A-Z0-9_]*(?:PATH|DIR))/g)) {
    if (!declared.has(m[1])) {
      declared.set(m[1], file);
    }
  }
}

ok(declared.size > 0, `found the store seams to check (${declared.size})`);

const redirected = new Set(REPO_ROOT_STORES.map(([envVar]) => envVar));

const missing = [...declared.entries()].filter(([envVar]) => !redirected.has(envVar));
ok(
  missing.length === 0,
  missing.length === 0
    ? `all ${declared.size} stores are redirected in a packaged build`
    : `these stores would write into the read-only app bundle when installed: ${missing
        .map(([v, f]) => `${v} (${f})`)
        .join(", ")}`
);

// The reverse: a redirect for a seam nobody reads is dead config and usually
// means a store was renamed and the registry half-updated.
const orphans = [...redirected].filter((v) => !declared.has(v));
ok(orphans.length === 0, `no redirect points at a seam no store reads (${JSON.stringify(orphans)})`);

// Each redirect must name a distinct file - two stores sharing one filename in
// ~/.helm would silently overwrite each other in the installed app only.
const targets = REPO_ROOT_STORES.map(([, fileName]) => fileName);
const dupes = targets.filter((t, i) => targets.indexOf(t) !== i);
ok(dupes.length === 0, `every store gets its own file in the shared data dir (${JSON.stringify(dupes)})`);

// AND THE SECOND READER, which is why the registry left packagedPaths.js at all: the E2E
// harness points every one of these at a throwaway directory so a check cannot write into
// the captain's real stores. The harness's own isolation was correct for config.json and
// absent for the other ten for months, and the only thing that made that visible was reading
// mates.json and finding three seats rooted in deleted temp directories.
//
// CALLED, NOT GREPPED. The first version of this asserted that the harness source mentioned
// `REPO_ROOT_STORES` - and a mutation replacing the import with `const REPO_ROOT_STORES = []`
// left it green while every store went back to the real files. A name is not a behaviour.
// storeIsolationEnv exists so this can be exercised without launching anything.
const { storeIsolationEnv } = await import("../../src/lib/storeSeams.js");
{
  const isolated = storeIsolationEnv({}, "/tmp/throwaway");
  const missing = REPO_ROOT_STORES.filter(([envVar]) => !isolated[envVar]);
  ok(
    missing.length === 0,
    missing.length === 0
      ? `an E2E run has all ${REPO_ROOT_STORES.length} stores pointed away from the repo root`
      : `these stores would be written for real by any check that does not override them: ${missing.map(([v]) => v).join(", ")}`
  );
  // Away from the REPO ROOT specifically - that is the failure, not "somewhere else".
  const atRepoRoot = Object.entries(isolated).filter(([, p]) => !p.includes("throwaway"));
  ok(atRepoRoot.length === 0, `and every one at the throwaway directory it was given (${JSON.stringify(atRepoRoot)})`);

  // A check's own fixture always wins: overriding a seam is a deliberate statement.
  const withOwn = storeIsolationEnv({ HELM_MATES_PATH: "/fixtures/mine.json" }, "/tmp/throwaway");
  ok(withOwn.HELM_MATES_PATH === undefined, "a check that points a seam at its own fixture is left alone");

  // And the packaged redirect owns the decision when it is the thing under test - two
  // mechanisms for one question, the explicit one wins. Without this, test-packaged-build
  // failed on the assertion that exists because a missing redirect broke the installed app.
  const packagedRun = storeIsolationEnv({ HELM_DATA_DIR: "C:/somewhere/.helm" }, "/tmp/throwaway");
  ok(
    Object.keys(packagedRun).length === 0,
    `a run testing the packaged redirect is not pre-empted (${JSON.stringify(packagedRun)})`
  );
}

// AND packagedPaths.js MUST ACTUALLY USE THE REGISTRY. This is the independence the earlier
// version of this file lost: it imported the registry and then checked the store libs against
// it, which says nothing about whether the packaged build reads the same list. Dropping the
// loop from packagedPaths.js survived a mutation for exactly that reason. The source is
// scanned because the module imports electron and cannot be loaded here.
const packagedSrc = fs.readFileSync(path.join(libDir, "packagedPaths.js"), "utf8");
const packagedBody = packagedSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
ok(
  /for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*REPO_ROOT_STORES\s*\)/.test(packagedBody),
  "the packaged build redirects by looping the registry, so a store added to it is redirected too"
);
// A leftover hand-written redirect is a second list, and a second list is the drift this
// module was extracted to end.
const handWritten = [...packagedBody.matchAll(/setIfUnset\(\s*"(HELM_[A-Z0-9_]*)"/g)].map((m) => m[1]);
ok(
  handWritten.length === 0,
  handWritten.length === 0
    ? "and names no seam by hand alongside it"
    : `packagedPaths.js still names these by hand, which can drift from the registry: ${handWritten.join(", ")}`
);

console.log(
  fails === 0
    ? "\nVERIFY OK: no store can persist in dev but fail in the installed app - a new one without a redirect fails this test."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
