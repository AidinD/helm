/**
 * Draw a line under every commit nobody tied to a card, and start from here.
 *
 * ## Why this exists
 *
 * Measured 2026-09-01: 510 commits across 16 projects sat in "commits without a task", and
 * several projects were at the per-project cap of 50, so the real number is higher. They are
 * there for a reason that is not going away by itself - almost no commit carries a task id,
 * so almost every commit anybody makes lands in that list.
 *
 * the captain, asked what to do about them: "ta bort alla obundna. jag kommer inte gå igenom dem.
 * Jag vill komma till en baseline och sen kan jag börja." That is the right call and it is
 * his to make - a backlog nobody is ever going to read is not a queue, it is a wall in front
 * of the six rows that do need him.
 *
 * ## What this does and, more importantly, does not mean
 *
 * It records that these commits will not be reviewed. It does NOT record that they were.
 * Nothing here writes a review record, no verdict, no evidence, no check - and the wording
 * everywhere it surfaces has to keep that distinction, because "cleared" and "approved" look
 * identical in a list a month later. The existing per-project control is called "Seen all"
 * for exactly this reason; this is the same act, at once, for a person who has said out loud
 * that he is not going to look.
 *
 * ## Why acknowledging HEAD is enough, and exact
 *
 * listUnboundCommits runs `git log HEAD --not <every ack>`. So one ack at the current HEAD
 * excludes everything reachable from it - the whole history, not the fifty the page had room
 * to show. The scan never looks past HEAD, so there is no divergent branch left behind
 * either. One sha per project clears that project completely.
 *
 * ## Undo
 *
 * The acks that existed before are returned, so a caller can put them back. A bulk clear that
 * cannot be undone is a bulk clear nobody should press.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectKey } from "./commitReview.js";

function git(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

/**
 * @param {object} input
 * @param {string[]} input.projectPaths every git project the review page scans
 * @param {Record<string, string[]>} [input.acks] the acks as they stand
 * @param {(p: string, a: string[]) => string} [input.run]
 * @returns {{ acks: Record<string, string[]>, previous: Record<string, string[]>, cleared: Array<{projectPath: string, head: string}>, skipped: Array<{projectPath: string, why: string}> }}
 */
export function baselineUnboundCommits({ projectPaths, acks = {}, run = git }) {
  const previous = JSON.parse(JSON.stringify(acks || {}));
  const next = { ...(acks || {}) };
  const cleared = [];
  const skipped = [];
  const seen = new Set();

  for (const raw of projectPaths || []) {
    if (!raw) {
      continue;
    }
    let abs;
    try {
      abs = path.resolve(raw);
    } catch {
      skipped.push({ projectPath: String(raw), why: "not a resolvable path" });
      continue;
    }
    const key = projectKey(abs);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!fs.existsSync(path.join(abs, ".git"))) {
      skipped.push({ projectPath: abs, why: "not a git repository" });
      continue;
    }
    let head;
    try {
      head = run(abs, ["rev-parse", "HEAD"]);
    } catch (err) {
      // A repo with no commits yet, or an unreadable one. Skipped and named, rather than
      // failing the whole operation over one project.
      skipped.push({ projectPath: abs, why: `could not read HEAD: ${err.message}` });
      continue;
    }
    if (!/^[0-9a-f]{40}$/i.test(head)) {
      skipped.push({ projectPath: abs, why: `HEAD did not resolve to a commit (${head})` });
      continue;
    }
    const set = new Set(next[key] || []);
    if (set.has(head)) {
      // Already the floor. Not an error and not work - saying so keeps the report honest
      // about how much this actually changed.
      skipped.push({ projectPath: abs, why: "already at this commit" });
      continue;
    }
    set.add(head);
    next[key] = [...set];
    cleared.push({ projectPath: abs, head });
  }

  return { acks: next, previous, cleared, skipped };
}
