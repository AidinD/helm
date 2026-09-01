/**
 * Binding commits to a card must actually give that card a diff - all the way to the button.
 *
 * ## The miss this exists to stop repeating
 *
 * The bind flow shipped on 2026-09-01 and was a dead end for an hour. Every piece worked in
 * isolation: the binding was written, main.js resolved the card's commits through it, and
 * `reviews:diff` would have returned the patch. The button that calls it never appeared,
 * because the page gates it on `row.hasCommits`, and that flag knew about records and about
 * subject searches and nothing about bindings.
 *
 * Each half was tested. The join was not, and the join was the feature. So this check walks
 * the chain in the order a person does - bind, then look for the affordance, then resolve
 * the commits - rather than asserting each link on its own.
 *
 * Offline: a real git repo and a real binding file, no app and no model.
 *
 * Run: node scripts/e2e/test-binding-reaches-the-diff.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeBinding } from "../../src/lib/commitBindings.js";
import { boundCommits } from "../../src/lib/commitBindings.js";
import { resolveTaskCommits, diffForCommits } from "../../src/lib/reviewDiff.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-bind-chain-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-bind-repo-"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "p@p");
git("config", "user.name", "p");

fs.writeFileSync(path.join(repo, "app.js"), "const rate = 0;\n", "utf8");
git("add", "-A");
// No task id in the subject - the whole point. This is the shape that made the old check
// answer "nothing was committed".
git("commit", "-q", "-m", "fix(pricing): a flat rate with nothing under it charges nothing");
const sha = git("rev-parse", "HEAD").trim();

const taskId = "0f1e2d3c-0000-4000-8000-000000000000";

// --- before binding: nothing ties the commit to the card ----------------------------
{
  const before = boundCommits(metaHome, taskId, null);
  ok(before.source === "none", "with no record and no binding, the card owns no commits", before.source);
  const resolved = resolveTaskCommits(repo, taskId, before.shas);
  ok(resolved.commits.length === 0, "so nothing resolves - which is the state that made the card a dead end");
}

// --- bind, the way the button does --------------------------------------------------
const written = writeBinding(metaHome, taskId, {
  projectPath: repo,
  shas: [sha],
  by: "captain",
  proposedBy: "claude-haiku-4-5-20251001",
});
ok(written.ok, "the binding is written", written.error || "");

// --- the flag the PAGE gates its diff button on -------------------------------------
// Asserted on the real payload builder rather than on a hand-made row: the bug was that the
// builder never looked at bindings, so a row built by this test would have hidden it.
{
  const { buildReviewQueuePayload } = await import("../../src/lib/reviewQueueBuild.js");
  // A board with exactly this card in review, and a category bound to the repo, so the row
  // is repo-rooted the way a real one is.
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-bind-board-"));
  const boardPath = path.join(boardDir, "todos.json");
  fs.writeFileSync(
    boardPath,
    JSON.stringify({
      categories: [{ id: "cat1", name: "Some Board", repoPath: repo }],
      todos: [
        {
          id: taskId,
          text: "Fast pris bokförs som om allt tjänats in direkt",
          status: "review",
          categoryId: "cat1",
          createdAt: Date.now() - 86400000,
          description: "",
        },
      ],
    }),
    "utf8"
  );
  const built = buildReviewQueuePayload({ metaHome, config: { jot: { path: boardPath } } });
  const row = built.payload.rows.find((r) => r.taskId === taskId);
  ok(!!row, "the card is on the queue", built.payload.error || `${built.payload.rows.length} rows`);
  ok(row?.repoPath === repo, "rooted at its repo", row?.repoPath);
  // THE assertion. This flag being false is exactly what hid the button.
  ok(row?.hasCommits === true, "and hasCommits is TRUE because of the binding - this is what the diff button gates on");
  ok(row?.boundCommitCount === 1, "with the bound count carried for the page to say so", String(row?.boundCommitCount));
  // And it must stop being offered as a candidate to itself or anyone else.
  ok((row?.candidateCommits || []).every((c) => c.sha !== sha), "a bound commit is no longer offered as a candidate");
  fs.rmSync(boardDir, { recursive: true, force: true });
}

// --- and the diff really comes out the other end -------------------------------------
{
  const resolved = resolveTaskCommits(repo, taskId, boundCommits(metaHome, taskId, null).shas);
  ok(resolved.commits.length === 1, "the card's commits resolve from the binding", `${resolved.commits.length}`);
  const diff = diffForCommits(repo, resolved.commits);
  ok(diff.ok, "and a patch comes back", diff.error || "");
  // Content, not just a truthy flag: a diff that resolved to the wrong commit would also
  // be "ok".
  ok(/app\.js/.test(diff.text) && /const rate/.test(diff.text), "carrying the file and the line the commit actually changed");
}

fs.rmSync(metaHome, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a bound card reaches its diff, including the flag the button is gated on.");
