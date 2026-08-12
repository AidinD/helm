// The session list is read on a 30-second poll, and every read tail-read 96KB of every
// session's transcript to work out whose turn it was - 2.4MB per tick on the captain's machine,
// to learn nothing, because 85 of his 90 sessions had no activity in 24 hours and 80 were
// archived. Two things changed:
//
//   - an ARCHIVED session's transcript is not read at all (deriveStatus returns "archived"
//     before it looks at the role, and nothing outside sessions.js reads the field);
//   - the answer is cached against the transcript file's own mtime+size.
//
// A cache on a status heuristic is exactly the kind of speed-up that can go quietly wrong:
// if it stops noticing an append, a session that IS waiting for you reads as idle, and the
// needs-you queue - the whole point of the app - silently misses it. So this asserts the
// cache UPDATES, not merely that it is fast.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-session-read-cache.mjs
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sessread-"));
const projects = path.join(root, "projects");
const sessionsDir = path.join(root, "sessions");
fs.mkdirSync(path.join(projects, "proj"), { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
process.env.HELM_PROJECTS_ROOT = projects;
process.env.HELM_SESSIONS_ROOT = sessionsDir;
// Dynamic import AFTER the env vars: paths.js resolves both roots once at import time, so
// a static import would silently run this against the real session folder.
const { readAllSessions } = await import("../../src/lib/sessions.js");
const { invalidateTranscriptIndex } = await import("../../src/lib/paths.js");

const transcript = (id, lines) => {
  const p = path.join(projects, "proj", `${id}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
};
const meta = (id, extra = {}) => {
  fs.writeFileSync(
    path.join(sessionsDir, `local_${id}.json`),
    JSON.stringify({ sessionId: id, cliSessionId: id, title: id, cwd: "D:/x", lastActivityAt: Date.now(), ...extra })
  );
};
const find = (list, id) => list.sessions.find((s) => s.sessionId === id);

try {
  const LIVE = "11111111-1111-1111-1111-111111111111";
  const ARCH = "22222222-2222-2222-2222-222222222222";
  const livePath = transcript(LIVE, [{ type: "user", message: {} }]);
  transcript(ARCH, [{ type: "assistant", message: {} }]);
  meta(LIVE);
  meta(ARCH, { isArchived: true });
  invalidateTranscriptIndex();

  const opts = { archivedSessions: [], helmSessions: {} };
  const first = readAllSessions(opts);
  ok(first.sessions.length === 2, `both staged sessions are read (${first.sessions.length}) - and nothing from the real folder`);
  ok(find(first, LIVE)?.lastRole === "user", "a live session's last role is derived from its transcript");
  ok(find(first, LIVE)?.status === "active", "and its status follows from that");

  // --- the archived session's transcript is not consulted ----------------------
  const arch = find(first, ARCH);
  ok(arch?.status === "archived", "an archived session is archived");
  ok(arch?.lastRole === null, "and its transcript was NOT read - the role is null rather than derived, because the status could never have depended on it");

  // --- the cache must UPDATE when the transcript grows --------------------------
  // The failure this guards: a waiting session reading as idle forever.
  const before = find(readAllSessions(opts), LIVE).lastRole;
  ok(before === "user", "an unchanged transcript gives the same answer (the cache hit)");
  fs.appendFileSync(livePath, JSON.stringify({ type: "assistant", message: {} }) + "\n");
  const after = find(readAllSessions(opts), LIVE);
  ok(
    after.lastRole === "assistant",
    `appending an assistant turn CHANGES the answer (${after.lastRole}) - if this ever reads "user", a session waiting for the captain has gone invisible in the needs-you queue`
  );
  ok(after.status === "waiting", "and the derived status follows it to waiting, which is what the queue keys on");

  // --- an in-place rewrite that keeps the SAME SIZE ----------------------------
  // The case size alone would miss: the file is rewritten so the last turn is a user turn
  // again, with the byte count unchanged. Only the mtime half of the key catches it.
  const rewritten = [
    { type: "assistant", message: {} },
    { type: "user", message: {} },
  ];
  const sameSizeBody = rewritten.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const previousSize = fs.statSync(livePath).size;
  fs.writeFileSync(livePath, sameSizeBody);
  ok(fs.statSync(livePath).size === previousSize, `the rewrite really is the same size (${previousSize} bytes) - otherwise this checks nothing that the append above did not`);
  const flipped = find(readAllSessions(opts), LIVE);
  ok(
    flipped.lastRole === "user",
    `a same-size in-place rewrite is still noticed (${flipped.lastRole}) - keying the cache on size alone would have returned the stale "assistant" here`
  );

  // --- the real data folder was never touched ----------------------------------
  // The env seam is only honoured if it was set before the import; if it was not, the
  // numbers above would have come from the captain's real 90 sessions.
  ok(first.sessions.length === 2 && !first.error, "the whole run stayed inside the temp fixture (2 sessions, no error) - proof the env seam took effect and no real session file was read");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: the session read skips work it does not need and still notices every change that decides a session's status."
    : "VERIFY FAILED."
);
process.exit(exit);
