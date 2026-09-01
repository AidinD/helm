/**
 * Clearing the unbound list must clear it completely, undo cleanly, and claim nothing.
 *
 * ## What it is for
 *
 * 535 commits across 13 projects sat in "commits without a task", several of them truncated
 * at the display cap so the real number is higher. The captain: "ta bort alla obundna. jag kommer
 * inte gå igenom dem. Jag vill komma till en baseline och sen kan jag börja." The list is not
 * a queue if nobody will ever read it - it is a wall in front of the handful of rows that do
 * need him.
 *
 * ## The three things that could go wrong
 *
 * It could clear only part of it, which is the trap the per-project button already has: "Seen
 * all" acknowledges the commits the page had ROOM to show, and the page shows fifty. A
 * baseline that inherited that would look complete and quietly leave the rest.
 *
 * It could be irreversible, which would make it a control nobody should press.
 *
 * And it could be mistaken later for a review. That is the one with the longest tail: a
 * cleared list and an approved list look identical a month afterwards, so the words matter as
 * much as the mechanism, and both are checked here.
 *
 * Offline: real git repos, no app.
 *
 * Run: node scripts/e2e/test-review-baseline.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { baselineUnboundCommits } from "../../src/lib/reviewBaseline.js";
import { listUnboundCommits } from "../../src/lib/commitReview.js";
import { projectKey } from "../../src/lib/commitReview.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-baseline-"));

function makeRepo(name, commitCount) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "p@p");
  git("config", "user.name", "p");
  for (let i = 0; i < commitCount; i += 1) {
    fs.writeFileSync(path.join(repo, `f${i}.txt`), String(i), "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", `feat(thing): change number ${i}`);
  }
  return repo;
}

// MORE than the display cap, because that is the trap: a baseline that only cleared what was
// shown would look finished and leave the rest behind.
const big = makeRepo("big", 60);
const small = makeRepo("small", 3);
const empty = path.join(tmp, "not-a-repo");
fs.mkdirSync(empty, { recursive: true });

// --- before: the list is full --------------------------------------------------------
{
  const listed = listUnboundCommits(big, { acks: [] });
  ok(listed.length > 0, `the big repo lists unbound commits (${listed.length})`);
  // The cap is what makes this test necessary at all.
  ok(listed.length < 60, "and the page's own listing is capped below the real number", `${listed.length} of 60`);
}

// --- clear ----------------------------------------------------------------------------
const result = baselineUnboundCommits({ projectPaths: [big, small, empty], acks: {} });
ok(result.cleared.length === 2, "both real repos are cleared", `${result.cleared.length}`);
ok(result.skipped.length === 1 && /not a git/i.test(result.skipped[0].why), "and the folder that is not a repo is skipped, with a reason", result.skipped[0]?.why);

// --- after: nothing is left, INCLUDING what the page never showed ----------------------
{
  const left = listUnboundCommits(big, { acks: result.acks[projectKey(big)] || [] });
  ok(left.length === 0, "the big repo has nothing left - all 60, not just the listed page", `${left.length} left`);
  const leftSmall = listUnboundCommits(small, { acks: result.acks[projectKey(small)] || [] });
  ok(leftSmall.length === 0, "and neither has the small one");
}

// --- undo puts it back exactly ----------------------------------------------------------
{
  const back = listUnboundCommits(big, { acks: result.previous[projectKey(big)] || [] });
  ok(back.length > 0, "restoring the previous acks brings the list back", `${back.length}`);
  ok(JSON.stringify(result.previous) === "{}", "and the previous state really was empty here, so the undo is not a coincidence");
}

// --- running it twice is not work, and says so --------------------------------------------
{
  const again = baselineUnboundCommits({ projectPaths: [big], acks: result.acks });
  ok(again.cleared.length === 0, "a second run clears nothing");
  ok(/already/i.test(again.skipped[0]?.why || ""), "and says the floor was already there", again.skipped[0]?.why);
}

// --- a new commit after the baseline DOES surface -------------------------------------------
// The whole point of a baseline rather than a mute: from here on, the list works again.
{
  execFileSync("git", ["-C", big, "commit", "-q", "--allow-empty", "-m", "feat(thing): made after the line was drawn"], {
    encoding: "utf8",
  });
  const after = listUnboundCommits(big, { acks: result.acks[projectKey(big)] || [] });
  ok(after.length === 1, "a commit made after the baseline shows up", `${after.length}`);
  ok(/after the line was drawn/.test(after[0]?.subject || ""), "and it is the right one", after[0]?.subject);
}

// --- and nowhere does this claim anything was reviewed --------------------------------------
// The words are the mechanism here. A cleared list and an approved list are indistinguishable
// later, so the only protection is that nothing ever said "reviewed".
{
  const lib = fs.readFileSync(new URL("../../src/lib/reviewBaseline.js", import.meta.url), "utf8");
  const renderer = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(/will not be reviewed/i.test(lib), "the module states what it records");
  ok(/NOT record that they were|not that they were/i.test(lib), "and what it does not");
  ok(/not that they were/i.test(renderer), "and the button's own text says the same to the person pressing it");
  // The strongest form: it must not write a review record. A binding is a fact about
  // identity; this is not even that.
  ok(!/writeReviewRecord|reviewRecord/i.test(lib), "and it writes no review record of any kind");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: the whole list clears, the undo restores it, later commits still surface, and nothing claims a review.");
