// Spike: does src/lib/worktree.js actually create/list/remove a real git
// worktree, with real filesystem + git state to show for it (not just "no
// error thrown")? De-risks the Phase 4 "treehouse" prerequisite before it's
// wired into any dispatch feature.
//
// Runs against a SCRATCH git repo created fresh under the OS temp dir, never
// against Helm's own working tree — so Helm's actual branch/worktree
// state is left completely untouched regardless of outcome. The scratch repo
// and its worktrees dir are removed at the end (including on failure).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktree,
  listWorktreePaths,
  worktreeExists,
  worktreesRootFor,
  hasUncommittedChanges,
  removeWorktree,
} from "../src/lib/worktree.js";

function log(msg) {
  console.log(`[spike] ${msg}`);
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`OK - ${msg}`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "helm-worktree-spike-"));
const projectPath = path.join(scratchRoot, "scratch-repo");
let worktreesRoot = null;

function cleanup() {
  log(`cleaning up scratch dir: ${scratchRoot}`);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

try {
  // --- Set up a real, minimal git repo to test against ---
  fs.mkdirSync(projectPath, { recursive: true });
  git(projectPath, ["init", "-q", "-b", "main"]);
  git(projectPath, ["config", "user.email", "spike@example.com"]);
  git(projectPath, ["config", "user.name", "Helm Spike"]);
  fs.writeFileSync(path.join(projectPath, "README.md"), "scratch repo for worktree spike\n");
  fs.writeFileSync(path.join(projectPath, ".env"), "SECRET=spike-value\n");
  fs.writeFileSync(path.join(projectPath, ".gitignore"), ".env\n.env.local\n");
  git(projectPath, ["add", "README.md", ".gitignore"]);
  git(projectPath, ["commit", "-q", "-m", "initial commit"]);
  log(`scratch repo created at ${projectPath}`);
  assert(
    git(projectPath, ["status", "--porcelain"]).trim() === "",
    "scratch repo starts with a clean working tree"
  );

  // --- 1. CREATE ---
  const { worktreePath, branchName, envFilesCopied } = createWorktree(projectPath, {
    id: "spike-wt-1",
  });
  worktreesRoot = worktreesRootFor(projectPath);
  log(`createWorktree returned: worktreePath=${worktreePath} branchName=${branchName}`);

  assert(fs.existsSync(worktreePath), "worktree directory actually exists on disk");
  assert(
    fs.existsSync(path.join(worktreePath, "README.md")),
    "worktree contains the tracked README.md file"
  );
  assert(
    fs.existsSync(path.join(worktreePath, ".env")),
    ".env was copied into the worktree (gnhf gap fix)"
  );
  assert(
    fs.readFileSync(path.join(worktreePath, ".env"), "utf8") ===
      fs.readFileSync(path.join(projectPath, ".env"), "utf8"),
    ".env content in the worktree matches the source repo byte-for-byte"
  );
  assert(envFilesCopied.includes(".env"), "createWorktree reports .env as copied");
  assert(!envFilesCopied.includes(".env.local"), ".env.local correctly NOT reported (doesn't exist in source)");

  // Confirm git itself (not just our own function) considers this a real worktree.
  const porcelain = git(projectPath, ["worktree", "list", "--porcelain"]);
  assert(porcelain.includes(worktreePath.replace(/\\/g, "/")) || porcelain.includes(worktreePath), "raw `git worktree list --porcelain` output includes the new worktree path");
  const branchInWorktree = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  assert(branchInWorktree === branchName, `worktree's checked-out branch is ${branchName} (git says: ${branchInWorktree})`);

  // --- 2. LIST ---
  const listed = listWorktreePaths(projectPath);
  log(`listWorktreePaths returned: ${JSON.stringify(listed)}`);
  assert(
    listed.some((p) => path.resolve(p) === path.resolve(worktreePath)),
    "listWorktreePaths includes the new worktree"
  );
  assert(
    listed.some((p) => path.resolve(p) === path.resolve(projectPath)),
    "listWorktreePaths also includes the primary working tree (git always lists it)"
  );
  assert(worktreeExists(projectPath, worktreePath), "worktreeExists() reports true for the new worktree");
  assert(
    !worktreeExists(projectPath, path.join(worktreesRoot, "does-not-exist")),
    "worktreeExists() reports false for a bogus path"
  );

  // --- 3. Fail-closed removal: uncommitted changes must block a plain remove ---
  fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted change\n");
  assert(hasUncommittedChanges(worktreePath), "hasUncommittedChanges() detects the untracked file");

  let blockedCorrectly = false;
  try {
    removeWorktree(projectPath, worktreePath);
  } catch (err) {
    blockedCorrectly = /uncommitted changes/i.test(err.message);
    log(`removeWorktree without force threw as expected: ${err.message}`);
  }
  assert(blockedCorrectly, "removeWorktree() refuses to remove a dirty worktree without force:true");
  assert(fs.existsSync(worktreePath), "worktree directory still exists after the blocked removal attempt");

  // --- 4. REMOVE (forced) ---
  removeWorktree(projectPath, worktreePath, { force: true });
  assert(!fs.existsSync(worktreePath), "worktree directory is actually gone from disk after forced removal");
  const listedAfterRemove = listWorktreePaths(projectPath);
  assert(
    !listedAfterRemove.some((p) => path.resolve(p) === path.resolve(worktreePath)),
    "git itself no longer lists the removed worktree"
  );
  assert(!worktreeExists(projectPath, worktreePath), "worktreeExists() reports false after removal");

  // --- 5. Removing an unregistered worktree should error, not silently no-op ---
  let unregisteredBlocked = false;
  try {
    removeWorktree(projectPath, worktreePath, { force: true });
  } catch (err) {
    unregisteredBlocked = /not a registered worktree/i.test(err.message);
  }
  assert(unregisteredBlocked, "removeWorktree() on an already-removed path errors clearly instead of no-op");

  log("ALL CHECKS PASSED");
} finally {
  cleanup();
  assert(!fs.existsSync(scratchRoot), "scratch dir fully removed after cleanup");
}
