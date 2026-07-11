import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Coach signal (vision point 12): how far a project's durable state docs have
// drifted behind the code. Helm's whole thesis is durable-knowledge-in-files so
// an ephemeral session can be archived safely - but nothing enforced keeping
// PLAN.md/DECISIONS.md current, so they went stale under a work flurry. This
// makes the drift VISIBLE (a pane-header nudge) so it gets reconciled on the
// commit cadence, rather than relying on remembering. Read-only; never writes.
//
// Pure git/fs (no electron import) so it's unit-testable in plain node.

export const DOCS_STALE_THRESHOLD = 8; // commits since a doc was last touched before we nudge
const DOC_FILES = ["PLAN.md", "DECISIONS.md"];

function git(projectPath, args) {
  return execFileSync("git", ["-C", projectPath, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

/**
 * How many commits have landed since PLAN.md/DECISIONS.md were last touched.
 * Returns { hasDocs, stale, commitsSince, threshold }. `stale` is true only
 * when the docs are tracked, clean (uncommitted edits = actively being
 * reconciled, so NOT stale), and commitsSince >= threshold. Any uncertainty
 * (no docs, not a git repo, git missing) resolves to not-stale - a nudge that
 * fires on a false positive is worse than a missed one.
 */
export function docsStaleness(projectPath, { threshold = DOCS_STALE_THRESHOLD } = {}) {
  const result = { hasDocs: false, stale: false, commitsSince: 0, threshold };
  if (!projectPath) {
    return result;
  }
  const resolved = path.resolve(projectPath);
  const docs = DOC_FILES.filter((f) => {
    try {
      return fs.existsSync(path.join(resolved, f));
    } catch {
      return false;
    }
  });
  if (docs.length === 0) {
    return result;
  }
  result.hasDocs = true;
  try {
    git(resolved, ["rev-parse", "--is-inside-work-tree"]);
    // Uncommitted (or untracked) doc edits mean you're reconciling right now -
    // not stale.
    if (git(resolved, ["status", "--porcelain", "--", ...docs])) {
      return result;
    }
    const lastDocCommit = git(resolved, ["log", "-1", "--format=%H", "--", ...docs]);
    const range = lastDocCommit ? `${lastDocCommit}..HEAD` : "HEAD";
    const count = parseInt(git(resolved, ["rev-list", "--count", range]), 10);
    result.commitsSince = Number.isFinite(count) ? count : 0;
    result.stale = result.commitsSince >= threshold;
  } catch {
    return { hasDocs: result.hasDocs, stale: false, commitsSince: 0, threshold };
  }
  return result;
}
