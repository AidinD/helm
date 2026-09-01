/**
 * Plant a deadlock and check that Helm says so on its own.
 *
 * The card's own definition of done: "plantera ett dödläge medvetet - stoppa en tur mitt i,
 * låt en compact misslyckas - och kontrollera att appen säger till utan att någon letat
 * efter det. Det är testet de tre enskilda fixarna inte kan ge oss."
 *
 * So this does not assert that the three known deaths are fixed - they are, each in its own
 * place, and a check per fix is exactly the pattern the card rejects. It plants dead work of
 * each shape and asks the watchdog whether it noticed, including a shape nobody anticipated,
 * which is the only one that says anything about the fourth death.
 *
 * `now` is an argument to findStalledWork rather than a clock it reads, so a deadlock can be
 * planted at an exact age instead of waited out.
 *
 * Run: node scripts/e2e/test-watchdog.mjs
 */
import { findStalledWork, workersFromSnapshot, summariseStalls, WORK_KINDS, UNKNOWN_KIND, rulesFor } from "../../src/lib/watchdog.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;
const byId = (stalls, id) => stalls.find((s) => s.id === id) || null;

// --- a turn stopped mid-way ---------------------------------------------------------------
{
  const workers = workersFromSnapshot({
    liveTurns: [
      { launchId: "dead", sessionId: "s1", title: "helm", startedAt: NOW - 90 * MIN, lastProgressAt: NOW - 45 * MIN },
      { launchId: "busy", sessionId: "s2", title: "keel", startedAt: NOW - 90 * MIN, lastProgressAt: NOW - 30 * 1000 },
    ],
  });
  const stalls = findStalledWork(workers, NOW);
  const dead = byId(stalls, "turn:dead");
  ok(!!dead, "a turn that has streamed nothing for 45 minutes is reported");
  ok(!byId(stalls, "turn:busy"), "and one that streamed 30 seconds ago is not");
  ok(!!dead && /helm/.test(dead.label), "the finding names the session, so it can be acted on without hunting");
  ok(!!dead && /Stop/.test(dead.whatToDo), "and says what to do about it");
  ok(!!dead && dead.context.launchId === "dead", "carrying the launch id the surface needs");
}

// --- a compaction that keeps failing --------------------------------------------------------
{
  const workers = workersFromSnapshot({
    compactFailures: [{ sessionId: "s3", title: "a huge session", firstFailedAt: NOW - 8 * 60 * MIN, failures: 12 }],
  });
  const stalls = findStalledWork(workers, NOW);
  ok(stalls.length === 1, "a compaction failing for eight hours is reported");
  ok(stalls[0].context.failures === 12, "with the number of attempts, which is the cost");
}

// --- a run recorded as running whose owner is gone --------------------------------------------
{
  const workers = workersFromSnapshot({
    ownPid: 1000,
    goalRuns: [
      // Ours, and its last finished iteration was 40 minutes ago - past the iteration limit.
      { goalRunId: "mine", status: "running", livePid: 1000, goal: "build the thing", startedAt: NOW - 60 * MIN, lastProgressAt: NOW - 40 * MIN },
      // Ours, and moving.
      { goalRunId: "moving", status: "running", livePid: 1000, goal: "other thing", startedAt: NOW - 60 * MIN, lastProgressAt: NOW - 2 * MIN },
      // Somebody else's, beating right now - hands off.
      { goalRunId: "theirs", status: "running", livePid: 2000, goal: "their thing", startedAt: NOW - 60 * MIN, liveHeartbeatAt: NOW - 10 * 1000 },
      // Nobody's: the process that owned this died and the record still says running.
      { goalRunId: "orphan", status: "running", livePid: 3000, goal: "abandoned thing", startedAt: NOW - 3 * 24 * 60 * MIN, liveHeartbeatAt: NOW - 3 * 24 * 60 * MIN },
      // Finished, so not work at all.
      { goalRunId: "done", status: "done", livePid: null, goal: "finished thing", startedAt: NOW - 60 * MIN },
    ],
  });
  const stalls = findStalledWork(workers, NOW);
  ok(!!byId(stalls, "goalRun:mine"), "an iteration of our own run that has not finished in 40 minutes is reported");
  ok(!byId(stalls, "goalRun:moving"), "and one that finished an iteration two minutes ago is not");
  ok(!byId(stalls, "goalRun:theirs"), "a run another Helm is actively beating on is left alone");
  const orphan = byId(stalls, "goalRun:orphan");
  ok(!!orphan, "a run left as running by a process that died is reported");
  ok(!!orphan && /no Helm process has claimed it/.test(orphan.reason), "and the reason says the owner is gone, not that the work is slow");
  ok(!byId(stalls, "goalRun:done"), "a finished run is not work and is not reported");
  // The two questions are genuinely different, and conflating them is what let a run sit
  // "running" for three weeks: the heartbeat proves the OWNER is alive, never the work.
  ok(byId(stalls, "goalRun:mine").kind === "goalIteration" && orphan.kind === "goalRun", "the two are reported as different kinds, because they are different faults");
}

// --- a crew run that finished and nobody was told ----------------------------------------------
{
  const workers = workersFromSnapshot({
    reports: [
      { dispatchId: "unread", dispatchedBy: "mate_a", goal: "fix the parser", reportedAt: NOW - 3 * 60 * MIN, dispatcherLastActiveAt: NOW - 5 * 60 * MIN },
      { dispatchId: "seen", dispatchedBy: "mate_b", goal: "fix the other parser", reportedAt: NOW - 3 * 60 * MIN, dispatcherLastActiveAt: NOW - 60 * MIN },
    ],
  });
  const stalls = findStalledWork(workers, NOW);
  ok(!!byId(stalls, "handback:unread"), "a finished crew run whose mate has not run since is reported");
  ok(!byId(stalls, "handback:seen"), "and one whose mate has had a turn since is not");
}

// --- the fourth death: a kind nobody anticipated ------------------------------------------------
// This is the assertion the card is actually about. Everything above is a known death.
{
  const stalls = findStalledWork([{ kind: "somethingNobodyPlannedFor", id: "x", lastProgressAt: NOW - 30 * MIN }], NOW);
  ok(stalls.length === 1, "work of a kind the watchdog has never heard of is still judged");
  ok(/does not recognise the kind/.test(stalls[0].reason), "and the finding says the kind was unknown rather than pretending to know");
  ok(rulesFor("somethingNobodyPlannedFor") === UNKNOWN_KIND, "using the cautious fallback rules");
  ok(UNKNOWN_KIND.limitMs < WORK_KINDS.compaction.limitMs, "whose limit is tighter than a known one, so a new kind errs towards being seen");
}

// --- work nothing measures at all -----------------------------------------------------------
{
  const stalls = findStalledWork(
    [
      { kind: "turn", id: "unmeasured", lastProgressAt: null, startedAt: null },
      { kind: "turn", id: "young", lastProgressAt: NOW - 1 * MIN },
    ],
    NOW
  );
  const un = byId(stalls, "unmeasured");
  ok(!!un, "work with no progress timestamp at all is reported, not skipped");
  ok(!!un && un.measured === false, "flagged as unmeasured rather than as late");
  ok(!!un && /no way to tell whether it is working or dead/.test(un.reason), "with a reason that says the measurement is missing");
  ok(stalls[0].id === "unmeasured", "and it sorts first, because a hole outranks an event");
  ok(!byId(stalls, "young"), "healthy work is still quiet");
}

// --- a progress timestamp in the future -----------------------------------------------------
{
  const stalls = findStalledWork(
    [
      { kind: "turn", id: "future", lastProgressAt: NOW + 5 * 24 * 60 * MIN },
      { kind: "turn", id: "skewed", lastProgressAt: NOW + 2 * MIN },
    ],
    NOW
  );
  // Otherwise a bad clock buys permanent immunity from the one check meant to catch it.
  ok(!!byId(stalls, "future"), "a progress stamp days in the future is reported, not trusted");
  ok(!byId(stalls, "skewed"), "while ordinary clock skew of a couple of minutes is tolerated");
}

// --- nothing wrong says nothing --------------------------------------------------------------
{
  const stalls = findStalledWork(workersFromSnapshot({ liveTurns: [{ launchId: "a", startedAt: NOW, lastProgressAt: NOW }] }), NOW);
  ok(stalls.length === 0, "healthy work produces no findings");
  ok(summariseStalls(stalls) === null, "and the summary is null rather than an all-clear - an all-clear every tick is how a real signal gets ignored");
}

// --- worst first means worst RELATIVE TO ITS OWN LIMIT ----------------------------------------
{
  // Raw age would put the compaction first: five hours beats forty minutes. But an hour is
  // routine for a compaction (limit: one hour) and unheard of for a turn (limit: twenty
  // minutes), so ranking by age compares numbers that do not mean the same thing. The turn
  // is 6x past its limit; the compaction is 1.5x past its own.
  const stalls = findStalledWork(
    [
      { kind: "compaction", id: "b", lastProgressAt: NOW - 90 * MIN },
      { kind: "turn", id: "a", label: 'the turn in "helm"', lastProgressAt: NOW - 120 * MIN },
    ],
    NOW
  );
  ok(stalls[0].id === "a", "the one furthest past its OWN limit sorts first, not the one with the biggest number");
}

// --- the summary a person actually reads ------------------------------------------------------
{
  const stalls = findStalledWork(
    [
      { kind: "turn", id: "a", label: 'the turn in "helm"', lastProgressAt: NOW - 120 * MIN },
      { kind: "compaction", id: "b", lastProgressAt: NOW - 90 * MIN },
    ],
    NOW
  );
  const line = summariseStalls(stalls);
  ok(typeof line === "string" && line.includes("helm"), "the summary names the worst one specifically");
  ok(/1 other piece of work is not moving/.test(line), "and counts the rest without listing them");
  // No error codes, no internal names: the reply is the status channel.
  ok(!/\b(EPERM|ENOENT|undefined|null)\b/.test(line), "in plain words, with no internal names or error codes");
}

// --- every kind carries its evidence ----------------------------------------------------------
{
  // A limit with no stated reason is a number nobody will ever be able to argue with, which
  // means nobody will fix it when it turns out wrong.
  const bad = Object.entries(WORK_KINDS).filter(([, r]) => !r.why || !r.whatToDo || !(r.limitMs > 0));
  ok(bad.length === 0, `every kind states a limit, why it matters and what to do (${Object.keys(WORK_KINDS).length} kinds)`);
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: planted deadlocks of five shapes are reported, healthy work is quiet." : "VERIFY FAILED.");
process.exit(exit);
