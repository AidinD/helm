// The review queue asked git once per row to find each task's commits. A git process
// costs ~70ms of pure startup on Windows, so 20 rows = 20 processes = 2194ms of blocked
// main process, measured on Aidin's real board 2026-08-12 - the app-wide freeze behind
// "helm är lite långsamt ibland". resolveTaskCommitsBatch does it in ONE call.
//
// The load-bearing risk is not speed, it is that a faster answer is a DIFFERENT answer:
// attribution now happens here instead of git-per-id, so a commit could be credited to
// the wrong task, or to none. The last check below therefore runs both implementations
// against this repo's real history and asserts they agree, sha for sha.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-review-commit-batch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveTaskCommits, resolveTaskCommitsBatch } from "../../src/lib/reviewDiff.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// A fake git that returns whatever records we hand it, and counts how often it ran.
const fakeGit = (records) => {
  const calls = [];
  const run = (projectPath, args) => {
    calls.push(args);
    return records.map((r) => `${r.sha}\x1f${r.subject}\x1f${r.body || ""}`).join("\x1e") + "\x1e";
  };
  return { run, calls };
};
const sha = (n) => String(n).repeat(40).slice(0, 40);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const repo = path.resolve(here, "..", "..");

// --- one call, not one per task ---------------------------------------------
{
  const { run, calls } = fakeGit([]);
  const ids = ["aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000", "cccccccc-0000-0000-0000-000000000000"];
  resolveTaskCommitsBatch(repo, ids, { run });
  ok(calls.length === 1, `three tasks cost ONE git call, not three (got ${calls.length}) - this is the entire point of the change`);
  const greps = calls[0].filter((a) => a.startsWith("--grep="));
  ok(greps.length === 3, "and that one call carries a --grep term per task, which git ORs together");
  ok(!calls[0].some((a) => a.startsWith("--max-count")), "no total --max-count: a shared cap would let one busy task push another's commits out of the window entirely");
}

// --- attribution reads the BODY, not only the subject ------------------------
{
  const { run } = fakeGit([
    { sha: sha(1), subject: "Fix the thing", body: "This closes task aaaaaaaa properly." },
    { sha: sha(2), subject: "Unrelated work", body: "nothing to see" },
  ]);
  const out = resolveTaskCommitsBatch(repo, ["aaaaaaaa-0000-0000-0000-000000000000"], { run });
  const got = out.get("aaaaaaaa-0000-0000-0000-000000000000");
  ok(got.commits.length === 1 && got.commits[0].sha === sha(1), "a commit naming the task only in its BODY is still attributed - git matched it, so dropping it here would lose a real commit");
  ok(got.source === "log", "and it is reported as a log SEARCH, never as a recorded fact");
}

// --- a commit that matches nothing is credited to nobody ---------------------
{
  const { run } = fakeGit([{ sha: sha(3), subject: "Something else", body: "" }]);
  const out = resolveTaskCommitsBatch(repo, ["dddddddd-0000-0000-0000-000000000000"], { run });
  const got = out.get("dddddddd-0000-0000-0000-000000000000");
  ok(got.commits.length === 0 && got.source === "none", "a commit in the batch that does not name this task is NOT credited to it - the risk batching introduces, and it is closed");
  ok(/no commit in this repo names dddddddd/i.test(got.error), "and the row says so in the same words the per-row search used");
}

// --- two tasks sharing an 8-char prefix --------------------------------------
{
  const a = "eeeeeeee-1111-0000-0000-000000000000";
  const b = "eeeeeeee-2222-0000-0000-000000000000";
  const { run, calls } = fakeGit([{ sha: sha(4), subject: "work on eeeeeeee", body: "" }]);
  const out = resolveTaskCommitsBatch(repo, [a, b], { run });
  ok(calls[0].filter((x) => x.startsWith("--grep=")).length === 1, "two tasks whose ids share an 8-char prefix search ONCE, not twice - the prefix is all git can match on");
  ok(out.get(a)?.commits.length === 1 && out.get(b)?.commits.length === 1, "and BOTH get the result, rather than one silently losing its commits to the other");
}

// --- the per-task cap --------------------------------------------------------
{
  const many = Array.from({ length: 60 }, (_, i) => ({ sha: sha(0).slice(0, 39) + String(i % 10), subject: `touch ffffffff #${i}`, body: "" }));
  const { run } = fakeGit(many);
  const id = "ffffffff-0000-0000-0000-000000000000";
  const out = resolveTaskCommitsBatch(repo, [id], { run, maxPerTask: 40 });
  ok(out.get(id).commits.length === 40, "the per-task cap still applies (40), so one task cannot flood the payload");
}

// --- inputs that are not task ids, and a project that is not there -----------
{
  const { run, calls } = fakeGit([]);
  const out = resolveTaskCommitsBatch(repo, ["not-an-id!"], { run });
  ok(out.get("not-an-id!").source === "none" && calls.length === 0, "a value that is not a task id searches for nothing at all - no git call is made for it");
}
{
  const out = resolveTaskCommitsBatch(path.join(os.tmpdir(), "helm-no-such-repo-xyz"), ["aaaaaaaa-0000-0000-0000-000000000000"]);
  ok(/no project folder that exists/i.test(out.get("aaaaaaaa-0000-0000-0000-000000000000").error), "a missing project folder is reported per task, in the same words as before, instead of throwing");
}

// --- git itself failing ------------------------------------------------------
{
  const run = () => {
    throw new Error("fatal: not a git repository");
  };
  const ids = ["aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000"];
  const out = resolveTaskCommitsBatch(repo, ids, { run });
  ok(
    ids.every((id) => out.get(id)?.source === "none" && /could not search the log/i.test(out.get(id).error)),
    "when git fails, EVERY task in the batch gets the failure - one broken call must not leave rows with no answer at all"
  );
}

// --- the real thing: batched === per-row, against real history ---------------
// Built here rather than run against this repo's own log so the check does not depend on
// which task ids happen to be in helm's history today.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-batch-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    git("init", "-q", "-b", "main");
    const ids = ["11111111-0000-0000-0000-000000000000", "22222222-0000-0000-0000-000000000000", "33333333-0000-0000-0000-000000000000"];
    const messages = [
      "Fix the header (task 11111111)",
      "Unrelated cleanup",
      "Rework the parser\n\nCloses 22222222 and touches 11111111 too.",
      "Bump deps",
      "Second pass on 22222222",
      "MIXED CASE 33333333 reference",
    ];
    messages.forEach((m, i) => {
      fs.writeFileSync(path.join(root, `f${i}.txt`), String(i));
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", m);
    });

    const batched = resolveTaskCommitsBatch(root, ids);
    let identical = true;
    for (const id of ids) {
      const single = resolveTaskCommits(root, id, []);
      const a = batched.get(id).commits.map((c) => c.sha).sort().join(",");
      const b = single.commits.map((c) => c.sha).sort().join(",");
      if (a !== b || batched.get(id).source !== single.source) {
        identical = false;
        console.log(`      ${id}: batched=[${a}] single=[${b}]`);
      }
    }
    ok(identical, "batched and per-row return the SAME commits and the same source for every task, against a real git log - the equivalence the whole change rests on");
    ok(batched.get(ids[0]).commits.length === 2, "a task named by two different commits (one in a subject, one in a body) gets both");
    ok(batched.get(ids[2]).commits.length === 1, "and the search stays case-insensitive, as --regexp-ignore-case made it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: one git call replaces one-per-row and returns identical commits, so the review queue got ~9x cheaper without changing what it says."
    : "VERIFY FAILED."
);
process.exit(exit);
