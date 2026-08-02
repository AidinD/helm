// Class-level check: EVERY durable store is redirected in a packaged build.
//
// The bug this exists to stop coming back (Aidin, task 7d9d2188): each store lib
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
// Run: node scripts/e2e/test-packaged-store-paths.mjs
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

const packagedSrc = fs.readFileSync(path.join(libDir, "packagedPaths.js"), "utf8");

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

// packagedPaths.js redirects them via setIfUnset("HELM_X_PATH", "file.json").
const redirected = new Set([...packagedSrc.matchAll(/setIfUnset\(\s*"(HELM_[A-Z0-9_]*)"/g)].map((m) => m[1]));

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
const targets = [...packagedSrc.matchAll(/setIfUnset\(\s*"HELM_[A-Z0-9_]*"\s*,\s*"([^"]+)"/g)].map((m) => m[1]);
const dupes = targets.filter((t, i) => targets.indexOf(t) !== i);
ok(dupes.length === 0, `every store gets its own file in the shared data dir (${JSON.stringify(dupes)})`);

console.log(
  fails === 0
    ? "\nVERIFY OK: no store can persist in dev but fail in the installed app - a new one without a redirect fails this test."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
