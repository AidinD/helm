// The repository tells its reviewer what this codebase gets wrong.
//
// .no-mistakes.yaml lands as `review.path_instructions`, read by the gate from the DEFAULT
// branch only, never from the branch being reviewed - so a change cannot switch off the
// questions being asked about it. That only holds if the file actually parses and the field
// the gate reads is really there: a broken block scalar or a renamed key fails silently (the
// gate just asks fewer questions), which is exactly the "failed look rendered as an all-clear"
// class of bug this file itself warns against.
//
// PARSED, not grepped, same reasoning as test-the-app-lane-reports-when-it-matters.mjs: a
// config that does not parse is a config that silently stops applying.
//
// Run: node scripts/pure-checks/test-repo-review-instructions.mjs
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
const file = path.join(repo, ".no-mistakes.yaml");
ok(fs.existsSync(file), `.no-mistakes.yaml exists at the repo root (${file})`);
if (!fs.existsSync(file)) {
  console.log("");
  console.log("VERIFY FAILED: nothing below can be trusted without the file");
  process.exit(1);
}
const raw = fs.readFileSync(file, "utf8");

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
ok(!!doc && typeof doc === "object", `the file parses as YAML (${parseError || "ok"})`);
if (!doc || typeof doc !== "object") {
  console.log("");
  console.log("VERIFY FAILED: nothing below can be trusted if the file does not parse");
  process.exit(1);
}

// This is the exact field the gate reads (per the commit that introduced this file: "It lands
// as review.path_instructions"). A rename or a re-nest here is invisible in a diff review of
// the prose but means the gate reads nothing.
const entries = doc.review?.path_instructions;
ok(Array.isArray(entries) && entries.length > 0, `review.path_instructions is a non-empty array (${JSON.stringify(entries)})`);
if (!Array.isArray(entries) || entries.length === 0) {
  console.log("");
  console.log("VERIFY FAILED: nothing below can be trusted without at least one path_instructions entry");
  process.exit(1);
}

for (const [i, entry] of entries.entries()) {
  ok(
    typeof entry?.path === "string" && entry.path.length > 0,
    `entry ${i} has a non-empty string path (${JSON.stringify(entry?.path)})`
  );
  ok(
    typeof entry?.instructions === "string" && entry.instructions.trim().length > 0,
    `entry ${i} has non-empty instructions text`
  );
}

// "The glob is everything, deliberately" - these questions are not scoped to a directory, so at
// least one entry has to actually cover every path rather than a subtree.
const catchAll = entries.find((e) => e?.path === "**");
ok(!!catchAll, `at least one entry applies to every path (glob "**")`);

// A placeholder or truncated block scalar would still satisfy "non-empty string" above; this
// catches the file being present but hollow (e.g. a bad YAML indent silently swallowing all but
// the first line of the block).
if (catchAll) {
  ok(
    catchAll.instructions.length > 1000,
    `the catch-all instructions are substantial, not a stub or truncated block (${catchAll.instructions.length} chars)`
  );
  const paragraphs = catchAll.instructions.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  ok(
    paragraphs.length >= 3,
    `the catch-all instructions read as more than one flattened line (${paragraphs.length} paragraph(s) found)`
  );
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: .no-mistakes.yaml parses, review.path_instructions exists with real content, and a catch-all entry covers every path."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
