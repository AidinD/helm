// A handoff is read before it is committed, and refused if it would publish a private subject.
//
// WHY THIS IS THE ONE PLACE IT MATTERS
// Nothing else in this app puts a file into a repository unread. A handoff save does it every
// time: the note is a whole session narrative - card titles, ids, paths, whatever the session
// happened to be about - written into whichever repository the session is rooted in, and
// committed on the user's behalf with nobody looking at it first. Several of those
// repositories are public.
//
// The push guard does cover the file, and it is not enough on its own: it guards a PUSH. By
// the time it sees the content the commit already exists in local history, so the remedy is a
// rewrite instead of simply not writing it. Refusing here costs a warning.
//
// WHAT MUST STILL HAPPEN ON A REFUSAL
// The file is saved. Saving is saving, and a note lost to a guard is a worse outcome than the
// one being prevented - uncommitted content in a working tree has not been published. So the
// property is a pair: not committed, AND the note is on disk, AND the answer names the subject
// that stopped it. A version that quietly dropped the note would pass a "did not commit" check.
//
// The term list is a fixture. Pointing the sources at a temp directory is not tidiness here:
// without it this check reads the machine's own private subjects, which is the very defect the
// whole change is about, committed inside its own test.
//
// Run:  node scripts/e2e/test-handoff-privacy-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function log(...a) {
  console.log("[handoff-privacy-e2e]", ...a);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-handoff-privacy-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(path.join(metaHome, ".helm", "handoffs"), { recursive: true });
// An invented subject, filed the way the store files one. A real subject here would put the
// thing being protected into the repository that protects it.
fs.writeFileSync(path.join(metaHome, ".helm", "handoffs", "model-trains.md"), "# notes\n", "utf8");

// keel derives its terms from these three, and every one has to be a fixture or the check
// reads the machine.
process.env.HELM_META_HOME = metaHome;
process.env.TEND_DATA_DIR = path.join(tmp, "no-tend");
process.env.NIB_DATA_DIR = path.join(tmp, "no-nib");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9531";

const { launch } = await import("../checks-lib/harness.mjs");
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

function newRepo(name) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `helm-handoff-${name}-`));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "initial");
  return { repo, git };
}

const made = [];
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- 1. a handoff that would publish a private subject -----------------------------------
  {
    const { repo, git } = newRepo("refused");
    made.push(repo);
    const cwd = repo.replace(/\\/g, "/");
    const note = "Picked up where the model-trains session left off and finished the wiring.";
    const saved = await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, ${JSON.stringify(note)})`);

    assert(saved && saved.ok === true, `the save itself still succeeds (${JSON.stringify(saved && saved.ok)})`);
    assert(saved.committed === false, `it is NOT committed (${JSON.stringify(saved.committed)})`);
    assert(
      typeof saved.commitError === "string" && /model-trains/.test(saved.commitError),
      `and the answer names the subject that stopped it, so the note can be edited (${JSON.stringify(saved.commitError)})`
    );
    assert(saved.privateSubjects === true, "and flags the reason as a privacy refusal rather than a git failure");

    const onDisk = fs.readFileSync(path.join(repo, "HANDOFF.md"), "utf8");
    assert(/model-trains session left off/.test(onDisk), "the note is SAVED - a refusal must never cost the user their note");
    assert(
      /HANDOFF\.md/.test(git("status", "--porcelain")),
      "and it is sitting uncommitted, which is where unpublished content belongs"
    );
    assert(
      !/HANDOFF\.md/.test(git("log", "-1", "--name-only", "--format=")),
      "nothing about it reached a commit"
    );
  }

  // --- 2. an ordinary handoff is untouched by the gate --------------------------------------
  // A guard that blocks the ordinary case is one that gets removed within a week, so this
  // half is not a formality: it is the reason the first half is allowed to exist.
  {
    const { repo, git } = newRepo("allowed");
    made.push(repo);
    const cwd = repo.replace(/\\/g, "/");
    const note = "Reconciled the stale records, added the test, and committed the fix.";
    const saved = await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, ${JSON.stringify(note)})`);

    assert(saved && saved.ok === true, "an ordinary handoff saves");
    assert(saved.committed === true, `and still commits itself (${JSON.stringify(saved.commitError)})`);
    assert(saved.privateSubjects === false, "with no privacy refusal recorded");
    assert(
      /HANDOFF\.md/.test(git("log", "-1", "--name-only", "--format=")),
      "HANDOFF.md is in the last commit, exactly as before this gate existed"
    );
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  log(
    exitCode === 0
      ? "VERIFY OK: a handoff that would publish a private subject is saved, refused and explained; an ordinary one commits."
      : "VERIFY FAILED."
  );
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
  for (const repo of made) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(exitCode);
