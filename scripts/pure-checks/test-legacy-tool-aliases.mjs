// A renamed MCP tool still answers to its old name, and every such call is written down.
//
// WHY AN ALIAS AT ALL. Renaming an MCP tool fails SILENTLY. A saved instruction or a running
// session calls the old name, the tool is not in the advertised list, and nothing errors
// anywhere - the seat behaves as though it never occurred to it. That is the same class as a
// tool that produced nothing for eight weeks with nobody noticing, and the same class as a
// narrowed allowlist removing a capability from a live seat.
//
// WHY A RECORD. Without one, the aliases become permanent by default: nobody can say whether
// anything still calls the old names, so nobody can justify removing them. The record is what
// turns that into a number. ONLY old names are recorded, so an empty file IS the answer -
// nothing to filter and nothing to interpret.
//
// AND THE RECORD IS NEVER A GATE. A failure to write must not stop the call, or the mechanism
// meant to keep a rename working becomes the thing that breaks it.
//
// Run:  node scripts/pure-checks/test-legacy-tool-aliases.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_TOOL_ALIASES, CROSS_PROJECT_TOOLS, helmToolsForSeat } from "../../src/lib/seatTools.js";
import { recordLegacyToolCall, readLegacyToolCalls } from "../../src/lib/dispatchQueue.js";

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

// --- the map itself --------------------------------------------------------------------------
const olds = Object.keys(LEGACY_TOOL_ALIASES);
ok(olds.length === 2, `two tools were renamed (${olds.length})`);
for (const [oldName, newName] of Object.entries(LEGACY_TOOL_ALIASES)) {
  ok(
    CROSS_PROJECT_TOOLS.includes(newName),
    `${oldName} maps to ${newName}, which is a tool the standing seat actually has`
  );
  ok(!CROSS_PROJECT_TOOLS.includes(oldName), `and the old name is not itself in the current set`);
}

// --- THE OLD NAMES STAY PRE-APPROVED, which is the half an allowlist would silently undo ------
const standing = helmToolsForSeat("standing");
for (const oldName of olds) {
  ok(standing.includes(oldName), `a standing seat may still call ${oldName} - or the alias never gets reached`);
}
for (const newName of CROSS_PROJECT_TOOLS) {
  ok(standing.includes(newName), `and it may call ${newName}`);
}
// A project seat gets neither, old or new. An alias must not become a way around the tier.
const project = helmToolsForSeat("project");
for (const name of [...olds, ...CROSS_PROJECT_TOOLS]) {
  ok(!project.includes(name), `a project seat may not call ${name} - an alias is not a way around the tier`);
}

// --- the record -------------------------------------------------------------------------------
const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-legacy-calls-"));
try {
  ok(readLegacyToolCalls(metaHome).length === 0, "nothing recorded before anything is called");

  ok(recordLegacyToolCall(metaHome, "helm_create_second_mate", { now: 1_700_000_000_000 }) === true, "a call is recorded");
  recordLegacyToolCall(metaHome, "helm_relay_to_second_mate", { now: 1_700_000_060_000 });
  recordLegacyToolCall(metaHome, "helm_create_second_mate", { now: 1_700_000_120_000 });

  const calls = readLegacyToolCalls(metaHome);
  ok(calls.length === 3, `all three are there, appended rather than overwritten (${calls.length})`);
  ok(
    calls[0].name === "helm_create_second_mate" && calls[2].name === "helm_create_second_mate",
    "in the order they happened, so 'last called' is answerable"
  );
  ok(typeof calls[0].at === "string" && calls[0].at.includes("T"), `each carries when (${calls[0].at})`);

  // A TORN LINE MUST NOT LOSE THE REST. The server is one short-lived process per session, so a
  // half-written append is reachable, and a reader that threw would turn a partial record into
  // no record at all - which reads as "nothing ever called it".
  fs.appendFileSync(path.join(metaHome, ".helm-dispatch", "legacy-tool-calls.jsonl"), '{"name":"tor\n', "utf8");
  recordLegacyToolCall(metaHome, "helm_relay_to_second_mate", { now: 1_700_000_180_000 });
  const afterTear = readLegacyToolCalls(metaHome);
  ok(afterTear.length === 4, `a torn line is skipped and the rest survive (${afterTear.length})`);

  // NEVER A GATE. An unwritable destination returns false and says nothing else.
  ok(recordLegacyToolCall("", "helm_create_second_mate") === false, "no meta-home means no record and no throw");
  ok(recordLegacyToolCall(metaHome, "") === false, "and neither does a nameless call");
} finally {
  fs.rmSync(metaHome, { recursive: true, force: true });
}

// --- what a fresh session is OFFERED, which is where the rename actually lives -----------------
//
// Read from source: the advertised list is built at module load and the server is not
// importable without its environment. This proves the old names are not advertised - a fresh
// session never learns them - while the switch still accepts them.
const serverSrc = fs
  .readFileSync(new URL("../../src/mcp/helmDispatchServer.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

for (const oldName of olds) {
  ok(
    !new RegExp(`name:\\s*"${oldName}"`).test(serverSrc),
    `${oldName} is not advertised - a fresh session never learns it`
  );
}
for (const newName of CROSS_PROJECT_TOOLS) {
  ok(new RegExp(`name:\\s*"${newName}"`).test(serverSrc), `${newName} is`);
}
ok(/LEGACY_TOOL_ALIASES\[name\]/.test(serverSrc), "and the call path consults the alias map before the switch");
ok(/recordLegacyToolCall\(/.test(serverSrc), "and records the call when it takes that path");

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - old names still answer, are not advertised, are recorded, and never reach a project seat");
