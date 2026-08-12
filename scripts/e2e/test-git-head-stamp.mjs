// The stale-build pill used to start a git process every 45 seconds, forever, to ask a
// question whose answer almost never changes - ~70ms of blocked main process per tick on
// Windows, and in a PACKAGED build (no .git at all) it started git only to have it fail.
// gitHeadStamp replaced that with a cheap change detector, and git is now asked only when
// the detector says HEAD could have moved.
//
// That trade is only safe if the detector actually DETECTS. A stamp that quietly stopped
// changing would pin the pill to a boot-time answer and it would look exactly like a
// working feature - so this does not argue that the logic is right, it MUTATES a real
// repo (commit, branch switch, detach, repack) and asserts the stamp moved each time.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-git-head-stamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitHeadStamp } from "../../src/lib/version.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-headstamp-"));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
const commit = (name) => {
  fs.writeFileSync(path.join(root, name), name);
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", name);
};

try {
  // --- no repo at all: the packaged-build case -------------------------------
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "helm-norepo-"));
  ok(gitHeadStamp(bare) === "none", "a folder with no .git stamps 'none', so the caller can skip git entirely (the packaged build never spawns it again)");
  fs.rmSync(bare, { recursive: true, force: true });

  git("init", "-q", "-b", "main");
  commit("a.txt");
  const afterFirst = gitHeadStamp(root);
  ok(typeof afterFirst === "string" && afterFirst !== "none" && afterFirst !== null, "a real checkout produces a stamp");

  // --- a new commit on the current branch ------------------------------------
  // The one that matters most and the easiest to get wrong: .git/HEAD does NOT change
  // when a commit lands on the branch it already points at, so a stamp reading only
  // HEAD would sit still through every commit the captain makes.
  commit("b.txt");
  const afterSecond = gitHeadStamp(root);
  ok(afterSecond !== afterFirst, "a NEW COMMIT on the current branch changes the stamp (.git/HEAD alone would not have moved)");

  // --- an unchanged repo -----------------------------------------------------
  ok(gitHeadStamp(root) === afterSecond, "reading it again with nothing changed gives the same stamp - which is what makes the git call skippable");

  // --- a branch switch -------------------------------------------------------
  git("checkout", "-q", "-b", "other");
  const afterBranch = gitHeadStamp(root);
  ok(afterBranch !== afterSecond, "switching branch changes the stamp");

  // --- a detached HEAD -------------------------------------------------------
  const head = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", head);
  const afterDetach = gitHeadStamp(root);
  ok(afterDetach !== afterBranch, "detaching HEAD changes the stamp (the ref: line becomes a raw sha)");

  // --- packed refs -----------------------------------------------------------
  // After a repack the loose ref file is gone; a stamp that only read loose refs would
  // stop noticing commits from here on.
  //
  // The baseline is taken AFTER pack-refs on purpose. Taking it before made this assertion
  // pass for the wrong reason - pack-refs moves packed-refs' own mtime, so the stamp
  // differed because of the REPACK and the assertion said nothing at all about the commit
  // that followed it. It survived a mutation run that broke exactly this case, which is
  // how the weakness showed up.
  git("checkout", "-q", "main");
  git("pack-refs", "--all");
  const packedBaseline = gitHeadStamp(root);
  commit("c.txt");
  ok(gitHeadStamp(root) !== packedBaseline, "a commit made AFTER `git pack-refs --all` still changes the stamp - the packed-refs case is covered, not silently blind");

  // The packed-refs COMPONENT of the stamp, pinned on its own.
  //
  // The assertion above passes even without it, because committing recreates the loose ref
  // and the loose-ref read alone notices that. An independent review (2026-08-12) removed
  // packed-refs from the stamp entirely and this file stayed green - so the component was
  // justified in prose and covered by nothing. It matters in the state where the ref a
  // branch points to lives ONLY in packed-refs, which is exactly what a repack leaves
  // behind, so this touches that file directly rather than hoping a git command produces
  // the state.
  git("pack-refs", "--all");
  const packedOnlyBefore = gitHeadStamp(root);
  const packedRefsPath = path.join(root, ".git", "packed-refs");
  ok(fs.existsSync(packedRefsPath), "the repo really has a packed-refs file to key on");
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(packedRefsPath, future, future);
  ok(
    gitHeadStamp(root) !== packedOnlyBefore,
    "packed-refs moving on its own changes the stamp - without this the whole packed-refs half of the key could be deleted and every check here would still pass"
  );

  // --- a .git FILE (worktree/submodule shape) --------------------------------
  // Must report "cannot tell" (null), NOT a stable stamp: a stable stamp here would
  // cache the first answer forever in exactly the shape this cannot reason about.
  const fileRepo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-gitfile-"));
  fs.writeFileSync(path.join(fileRepo, ".git"), "gitdir: /somewhere/else\n");
  ok(gitHeadStamp(fileRepo) === null, "a .git FILE (worktree/submodule) stamps null = 'cannot tell', so the caller falls back to asking git every time instead of trusting a cache");
  fs.rmSync(fileRepo, { recursive: true, force: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: the stale-build change detector still fires on every way HEAD can move, so skipping the 45s git spawn does not blind the pill."
    : "VERIFY FAILED."
);
process.exit(exit);
