// The prune veto, against REAL git. This is the test whose absence let a guard ship
// that could not fire even once (independent review, 2026-08-03).
//
// `git worktree prune` is repo-global: it deregisters EVERY worktree whose directory
// is gone, not just the one the sweep decided about. That matters most for a DETACHED
// worktree, whose HEAD is the only thing keeping its commit reachable - deregister it
// and the commit becomes collectable, which is exactly the loss the sweep's detached-
// worktree guard exists to prevent, reached from the side.
//
// The first version of the veto asked `git worktree prune --dry-run --verbose` and
// parsed quoted paths out of the result. git writes that report to STDERR, which the
// helper does not capture, and its lines carry neither quotes nor paths - so the match
// list was always empty, "everything is vouched for" was vacuously true, and the veto
// was an assertion that could not fail. The only coverage was two source-scans for the
// TEXT `pruneWorktrees(projectPath, {` and `onlyIfAllMatch:` - both of which passed
// while the behaviour was absent. Hence this file: behaviour, not spelling.
//
// Run:  node scripts/e2e/test-prune-veto-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listWorktrees, pruneWorktrees } from "../../src/lib/worktree.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-prune-veto-"));
const repo = path.join(tmp, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
const registered = () => listWorktrees(repo).map((w) => path.basename(w.path));

try {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-m", "init");

  const root = path.join(tmp, "repo-worktrees");
  // One worktree the sweep decided about...
  const mine = path.join(root, "helm-goal");
  git("worktree", "add", "-b", "helm/goal", mine);
  // ...and one DETACHED worktree holding a commit that lives on no branch at all.
  // Its commit is reachable only through this worktree's HEAD.
  const precious = path.join(root, "precious");
  git("worktree", "add", "--detach", precious);
  fs.writeFileSync(path.join(precious, "unsaved.txt"), "work on no ref\n");
  execFileSync("git", ["-C", precious, "add", "-A"], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["-C", precious, "commit", "-m", "on no ref"], { encoding: "utf8", windowsHide: true });
  const preciousSha = execFileSync("git", ["-C", precious, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

  // Both directories vanish, as they do when a worktree is deleted from outside
  // Helm or lives on a drive that is not mounted. Both are now prunable.
  fs.rmSync(mine, { recursive: true, force: true });
  fs.rmSync(precious, { recursive: true, force: true });
  ok(registered().length === 3, `git still has all three registrations (${registered().join(", ")})`);

  const prunableSeen = listWorktrees(repo).filter((w) => w.prunable).length;
  ok(prunableSeen >= 2, `listWorktrees reports git's own prunable verdict (${prunableSeen} prunable)`);

  // --- THE VETO ------------------------------------------------------------
  // Vouch for our own worktree only. The detached one is a stray, so nothing may
  // be pruned - not even the vouched one, because prune cannot be scoped.
  const res = pruneWorktrees(repo, { onlyIfAllMatch: (p) => path.resolve(p) === path.resolve(mine) });
  ok(res.pruned === false, `the veto FIRES when git would also drop a worktree we did not decide about (pruned=${res.pruned})`);
  ok(
    res.skipped.some((p) => path.basename(p) === "precious"),
    `and it names the stray that stopped it (${JSON.stringify(res.skipped.map((p) => path.basename(p)))})`
  );
  ok(registered().length === 3, `nothing was deregistered (${registered().join(", ")})`);

  // The whole point: the commit on no ref is still reachable.
  const stillThere = execFileSync("git", ["-C", repo, "cat-file", "-t", preciousSha], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  ok(stillThere === "commit", `the detached worktree's commit is still a live object (${stillThere})`);
  const unreachable = execFileSync("git", ["-C", repo, "fsck", "--unreachable"], {
    encoding: "utf8",
    windowsHide: true,
  });
  ok(!unreachable.includes(preciousSha), "and git does not consider it unreachable");

  // --- AND IT STILL PRUNES WHEN EVERYTHING IS VOUCHED FOR -------------------
  // The negative twin. Without this, "veto everything, always" would pass the test
  // above and the sweep would report the same phantom removal on every app start -
  // the bug the prune was added to fix.
  const res2 = pruneWorktrees(repo, { onlyIfAllMatch: () => true });
  ok(res2.pruned === true, `it DOES prune when every dropped registration was vouched for (pruned=${res2.pruned})`);
  ok(registered().length === 1, `both stale registrations are gone (${registered().join(", ")})`);

  // --- AND AN UNVOUCHED CALL IS UNGATED ------------------------------------
  // No onlyIfAllMatch means the caller accepts repo-global behaviour explicitly.
  const res3 = pruneWorktrees(repo);
  ok(res3.pruned === true, "a call with no vouching function still prunes (the gate is opt-in, by argument)");
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: the prune veto refuses when git would also deregister a worktree the sweep kept, the detached commit survives, and pruning still happens when everything is vouched for."
    : "VERIFY FAILED."
);
process.exit(exit);
