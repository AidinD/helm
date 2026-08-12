// Unit test for the commit-centric review source (commitReview.js). Injects the git runner
// so it's deterministic and needs no repo. Covers: binding detection (record shas + task-id
// in the subject), the unbound listing (range, filtering, limit), and the initial-watermark
// ladder (mainline baseline, else HEAD~cap).
//
// Run:  node scripts/e2e/test-commit-review.mjs
import os from "node:os";
import { listUnboundCommits, initialWatermark, makeIsBound } from "../../src/lib/commitReview.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = os.tmpdir(); // exists, so the fs guard passes

// --- makeIsBound -----------------------------------------------------------
{
  const isBound = makeIsBound({
    recordCommitShas: ["8b75619", "a9bf76a subject text"], // short shas, one with a trailing subject token
    taskShortIds: ["07cd4fc9", "1116b7ef"],
  });
  ok(isBound("8b75619ffffffffffffffffffffffffffffffff", "anything"), "a full sha whose prefix is a record's short sha is BOUND");
  ok(isBound("a9bf76a0000000000000000000000000000000a", "x"), "the sha token is taken from a 'sha subject' record entry");
  ok(isBound("deadbeef1234567890", "Fix the thing for task 07cd4fc9 today"), "a commit whose subject names a task short id is BOUND");
  ok(!isBound("cafebabe1234567890", "an unrelated commit with no task and no record"), "a commit with neither is UNBOUND");

  // The >=6 length guard is what stops a tiny id from matching everything - exercise the
  // boundary directly, or reverting the guard would go unnoticed.
  const shortId = makeIsBound({ taskShortIds: ["abcde"] }); // 5 chars, below the guard
  ok(!shortId("deadbeef1234", "a commit mentioning abcde in passing"), "a task id shorter than 6 chars never binds (the length guard holds)");
  const sixId = makeIsBound({ taskShortIds: ["abcdef"] }); // 6 chars, at the guard
  ok(sixId("deadbeef1234", "a commit mentioning abcdef here"), "a 6-char id whose full string is in the subject DOES bind");
}

// --- listUnboundCommits ----------------------------------------------------
{
  let seenArgs = null;
  const fakeLog =
    "1111111111111111111111111111111111111111\tFirst unbound\n" +
    "2222222222222222222222222222222222222222\tBound to a task 07cd4fc9\n" +
    "3333333333333333333333333333333333333333\tSecond unbound\n";
  const run = (_p, args) => {
    seenArgs = args;
    return fakeLog;
  };
  const isBound = makeIsBound({ taskShortIds: ["07cd4fc9"] });
  const commits = listUnboundCommits(here, { watermark: "abcdef1", isBound, run });
  ok(
    seenArgs.includes("HEAD") && seenArgs.includes("--not") && seenArgs.includes("abcdef1") && !seenArgs.some((x) => x.includes("..")),
    `the floor is a --not exclude set, not a <watermark>..HEAD range (${seenArgs.join(" ")})`
  );
  ok(seenArgs.includes("--no-merges"), "merge commits are excluded");
  ok(seenArgs.includes("--ignore-missing"), "a stale floor sha is ignored, not fatal");

  // Acks join the watermark as additional --not excludes (the divergent-branch fix): both the
  // baseline and every acknowledged commit become floor entries in one listing.
  listUnboundCommits(here, { watermark: "abcdef1", acks: ["1234567", "89abcde"], run: (_p, a) => ((seenArgs = a), fakeLog) });
  ok(
    seenArgs.includes("--not") && seenArgs.includes("abcdef1") && seenArgs.includes("1234567") && seenArgs.includes("89abcde"),
    `every ack is excluded alongside the baseline (${seenArgs.join(" ")})`
  );
  ok(commits.length === 2, `the bound commit is filtered out (${commits.length} of 2 unbound)`);
  ok(
    commits.every((c) => c.shortSha.length === 8 && c.sha.startsWith(c.shortSha)),
    "each row carries an 8-char shortSha derived from the full sha"
  );
  ok(commits[0].subject === "First unbound", `subjects are parsed (${JSON.stringify(commits[0].subject)})`);

  // No watermark -> list from HEAD (still bounded by the limit).
  const noWm = listUnboundCommits(here, { watermark: null, run: (_p, a) => ((seenArgs = a), fakeLog) });
  ok(seenArgs.includes("HEAD") && !seenArgs.some((x) => x.includes("..")), "a null watermark lists from HEAD, no range");
  ok(noWm.length === 3, "with no isBound, every non-merge commit is unbound");

  // Limit is honoured.
  const many = Array.from({ length: 10 }, (_, i) => `${String(i).repeat(40).slice(0, 40)}\tc${i}`).join("\n");
  const capped = listUnboundCommits(here, { watermark: "abcdef1", limit: 4, run: () => many });
  ok(capped.length === 4, `the limit caps the result (${capped.length})`);

  // A missing project folder yields nothing (never throws).
  ok(listUnboundCommits("Z:/definitely/not/here", { run: () => fakeLog }).length === 0, "a missing project folder yields no commits");
}

// --- initialWatermark ------------------------------------------------------
{
  const HEAD = "ffffffffffffffffffffffffffffffffffffffff";
  const UPSTREAM = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  // Upstream exists and is behind HEAD -> it's the baseline.
  const withUpstream = (_p, args) => {
    const ref = args[args.length - 1];
    if (ref.startsWith("HEAD^")) {
      return HEAD;
    }
    if (ref.startsWith("@{upstream}")) {
      return UPSTREAM;
    }
    throw new Error("no such ref");
  };
  ok(initialWatermark(here, { run: withUpstream }) === UPSTREAM, "the upstream tip is the initial watermark when it's behind HEAD");

  // No mainline anywhere -> fall back to HEAD~cap.
  const capSha = "cccccccccccccccccccccccccccccccccccccccc";
  const noMainline = (_p, args) => {
    const ref = args[args.length - 1];
    if (ref === "HEAD^{commit}") {
      return HEAD;
    }
    if (ref.startsWith("HEAD~")) {
      return capSha;
    }
    throw new Error("no such ref");
  };
  ok(initialWatermark(here, { run: noMainline, cap: 30 }) === capSha, "with no mainline, the window is capped to HEAD~cap");

  // A mainline that EQUALS HEAD is not a useful baseline -> skip it, fall to the cap.
  const mainlineAtHead = (_p, args) => {
    const ref = args[args.length - 1];
    if (ref === "HEAD^{commit}" || ref.startsWith("origin/main")) {
      return HEAD;
    }
    if (ref.startsWith("HEAD~")) {
      return capSha;
    }
    throw new Error("no such ref");
  };
  ok(initialWatermark(here, { run: mainlineAtHead }) === capSha, "a mainline sitting AT HEAD is skipped (no commits ahead to review)");
}

console.log(exit === 0 ? "VERIFY OK: unbound-commit listing, binding detection, and the watermark ladder behave." : "VERIFY FAILED.");
process.exit(exit);
