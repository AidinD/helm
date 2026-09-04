// the captain, task 76790f23: "Bind varje review till en commit för att förhindra
// 'Ran on uncommited changes' när man kör run checks."
//
// reviews:runChecks used to run a check straight in rec.projectPath, so
// whatever else happened to be sitting uncommitted there at that exact
// moment - unrelated work-in-progress on a DIFFERENT task, the ordinary case
// during an active session - tainted every result with headDirty:true,
// regardless of whether the code actually under review was safely
// committed. It now runs checks in an isolated, detached worktree pinned to
// the record's own commit, immune to that by construction.
//
// This drives the REAL reviews:runChecks IPC against a real git repo with a
// genuinely dirty working tree, and checks: the check still passes, it's
// stamped headDirty:false (bound to the clean commit, not the dirty live
// tree), the unrelated uncommitted file survives untouched in the main
// tree, and no worktree litter is left behind afterward.
//
// Run:  node scripts/e2e/test-review-checks-worktree.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildReviewQueue } from "../../src/lib/reviewRecords.js";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-checkwt-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init", "-q", "-b", "main");
git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
// A trivial, always-passing check that lives IN the repo, so a worktree
// checkout actually has it available too.
fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(0);\n", "utf8");
git("add", "check.mjs");
git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "add check");
const boundSha = git("rev-parse", "HEAD").trim();

const metaHome = path.join(tmp, "meta-home");
const reviewsDir = path.join(metaHome, ".helm", "reviews");
fs.mkdirSync(reviewsDir, { recursive: true });
const TASK = "aaaaaaaa-1111-2222-3333-444444444444";
fs.writeFileSync(
  path.join(reviewsDir, `${TASK}.json`),
  JSON.stringify({
    taskId: TASK,
    projectPath: repo,
    criticality: "cosmetic",
    whyNotCritical: "A throwaway fixture for a test, nothing real is at stake here.",
    verdict: "stamp",
    summary: "A trivial fixture for testing worktree-bound check runs.",
    testSteps: [{ step: "Run the check.", expect: "It passes." }],
    evidence: [],
    notVerified: [],
    commits: [boundSha],
    checks: [{ label: "trivial", cmd: "node check.mjs", cwd: repo }],
  }),
  "utf8"
);

// The dirty tree the fix has to survive: unrelated work-in-progress on a
// DIFFERENT task, sitting uncommitted in the SAME repo at the moment the
// button is clicked - the ordinary case during an active session.
fs.writeFileSync(path.join(repo, "unrelated-work-in-progress.txt"), "not part of this review", "utf8");

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9538";
const { launch } = await import("../checks-lib/harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const dirtyBefore = git("status", "--porcelain");
  ok(/unrelated-work-in-progress/.test(dirtyBefore), "the repo is genuinely dirty before the run (sanity check on the test setup)");

  const res = await app.eval(`window.helm.runReviewChecks(${JSON.stringify(TASK)})`);
  ok(res?.ok === true, `reviews:runChecks succeeded (${JSON.stringify(res?.error || "")})`);
  ok(res?.results?.[0]?.ok === true, `the check itself passed (${JSON.stringify(res?.results)})`);

  const rec = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${TASK}.json`), "utf8"));
  const run = rec.checkRuns?.[0];
  ok(!!run, "a check run was stamped onto the record");
  ok(run?.exitCode === 0, `with exit code 0 (${run?.exitCode})`);
  ok(
    run?.headDirty === false,
    `and headDirty:false - bound to the clean commit, NOT the live dirty tree (${JSON.stringify(run?.headDirty)})`
  );
  ok(run?.head === boundSha, `stamped with the record's own bound commit (${run?.head} vs ${boundSha})`);

  const dirtyAfter = git("status", "--porcelain");
  ok(
    /unrelated-work-in-progress/.test(dirtyAfter),
    "the unrelated uncommitted file is UNTOUCHED in the main tree - isolation, not a side effect on the real repo"
  );
  ok(!/check\.mjs/.test(dirtyAfter), "and the main tree itself is not otherwise modified by the check run");

  const worktreesRoot = path.join(path.dirname(repo), "repo-worktrees");
  const leftoverWorktrees = fs.existsSync(worktreesRoot) ? fs.readdirSync(worktreesRoot) : [];
  ok(leftoverWorktrees.length === 0, `the isolated worktree was cleaned up afterward, no litter left (${JSON.stringify(leftoverWorktrees)})`);

  const listed = git("worktree", "list", "--porcelain");
  ok(!new RegExp(worktreesRoot.replace(/\\/g, "\\\\")).test(listed), "and git itself no longer tracks the worktree either");

  // Staleness baseline (task 5143316e: "det står stale - the code changed after
  // it ran"). The check just ran, pinned to the record's own commit. Now advance
  // the live project HEAD past that commit with an UNRELATED code commit - the
  // ordinary case during an active session. The gauntlet must still read passing:
  // staleness is measured against the record's pinned commit (what the check ran
  // against), not the live HEAD, or every freshly-run check would read stale the
  // moment any later commit lands.
  fs.writeFileSync(path.join(repo, "later-unrelated-feature.mjs"), "export const x = 1;\n", "utf8");
  git("add", "later-unrelated-feature.mjs");
  git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "unrelated later code commit");
  const newHead = git("rev-parse", "HEAD").trim();
  ok(newHead !== boundSha, "sanity: the live HEAD has genuinely moved past the record's commit with a code change");

  // Build the queue the way the review page does (buildReviewQueue is what computes
  // the gauntlet), with the freshly-stamped record and a synthetic review task. The
  // record's check ran against boundSha; live HEAD is now newHead. The gauntlet must
  // read passing, because staleness is measured against the record's pinned commit.
  const stampedRec = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${TASK}.json`), "utf8"));
  const queue = buildReviewQueue([{ id: TASK, title: "fixture" }], [stampedRec], metaHome);
  const row = queue.find((r) => String(r.taskId).toLowerCase() === TASK.toLowerCase());
  ok(!!row, "the record produces a review row");
  ok(
    row?.gauntlet?.stale === 0,
    `the freshly-run check is NOT marked stale even though live HEAD moved past the record's commit (stale=${row?.gauntlet?.stale}, state=${row?.gauntlet?.state})`
  );
  ok(row?.gauntlet?.state === "passing", `so the gauntlet reads passing, not "the code changed after it ran" (${row?.gauntlet?.state})`);

  // The OTHER direction, so the fix didn't just silence staleness: if the record is
  // RE-PINNED to the later commit (its own commits updated) while the check still
  // ran against the old one, that IS genuinely stale and must still read so.
  const repinnedRec = { ...stampedRec, commits: [newHead] };
  const staleRow = buildReviewQueue([{ id: TASK, title: "fixture" }], [repinnedRec], metaHome).find(
    (r) => String(r.taskId).toLowerCase() === TASK.toLowerCase()
  );
  ok(
    staleRow?.gauntlet?.stale === 1 && staleRow?.gauntlet?.state !== "passing",
    `re-pinning the record to a newer code commit DOES mark the old run stale (stale=${staleRow?.gauntlet?.stale}, state=${staleRow?.gauntlet?.state})`
  );

  const consoleErrors = app.getConsoleErrors();
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
} catch (err) {
  ok(false, `unexpected failure: ${err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: check runs are bound to the record's own commit in an isolated worktree, immune to unrelated dirty state, and cleaned up afterward."
    : "VERIFY FAILED."
);
process.exit(exit);
