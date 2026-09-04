// Unit test (no app, no API): the live-session registry that fixes "idle while
// working" (task 5939df). Verifies (1) a live session's status is forced to
// "active" over whatever the file heuristic decayed to, matched on either id
// form; (2) refcounting - overlapping turns keep it live until BOTH end; (3) an
// unrelated / finished session is left untouched.
//
// Run:  node scripts/e2e/test-live-session-status.mjs
import { createLiveSessionRegistry } from "../../src/lib/liveSessions.js";

let exitCode = 0;
function ok(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const reg = createLiveSessionRegistry();

// A session whose transcript decayed to "idle" while a turn is genuinely live.
const liveByCli = { cliSessionId: "cli-1", sessionId: "sess-1", status: "idle" };
const liveBySessionId = { sessionId: "sess-2", status: "waiting" }; // no cliSessionId form
const untouched = { cliSessionId: "cli-9", sessionId: "sess-9", status: "waiting" };

reg.markLive("cli-1");
reg.markLive("sess-2");

ok(reg.isLive("cli-1") === true, "isLive true for a marked id");
ok(reg.isLive("cli-9") === false, "isLive false for an unmarked id");

reg.applyStatus(liveByCli);
reg.applyStatus(liveBySessionId);
reg.applyStatus(untouched);
ok(liveByCli.status === "active", "a live session (matched by cliSessionId) is forced to active, over the decayed 'idle'");
ok(liveBySessionId.status === "active", "a live session matched by sessionId (no cli form) is forced to active");
ok(untouched.status === "waiting", "an un-live session keeps its heuristic status (no false 'active')");

// Refcount: two overlapping turns on the same id; ending one keeps it live.
reg.markLive("cli-1"); // now 2 live turns on cli-1
reg.markDone("cli-1"); // back to 1
ok(reg.isLive("cli-1") === true, "refcount: after one of two overlapping turns ends, the session is still live");
reg.markDone("cli-1"); // back to 0
ok(reg.isLive("cli-1") === false, "refcount: once the last live turn ends, the session is no longer forced active");

// After the turn ends, applyStatus no longer overrides.
const afterDone = { cliSessionId: "cli-1", sessionId: "sess-1", status: "idle" };
reg.applyStatus(afterDone);
ok(afterDone.status === "idle", "once done, the session falls back to its real heuristic status");

// Guards: null id is a no-op, null session doesn't throw.
reg.markLive(null);
reg.markDone(null);
ok(reg.size() === 1, "null ids are no-ops (only sess-2 remains live)");
ok(reg.applyStatus(null) === null, "applyStatus(null) is a safe no-op");

console.log(exitCode === 0 ? "VERIFY OK: live-session registry forces 'active' while a turn runs, refcounts overlaps, and leaves idle sessions alone." : "VERIFY FAILED.");
process.exit(exitCode);
