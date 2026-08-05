// Unit test against a REAL git repo: which commits belong to a review item, and their
// patch.
//
// Aidin, task c3dfbb42: "Review ändringar - Kunna se diff." The diff itself is the easy
// half; knowing WHICH commits belong to a task is the part that can quietly be wrong, so
// this builds an actual repo with a mix of related and unrelated commits and checks the
// attribution - including that a search of the log is reported AS a search.
//
// Run:  node scripts/e2e/test-review-diff.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveTaskCommits, diffForCommits, taskShortId } from "../../src/lib/reviewDiff.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-revdiff-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
const commit = (file, body, message) => {
  fs.writeFileSync(path.join(repo, file), body, "utf8");
  git("add", file);
  git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
};

const TASK = "c3dfbb42-1111-2222-3333-444444444444";

try {
  git("init", "-q", "-b", "main");
  const unrelated = commit("a.txt", "one\n", "Something else entirely");
  const first = commit("b.txt", "hello\n", `Add the thing (task ${TASK.slice(0, 8)})`);
  const second = commit("b.txt", "hello\nworld\n", `Fix the thing - task C3DFBB42 in different case`);
  const later = commit("c.txt", "no\n", "Unrelated follow-up");

  ok(taskShortId(TASK) === "c3dfbb42", "the short id is the first 8 characters");
  ok(taskShortId("not a task") === null, "and anything that is not a task id has none");

  // --- attribution by SEARCH -------------------------------------------------
  const found = resolveTaskCommits(repo, TASK, []);
  ok(found.source === "log", `with no commits on the record it searches the log, and says so (${found.source})`);
  const shas = found.commits.map((c) => c.sha);
  ok(shas.includes(first) && shas.includes(second), `finding both commits that name the task, case-insensitively (${found.commits.length})`);
  ok(!shas.includes(unrelated) && !shas.includes(later), "and neither of the commits that do not name it");

  // --- attribution by RECORD ------------------------------------------------
  const recorded = resolveTaskCommits(repo, TASK, [`${first} Add the thing`, second]);
  ok(recorded.source === "record", `commits named by the record win over the search (${recorded.source})`);
  ok(recorded.commits.length === 2, `and both are resolved from "sha subject" strings (${recorded.commits.length})`);
  ok(
    recorded.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha)),
    "to full shas with their subjects"
  );
  const bogus = resolveTaskCommits(repo, TASK, ["0000000000000000000000000000000000000000"]);
  ok(
    bogus.commits.length === 0 && /does not have/.test(bogus.error || ""),
    `a record naming a commit this repo lacks is an error, not a silent empty diff (${JSON.stringify(bogus.error?.slice(0, 60))})`
  );
  ok(
    resolveTaskCommits(repo, TASK, ["; rm -rf /"]).source === "log",
    "and a record entry that is not a sha is ignored rather than reaching git"
  );

  // --- nothing to show ------------------------------------------------------
  const none = resolveTaskCommits(repo, "aaaaaaaa-0000-0000-0000-000000000000", []);
  ok(none.commits.length === 0, "a task no commit mentions yields nothing");
  ok(
    /No commit in this repo names aaaaaaaa/.test(none.error || "") && /add the commits to the record/i.test(none.error || ""),
    `with an error that says why AND how to make it exact (${JSON.stringify(none.error?.slice(0, 80))})`
  );
  const noRepo = resolveTaskCommits(path.join(tmp, "gone"), TASK, []);
  ok(/no project folder that exists/.test(noRepo.error || ""), "a record pointing at a missing folder says that, rather than failing inside git");

  // --- the patch ------------------------------------------------------------
  const diff = diffForCommits(repo, found.commits);
  ok(diff.ok, "the patch is produced");
  ok(/\+world/.test(diff.text), `and contains the added line (${/\+world/.test(diff.text)})`);
  ok(!/\+no$/m.test(diff.text), "and nothing from the unrelated commits");
  // Oldest first: reading a change in the order it happened is the whole point.
  ok(
    diff.text.indexOf(first.slice(0, 12)) < diff.text.indexOf(second.slice(0, 12)),
    "oldest commit first, so the change reads in the order it happened"
  );
  ok(diff.truncated === false, "a small diff is not marked truncated");
  ok(diffForCommits(repo, []).ok === false, "no commits means no diff, reported rather than an empty string");

  // The cap cuts at a commit boundary: half a hunk reads as a diff and is not one.
  const tiny = diffForCommits(repo, found.commits, { maxBytes: 10 });
  ok(tiny.truncated === true, "a diff over the cap is marked truncated");
  ok(tiny.shown < tiny.total || tiny.text === "", `and shows fewer commits than it found (${tiny.shown} of ${tiny.total})`);
  ok(
    tiny.text.split("\n").filter((l) => /^@@/.test(l)).length === 0 || /^commit /m.test(tiny.text),
    "cut at a commit boundary rather than mid-hunk"
  );
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows can hold git's pack files briefly; a leftover temp dir is not a failure.
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: a review item's commits are resolved from the record or found by search (and labelled as such), and their patch reads oldest-first."
    : "VERIFY FAILED."
);
process.exit(exit);
