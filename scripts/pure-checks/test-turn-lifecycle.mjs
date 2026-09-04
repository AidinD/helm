/**
 * A turn that dies without saying so must not hold the session hostage.
 *
 * Hit live on 2026-08-17: "den verkar fortfarande bara tugga på och jag kan varken
 * prompta eller stoppa", with the process list confirming nothing was running. The turn
 * lock, the live marks and the child handle were released in exactly one place - the
 * `.then` of the promise that started the turn - so a promise that never settled held all
 * of it until Helm was restarted. Stop could not help: it only knew how to kill a tracked
 * child, and there was none, so it returned an error and changed nothing.
 *
 * These build a stuck turn and look at what actually gets let go of. That is the point of
 * the extraction: the previous check of this class asserted against the source text of
 * main.js, which is not proportional to a bug that cost a restart every time it happened.
 */
import { createTurnLifecycle } from "../../src/lib/turnLifecycle.js";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

/** A world with one turn in flight on a resumed session. */
function world({ exitCode = null, signalCode = null } = {}) {
  const liveChildren = new Map([["launch-1", { exitCode, signalCode }]]);
  const launchHolds = new Map([["launch-1", { resumeSessionId: "sess-A", liveTurnId: "sess-A" }]]);
  const sessionTurnLocks = new Set(["sess-A"]);
  const cleared = [];
  const done = [];
  const notices = [];
  const lifecycle = createTurnLifecycle({
    liveChildren,
    launchHolds,
    sessionTurnLocks,
    liveSessions: { clearLaunching: (id) => cleared.push(id) },
    markSessionDone: (id) => done.push(id),
    notify: (launchId, why) => notices.push({ launchId, why }),
  });
  return { lifecycle, liveChildren, launchHolds, sessionTurnLocks, cleared, done, notices };
}

// --- the whole point: the lock comes off ------------------------------------------
{
  const w = world();
  const held = w.lifecycle.finishLaunch("launch-1", "stopped");
  ok(!w.sessionTurnLocks.has("sess-A"), "the per-session turn lock is released");
  ok(w.done.includes("sess-A"), "the session stops being marked live");
  ok(w.cleared.includes("launch-1"), "and stops being marked launching");
  ok(!w.liveChildren.has("launch-1"), "the child handle is dropped");
  ok(!w.launchHolds.has("launch-1"), "and so is what it was holding");
  ok(held?.resumeSessionId === "sess-A", "it reports what it let go of", JSON.stringify(held));
}

// --- Stop, with nothing left to kill ------------------------------------------------
// The exact shape of the live failure: the process is gone, so the old handler returned
// "no running process for that launch" and changed nothing at all.
{
  const w = world();
  w.liveChildren.delete("launch-1"); // the process is already gone
  const held = w.lifecycle.finishLaunch("launch-1", "stopped (its process was already gone)");
  ok(held !== null, "there was still something held, even with no process");
  ok(!w.sessionTurnLocks.has("sess-A"), "and stopping releases it - the session is usable again");
  ok(w.notices.length === 1, "the renderer is told the turn ended", JSON.stringify(w.notices[0]?.why));
}

// --- a launch nobody knows about -----------------------------------------------------
{
  const w = world();
  const held = w.lifecycle.finishLaunch("launch-unknown", "stopped");
  ok(held === null, "an unknown launch reports that nothing was held");
  ok(w.sessionTurnLocks.has("sess-A"), "and does not disturb a different, live turn");
}

// --- calling it twice must be harmless ----------------------------------------------
// Stop, the sweep and the promise can all now try to end the same turn.
{
  const w = world();
  w.lifecycle.finishLaunch("launch-1", "stopped");
  let threw = null;
  try {
    w.lifecycle.finishLaunch("launch-1", "stopped again");
  } catch (err) {
    threw = err;
  }
  ok(threw === null, "a second release does not throw");
  ok(w.done.filter((id) => id === "sess-A").length === 1, "and does not mark the session done twice");
}

// --- the sweep: only genuinely dead processes ----------------------------------------
{
  const alive = world({ exitCode: null, signalCode: null });
  ok(alive.lifecycle.sweepDeadTurns().length === 0, "a running turn is left alone");
  ok(alive.sessionTurnLocks.has("sess-A"), "and keeps its lock");

  const exited = world({ exitCode: 0 });
  ok(exited.lifecycle.sweepDeadTurns().length === 1, "a turn whose process exited is released");
  ok(!exited.sessionTurnLocks.has("sess-A"), "and its lock comes off without anybody clicking anything");

  const killed = world({ signalCode: "SIGKILL" });
  ok(killed.lifecycle.sweepDeadTurns().length === 1, "so is one that was killed by a signal");
}

// --- the startup race, which is how a fix here goes wrong ----------------------------
// The lock is taken BEFORE the child exists. Anything keyed on "no child yet" would end
// a turn that is only still spawning.
//
// NOTE on what this can and cannot catch: the protection here is STRUCTURAL - the sweep
// walks liveChildren, and a still-spawning turn is not in it - so mutating the guard
// inside the loop does not break it and this will not fail for that. It is here to
// document the property and to catch a future sweep rewritten to walk launchHolds
// instead, which is the shape that WOULD end turns that are only starting.
//
// The first version of this deleted the child and asserted the sweep returned nothing -
// which it cannot help doing, because the sweep iterates liveChildren and there was
// nothing left to iterate. A mutation that broke the guard passed it. The property that
// actually matters is that a turn which is still spawning - held, locked, no child yet -
// survives a sweep that is busy releasing a different, genuinely dead one.
{
  const w = world({ exitCode: 0 }); // launch-1 is dead and will be swept
  w.launchHolds.set("launch-2", { resumeSessionId: "sess-B", liveTurnId: null });
  w.sessionTurnLocks.add("sess-B"); // launch-2 is spawning: locked, no child yet

  const released = w.lifecycle.sweepDeadTurns();
  ok(released.length === 1 && released[0] === "launch-1", "the sweep releases the dead turn", released.join(","));
  ok(!w.sessionTurnLocks.has("sess-A"), "whose lock comes off");
  ok(w.sessionTurnLocks.has("sess-B"), "while a turn that is still spawning keeps its lock");
  ok(w.launchHolds.has("launch-2"), "and keeps what it is holding");
}

// --- a normal end must stay quiet ----------------------------------------------------
// The stream handler sends its own "done" with the summary, duration and cost. A second
// one from here would reach a pane that has already torn its state down.
{
  const w = world();
  w.lifecycle.finishLaunch("launch-1", null);
  ok(w.notices.length === 0, "a normal end raises no extra done event");
  ok(!w.sessionTurnLocks.has("sess-A"), "but still releases everything");
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a turn can be ended by whoever notices, once or twice, without stranding the session.");
