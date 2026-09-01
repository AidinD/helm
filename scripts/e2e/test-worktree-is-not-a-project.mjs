/**
 * A run cannot be rooted in another run's worktree - and a capped run can still be continued.
 *
 * ## What happened
 *
 * Twice, a second mate dispatched a run whose PROJECT was another run's worktree. The captain, on
 * being told: "jag tror inte det ska kunna hända, kontrollera". It could.
 *
 * Two guards let it through, both asking a slightly different question from the one that
 * mattered. The dispatch resolver accepted any absolute path that exists, and a worktree
 * exists. runGoal validated with `git rev-parse --is-inside-work-tree`, and a worktree IS a
 * work tree - it asked whether the path is A work tree, not whether it is the repository's
 * PRIMARY one.
 *
 * Damage: none, measured rather than assumed. Both continuations built on their parents'
 * branches and nothing was lost. But a boundary that accepts itself as input is not a
 * boundary, it is a coincidence - and this coincidence cost 1.85 million tokens of fresh
 * input re-attempting work that was already paid for.
 *
 * ## Why this file tests two things that look unrelated
 *
 * Because they have to ship together. The mate was doing something reasonable: trying to
 * continue a capped run on its own branch, and pointing at the worktree was the only route it
 * had. Closing that route without giving crew a way to continue turns a capped job from
 * expensive into a dead end - and a dead end gets routed around, not obeyed.
 *
 * Run: node scripts/e2e/test-worktree-is-not-a-project.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyWorkTree, refuseIfNotPrimary } from "../../src/lib/primaryWorkTree.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-wtproj-"));
const repo = path.join(root, "repo");
const worktree = path.join(root, "repo-worktrees", "goal-abc");
fs.mkdirSync(repo, { recursive: true });
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
git(repo, "init", "-q");
git(repo, "config", "user.email", "p@p");
git(repo, "config", "user.name", "p");
fs.writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "seed");
git(repo, "worktree", "add", "-q", worktree, "-b", "helm/goal-abc");

// --- the two are told apart, which the old check could not do ------------------------
{
  const primary = classifyWorkTree(repo);
  ok(primary.kind === "primary", "the repository is the primary work tree", primary.kind);
  ok(path.resolve(primary.primaryPath) === path.resolve(repo), "and names itself", primary.primaryPath);

  const linked = classifyWorkTree(worktree);
  ok(linked.kind === "worktree", "a linked worktree is NOT primary", linked.kind);
  // The point of naming it: the refusal can say where to go instead.
  ok(path.resolve(linked.primaryPath) === path.resolve(repo), "and it names the repository it belongs to", linked.primaryPath);

  // The old question, on the same path, to show it could not have caught this.
  const insideWorkTree = git(worktree, "rev-parse", "--is-inside-work-tree").trim();
  ok(insideWorkTree === "true", "while the check that was there answers 'true' for it - which is why it let this through");
}

// --- a subdirectory is not a repository of its own -------------------------------------
// The first version of the classifier returned the input as the "primary path", so
// <repo>/src came back as its own repository - a wrong answer under a confident name.
{
  const sub = path.join(repo, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const seen = classifyWorkTree(sub);
  ok(seen.kind === "primary", "a subdirectory of the repository is still primary");
  ok(path.resolve(seen.primaryPath) === path.resolve(repo), "but its primary path is the work-tree ROOT, not itself", seen.primaryPath);
}

// --- the refusal is usable, not just correct ---------------------------------------------
{
  const refusal = refuseIfNotPrimary(worktree, { what: "A dispatch" });
  ok(typeof refusal === "string", "a worktree is refused");
  ok(refusal.includes(path.resolve(repo)), "and the message names the repository to point at instead");
  // A refusal with no route is what gets routed around. The mate that hit this had a real
  // goal - carry on work already on a branch - and needs to be told where that lives.
  ok(/resume that run/i.test(refusal), "and points at resuming rather than starting over");
  ok(refuseIfNotPrimary(repo) === null, "the repository itself is not refused");
  ok(typeof refuseIfNotPrimary(path.join(root, "nowhere")) === "string", "and a path that does not exist is refused too");
}

// --- both guards actually consult it -------------------------------------------------------
// The join. Two guards let this through; a fix in only one of them leaves the other open.
{
  const orchestrator = fs.readFileSync(new URL("../../src/lib/goalOrchestrator.js", import.meta.url), "utf8");
  ok(/refuseIfNotPrimary\(projectPath/.test(orchestrator), "runGoal asks the primary-work-tree question");
  ok(!/"--is-inside-work-tree"/.test(orchestrator), "and no longer asks the one that answered yes to a worktree");
  // The exemption that keeps a resume working - a resume re-attaches to a worktree ON PURPOSE.
  ok(/if \(!resume\) \{[\s\S]{0,200}refuseIfNotPrimary/.test(orchestrator), "while a resume is exempt, since that is the one legitimate way to be rooted in one");

  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/classifyWorkTree\(resolved\)/.test(main), "the dispatch resolver checks the escape-hatch path");
  ok(/refuseIfNotPrimary\(path\.resolve\(request\.project\)/.test(main), "and the dispatch refusal names the repository rather than saying 'unknown project'");
}

// --- and crew can still continue a capped run ------------------------------------------------
// The half without which the fix makes things worse.
{
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/allowCapped/.test(main), "a run that hit its iteration cap can be continued when named");
  ok(/max_iterations_reached/.test(main), "and the capped state is what that recognises");
  // Named, not blanket: marking capped runs resumable in general would make one no-argument
  // call restart every one of them.
  ok(/request\.goalRunId/.test(main), "the continuation is by explicit run id");
  ok(/only continue your own crew/.test(main), "and a mate can only continue its own crew");

  const server = fs.readFileSync(new URL("../../src/mcp/helmDispatchServer.js", import.meta.url), "utf8");
  ok(/goalRunId: \{/.test(server), "the tool a second mate calls accepts that id");
  ok(/ran out of iterations/.test(server), "and its description says this is the way to carry on a capped run");
}

git(repo, "worktree", "remove", "--force", worktree);
fs.rmSync(root, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a worktree is refused as a project, the refusal names the repository, and a capped run can still be continued.");
