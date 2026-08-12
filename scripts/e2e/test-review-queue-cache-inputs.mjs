// The review queue costs ~2.2 seconds of blocked main process to build (measured on
// the captain's real board, 2026-08-12). A cache guarded it - but the cache was keyed on AGE
// (20s) while the badge that read it ticked every 60s, so EVERY tick missed and paid the
// full build. Once a minute, forever, for a board he was not looking at. That is the
// "hela appen laggar faktiskt till ibland" this file's fix is for.
//
// reviewQueueInputsFingerprint replaces "how old is it?" with "has anything it was
// computed FROM changed?". Two failure modes, and this pins both:
//   - too STICKY: it stops noticing a real change, and the badge silently freezes.
//   - too LOOSE: it changes when nothing did, and we are back to rebuilding every tick.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-review-queue-cache-inputs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewQueueInputsFingerprint, reviewsDir, writeReviewRecord, buildAutoReviewRecord } from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rqcache-"));
const todos = path.join(home, "todos.json");

try {
  fs.mkdirSync(reviewsDir(home), { recursive: true });
  fs.writeFileSync(todos, JSON.stringify({ todos: [], categories: [] }));

  const fp = () => reviewQueueInputsFingerprint(home, todos);

  const first = fp();
  ok(typeof first === "string" && first.length > 0, "a readable board + records folder produce a fingerprint");
  ok(fp() === first, "reading it again with nothing changed gives the SAME value - otherwise the cache never hits and nothing was fixed");

  // --- the board changing -----------------------------------------------------
  fs.writeFileSync(todos, JSON.stringify({ todos: [{ id: "aaaaaaaa", status: "review" }], categories: [] }));
  const afterBoard = fp();
  ok(afterBoard !== first, "moving a task into review changes the fingerprint, so the badge rebuilds instead of showing a stale count");

  // --- a record being written the way the APP writes it ------------------------
  // Not with a hand-rolled fs.writeFileSync: the folder-mtime shortcut is only valid
  // because writeReviewRecord renames a temp file into place. Writing it here the app's
  // own way is what makes this check able to catch that write path changing.
  const rec = buildAutoReviewRecord({
    taskId: "aaaaaaaa-0000-0000-0000-000000000000",
    projectPath: home,
    outcome: "Finished with 1 commit",
    where: "in a worktree",
    branch: "helm/goal-x",
    worktreePath: home,
    commits: 1,
    lastSummary: "Did the thing.",
    verifyCommand: "npm test",
    stoppedReason: "done",
  });
  const written = writeReviewRecord(home, rec);
  ok(written.ok, `the record wrote (${written.error || "ok"}) - the rest of this check depends on it`);
  const afterRecord = fp();
  ok(afterRecord !== afterBoard, "writing a review record the way the app writes it changes the fingerprint - this is the property the folder-stat shortcut rests on, pinned so a switch to in-place writes fails HERE rather than silently freezing the badge");

  // --- updating that same record ----------------------------------------------
  const rec2 = { ...rec, summary: `${rec.summary} And a second pass.` };
  const updated = writeReviewRecord(home, rec2);
  ok(updated.ok, `the update wrote (${updated.error || "ok"})`);
  ok(fp() !== afterRecord, "UPDATING an existing record also changes it - an in-place rewrite would not have, which is exactly the case that would have gone unnoticed");

  // --- unreadable inputs -------------------------------------------------------
  const gone = path.join(os.tmpdir(), "helm-no-such-home-xyz");
  ok(
    reviewQueueInputsFingerprint(gone, path.join(gone, "todos.json")) === null,
    "when NEITHER input can be read the answer is null, not a string - callers must treat that as 'cannot tell' and rebuild, never as 'unchanged', which would pin a stale queue forever"
  );
  ok(
    typeof reviewQueueInputsFingerprint(home, path.join(gone, "todos.json")) === "string",
    "but one readable input is still a usable fingerprint - a missing board must not disable caching for the records half"
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: the review-queue cache now invalidates on its real inputs, so the badge stops paying a 2.2s rebuild every minute without ever showing a frozen count."
    : "VERIFY FAILED."
);
process.exit(exit);
