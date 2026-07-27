// Unit test (no app): the session lifecycle-state projection (Epic f3d096fa,
// increment 1). A pure map from status + orchestratorTag to one FSM state, and the
// three surface-decision helpers - so the later reader migration is behaviour-
// preserving. Run: node scripts/e2e/test-session-lifecycle-state.mjs
import { sessionLifecycleState, isNeedsYouState, isWorkingState, isArchiveSuggestState, sessionStateSource } from "../../src/lib/sessionState.js";
import { createLiveSessionRegistry } from "../../src/lib/liveSessions.js";

let code = 0;
const ok = (c, m) => { console.log(`${c ? "OK  " : "FAIL"} - ${m}`); if (!c) code = 1; };
const tag = (t) => ({ orchestratorTag: { statusTag: t } });
const st = (status, extra = {}) => sessionLifecycleState({ status, ...extra });

// --- the state map ---
ok(st("archived") === "archived", "archived -> archived");
ok(st("active") === "working", "active -> working");
ok(st("active", tag("done_not_archived")) === "working", "active wins even if a stale done tag lingers");
ok(st("waiting") === "waiting", "waiting (no tag) -> waiting (needs-you)");
ok(st("waiting", tag("waiting_for_input")) === "waiting", "waiting + waiting_for_input -> waiting");
ok(st("waiting", tag("stuck")) === "waiting", "waiting + stuck -> waiting (still needs you)");
ok(st("waiting", tag("done_not_archived")) === "wrapped", "waiting + done_not_archived -> wrapped (suppressed, like the needs-you gate)");
ok(st("idle") === "idle", "idle -> idle");
ok(st("idle", tag("done_not_archived")) === "wrapped", "idle + done_not_archived -> wrapped");
ok(st(undefined) === "idle", "missing status -> idle (safe default)");
ok(sessionLifecycleState(null) === "idle", "null session -> idle (no throw)");

// --- bug 4cd7d592: a content signal that input is awaited beats the age-decay ---
// deriveStatus buries an old assistant-ended session as "idle"; if the classifier
// says it's actually awaiting input, promote it back to needs-you regardless of age.
ok(st("idle", tag("waiting_for_input")) === "waiting", "idle + waiting_for_input -> waiting (age-decayed open question is still needs-you)");
ok(st("idle", tag("stuck")) === "idle", "idle + stuck (not waiting_for_input) stays idle - only a clear await-input signal promotes");
// ...unless the user explicitly acked it ("I'm done"): the ack overrides the signal.
ok(sessionLifecycleState({ status: "idle", ...tag("waiting_for_input") }, { isAcked: true }) === "idle",
  "idle + waiting_for_input + acked -> idle (the ack overrides the promotion)");
ok(sessionLifecycleState({ status: "idle", ...tag("waiting_for_input") }, { isAcked: false }) === "waiting",
  "idle + waiting_for_input + not acked -> waiting (explicit opts)");
// The promotion must also take it OUT of archive-suggest (no needs-you + archive both).
ok(isArchiveSuggestState(st("idle", tag("waiting_for_input"))) === false, "a promoted needs-you is NOT archive-suggested");
ok(isNeedsYouState(st("idle", tag("waiting_for_input"))) === true, "a promoted needs-you reads as needs-you");

// --- the decisions map behaviour-preservingly onto the state ---
// today: needs-you  = status waiting && !classifierDone
ok(isNeedsYouState(st("waiting")) === true && isNeedsYouState(st("waiting", tag("done_not_archived"))) === false,
  "needs-you = waiting state (and NOT when done-tagged) - matches today's gate");
// today: working = status active || live
ok(isWorkingState(st("active")) === true && isWorkingState(st("waiting")) === false,
  "working = working state");
// today: archive-suggest = status idle || classifierDone
ok(isArchiveSuggestState(st("idle")) === true && isArchiveSuggestState(st("waiting", tag("done_not_archived"))) === true && isArchiveSuggestState(st("waiting")) === false,
  "archive-suggest = wrapped|idle (idle, or a done-tagged waiting) - matches today");

// --- increment 5: the `launching` state, and the hybrid caveat made explicit ---
// The bug this closes: a just-spawned session's transcript says nothing at all, so
// the file heuristic reads it as idle - "idle while working" at its worst, because
// it is the ONE moment Helm knows the truth for certain (it did the spawning).
const launching = (status, extra = {}) => sessionLifecycleState({ status, ...extra }, { isLaunching: true });
ok(launching("idle") === "launching", "isLaunching beats the idle heuristic - a brand-new session is not parked");
ok(launching(undefined) === "launching", "isLaunching with no status at all -> launching (the transcript has nothing to read yet)");
ok(launching("waiting") === "launching", "isLaunching beats a stale waiting reading");
ok(launching("archived") === "archived", "archived still wins over launching - an archived session is off the board, period");
ok(sessionLifecycleState({ status: "idle", ...tag("waiting_for_input") }, { isLaunching: true }) === "launching",
  "launching is checked BEFORE the needs-you promotion (a session that hasn't spoken can't be awaiting you)");
// It must read as working, and must never be offered for archive.
ok(isWorkingState("launching") === true, "launching counts as working - something IS happening, it just hasn't spoken");
ok(isArchiveSuggestState("launching") === false, "launching is never archive-suggested");
ok(isNeedsYouState("launching") === false, "launching never reads as needs-you");

// stateSource: tracked only where Helm actually has authority.
ok(sessionStateSource({ helmOwned: false }, { isLive: true }) === "derived",
  "a FOREIGN session is 'derived' even when something looks live - Helm has only the transcript heuristic");
ok(sessionStateSource({ helmOwned: false }) === "derived", "a foreign session with no signals is derived");
ok(sessionStateSource({ helmOwned: true }, { isLive: true }) === "tracked", "helm-owned + live turn -> tracked");
ok(sessionStateSource({ helmOwned: true }, { isLaunching: true }) === "tracked", "helm-owned + launching -> tracked");
ok(sessionStateSource({ helmOwned: true }) === "derived",
  "helm-owned but nothing in flight -> derived (ownership alone isn't a live signal; the status still comes from the file)");
ok(sessionStateSource(null) === "derived", "no session at all -> derived, not a crash");

// --- the launching registry: keyed by launchId because a fresh launch has no session id yet ---
const reg = createLiveSessionRegistry();
reg.markLaunching("launch-1", null);
ok(reg.pendingLaunchCount() === 1, "a launch with no session id yet is counted as pending");
ok(reg.isLaunching("sess-a") === false, "...but it doesn't claim to be launching any particular session");
reg.bindLaunch("launch-1", "sess-a");
ok(reg.isLaunching("sess-a") === true, "once the CLI reports an id, the launch binds to it");
ok(reg.pendingLaunchCount() === 0, "and it is no longer counted as pending");
ok(reg.isLaunching("sess-b") === false, "an unrelated session is not launching");
reg.clearLaunching("launch-1");
ok(reg.isLaunching("sess-a") === false, "clearing the launch ends the launching window - a failed launch can't hang there forever");
reg.bindLaunch("launch-gone", "sess-c");
ok(reg.isLaunching("sess-c") === false, "binding a launch that was already cleared must NOT resurrect it");
ok(reg.isLaunching(null) === false && reg.isLaunching(undefined) === false, "a missing id never reads as launching");
reg.markLaunching(null);
ok(reg.pendingLaunchCount() === 0, "marking with no launchId is a no-op, not a phantom pending launch");
// launching and live are independent registries - clearing one must not touch the other.
reg.markLaunching("launch-2", "sess-d");
reg.markLive("sess-d");
reg.clearLaunching("launch-2");
ok(reg.isLive("sess-d") === true, "clearing the launching window leaves a genuinely live turn live");

console.log(code === 0 ? "VERIFY OK: lifecycle-state projection + decision helpers behave as intended (behaviour-preserving foundation)." : "VERIFY FAILED.");
process.exit(code);
