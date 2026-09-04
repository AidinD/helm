/**
 * The property that earns a crew run its bypassed permissions is now enforced, not described.
 *
 * ## The claim, and where it was made
 *
 * A crew iteration launches with `--permission-mode bypassPermissions`, and the comment
 * justifying that says in as many words: "Bypassing is SAFE precisely because every iteration
 * runs inside the isolated, never-pushed worktree - that isolation is what earns the bypass."
 * The tool description a first mate reads before dispatching says the same thing: the run
 * "never pushes/merges".
 *
 * Both were true of the MODULE, which really never pushes, and false of the RUN. A crew
 * iteration has a shell, bypassed permissions, and a worktree that shares the repository's
 * remotes; the tier guard covered first and second mates and said so explicitly - "Crew, the
 * captain's own sessions, and anything untiered are untouched". Nothing stopped `git push`.
 *
 * Found on 2026-09-01 while auditing what Helm's instruction files claim about Helm. It is
 * the worst shape a claim can have: not merely untrue, but load-bearing for a decision made
 * somewhere else, so removing the sentence would have removed the justification and left the
 * risk.
 *
 * ## What is checked, in both directions
 *
 * That the exits are closed, and - just as hard - that nothing else is. Crew IS the work: a
 * guard that made it ask before writing or committing would break the tier and get switched
 * off, which is how a real fence becomes no fence.
 *
 * Run: node scripts/e2e/test-crew-cannot-leave-its-worktree.mjs
 */
import fs from "node:fs";
import { decideToolCall, shellLeavesWorktree, TIER_CREW, TIER_SECOND_MATE } from "../../src/lib/tierGuard.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const decide = (command) => decideToolCall({ tier: TIER_CREW, tool: "Bash", input: { command } });

// --- the exits, closed ---------------------------------------------------------------
{
  const mustDeny = [
    "git push",
    "git push origin main",
    "git push --force origin HEAD",
    "git -C . push",
    "git remote add mine https://example.invalid/x.git",
    "git submodule add https://example.invalid/y.git",
    "gh pr create --fill",
    "gh release create v1",
    // Wrapped, chained and prefixed - the shapes an agent reaches for when the plain one
    // is refused. Two seats have walked around a deny list in this project before.
    "cd /somewhere && git push",
    "echo hi; git push origin main",
    "GIT_SSH_COMMAND=ssh git push",
  ];
  for (const command of mustDeny) {
    const r = decide(command);
    ok(r.decision === "deny", `refused: ${command}`);
  }
  ok(/worktree/i.test(decide("git push").reason || ""), "and the refusal explains the isolation rather than just saying no");
  // Not a dead end: crew's work is meant to be committed and read, so the refusal has to
  // say what to do instead or it reads as "your work is worthless".
  ok(/Commit your work/i.test(decide("git push").reason || ""), "and says what to do instead");
}

// --- and nothing else is ----------------------------------------------------------------
// Crew is the tier that does the work. A guard that made it ask before writing would break
// the tier, and a broken guard gets switched off.
{
  const mustAllow = [
    "git commit -m \"the work\"",
    "git add -A",
    "git checkout -b helm/goal-x",
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1",
    "npm test",
    "npm run build",
    "node scripts/thing.mjs",
    "rm -rf node_modules",
    "echo something > file.txt",
    // Near-misses that must not trip the matcher.
    "git pushx",
    "echo 'git push' >> notes.md",
    "grep -r push src/",
  ];
  for (const command of mustAllow) {
    const r = decide(command);
    ok(r.decision === "allow", `allowed: ${command}`, r.reason ? String(r.reason).slice(0, 60) : "");
  }
  ok(decideToolCall({ tier: TIER_CREW, tool: "Edit", input: {} }).decision === "allow", "and editing a file is never this guard's business");
  ok(decideToolCall({ tier: TIER_CREW, tool: "Write", input: {} }).decision === "allow", "nor writing one");
}

// --- an unreadable command fails CLOSED --------------------------------------------------
// Same trade the read-only question already makes: a false block costs one command, a miss
// costs work landing on a remote nobody reviewed.
{
  const why = shellLeavesWorktree('git push "unterminated');
  ok(typeof why === "string", "a command that cannot be parsed is refused rather than waved through", why);
}

// --- the other tiers are untouched by this ------------------------------------------------
// The crew rule must not leak upward: a second mate landing a crew branch is its whole job,
// and this guard already has a budget for that.
{
  const second = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Bash", input: { command: "git push origin main" } });
  ok(second.decision === "allow", "a second mate is not caught by the crew rule", second.reason ? "" : "allowed");
}

// --- and it is actually attached to a crew run ---------------------------------------------
// The join. A policy nothing passes to a process is a policy that has never run - which is
// exactly how the first version of this guard would have failed in the packaged app.
{
  const orchestrator = fs.readFileSync(new URL("../../src/lib/goalOrchestrator.js", import.meta.url), "utf8");
  ok(/guardSettings/.test(orchestrator), "the iteration builder accepts the guard's settings");
  ok(/args\.push\("--settings"/.test(orchestrator), "and puts them on the command line");
  ok(/\.\.\.\(guard\?\.extraEnv \|\| \{\}\)/.test(orchestrator), "and the hook's environment rides along - settings alone would classify the run as untiered");

  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/guard: tierGuardLaunchConfig\(TIER_CREW/.test(main), "and main.js supplies it for every crew run");
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: crew can do its work and cannot publish it - the property that earns the bypass is enforced.");
