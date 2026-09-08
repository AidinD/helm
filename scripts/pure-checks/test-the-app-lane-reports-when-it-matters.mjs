// The app lane runs when something becomes true on main, not only overnight.
//
// WHY THIS IS PINNED. On 2026-09-07 a change adding a widget to the seedable list broke an
// assertion in the DOCS-STALENESS check - a coupling nobody would have predicted. It merged at
// nine in the evening. The nightly schedule found it at six the next morning. It reached the
// captain only because he opened GitHub himself and looked. Nine hours, and the last hop was
// luck.
//
// The lane was doing its job the whole time; the CADENCE was the gap. So the trigger is now
// part of what the suite protects, the same way test-siblings-checked-at-install.mjs asserts
// that the install check is actually wired as postinstall - a check nobody runs says nothing,
// and a lane that reports a day late says it a day late.
//
// WHAT THIS DOES NOT CLAIM. That the lane passes, or that it covers everything. It covers 161
// of 163 app checks and names the excluded ones (see scripts/ci-app-lane-plan.mjs, and the
// check next to it that keeps that list honest). This file is only about WHEN it speaks.
//
// Run: node scripts/pure-checks/test-the-app-lane-reports-when-it-matters.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${what}`);
  if (!cond) {
    fails += 1;
  }
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = path.join(repo, ".github", "workflows", "app-lane.yml");
const raw = fs.readFileSync(file, "utf8");

// PARSED, not grepped. A workflow file that does not parse is a workflow that silently never
// runs - which is this same failure with the volume turned all the way down - so the first
// thing to establish is that GitHub can read it at all.
let load = null;
let loadError = null;
try {
  ({ load } = await import("js-yaml"));
} catch (err) {
  loadError = err?.message || String(err);
}
ok(!!load, `the YAML parser is installed (${loadError ? `${loadError} - run npm install` : "ok"})`);
if (!load) {
  console.log("");
  console.log("VERIFY FAILED: nothing below can be trusted without the parser - run npm install");
  process.exit(1);
}

let doc = null;
let parseError = null;
try {
  doc = load(raw);
} catch (err) {
  parseError = err?.message || String(err);
}
ok(!!doc, `the workflow parses as YAML (${parseError || "ok"})`);
if (!doc) {
  console.log("");
  console.log("VERIFY FAILED: nothing below can be trusted if the file does not parse");
  process.exit(1);
}

// `on:` is the YAML 1.1 boolean `true` once loaded, which is a real trap: reading doc.on gives
// undefined and every assertion below would then pass vacuously against an empty object. Both
// spellings are read, and the one that exists is asserted to exist.
const triggers = doc.on ?? doc[true] ?? null;
ok(!!triggers, "and its trigger block is readable (YAML turns a bare `on` into the boolean true)");

const pushBranches = triggers?.push?.branches || [];
ok(
  Array.isArray(pushBranches) && pushBranches.includes("main"),
  `the lane runs on push to main (${JSON.stringify(pushBranches)}) - the nine-hour gap this closes was a merge at 21:00 found at 06:00`
);

ok(
  !triggers?.push?.["paths-ignore"] && !triggers?.push?.paths,
  "with no path filter, because which files can break which checks is exactly the prediction that has been wrong twice"
);

// The schedule STAYS. It is not redundant: it catches what a push cannot - a flake that only
// shows under another runner's load, and a break that arrives from outside a commit, like an
// action version moving or a dependency's tag being repointed underneath us.
const schedule = triggers?.schedule || [];
ok(
  Array.isArray(schedule) && schedule.length > 0 && schedule.every((s) => typeof s?.cron === "string"),
  `the nightly schedule is still there as a backstop (${JSON.stringify(schedule.map((s) => s?.cron))})`
);

// And by hand, which is how a fix gets verified without waiting for either.
ok("workflow_dispatch" in (triggers || {}), "and it can still be run by hand");

// NOT A GATE, asserted rather than trusted to the comment that says so. A read-only lane that
// quietly gained write permissions would be a different thing wearing the same name.
ok(
  doc.permissions && doc.permissions.contents === "read",
  `it stays read-only (${JSON.stringify(doc.permissions)})`
);
ok(
  Object.keys(doc.permissions || {}).length === 1,
  `with no other permission granted (${Object.keys(doc.permissions || {}).join(",") || "none"})`
);

// The cancellation behaviour is deliberate and worth pinning, because it decides what Helm's own
// CI widget shows during a burst of merges: the newest run wins, the superseded one reports
// `cancelled`, and the widget reads that as unknown rather than as a stale green.
ok(
  doc.concurrency?.["cancel-in-progress"] === true,
  `a newer run supersedes an older one on the same ref (${JSON.stringify(doc.concurrency || null)})`
);

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: the app lane speaks when something becomes true on main, keeps the nightly as a backstop, can be run by hand, and is still read-only."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
