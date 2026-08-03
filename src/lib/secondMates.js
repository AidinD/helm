import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicSync } from "./atomicWrite.js";

// Second-mate identity (the "named mates" model, corrected: a second mate is a
// per-PROJECT SESSION the captain can jump into and steer directly - the
// judgment/validation tier - NOT a background task. The background work is the
// CREW beneath it: the dispatched Autopilot runs + their agents.)
//
// A second mate is DERIVED, not a separately-managed record: it exists whenever
// a first mate has dispatched crew to a project (the run record, written at
// dispatch time with dispatchedBy=<firstMateId> + projectPath, is the source of
// truth). Its identity is deterministic from (firstMateId, projectPath), so no
// parallel store can drift out of sync with the runs. The ONLY extra state a
// second mate needs is persisted here: the sessionId of the interactive session
// currently embodying it (so "jump in" resumes it) and an optional custom name.
//
// Direct project sessions the captain starts himself (no first mate above) are
// modelled the same way, under the synthetic firstMateId "direct".

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Test-only seam, like mates.js's HELM_MATES_PATH.
const bindingsPath = process.env.HELM_SECOND_MATES_PATH || path.join(__dirname, "..", "..", "second-mates.json");

export const DIRECT_FIRST_MATE = "direct";

function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

/** Deterministic id for a second mate = the (firstMate, project) pair it coordinates. */
export function secondMateId(firstMateId, projectPath) {
  const key = `${firstMateId || DIRECT_FIRST_MATE}::${normPath(projectPath)}`;
  return "sm_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** The persisted per-second-mate overrides: { [secondMateId]: { sessionId, name } }. */
export function readBindings() {
  if (!fs.existsSync(bindingsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingsPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBindings(obj) {
  // Shared atomic write with the locked-file retry (task efcaf486) - see the note
  // in domains.js for why this one was missed until 2026-08-02.
  const res = writeJsonAtomicSync(bindingsPath, obj);
  if (!res.ok) {
    throw new Error(`Could not write the second-mate bindings: ${res.error}`);
  }
}

/**
 * Drop second-mate bindings by id (proposed/created/engaged). Used when a first
 * mate is retired and its subtree is torn down (task 58e9a433) so its second
 * mates don't linger as stale proposals or orphaned nodes referencing a dead
 * parent id. Only removes bindings; crew runs in goal-run history are untouched
 * (they stay on the Autopilot page - tearing down in-flight work would lose it).
 * Returns the number of bindings removed.
 */
export function removeSecondMates(ids) {
  const bindings = readBindings();
  let removed = 0;
  for (const id of ids || []) {
    if (bindings[id]) {
      delete bindings[id];
      removed++;
    }
  }
  if (removed > 0) {
    writeBindings(bindings);
  }
  return removed;
}

/**
 * Derives the second-mate list from goal-run history: one per distinct
 * (dispatchedBy||"direct", projectPath), carrying its crew (the runs) plus any
 * persisted sessionId/name override. Pure w.r.t. its inputs (bindings injectable
 * for tests); crew are the raw run records, newest last, so the renderer can
 * roll up status/counts however it likes.
 */
export function deriveSecondMates(runHistory, bindings = readBindings()) {
  const byId = new Map();
  for (const r of runHistory || []) {
    if (!r || !r.projectPath) {
      continue;
    }
    const dispatcher = r.dispatchedBy || DIRECT_FIRST_MATE;
    // A crew run dispatched BY A SECOND MATE (Phase 2: second mates dispatch
    // their own crew) carries that second mate's id in dispatchedBy. Attach the
    // crew to THAT second mate directly - hashing it as a (firstMate, project)
    // pair would mint a PHANTOM node whose firstMateId is itself a second mate,
    // stranding the real crew and breaking report-up parent resolution
    // (ship-review). Second-mate ids are "sm_<hash>"; first mates are
    // "mate_<uuid>" or the synthetic "direct".
    const dispatchedBySecondMate = typeof dispatcher === "string" && dispatcher.startsWith("sm_");
    const id = dispatchedBySecondMate ? dispatcher : secondMateId(dispatcher, r.projectPath);
    let sm = byId.get(id);
    if (!sm) {
      sm = {
        secondMateId: id,
        // A first-mate-dispatched run names its own parent (the dispatcher). A
        // second-mate-dispatched one gets its parent from the binding below.
        firstMateId: dispatchedBySecondMate ? bindings[id]?.firstMateId || DIRECT_FIRST_MATE : dispatcher,
        projectPath: r.projectPath,
        name: path.basename(r.projectPath) || r.projectPath,
        sessionId: null,
        crew: [],
      };
      byId.set(id, sm);
    }
    sm.crew.push(r);
    // A project node is an AUTO node if anything under it was started by the
    // auto-captain. The Auto widget needs this on the node, because after the
    // reshape (2026-08-03) an auto task is no longer a session of its own - it is
    // an autopilot run underneath the project's second mate, and the node itself
    // is only ever "proposed" with no session bound. Sticky: one auto run makes the
    // project's row the auto lane's, which is what the two columns must agree on so
    // the same row cannot appear in both.
    if (r.startedBy === "auto") {
      sm.startedBy = "auto";
    }
  }
  for (const sm of byId.values()) {
    const b = bindings[sm.secondMateId];
    if (b) {
      if (b.name) {
        sm.name = b.name;
      }
      if (b.sessionId) {
        sm.sessionId = b.sessionId;
      }
      // Trust the binding's parent when it has one - it's how a second-mate-
      // dispatched node learns its real first mate (the run record only carries
      // the dispatching second mate, not the first mate above it).
      if (b.firstMateId) {
        sm.firstMateId = b.firstMateId;
      }
      sm.status = b.status || (b.sessionId ? "created" : "proposed");
      sm.brief = b.brief || null;
      sm.assignments = b.assignments || null;
    }
  }
  // Union in PROPOSED/created second mates that have no crew runs yet - they
  // exist only as a binding (Phase-2 Slice 1: lazy creation). A proposed second
  // mate appears in the Fleet before any dispatch, so the captain can engage it.
  // Requires the binding to carry its own projectPath (a run-derived one gets it
  // from the run record instead).
  for (const [id, b] of Object.entries(bindings)) {
    if (byId.has(id) || !b || !b.projectPath) {
      continue;
    }
    byId.set(id, {
      secondMateId: id,
      firstMateId: b.firstMateId || DIRECT_FIRST_MATE,
      projectPath: b.projectPath,
      name: b.name || path.basename(b.projectPath) || b.projectPath,
      sessionId: b.sessionId || null,
      status: b.status || "proposed",
      brief: b.brief || null,
      assignments: b.assignments || null,
      crew: [],
    });
  }
  return [...byId.values()];
}

/**
 * Proposes a second mate for a project WITHOUT spinning up its session yet
 * (Phase-2 lazy creation): the first mate lays out the assignment, the Opus
 * session is created only on first engagement (markSecondMateCreated). Persists
 * the project + firstMate + brief so deriveSecondMates can surface it before any
 * crew run exists. Idempotent per (firstMateId, projectPath); re-proposing merges
 * the brief/assignments and never downgrades a "created" one back to "proposed".
 */
export function proposeSecondMate(firstMateId, projectPath, { brief = null, assignments = null, name = null } = {}) {
  if (!projectPath) {
    throw new Error("proposeSecondMate requires a projectPath");
  }
  const id = secondMateId(firstMateId, projectPath);
  const bindings = readBindings();
  const existing = bindings[id] || {};
  bindings[id] = {
    ...existing,
    firstMateId: firstMateId || DIRECT_FIRST_MATE,
    projectPath,
    name: name || existing.name || path.basename(projectPath) || projectPath,
    brief: brief ?? existing.brief ?? null,
    assignments: assignments ?? existing.assignments ?? null,
    status: existing.status === "created" ? "created" : "proposed",
    sessionId: existing.sessionId || null,
  };
  writeBindings(bindings);
  return { secondMateId: id, ...bindings[id] };
}

/**
 * The secondMateId currently bound to a given CLI session, or null. Lets
 * session:start re-attach the crew-dispatch config to a RESUMED second-mate
 * session by its durable binding, not a pane tag that a resume rebuilds away
 * (the "resumed second mate loses its tools" bug).
 */
export function secondMateIdForSession(sessionId, bindings = readBindings()) {
  if (!sessionId) {
    return null;
  }
  for (const [id, b] of Object.entries(bindings)) {
    if (b && b.sessionId === sessionId) {
      return id;
    }
  }
  return null;
}

/** Marks a proposed second mate as CREATED once its session actually spins up. */
export function markSecondMateCreated(secondMateId, sessionId, model = null) {
  const bindings = readBindings();
  bindings[secondMateId] = {
    ...(bindings[secondMateId] || {}),
    status: "created",
    sessionId: sessionId || bindings[secondMateId]?.sessionId || null,
    model: model || bindings[secondMateId]?.model || null,
  };
  writeBindings(bindings);
  return { secondMateId, ...bindings[secondMateId] };
}

/**
 * Binds the CLI session currently embodying a second mate (for "jump in"). A
 * session belongs to one node, so this clears the id from any other second mate
 * first. Returns the binding object.
 */
export function bindSecondMateSession(secondMateId, sessionId) {
  const bindings = readBindings();
  if (sessionId) {
    for (const [id, b] of Object.entries(bindings)) {
      if (id !== secondMateId && b && b.sessionId === sessionId) {
        b.sessionId = null;
      }
    }
  }
  bindings[secondMateId] = {
    ...(bindings[secondMateId] || {}),
    sessionId: sessionId || null,
    // Binding a live session IS the "first engagement" that turns a proposed
    // second mate into a created one (Phase-2 Slice 1 lazy creation).
    status: sessionId ? "created" : bindings[secondMateId]?.status || "proposed",
  };
  writeBindings(bindings);
  return bindings[secondMateId];
}

/** Sets a custom name override for a second mate (default is the project basename). */
export function renameSecondMate(secondMateId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    throw new Error("renameSecondMate requires a non-empty name");
  }
  const bindings = readBindings();
  bindings[secondMateId] = { ...(bindings[secondMateId] || {}), name: trimmed };
  writeBindings(bindings);
  return bindings[secondMateId];
}
