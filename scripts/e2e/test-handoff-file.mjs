// E2E: a session handoff is saved to <cwd>/HANDOFF.md and OVERWRITES (latest-
// only), so it never grows the way appending into DECISIONS.md did (the captain
// 2026-07-14 - Skiff's DECISIONS.md had bloated with transient handoff
// narrative). Drives the real context:saveHandoff IPC via a launched Helm.
//
// Run:  node scripts/e2e/test-handoff-file.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function log(...a) {
  console.log("[handoff-file-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-handoff-"));
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const cwd = tmp.replace(/\\/g, "/");
  const first = await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, "FIRST handoff - state A")`);
  assert(first && first.ok, `saveHandoff writes HANDOFF.md (got ${JSON.stringify(first)})`);
  const afterFirst = fs.readFileSync(path.join(tmp, "HANDOFF.md"), "utf8");
  assert(/FIRST handoff - state A/.test(afterFirst), "the first handoff text is in HANDOFF.md");
  assert(/# Handoff - latest session state/.test(afterFirst), "HANDOFF.md carries the latest-state header");
  assert(/Overwritten on each handoff/.test(afterFirst), "the header explains it's overwritten (latest-only)");

  // A SECOND handoff must OVERWRITE, not append.
  await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, "SECOND handoff - state B")`);
  const afterSecond = fs.readFileSync(path.join(tmp, "HANDOFF.md"), "utf8");
  assert(/SECOND handoff - state B/.test(afterSecond), "the second handoff text is in HANDOFF.md");
  assert(!/FIRST handoff - state A/.test(afterSecond), "the first handoff is GONE - overwritten, not appended (won't grow)");
  assert((afterSecond.match(/# Handoff - latest session state/g) || []).length === 1, "exactly one handoff header (not stacked)");

  // Empty text is a no-op error (doesn't clobber with an empty file).
  const empty = await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, "   ")`);
  assert(empty && empty.ok === false, "empty handoff text is rejected, not saved");
  assert(/SECOND handoff/.test(fs.readFileSync(path.join(tmp, "HANDOFF.md"), "utf8")), "the prior handoff survives an empty-save attempt");

  // Committed immediately (the captain, task 76790f23: "ja, en handoff borde commitas
  // direkt" - a handoff left uncommitted made git status report the repo dirty
  // FOREVER, which stamped every review check run "ran on uncommitted changes"
  // regardless of what was actually being tested). A real repo, not the plain
  // temp dir above, since git has to actually exist to commit into.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-handoff-repo-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "initial");
  // A genuinely dirty tree at save time (the ordinary edit-then-test-then-
  // commit flow means there often is one) must survive UNCOMMITTED - the
  // handoff commit stages ONLY HANDOFF.md, never -A.
  fs.writeFileSync(path.join(repo, "unrelated-work-in-progress.txt"), "not part of the handoff", "utf8");
  const repoCwd = repo.replace(/\\/g, "/");
  const saved = await app.eval(`window.helm.saveHandoff(${JSON.stringify(repoCwd)}, "Handoff that should get committed")`);
  assert(saved && saved.ok, `saveHandoff still succeeds in a real repo (${JSON.stringify(saved)})`);
  const statusAfter = git("status", "--porcelain");
  // TWO WORLDS, BOTH LEGITIMATE, and the check now says which one it is in rather than
  // assuming the author's. A machine with a global git identity commits the handoff. A machine
  // without one - which is every fresh machine, and every hosted CI runner - cannot, and that
  // is not a failure of this feature.
  //
  // What IS a failure is saying nothing about it. Until 2026-09-03 the commit was best-effort
  // and silent, so on a machine with no identity the exact problem committing was added to
  // solve came straight back with nobody told: HANDOFF.md sits uncommitted forever and stamps
  // every review run "ran on uncommitted changes". This check only ever ran where an identity
  // exists, so it had never seen it.
  //
  // So the assertion is on the pair - either it committed, or it said why not - which is true
  // in both worlds and false in the one that was shipping.
  assert(
    typeof saved.committed === "boolean",
    `the answer says whether it committed rather than leaving the caller to guess (${JSON.stringify(saved.committed)})`
  );
  if (saved.committed) {
    assert(/HANDOFF\.md/.test(git("log", "-1", "--name-only", "--format=")), "it committed, and HANDOFF.md is in the last commit's file list");
    assert(!/HANDOFF\.md/.test(statusAfter), "and no longer shows up as uncommitted");
    assert(
      /unrelated-work-in-progress\.txt/.test(statusAfter),
      "but the OTHER uncommitted file is untouched - the handoff commit is scoped to HANDOFF.md only, never -A"
    );
    const log1 = git("log", "-1", "--format=%s");
    assert(/handoff/i.test(log1), `the commit message says what it is (${JSON.stringify(log1)})`);
    assert(!saved.commitError, `and it does not also report an error (${saved.commitError})`);
  } else {
    assert(
      typeof saved.commitError === "string" && saved.commitError.length > 30,
      `it did not commit, and says why in a sentence (${JSON.stringify(saved.commitError)})`
    );
    assert(
      /HANDOFF\.md/.test(statusAfter),
      "the file is still there uncommitted, which is what the message is about - saved is saved"
    );
    assert(
      /user\.email|user\.name|git/i.test(saved.commitError),
      "and the message names git rather than being a generic failure nobody can act on"
    );
    console.log(`      (no commit here, and it said so: ${saved.commitError.slice(0, 100)})`);
  }
  fs.rmSync(repo, { recursive: true, force: true });

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  log(exitCode === 0 ? "VERIFY OK: handoffs land in HANDOFF.md, overwrite (latest-only), and commit themselves without sweeping up other work." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
