// Has anything called a renamed MCP tool by its old name, and when?
//
// This is the measurement the aliases are waiting on. `helm_create_second_mate` and
// `helm_relay_to_second_mate` became `helm_open_project` and `helm_relay_to_project` on
// 2026-09-05, and the old names still answer - because renaming an MCP tool fails SILENTLY: a
// saved instruction or a running session calls the old name, the tool is not offered, and
// nothing errors anywhere.
//
// So the aliases come out on a number rather than on an assumption about who has switched.
// Run this, read the answer, and if the file is empty after a stretch of real use, the aliases
// are dead weight and can go. If it is not empty, it names what is still calling them.
//
// The absence of exactly this instrument is why helm_report_up could produce nothing for eight
// weeks with nobody able to say whether it had been called and refused or never called at all.
//
// Run:  node scripts/legacy-tool-calls.mjs
import path from "node:path";
import { readLegacyToolCalls } from "../src/lib/dispatchQueue.js";

// The same resolution main.js uses, kept simple: the meta-home is where the dispatch dirs are.
const metaHome = process.env.HELM_META_HOME || process.argv[2] || null;
if (!metaHome) {
  console.log("Usage: node scripts/legacy-tool-calls.mjs <meta-home>   (or set HELM_META_HOME)");
  console.log("The meta-home is the folder holding the CLAUDE.md your global one imports.");
  process.exit(2);
}

const calls = readLegacyToolCalls(metaHome);

if (calls.length === 0) {
  console.log(`No call has arrived under an old tool name.`);
  console.log(`Read from: ${path.join(metaHome, ".helm-dispatch", "legacy-tool-calls.jsonl")}`);
  console.log("");
  // AN EMPTY FILE IS NOT YET AN ANSWER, and saying so is the point of this script rather than
  // a caveat on it. Nothing recorded can mean nothing called, or it can mean nothing has run
  // since the rename. The second is the ordinary state on the day of a rename.
  console.log("That is not yet a reason to remove the aliases: nothing recorded also looks like");
  console.log("nothing having RUN since the rename. Come back after a stretch of real use.");
  process.exit(0);
}

const byName = new Map();
for (const c of calls) {
  const seen = byName.get(c.name) || { count: 0, first: c.at, last: c.at };
  seen.count += 1;
  seen.last = c.at;
  byName.set(c.name, seen);
}

console.log(`${calls.length} call(s) arrived under an old name:`);
for (const [name, seen] of byName) {
  console.log(`  ${name}  ${seen.count}x   first ${seen.first}   last ${seen.last}`);
}
console.log("");
console.log("Something is still calling these, so the aliases are load-bearing. Removing them");
console.log("now would break that caller with no error it can see.");
