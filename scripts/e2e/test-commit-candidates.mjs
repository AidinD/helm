/**
 * A card whose repo has commits nobody tied to it must not be hidden as "nothing was done".
 *
 * ## The bug
 *
 * The Review page hides a row that has no record AND `hasCommits === false`, on the stated
 * grounds that the second is "a POSITIVE statement - git was asked and found nothing". The
 * question git was asked is narrower than that conclusion: does a commit subject carry the
 * task's 8-character id, or does a record list one. For a repo whose commits are written as
 * ordinary prose the answer is always no.
 *
 * Measured on the real board, 2026-09-01: 30 tasks in review, 6 belonging to a repo, and 5
 * of those 6 hidden. One board's repo has zero commits mentioning any task id anywhere in
 * its history - its subjects are conventional-commit prose, "fix(scope): what changed" - so
 * every card on that board disappeared behind a filter meant to hide noise. The work exists;
 * the page could not see the thread.
 *
 * ## What is checked, and what is deliberately NOT
 *
 * That the candidate window finds real commits, excludes the ones another card already
 * claims, and reports its cap instead of truncating quietly.
 *
 * There is no assertion that a candidate is the RIGHT commit, because the code makes no
 * such claim. Matching on words is impossible here by construction - tasks are written in
 * Swedish and commits in English, so a card and its own commit routinely share not one word -
 * and a confident wrong pairing is worse than none, since it sends somebody to review the
 * wrong diff. The window narrows what a person looks at; their eyes do the matching.
 *
 * Run: node scripts/e2e/test-commit-candidates.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { candidateCommitsByRepo, windowStart, CANDIDATE_CAP } from "../../src/lib/commitCandidates.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// A real repo, because this reads real git output. Commits are dated explicitly so the
// window has something deterministic to cut on.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-candidates-"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "p@p");
git("config", "user.name", "p");

const shas = [];
function commit(subject, isoDate) {
  fs.writeFileSync(path.join(repo, `${shas.length}.txt`), subject, "utf8");
  git("add", "-A");
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", subject], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
  const sha = git("rev-parse", "HEAD").trim();
  shas.push({ sha, shortSha: sha.slice(0, 8), subject });
  return sha;
}

// Invented subjects in the shape that matters: conventional-commit prose with no task id
// anywhere, which is what makes the old check answer "nothing was done". Deliberately not
// copied from a real project - a fixture that quotes real work publishes it.
const older = commit("fix(pricing): round the tier boundary the same way twice", "2026-08-01T09:00:00+02:00");
const inWindowA = commit("feat(reports): sort and filter the summary table", "2026-08-26T09:00:00+02:00");
const inWindowB = commit("fix(pricing): a flat rate with nothing under it charges nothing", "2026-08-27T09:00:00+02:00");

const CREATED = Date.parse("2026-08-25T00:00:00+02:00");
// An invented id. It has to LOOK like a real one - the code takes an 8-character prefix -
// without being one: a fixture carrying a real card's id publishes which card it was.
const task = { taskId: "0f1e2d3c-0000-4000-8000-000000000000", createdAt: CREATED };

// --- the window itself -----------------------------------------------------------
{
  ok(windowStart(task) !== null, "a card with a creation time has a window");
  ok(windowStart({}) === null, "and one without has none, rather than a window starting at the epoch");
}

// --- commits after the card was created, and only those ----------------------------
{
  const found = candidateCommitsByRepo(repo, [task]).get(task.taskId);
  ok(found.error === null, "the window resolves against a real repo", found.error || "");
  const got = found.commits.map((c) => c.sha);
  ok(got.includes(inWindowA) && got.includes(inWindowB), `both commits made after the card are offered (${found.commits.length})`);
  ok(!got.includes(older), "and the one from three weeks before it is not");
  // The point of the whole exercise: the old check would have said no.
  const namesTheTask = found.commits.some((c) => c.subject.includes("0f1e2d3c"));
  ok(!namesTheTask, "none of them names the card - which is exactly why they were invisible");
}

// --- a commit another card already owns is not offered twice ------------------------
// Without this, one commit shows up as a candidate under every open card in the repo, and
// the list stops being a narrowing at all.
{
  const found = candidateCommitsByRepo(repo, [task], { claimed: new Set([inWindowA]) }).get(task.taskId);
  const got = found.commits.map((c) => c.sha);
  ok(!got.includes(inWindowA), "a commit already bound to some card is left out");
  ok(got.includes(inWindowB), "and the unclaimed one still comes through");
}

// --- the cap is reported, never applied in silence ----------------------------------
// A list cut short without saying so reads as "this is all of it", which is the shape of
// several bugs in this repo's own history.
{
  for (let i = 0; i < CANDIDATE_CAP + 3; i += 1) {
    commit(`chore: filler ${i}`, "2026-08-28T09:00:00+02:00");
  }
  const found = candidateCommitsByRepo(repo, [task]).get(task.taskId);
  ok(found.commits.length === CANDIDATE_CAP, `at most ${CANDIDATE_CAP} are carried (${found.commits.length})`);
  ok(found.more > 0, `and the remainder is counted rather than dropped (${found.more} more)`);
}

// --- a missing repo answers, rather than throwing -----------------------------------
// This runs inside the queue build, which renders the whole page; one deleted folder must
// not take the page down with it.
{
  const found = candidateCommitsByRepo(path.join(repo, "does-not-exist"), [task]).get(task.taskId);
  ok(found.commits.length === 0 && typeof found.error === "string", "a folder that is gone gives a reason, not an exception", found.error);
}

// --- and the page's own filter uses it ----------------------------------------------
// Source-level, since the renderer is a classic script that cannot be imported. Comments
// are stripped first: this file's own explanation mentions the identifier, and a check that
// matches its neighbouring prose passes with the code deleted.
{
  // Read raw and anchor at the start of a line rather than stripping comments first.
  // Stripping block comments was the first attempt and it silently deleted the code it was
  // looking for: somewhere in this 20k-line file a "/*" inside a string pairs with a later
  // "*/", so the stripper ate the definition and the check failed against correct code. A
  // line-start anchor is enough for what this needs - a commented-out copy would read
  // "// const ..." and cannot match.
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const rule = src.match(/^const rowNeedsNoCommitsCard = [^;]+;/m);
  ok(!!rule, "the page still has one place that decides whether to hide a no-commit row");
  ok(
    !!rule && /candidateCommits|candidateMore/.test(rule[0]),
    "and it consults the candidates before hiding one",
    rule ? rule[0].replace(/\s+/g, " ").slice(0, 120) : ""
  );
}

fs.rmSync(repo, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a card whose repo has unclaimed commits is offered them, and is no longer hidden as though nothing was done.");
