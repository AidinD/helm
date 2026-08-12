// The "commits without a task" rows toggled forever (the captain, 2026-08-12): two unbound commits
// stuck in review, only one shown at a time, and clicking "Reviewed" flipped between them
// instead of clearing both. Root cause: the review floor was a single watermark and the
// listing used `<watermark>..HEAD`, which assumes LINEAR history. The two commits were on
// DIVERGENT branches (each merged via its own merge commit - neither an ancestor of the
// other), so `cA..HEAD` still contains cB and `cB..HEAD` still contains cA: acking one always
// re-surfaced the other.
//
// This builds that exact shape in a REAL repo (an injected fake git runner can't reproduce
// ancestry) and proves: the OLD single-watermark model toggles; the NEW ack-SET model clears
// both.
//
// Run:  node scripts/e2e/test-unbound-divergent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listUnboundCommits } from "../../src/lib/commitReview.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-unbound-div-"));
const repo = path.join(tmp, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
const shaOf = (ref) => git("rev-parse", ref);

try {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");

  const write = (name, body) => fs.writeFileSync(path.join(repo, name), body);
  // Baseline (the review floor / initial watermark).
  write("base.txt", "base\n");
  git("add", "-A");
  git("commit", "-m", "baseline");
  const baseline = shaOf("HEAD");

  // Two divergent branches off the baseline, each one unbound commit, merged back separately -
  // exactly how the two chip fixes landed (frosty-tharp + gallant-wu, each its own merge).
  git("checkout", "-b", "branchA");
  write("a.txt", "A\n");
  git("add", "-A");
  git("commit", "-m", "unbound commit A");
  const cA = shaOf("HEAD");

  git("checkout", "main");
  git("checkout", "-b", "branchB");
  write("b.txt", "B\n");
  git("add", "-A");
  git("commit", "-m", "unbound commit B");
  const cB = shaOf("HEAD");

  git("checkout", "main");
  git("merge", "--no-ff", "branchA", "-m", "Merge A");
  git("merge", "--no-ff", "branchB", "-m", "Merge B");

  // Sanity: the two commits really ARE divergent (the precondition for the bug).
  const isAncestor = (a, b) => {
    try {
      execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", a, b], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
  ok(!isAncestor(cA, cB) && !isAncestor(cB, cA), "precondition: commit A and commit B are on divergent branches (neither an ancestor of the other)");

  const shas = (rows) => rows.map((r) => r.sha).sort();
  const has = (rows, sha) => rows.some((r) => r.sha === sha);

  // --- the bug, documented: the OLD single-watermark `<sha>..HEAD` toggles ---
  const oldRange = (wm) => git("log", `${wm}..HEAD`, "--no-merges", "--format=%H").split(/\r?\n/).filter(Boolean);
  ok(oldRange(cA).includes(cB), "OLD model: with the floor at A, `A..HEAD` STILL lists B (the re-surfacing that caused the toggle)");
  ok(oldRange(cB).includes(cA), "OLD model: with the floor at B, `B..HEAD` STILL lists A - so acking either never clears both");

  // --- the fix: an ack SET, excluded via `git log HEAD --not ...` ---
  const both = listUnboundCommits(repo, { watermark: baseline, acks: [] });
  ok(both.length === 2 && has(both, cA) && has(both, cB), `NEW model: both unbound commits show (merges excluded) - got ${shas(both).length}`);

  const afterAckA = listUnboundCommits(repo, { watermark: baseline, acks: [cA] });
  ok(afterAckA.length === 1 && has(afterAckA, cB) && !has(afterAckA, cA), "NEW model: acking A leaves ONLY B (no toggle back to A)");

  const afterAckBoth = listUnboundCommits(repo, { watermark: baseline, acks: [cA, cB] });
  ok(afterAckBoth.length === 0, `NEW model: acking BOTH clears the section entirely - got ${afterAckBoth.length}`);

  // A stale ack (a sha that no longer exists after a rewrite) must not blow up the listing.
  const withStale = listUnboundCommits(repo, { watermark: baseline, acks: [cA, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"] });
  ok(withStale.length === 1 && has(withStale, cB), "a stale/unresolvable ack sha is ignored, not fatal (--ignore-missing)");
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
    ? "VERIFY OK: divergent unbound commits clear independently and acking all empties the section (no toggle)."
    : "VERIFY FAILED."
);
process.exit(exit);
