// Audit an ANONYMOUS CLONE, not the working tree - both the files it serves now and its
// whole history.
//
// GITHUB-PUSH.md rule 3 says to verify against a fresh clone, and rule 2 says a force-push
// does not remove anything: GitHub keeps serving old commits by sha. So "the file is clean
// today" and "the repo is clean" are different claims, and only the second one matters once
// something has been published.
//
// Usage: node spike/audit-public-clone.mjs <path-to-clone>
import { execFileSync } from "node:child_process";
import { privateTerms } from "keel/privacy";

const clone = process.argv[2];
if (!clone) {
  console.error("Pass the path to a clone.");
  process.exit(1);
}

const { terms, sources } = privateTerms({});
console.log(`${terms.length} private terms, from ${sources.length} source(s)`);
console.log(`auditing ${clone}\n`);

const git = (...args) => {
  try {
    return execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
};

let anyNow = 0;
let anyHistory = 0;
for (const term of terms) {
  // What it serves right now.
  const now = git("grep", "-l", "-i", "-F", term, "HEAD", "--")
    .split(/\r?\n/)
    .filter(Boolean).length;
  // What it has ever served. -S searches DIFFS, --grep searches MESSAGES, and a term that
  // only ever lived in a message returns zero from the first - that is how two leaks hid.
  const inDiffs = git("log", "--all", "-S", term, "--oneline").split(/\r?\n/).filter(Boolean).length;
  const inMessages = git("log", "--all", "--grep", term, "-i", "--oneline").split(/\r?\n/).filter(Boolean).length;
  if (now || inDiffs || inMessages) {
    console.log(`  ${term}`);
    console.log(`      files served now: ${now}   commits touching it: ${inDiffs}   commit messages: ${inMessages}`);
    anyNow += now;
    anyHistory += inDiffs + inMessages;
  }
}

console.log("");
if (anyNow === 0 && anyHistory === 0) {
  console.log("CLEAN - no private term appears in the served files or anywhere in the history.");
} else {
  console.log(`FOUND - ${anyNow} served file(s) and ${anyHistory} historical commit reference(s).`);
  console.log("A force-push does not remove the historical half: GitHub keeps serving old commits by sha.");
}
