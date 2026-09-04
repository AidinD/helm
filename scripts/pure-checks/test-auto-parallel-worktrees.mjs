// Two auto tasks in the SAME project must both be able to run, and they must
// appear in the shape the captain asked for (2026-08-03): "en 2nd mate för det projektet
// och sedan autopilots under den för tasken" - ONE row for the project, with an
// autopilot run per task underneath it.
//
// They could not run at all before. A second mate's identity is hashed from
// (first mate, path), so two tasks in one repo produced the same id and the second
// dispatch was refused as "busy with a turn" - one session cannot hold two turns.
//
// An earlier attempt gave each TASK its own second mate. That unblocked it but
// flattened the hierarchy into sibling rows with no project above them, each
// holding a duplicate of the same project context. Dispatching each task as CREW
// under the project's second mate gets both: the runs are independent (each
// autopilot run already makes its own worktree) and the fleet keeps its shape.
//
// Run: node scripts/e2e/test-auto-parallel-worktrees.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, listWorktrees } from "../../src/lib/worktree.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-autopar-"));
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
// DYNAMIC import, after the env var is set. ESM imports are hoisted and run before
// any statement in this file, and secondMates.js resolves its file path once at
// import time - so a static import here read the ambient env and this test wrote two
// stray entries into the DEV repo's real second-mates.json before I noticed
// (2026-08-03). Any test seam that is a module-level constant has this shape.
const { secondMateId, deriveSecondMates, proposeSecondMate, AUTO_CAPTAIN } = await import("../../src/lib/secondMates.js");
const repo = path.join(tmp, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

try {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "app.js"), "// the shared file both tasks would have edited\n");
  git("add", "-A");
  git("commit", "-m", "init");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "1\n");

  // --- ONE second mate for the project (the auto-captain's own node) --------
  const smId = secondMateId(AUTO_CAPTAIN, repo);
  ok(secondMateId(AUTO_CAPTAIN, repo) === smId, "the project resolves to one stable auto second mate");
  proposeSecondMate(AUTO_CAPTAIN, repo, { brief: "Auto-started tasks for repo" });

  // --- both tasks become autopilot runs UNDER it ---------------------------
  // Shaped exactly as the auto dispatch records them: crew runs whose dispatchedBy
  // is the project's second mate, started BY the auto-captain.
  const runs = [
    { goalRunId: "run-a", projectPath: repo, dispatchedBy: smId, tier: "crew", status: "running", startedBy: "auto", goal: "Task from the board: A" },
    { goalRunId: "run-b", projectPath: repo, dispatchedBy: smId, tier: "crew", status: "running", startedBy: "auto", goal: "Task from the board: B" },
  ];
  const derived = deriveSecondMates(runs);
  const mine = derived.filter((s) => s.secondMateId === smId);
  ok(mine.length === 1, `both runs attach to the SAME second mate - one project row, not two (${mine.length})`);
  ok(mine[0]?.crew?.length === 2, `with both tasks as crew underneath it (${mine[0]?.crew?.length})`);
  ok(
    derived.filter((s) => s.firstMateId === AUTO_CAPTAIN).length === 1,
    "and there is exactly one auto-captain node for the project, not one per task"
  );
  ok(
    mine[0].crew.map((r) => r.goalRunId).sort().join(",") === "run-a,run-b",
    "each task keeps its own run identity under that row"
  );

  // --- and the runs are genuinely independent on disk ----------------------
  // Each autopilot run gets its own worktree from the orchestrator; this proves the
  // property that actually matters - two runs editing the SAME file without
  // touching each other - rather than just that two ids differ.
  const wtA = createWorktree(repo, { id: "goal-a", branchName: "helm/goal-a", deps: "junction" });
  const wtB = createWorktree(repo, { id: "goal-b", branchName: "helm/goal-b", deps: "junction" });
  fs.writeFileSync(path.join(wtA.worktreePath, "app.js"), "// task A's version\n");
  fs.writeFileSync(path.join(wtB.worktreePath, "app.js"), "// task B's version\n");
  ok(
    fs.readFileSync(path.join(wtA.worktreePath, "app.js"), "utf8").includes("task A") &&
      fs.readFileSync(path.join(wtB.worktreePath, "app.js"), "utf8").includes("task B"),
    "each run's edit to the same file stands on its own - the whole point of parallel runs"
  );
  ok(
    fs.readFileSync(path.join(repo, "app.js"), "utf8").includes("shared file"),
    "and the project's own checkout is untouched by either"
  );
  ok(listWorktrees(repo).length === 3, `git sees the repo plus both runs' worktrees (${listWorktrees(repo).length})`);
  ok(!wtA.depsError && !wtB.depsError, `both got their dependencies (${wtA.depsError || "ok"} / ${wtB.depsError || "ok"})`);

  // --- the app's wiring -----------------------------------------------------
  const stripComments = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  const mainSrc = stripComments(fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8"));
  ok(
    // AUTO_LANE since 2026-09-04. The constant holds the same value; what changed is that the
    // first argument is a LANE rather than a dispatcher, so the name now says which question it
    // answers. Both spellings are accepted here, because this assertion is about the auto node
    // being derived from the PROJECT - which is true under either name.
    /const smId = secondMateId\((AUTO_CAPTAIN|AUTO_LANE), where\.projectPath\)/.test(mainSrc),
    "the dispatch derives the second mate from the PROJECT (under the auto-captain), so tasks in one repo share it"
  );
  ok(/dispatchedBy: smId/.test(mainSrc), "and hangs each task's run underneath it");
  ok(/tier: "crew"/.test(mainSrc), "as crew, which is what the fleet renders under a second mate");
  ok(!/ensureAutoWorktree/.test(mainSrc), "and there is no second, auto-specific worktree convention left to keep in sync");
  ok(/finishAutoRun\(todo\.id, result, meta\)/.test(mainSrc), "the run's completion is what moves the card, not a relay turn ending");
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  // Unlink the junctions BEFORE removing anything - a removal once followed one
  // into the shared package folder and emptied it.
  try {
    const root = path.join(tmp, "repo-worktrees");
    for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const nm = path.join(root, dir, "node_modules");
      try {
        if (fs.lstatSync(nm).isSymbolicLink()) {
          fs.rmSync(nm, { recursive: true, force: true });
        }
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: two auto tasks in one project share one second-mate row, each runs as its own autopilot underneath it, and their worktrees are independent."
    : "VERIFY FAILED."
);
process.exit(exit);
