/**
 * Nothing dies quietly.
 *
 * ## Why this is one thing and not three fixes
 *
 * the captain, 2026-08-17: "Inget ska dö tyst." Three silent deaths were known when this was
 * written, and no two shared a mechanism:
 *
 *   - Auto-compact never recorded a failure, so the loop re-queued the same session every
 *     fifteen minutes and had done it 256 times since 13 August.
 *   - A turn whose promise never settled held its session lock forever. The app showed
 *     "working", every new prompt was refused, and Stop could not help because there was
 *     no tracked child left to kill.
 *   - A crew run finished and nothing woke the mate that dispatched it.
 *
 * Each was fixed where it happened. Fixing all three does not catch the fourth, and that is
 * the entire point of this file: every one of them was invisible until the captain happened to
 * look. What was missing was not three fixes but a sign of life - one thing that says so
 * when something that ought to be moving is not.
 *
 * ## What it is and is not
 *
 * It is not a deadline that kills work. Nothing here stops, restarts, or cleans up
 * anything; it produces findings, and a person decides. A watchdog that acts is a second
 * mechanism able to destroy work silently, which is the disease.
 *
 * It compares a piece of work's last sign of progress against what is reasonable for that
 * KIND of work. "Reasonable" differs by an order of magnitude between a compaction and an
 * autonomous goal run, so a single global timeout would either shout constantly or never.
 *
 * ## The two rules that decide the false-positive direction
 *
 * Both lean the same way on purpose (the captain's standing rule for attention signals: flag in
 * doubt, never suppress a real one).
 *
 * 1. Work with NO progress timestamp is stalled, not skipped. A worker nothing can measure
 *    is precisely the fourth silent death - the one no fix anticipated - so the absence of
 *    a measurement is itself the finding.
 * 2. A kind this file has never heard of gets the most cautious limit there is, and says
 *    the kind was unknown. A new sort of work must not become invisible by being new.
 */

const MINUTE = 60 * 1000;

/**
 * What counts as too long without progress, per kind of work, and why.
 *
 * Every number is a claim about the world and carries the evidence for it, because a limit
 * nobody can argue with is a limit nobody will fix when it turns out wrong.
 */
export const WORK_KINDS = {
  turn: {
    label: "a turn",
    limitMs: 20 * MINUTE,
    // A turn streams continuously - a tool call, a token, anything - so silence is a
    // stronger signal here than elsewhere. Twenty minutes is generous even for a long
    // agentic turn, and the failure it exists for held a lock for the rest of the app's
    // life, so being late costs far less than being wrong.
    why: "a turn streams something every few seconds; total silence means the process is gone or wedged",
    whatToDo: "Press Stop on the session. If Stop cannot clear it, the turn is holding a lock nothing will release and Helm needs a restart.",
  },
  goalIteration: {
    label: "a goal-run iteration",
    // An iteration has a hard 15-minute limit inside the orchestrator. Passing 25 means
    // the timeout that should have fired did not - which is a different fault from a slow
    // iteration and deserves to be seen as one.
    limitMs: 25 * MINUTE,
    why: "an iteration has a hard 15-minute limit, so more than that without progress means the limit itself did not fire",
    whatToDo: "Open the run on the Goal page and stop it. Its worktree and any commits it made are still on disk.",
  },
  goalRun: {
    label: "a goal run",
    // Not about speed: this is a run recorded as "running" whose owning process is gone.
    // The heartbeat proves the OWNER is alive, not that the work is moving, so it answers
    // this question and not the one above.
    limitMs: 5 * MINUTE,
    why: "the run is recorded as running, but no Helm process has claimed it recently - the process that owned it is gone",
    whatToDo: "Resume it from the Goal page, or mark it finished. Nothing is driving it right now.",
  },
  compaction: {
    label: "a compaction",
    limitMs: 60 * MINUTE,
    why: "a compaction that keeps failing costs a full model call every time it retries and never gets closer",
    whatToDo: "Look at the session's size on the Analysis page. A session that cannot be compacted usually needs to be retired instead.",
  },
  handback: {
    label: "a finished crew run nobody was told about",
    // The third known death. Not slowness at all - the work SUCCEEDED and then stopped
    // existing as far as its dispatcher was concerned.
    limitMs: 10 * MINUTE,
    why: "the run finished and the mate that dispatched it was never woken, so its result is sitting there unread",
    whatToDo: "Open the mate and relay the result, or review the run's commits directly.",
  },
  dispatch: {
    label: "a queued dispatch",
    limitMs: 15 * MINUTE,
    why: "a dispatch that never starts is indistinguishable from one that is working, until you look",
    whatToDo: "Check the dispatch queue. A dispatch that cannot start usually names its reason there.",
  },
};

/**
 * The limit for a kind nothing here knows about.
 *
 * Ten minutes and not an hour: an unrecognised kind is the case with the least evidence
 * behind it, so it gets the setting that is wrong in the cheap direction. Being told about
 * healthy work costs a glance. Not being told is what this file exists to stop.
 */
export const UNKNOWN_KIND = {
  label: "work of an unrecognised kind",
  limitMs: 10 * MINUTE,
  why: "Helm does not know what this kind of work is, so it cannot know what is reasonable for it",
  whatToDo: "Add this kind to WORK_KINDS in watchdog.js with a limit and the reason for it.",
};

/**
 * A timestamp this far in the future is not a timestamp.
 *
 * Small skew is normal - different clocks, a record written a moment ago. An hour is not,
 * and a future progress stamp makes work permanently un-stallable, which is the exact
 * property this file must never grant by accident.
 */
const FUTURE_TOLERANCE_MS = 60 * MINUTE;

/**
 * @typedef {object} Worker A piece of work that ought to be moving.
 * @property {string} kind One of WORK_KINDS, or anything at all - see UNKNOWN_KIND.
 * @property {string} id Stable identifier, so a finding can be matched across ticks.
 * @property {string} [label] What to call it to a person.
 * @property {number|null} [lastProgressAt] The last real sign of progress. Not a heartbeat:
 *   see the goalRun entry above for why the two are different questions.
 * @property {number|null} [startedAt] Used only when there is no progress stamp at all.
 * @property {string} [note] Extra context for the person reading the finding.
 * @property {object} [context] Whatever the surface needs to link to it.
 */

/**
 * @typedef {object} Stall
 * @property {string} kind
 * @property {string} id
 * @property {string} label
 * @property {number|null} stalledForMs Null when there is nothing to measure from.
 * @property {number} limitMs
 * @property {string} reason Why this is being reported, in a person's words.
 * @property {string} whatToDo
 * @property {boolean} measured False when the finding IS the missing measurement.
 * @property {object} context
 */

/** The rules for a kind, falling back to the cautious unknown-kind rules. */
export function rulesFor(kind) {
  return WORK_KINDS[kind] || UNKNOWN_KIND;
}

/**
 * Which of these workers has stopped moving.
 *
 * Pure: no clock of its own, no disk, no knowledge of where any of this came from. `now` is
 * passed in so a test can plant a deadlock at an exact age rather than sleeping through one.
 *
 * @param {Worker[]} workers
 * @param {number} now
 * @returns {Stall[]} Worst first, so a surface that shows only a few shows the right few.
 */
export function findStalledWork(workers, now) {
  if (!Array.isArray(workers)) {
    return [];
  }
  const found = [];
  for (const worker of workers) {
    if (!worker || typeof worker !== "object") {
      continue;
    }
    const kind = typeof worker.kind === "string" ? worker.kind : "";
    const rules = rulesFor(kind);
    const known = Object.prototype.hasOwnProperty.call(WORK_KINDS, kind);
    const label = worker.label || rules.label;
    const base = {
      kind: kind || "unknown",
      id: String(worker.id ?? ""),
      label,
      limitMs: rules.limitMs,
      whatToDo: rules.whatToDo,
      context: worker.context || {},
    };

    const stamp = pickStamp(worker);
    if (stamp === null) {
      // Rule 1. The absence of a measurement is the finding, not a reason to skip.
      found.push({
        ...base,
        stalledForMs: null,
        measured: false,
        reason: `Nothing records progress for ${label}, so there is no way to tell whether it is working or dead.`,
      });
      continue;
    }

    if (stamp > now + FUTURE_TOLERANCE_MS) {
      // A future stamp would otherwise make this worker permanently healthy.
      found.push({
        ...base,
        stalledForMs: null,
        measured: false,
        reason: `${cap(label)} reports its last progress in the future, so its age cannot be trusted.`,
      });
      continue;
    }

    const stalledForMs = Math.max(0, now - stamp);
    if (stalledForMs <= rules.limitMs) {
      continue;
    }
    const unknownNote = known ? "" : ` Helm does not recognise the kind "${kind}", so this used the most cautious limit it has.`;
    found.push({
      ...base,
      stalledForMs,
      measured: true,
      reason: `${cap(label)} has shown no progress for ${humanDuration(stalledForMs)} - ${rules.why}.${unknownNote}`,
    });
  }

  // Unmeasurable first: "nothing is watching this at all" outranks "this is late", because
  // one of them is a hole and the other is an event.
  //
  // Then by how far past ITS OWN limit each one is, not by raw age. Raw age would rank a
  // compaction that has been failing for five hours above a turn that has been silent for
  // forty minutes, and that is backwards: an hour is nothing for the first and unheard of
  // for the second. The ratio is the only comparison that means the same thing across kinds
  // whose limits differ by an order of magnitude.
  return found.sort((a, b) => {
    if (a.measured !== b.measured) {
      return a.measured ? 1 : -1;
    }
    return overrun(b) - overrun(a);
  });
}

/** How many times over its own limit a stall is. */
function overrun(stall) {
  return stall.limitMs > 0 ? (stall.stalledForMs || 0) / stall.limitMs : 0;
}

/**
 * The progress stamp to judge this worker by, or null when there is none.
 *
 * `startedAt` is a legitimate fallback: work that started and has never reported progress
 * is measurable from its start, and that is exactly the shape of a launch that died before
 * its first output.
 */
function pickStamp(worker) {
  if (typeof worker.lastProgressAt === "number" && Number.isFinite(worker.lastProgressAt) && worker.lastProgressAt > 0) {
    return worker.lastProgressAt;
  }
  if (typeof worker.startedAt === "number" && Number.isFinite(worker.startedAt) && worker.startedAt > 0) {
    return worker.startedAt;
  }
  return null;
}

/** "3 minutes", "2 hours" - a person's phrasing, not a duration format. */
function humanDuration(ms) {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function cap(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * One line for a log or a notification, or null when there is nothing to say.
 *
 * Null and not an empty string: "nothing is stuck" is not news and must not be announced,
 * or the signal becomes noise and gets ignored - which is how a real one gets missed.
 */
export function summariseStalls(stalls) {
  if (!Array.isArray(stalls) || stalls.length === 0) {
    return null;
  }
  const [first] = stalls;
  if (stalls.length === 1) {
    return first.reason;
  }
  return `${first.reason} And ${stalls.length - 1} other piece${stalls.length === 2 ? "" : "s"} of work ${stalls.length === 2 ? "is" : "are"} not moving either.`;
}

/**
 * Turn what the app already knows into workers this file can judge.
 *
 * Plain data in, plain data out: main.js reads the live maps and the history file, this
 * decides what each of them MEANS as a piece of work that ought to be moving. Splitting it
 * here is what lets a test plant a deadlock without an Electron app around it - and the
 * card's own definition of done is planting one deliberately and seeing Helm say so.
 *
 * @param {object} snapshot
 * @param {Array<{launchId: string, sessionId: string|null, title: string|null, startedAt: number|null, lastProgressAt: number|null}>} [snapshot.liveTurns]
 * @param {Array<object>} [snapshot.goalRuns] Raw goal-run history records.
 * @param {number} [snapshot.ownPid] This process, so a run it owns is judged on progress
 *   rather than on ownership.
 * @param {number} [snapshot.heartbeatStaleMs] How old a heartbeat may be before its owner
 *   counts as gone. Passed in rather than duplicated - main.js already has this number and
 *   two copies of it would drift.
 * @param {Array<{dispatchId: string, dispatchedBy: string|null, goal: string|null, reportedAt: number|null, dispatcherLastActiveAt: number|null}>} [snapshot.reports]
 * @param {Array<{sessionId: string, title: string|null, firstFailedAt: number|null, failures: number}>} [snapshot.compactFailures]
 * @returns {Worker[]}
 */
export function workersFromSnapshot({
  liveTurns = [],
  goalRuns = [],
  ownPid = null,
  heartbeatStaleMs = 70000,
  reports = [],
  compactFailures = [],
} = {}) {
  const workers = [];

  for (const turn of liveTurns) {
    if (!turn || !turn.launchId) {
      continue;
    }
    workers.push({
      kind: "turn",
      id: `turn:${turn.launchId}`,
      label: turn.title ? `the turn in "${turn.title}"` : "a turn",
      lastProgressAt: turn.lastProgressAt ?? null,
      startedAt: turn.startedAt ?? null,
      context: { launchId: turn.launchId, sessionId: turn.sessionId || null },
    });
  }

  for (const run of goalRuns) {
    if (!run || run.status !== "running") {
      continue;
    }
    const ownedHere = ownPid != null && run.livePid === ownPid;
    const beat = typeof run.liveHeartbeatAt === "number" ? run.liveHeartbeatAt : null;
    if (ownedHere) {
      // This process is driving it, so the honest question is whether the WORK is moving.
      // The heartbeat cannot answer that - it beats whether or not the iteration is wedged,
      // which is why lastProgressAt is written separately at each finished iteration.
      workers.push({
        kind: "goalIteration",
        id: `goalRun:${run.goalRunId}`,
        label: run.goal ? `the goal run "${shorten(run.goal)}"` : "a goal run",
        lastProgressAt: run.lastProgressAt ?? null,
        startedAt: run.startedAt ?? null,
        context: { goalRunId: run.goalRunId, projectPath: run.projectPath || null },
      });
      continue;
    }
    // Not ours. Another Helm may be driving it - its heartbeat says so, and a fresh one
    // means hands off. A stale or missing one means the process that owned this is gone
    // and the record has been claiming "running" ever since.
    workers.push({
      kind: "goalRun",
      id: `goalRun:${run.goalRunId}`,
      label: run.goal ? `the goal run "${shorten(run.goal)}"` : "a goal run",
      lastProgressAt: beat,
      startedAt: run.startedAt ?? null,
      // heartbeatStaleMs is smaller than the goalRun limit, so a run with a fresh foreign
      // heartbeat is never reported - the limit does the filtering, not a second condition
      // that could disagree with it.
      context: { goalRunId: run.goalRunId, projectPath: run.projectPath || null, heartbeatStaleMs },
    });
  }

  for (const report of reports) {
    if (!report || !report.dispatchId) {
      continue;
    }
    const reportedAt = typeof report.reportedAt === "number" ? report.reportedAt : null;
    const seenAt = typeof report.dispatcherLastActiveAt === "number" ? report.dispatcherLastActiveAt : null;
    if (reportedAt !== null && seenAt !== null && seenAt >= reportedAt) {
      // The mate has run since the report was written, so it has had the chance to read it.
      // Whether it DID is not knowable from here, and guessing would turn a real signal
      // into a permanent one.
      continue;
    }
    workers.push({
      kind: "handback",
      id: `handback:${report.dispatchId}`,
      label: report.goal ? `the finished crew run "${shorten(report.goal)}"` : "a finished crew run",
      lastProgressAt: reportedAt,
      startedAt: null,
      context: { dispatchId: report.dispatchId, dispatchedBy: report.dispatchedBy || null },
    });
  }

  for (const fail of compactFailures) {
    if (!fail || !fail.sessionId) {
      continue;
    }
    workers.push({
      kind: "compaction",
      id: `compaction:${fail.sessionId}`,
      label: fail.title ? `compaction of "${shorten(fail.title)}"` : "a compaction",
      lastProgressAt: fail.firstFailedAt ?? null,
      startedAt: fail.firstFailedAt ?? null,
      context: { sessionId: fail.sessionId, failures: fail.failures || 0 },
    });
  }

  return workers;
}

/** Enough of a goal or title to recognise it in a one-line finding. */
function shorten(text, max = 60) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
