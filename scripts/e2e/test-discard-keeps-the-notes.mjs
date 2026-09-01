/**
 * Rolling back a failed iteration must not delete the log that says why it failed.
 *
 * ## What the history said
 *
 * Card bf2c01df: five runs have status `error`, four of them the same shape - "ENOENT: no
 * such file or directory, open '...\\.helm-goal\\notes.md'" - across two different projects,
 * with stoppedReason null on all of them, and nobody had looked. The card's own guess was
 * worktree dependency provisioning, and said so as a guess to be verified rather than
 * assumed.
 *
 * It was not that. Reading the records first: all four are from 2026-07-12, and three of
 * them started within FOUR SECONDS of each other - one batch of second-mate dispatches, all
 * dying the same way, none of them past its first iteration.
 *
 * ## What it actually was
 *
 * Every failure path in the loop rolls the worktree back and then writes the failure to
 * notes.md, in that order:
 *
 *     discardWorktreeChanges(worktreePath);   // git reset --hard; git clean -fd
 *     appendNotes(worktreePath, i, result);
 *
 * Until the first successful iteration commits, .helm-goal/ is UNTRACKED. `reset --hard`
 * leaves it alone; `clean -fd` deletes the whole directory. appendFileSync creates a missing
 * file but not a missing parent, so the next line throws ENOENT, nothing catches it, and the
 * run dies with status "error" and no stoppedReason - which is exactly the shape in the
 * history. A run whose first iteration failed therefore destroyed the record of WHY, and
 * then died of the destruction.
 *
 * Reproduced end to end before anything was changed: a real repo, a real worktree, a real
 * reset+clean, a real append. That reproduction is the first half of this check.
 *
 * ## Why the exclusion and not just a mkdir
 *
 * The mkdir alone would stop the crash and keep the deeper bug: this discard exists to throw
 * away the AGENT's work, and .helm-goal/ is the ORCHESTRATOR's own log - the only thing
 * carrying knowledge between fresh-context iterations. Deleting it on failure is backwards,
 * because a failure is when the next iteration most needs to be told what was tried. The
 * mkdir stays as a belt: the cost of being wrong is a whole run.
 *
 * Run: node scripts/e2e/test-discard-keeps-the-notes.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "..", "src", "lib", "goalOrchestrator.js"), "utf8");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });

/** A real repo with a real linked worktree, matching what a run works in. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-discard-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# scratch\n", "utf8");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "e2e@helm.local");
  git(repo, "config", "user.name", "helm e2e");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed");
  const wt = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "helm/goal-discard-check", wt);
  return { root, repo, wt };
}

// --- the bug, reproduced: the OLD discard destroys the log and then the run --------------
{
  const { root, wt } = scratch();
  const dir = path.join(wt, ".helm-goal");
  const notes = path.join(dir, "notes.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(notes, "# Goal orchestrator notes\n", "utf8");
  // The agent's own work, which the discard is genuinely meant to throw away.
  fs.writeFileSync(path.join(wt, "agent-scratch.txt"), "half-finished\n", "utf8");

  git(wt, "reset", "--hard");
  git(wt, "clean", "-fd"); // the old command, verbatim

  ok(!fs.existsSync(notes), "reproduced: the old `git clean -fd` deletes the orchestrator's own notes.md");
  let threw = null;
  try {
    fs.appendFileSync(notes, "iteration 1 failed\n", "utf8");
  } catch (err) {
    threw = err;
  }
  ok(!!threw && threw.code === "ENOENT", "and the very next line - appending the failure to notes.md - throws ENOENT, which is what killed the four runs");
  fs.rmSync(root, { recursive: true, force: true });
}

// --- the fix: the same rollback, keeping the log ------------------------------------------
{
  const { root, wt } = scratch();
  const dir = path.join(wt, ".helm-goal");
  const notes = path.join(dir, "notes.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(notes, "# Goal orchestrator notes\n", "utf8");
  fs.writeFileSync(path.join(dir, "plan.md"), "1. do the thing\n", "utf8");
  const agentFile = path.join(wt, "agent-scratch.txt");
  fs.writeFileSync(agentFile, "half-finished\n", "utf8");
  // Agent work in a subdirectory too: `clean -fd` removes directories, and an exclusion
  // that only saved loose files would still take a new source folder with it.
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "new.js"), "export const x = 1;\n", "utf8");

  git(wt, "reset", "--hard");
  git(wt, "clean", "-fd", "-e", ".helm-goal"); // the new command, verbatim

  ok(fs.existsSync(notes), "the log survives the rollback");
  ok(fs.existsSync(path.join(dir, "plan.md")), "and so does the plan beside it - the whole directory is the continuity mechanism, not one file");
  // The half that must NOT change: this is still a rollback.
  ok(!fs.existsSync(agentFile), "while the agent's own leftover file is still discarded");
  ok(!fs.existsSync(path.join(wt, "src", "new.js")), "including one it created in a new directory");
  fs.appendFileSync(notes, "iteration 1 failed\n", "utf8");
  ok(/iteration 1 failed/.test(fs.readFileSync(notes, "utf8")), "and the failure can be written down, which is the point");
  fs.rmSync(root, { recursive: true, force: true });
}

// --- the appendNotes belt ------------------------------------------------------------------
{
  const { root, wt } = scratch();
  const notes = path.join(wt, ".helm-goal", "notes.md");
  // No .helm-goal at all, the state the old clean left behind.
  ok(!fs.existsSync(path.dirname(notes)), "starting from no .helm-goal directory at all");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.appendFileSync(notes, "written anyway\n", "utf8");
  ok(fs.existsSync(notes), "a mkdir before the append is enough to survive it, whatever removed the directory");
  fs.rmSync(root, { recursive: true, force: true });
}

// --- both changes are actually in the source -----------------------------------------------
{
  ok(/runGit\(worktreePath, \["clean", "-fd", "-e", NOTES_DIR\]\)/.test(src), "the discard excludes the notes directory");
  ok(!/runGit\(worktreePath, \["clean", "-fd"\]\)/.test(src), "and no bare `clean -fd` is left anywhere in the orchestrator");
  ok(/function appendNotes[\s\S]{0,600}fs\.mkdirSync\(path\.dirname\(file\), \{ recursive: true \}\)/.test(src), "appendNotes creates the directory before writing");
  // The ordering that made the crash fatal rather than cosmetic: the rollback runs first.
  ok(/discardWorktreeChanges\(worktreePath\);\s*\n\s*appendNotes\(worktreePath/.test(src), "the rollback still runs before the notes are written, so the exclusion is what protects them");
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: a rolled-back iteration keeps the log that says why it failed, and still discards the agent's work." : "VERIFY FAILED.");
process.exit(exit);
