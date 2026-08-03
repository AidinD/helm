// Resolving a session's transcript must not cost a filesystem probe per project folder.
//
// findTranscriptPath answered every lookup by stat-ing the same candidate path in EVERY
// project directory. On the captain's machine that is 292 directories, measured at 25ms per
// lookup and 938ms for the 40 lookups a session list performs - all synchronous, in the
// Electron main process. Callers loop over sessions (session:liveSubAgents, the status
// classifier, the context-size estimate), so the cost multiplies.
//
// It also explains "mycket segare an tidigare" with no code having changed: the cost is
// proportional to the NUMBER OF PROJECT DIRECTORIES, and that grows every day. 419 MB
// across 1155 files in 292 directories here.
//
// The correctness half matters as much as the speed: an index that goes stale must never
// make a live session look transcript-less, and the newest copy must still win when the
// same id exists in two folders (which happens for real after a root-folder switch).
//
// Run:  node scripts/e2e/test-transcript-index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-tidx-"));
process.env.HELM_PROJECTS_ROOT = root;
// Dynamic import AFTER the env var: paths.js resolves projectsRoot once at import time,
// and a static import here would read the ambient value and silently test the real
// 292-directory folder instead.
const { findTranscriptPath, invalidateTranscriptIndex, projectsRoot } = await import("../../src/lib/paths.js");

const mkProject = (name) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const write = (dir, id, body = "{}\n", mtime = null) => {
  const p = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(p, body);
  if (mtime) {
    fs.utimesSync(p, mtime / 1000, mtime / 1000);
  }
  return p;
};

try {
  ok(projectsRoot === root, `the seam is in effect (${projectsRoot === root})`);

  // A realistic shape: many project dirs, the transcript in one of them.
  for (let i = 0; i < 40; i++) {
    mkProject(`D--Repo-project-${i}`);
  }
  const home = mkProject("D--Repo-Tools-helm");
  const wanted = write(home, "sess-aaaa");

  ok(path.resolve(findTranscriptPath("sess-aaaa") || "") === path.resolve(wanted), "an existing transcript is found");
  ok(findTranscriptPath("local_sess-aaaa") !== null, "the local_ prefix is still stripped");
  ok(findTranscriptPath("sess-nope") === null, "an unknown id returns null rather than a wrong path");
  ok(findTranscriptPath([]) === null && findTranscriptPath(null) === null, "no ids is null, not a throw");
  ok(
    path.resolve(findTranscriptPath(["sess-nope", "sess-aaaa"]) || "") === path.resolve(wanted),
    "a list falls through to the id that exists - the cliSessionId/sessionId pair"
  );

  // --- the newest copy wins ---------------------------------------------------
  // Real case: switchSessionRootFolder copies a transcript to a new project dir, so the
  // same id exists twice until the next turn is written. Enumeration order is not
  // meaningfully "correct"; the live conversation is the one most recently modified.
  const moved = mkProject("D--Repo-Tools-helm-moved");
  const older = 1_600_000_000_000;
  fs.utimesSync(wanted, older / 1000, older / 1000);
  const newer = write(moved, "sess-aaaa", "{}\n{}\n", older + 60_000);
  invalidateTranscriptIndex();
  ok(
    path.resolve(findTranscriptPath("sess-aaaa") || "") === path.resolve(newer),
    "with two copies, the most recently modified one wins"
  );

  // --- a brand-new transcript must resolve, not wait out a cache --------------
  const fresh = mkProject("D--Repo-brand-new");
  const freshPath = write(fresh, "sess-brandnew");
  ok(
    path.resolve(findTranscriptPath("sess-brandnew") || "") === path.resolve(freshPath),
    "a transcript created AFTER the index was built still resolves - a miss forces one rebuild"
  );

  // ...and explicitly, which is what recordHelmSession uses so a new session never has to
  // wait for a TTL.
  const later = mkProject("D--Repo-later");
  const laterPath = write(later, "sess-later");
  invalidateTranscriptIndex();
  ok(path.resolve(findTranscriptPath("sess-later") || "") === path.resolve(laterPath), "and invalidation resolves it at once");

  // --- an indexed file that has since been deleted must not be returned -------
  fs.rmSync(laterPath);
  ok(findTranscriptPath("sess-later") === null, "a file deleted since indexing is not handed back as a live path");

  // --- SPEED, which is the point ---------------------------------------------
  // Measured against the shape that hurt: repeated lookups, as a session list does. The
  // old implementation stat-ed once per project directory PER LOOKUP.
  invalidateTranscriptIndex();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    findTranscriptPath("sess-aaaa");
  }
  const perLookupMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  console.log(`    ${perLookupMs.toFixed(3)}ms per lookup over 43 project dirs`);
  // A generous ceiling: the old code did one statSync per directory, so it could not
  // possibly beat this, and a regression back to that shape blows straight through it.
  ok(perLookupMs < 1, `a warm lookup costs well under a millisecond (${perLookupMs.toFixed(3)}ms)`);
  // And the cost must not scale with the number of project directories any more.
  for (let i = 0; i < 200; i++) {
    mkProject(`D--Repo-bulk-${i}`);
  }
  invalidateTranscriptIndex();
  findTranscriptPath("sess-aaaa"); // build the bigger index
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    findTranscriptPath("sess-aaaa");
  }
  const bigMs = Number(process.hrtime.bigint() - t1) / 1e6 / 200;
  console.log(`    ${bigMs.toFixed(3)}ms per lookup over 243 project dirs`);
  ok(
    bigMs < Math.max(0.5, perLookupMs * 3),
    `five times the directories does not multiply the lookup cost (${perLookupMs.toFixed(3)}ms -> ${bigMs.toFixed(3)}ms)`
  );
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: transcript lookups are indexed - correct for new, moved and deleted transcripts, and no longer proportional to the number of project directories."
    : "VERIFY FAILED."
);
process.exit(exit);
