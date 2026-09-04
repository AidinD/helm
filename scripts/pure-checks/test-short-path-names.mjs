// Two spellings of one Windows directory compare equal, and the worktree boundary survives it.
//
// Windows gives every path component longer than eight characters an 8.3 short alias, so
// `longdirectoryname` is also `LONGDI~1`. The two share no common prefix, and no amount of
// lowercasing or separator folding makes them equal - which is why `normalizeFsPath` cannot
// close this and a filesystem call is required.
//
// This was not found by reading. It failed on a build machine whose account is `runneradmin`,
// where the temp directory handed to a process used the short spelling while git answered with
// the long one, and it produced two failures that both read as logic bugs:
//
//   - `removeWorktree` threw "<path> is not a registered worktree of <repo>" for a worktree
//     the same process had just registered, which stops the housekeeping sweep dead;
//   - a repository was reported as not being its own primary work tree, which is the guard
//     that decides whether a crew run may be dispatched into a path at all.
//
// The check builds a REAL alias rather than a fake one, because a hand-written "LONGDI~1"
// string would prove nothing about `realpathSync.native` actually resolving it. It is skipped
// on platforms without 8.3 aliasing, and skipped rather than passed if this filesystem has the
// feature turned off - a green tick from a machine that could not have failed is the exact
// false comfort this repo keeps removing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeFsPath, canonicalFsPath, sameFsPath } from "../../src/lib/fsPath.js";
import { classifyWorkTree } from "../../src/lib/primaryWorkTree.js";
import { createWorktree, removeWorktree } from "../../src/lib/worktree.js";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

if (process.platform !== "win32") {
  console.log("SKIP - 8.3 short names are a Windows filesystem feature");
  console.log("VERIFY OK: nothing to check on this platform.");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-shortname-"));
const LONG = "a-directory-name-far-longer-than-eight";

function shortAliasOf(parent, name) {
  // `dir /x` prints the 8.3 alias beside the long name. Parsed rather than guessed, because
  // the numeric suffix depends on what else in the folder collides.
  const out = execFileSync("cmd", ["/c", "dir", "/x", "/ad", parent], { encoding: "utf8", windowsHide: true });
  for (const line of out.split("\n")) {
    if (!line.includes(name)) {
      continue;
    }
    const m = line.match(/\s([A-Z0-9_~\-!#$%&'()@^`{}]{1,8}(?:\.[A-Z0-9_~]{1,3})?)\s+/);
    if (m && m[1].includes("~")) {
      return m[1];
    }
  }
  return null;
}

try {
  const longDir = path.join(tmp, LONG);
  fs.mkdirSync(longDir);
  const alias = shortAliasOf(tmp, LONG);

  if (!alias) {
    // Not a pass. 8.3 creation can be disabled per volume, and a machine with it off cannot
    // exercise the bug at all - saying so is the honest outcome.
    console.log(`SKIP - this volume produced no 8.3 alias for "${LONG}", so the bug is not reachable here`);
    console.log("VERIFY OK: skipped, not verified. Run this where 8.3 aliasing is enabled.");
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }

  const shortDir = path.join(tmp, alias);
  console.log(`      alias: ${LONG} -> ${alias}`);
  ok(fs.existsSync(shortDir), "the short alias really resolves to a directory - so both spellings are usable");

  // --- the string fold cannot do it, and the canonical one can ----------------------------
  ok(
    normalizeFsPath(longDir) !== normalizeFsPath(shortDir),
    "normalizeFsPath still sees two different folders, which is why it is not enough on its own"
  );
  ok(canonicalFsPath(longDir) === canonicalFsPath(shortDir), "canonicalFsPath folds them to one");
  ok(sameFsPath(longDir, shortDir), "and sameFsPath says they are the same folder");
  ok(sameFsPath(shortDir, longDir), "in both directions");

  // A path that does not exist must still be comparable, or a caller cannot ask about
  // something it has deleted.
  const gone = path.join(tmp, "never-created");
  ok(sameFsPath(gone, gone) === true, "a path that does not exist still compares equal to itself");
  ok(sameFsPath(gone, longDir) === false, "and unequal to a different one");
  ok(sameFsPath("", longDir) === false, "an empty path never matches a real one");

  // --- the boundary that decides whether a crew run may be dispatched ---------------------
  const repo = path.join(longDir, "repo");
  fs.mkdirSync(repo);
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "check@example.invalid"]);
  git(repo, ["config", "user.name", "Check"]);
  fs.writeFileSync(path.join(repo, "README.md"), "check\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "first"]);

  // Reached through the SHORT spelling, which is what a caller handed a temp path gets.
  const repoViaShort = path.join(shortDir, "repo");
  const classified = classifyWorkTree(repoViaShort);
  ok(classified.kind === "primary", `a repository reached through its short alias is still primary (${classified.kind}: ${classified.why})`);
  // EXACT, not sameFsPath. Comparing canonically here would pass whichever spelling came
  // back, so the assertion would not check the thing it claims - caught by mutating the
  // module and watching this stay green. The returned path is the module's ANSWER: it goes
  // into a refusal telling somebody where to point instead, and gets stored and compared by
  // callers that may not canonicalise. So it has to be the real one, not the caller's alias.
  ok(
    classified.primaryPath === fs.realpathSync.native(repo),
    `and it names the repository in its real spelling, not the alias it was reached through (${classified.primaryPath})`
  );
  ok(
    !classified.primaryPath.includes("~"),
    "so no short alias survives into a path that will be shown to a person or stored"
  );

  // --- the worktree registration check ----------------------------------------------------
  const wt = createWorktree(repo, "shortname-check");
  const worktreePath = typeof wt === "string" ? wt : wt.worktreePath || wt.path;
  ok(!!worktreePath && fs.existsSync(worktreePath), `a worktree was created (${worktreePath})`);

  const wtClassified = classifyWorkTree(worktreePath);
  ok(wtClassified.kind === "worktree", `the worktree is classified as one (${wtClassified.kind})`);
  ok(sameFsPath(wtClassified.primaryPath, repo), "and names the repository it belongs to");

  // THE failure this whole check exists for, and getting the scenario right took a mutation
  // run to discover. Passing the alias as the PROJECT path proves nothing: that argument is
  // only used to run git, never compared. The mismatch is on the WORKTREE side - git prints
  // its worktree list in the real spelling while the caller holds the alias - which is exactly
  // what the build machine's log showed, with both of its paths short and git's answer long.
  //
  // So address the worktree itself through the alias.
  const worktreeViaShort = worktreePath.replace(longDir, shortDir);
  ok(worktreeViaShort !== worktreePath, `the worktree can be named through the alias too (${worktreeViaShort})`);
  ok(fs.existsSync(worktreeViaShort), "and that spelling resolves to the same directory");

  let threw = null;
  try {
    removeWorktree(repoViaShort, worktreeViaShort);
  } catch (err) {
    threw = err && err.message;
  }
  ok(threw === null, `removeWorktree accepts a worktree named by its short alias (${threw || "no error"})`);
  ok(!fs.existsSync(worktreePath), "and the worktree is actually gone, so it removed rather than merely not complaining");
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
    ? "VERIFY OK: an 8.3 short alias and its long name are one folder to every comparison that decides a boundary."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
