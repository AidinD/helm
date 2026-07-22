// Unit test (no app): the session lifecycle-state projection (Epic f3d096fa,
// increment 1). A pure map from status + orchestratorTag to one FSM state, and the
// three surface-decision helpers - so the later reader migration is behaviour-
// preserving. Run: node scripts/e2e/test-session-lifecycle-state.mjs
import { sessionLifecycleState, isNeedsYouState, isWorkingState, isArchiveSuggestState } from "../../src/lib/sessionState.js";

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

console.log(code === 0 ? "VERIFY OK: lifecycle-state projection + decision helpers behave as intended (behaviour-preserving foundation)." : "VERIFY FAILED.");
process.exit(code);
