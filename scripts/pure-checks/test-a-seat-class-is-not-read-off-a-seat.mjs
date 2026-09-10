/**
 * Nothing derives a seat CLASS from a seat record - the launch site decides.
 *
 * Run: node scripts/pure-checks/test-a-seat-class-is-not-read-off-a-seat.mjs
 *
 * WHY THIS EXISTS AT ALL, given it pins something nobody is trying to change. Until
 * 2026-09-10 seatTools.js opened by saying "the argument is the seat's own declared kind.
 * Today that is `kind`; when personas take over seat identity it becomes the persona". Both
 * halves were false: identity became a TAG on 2026-09-05, and no caller has ever passed a
 * seat's field - `main.js` passes two literals. So the file that decides what a seat may DO
 * sent its readers looking for a stored field that does not exist, and the next reader is
 * whoever lets the second standing seat in.
 *
 * The comment is corrected now, and a corrected comment is worth exactly as much as the last
 * one was. The property it describes is the checkable part: wire this to a seat record and
 * the paragraph goes stale again, silently, the same way. So the paragraph gets a check.
 *
 * IT DOES NOT PIN A SPELLING. Asserting that the word "kind" is absent would be the mistake
 * PR 22 cost a week to: three checks pinned a deprecated tool name, so the rename could not
 * fail anything. This asserts the SHAPE of the argument - a literal, not an expression - which
 * is the thing the sentence actually claims.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

// Commented-out code is not code. Leaving it in would let `// helmToolsForSeat(seat.kind)`
// fail this check, and - worse in the other direction - let a real call be hidden from it by
// nothing more than a stray block-comment opener.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...jsFilesUnder(full));
    } else if (/\.(js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// The function's OWN file is excluded: its two internal calls forward their parameters, which
// is the pass-through this check would otherwise read as a violation. The claim is about
// callers outside the module.
const SELF = path.join(SRC, "lib", "seatTools.js");
const files = jsFilesUnder(SRC).filter((f) => f !== SELF);

// Every call, with whatever sits between the parentheses. Nesting one call inside another
// would defeat this regex - and would also be a call whose argument is an expression, so it
// fails the assertion below rather than slipping past it.
const CALL = /helmToolsForSeat\s*\(([^()]*)\)/g;
const LITERAL = /^\s*(?:"[^"]*"|'[^']*'|`[^`${]*`)\s*$/;

const calls = [];
for (const file of files) {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  let m;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length;
    calls.push({ file: path.relative(SRC, file).split(path.sep).join("/"), line, arg: m[1] });
  }
}

// THE CONTROL GROUP, and it is the whole reason this check can be believed. A regex that
// matches nothing produces the same clean sweep as a codebase that obeys the rule perfectly,
// and the two are indistinguishable from the exit code. If the calls stop being found, that
// is a broken matcher until proven otherwise - never a pass.
ok(
  calls.length >= 2,
  "the scan actually found the calls it is meant to judge",
  `${calls.length} found: ${calls.map((c) => `${c.file}:${c.line}`).join(", ") || "NONE - the matcher is broken, not the code"}`
);

for (const c of calls) {
  ok(
    LITERAL.test(c.arg),
    `${c.file}:${c.line} passes a literal seat class, not something read off a seat`,
    `helmToolsForSeat(${c.arg.trim()})`
  );
}

// And the two constants the head comment names are still built from it, so the paragraph's
// account of WHERE the two sets come from does not quietly become the stale half.
const mainSrc = stripComments(fs.readFileSync(path.join(SRC, "main.js"), "utf8"));
for (const constant of ["STANDING_SEAT_TOOLS", "PROJECT_SEAT_TOOLS"]) {
  ok(
    new RegExp(`const\\s+${constant}\\s*=[^\\n]*helmToolsForSeat\\s*\\(`).test(mainSrc),
    `${constant} is still built by calling helmToolsForSeat`,
    "the head comment says both sets come from here"
  );
}

console.log(
  failures === 0
    ? "VERIFY OK: a seat class is a literal chosen at the launch site, never a field read off a seat record."
    : `VERIFY FAILED: ${failures} assertion(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
