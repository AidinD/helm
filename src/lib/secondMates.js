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
// The auto-captain is its OWN dispatcher identity, distinct from the manual captain's
// "direct". Without this, an auto run and a MANUAL second mate on the same project hashed to
// the same node (secondMateId("direct", project)) and collapsed into one - and the sticky
// startedBy:"auto" flag then yanked the manual second mate (and its session) out of the
// Captain widget into the Auto lane. A separate identity keeps them as two nodes, one per
// lane. Like "direct", it is top-of-chain (reports to the captain, not up to a first mate).
export const AUTO_CAPTAIN = "auto";

function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

/** Deterministic id for a second mate = the (firstMate, project) pair it coordinates. */
export function secondMateId(firstMateId, projectPath) {
  const key = `${firstMateId || DIRECT_FIRST_MATE}::${normPath(projectPath)}`;
  return "sm_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

// A second mate has exactly ONE id namespace, and this is the only function that
// mints it. The Fleet also renders a node for a plain project session that is not
// a registered second mate, keyed "sess_<sessionId>" - but that is a DISPLAY key
// for a row on a screen, not an identity.
//
// It leaked. Jumping into such a node passed its display key on as the session's
// secondMateId, so it was stamped onto every crew run as dispatchedBy and written
// into the bindings file. deriveSecondMates only recognizes "sm_" as a second mate,
// so those runs hashed into a phantom node no binding matches, and the node the
// captain was looking at showed an empty crew list - "den här 2nd maten kör
// autopilots men den syns inte i trädvy" (Aidin, task 99089c59). His own data had
// three crewline runs dispatched by sess_3436226e-..., a binding for that id with
// projectPath undefined, and two id namespaces living side by side in one file.
//
// Teaching derive to also understand "sess_" would have cleared the symptom and
// made two namespaces permanent. Instead the display key is translated back to a
// real identity at the one boundary it crosses (a session launch) and in the one
// place that reads history written before the fix.
export function isDisplaySecondMateId(id) {
  return typeof id === "string" && id.startsWith("sess_");
}

/**
 * The durable second-mate id for an id that may be a renderer display key.
 * A session node has no first mate above it (it is the captain's own project
 * session), so it resolves under DIRECT_FIRST_MATE for its project - exactly the
 * node a registered direct second mate for that project already has.
 * Returns null when a display key arrives with no project to resolve against,
 * so a caller can refuse rather than invent a node at an unknown path.
 */
export function resolveSecondMateId(id, projectPath) {
  if (!isDisplaySecondMateId(id)) {
    return id || null;
  }
  if (!projectPath) {
    return null;
  }
  return secondMateId(DIRECT_FIRST_MATE, projectPath);
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
    // LEGACY: a run dispatched before the display key stopped leaking (see
    // resolveSecondMateId) carries "sess_<sessionId>" as its dispatcher. Route it
    // to the node the fixed path now produces, so crew stranded on a phantom
    // reappears under the second mate that actually ran it - without rewriting
    // history, the same migration shape the auto routing below already uses.
    const dispatchedByDisplayKey = isDisplaySecondMateId(dispatcher);
    // An AUTO-started run always belongs to the project's AUTO node - even a LEGACY one
    // dispatched under the old shared "direct" second-mate id. Without this, one auto run
    // landed on a MANUAL second mate that happened to share the project and flipped it into
    // the Auto lane (the reported bug). Routing by startedBy, not just the dispatcher id, also
    // migrates existing runs so the collision clears without rewriting history.
    const isAuto = r.startedBy === "auto";
    const id = isAuto
      ? secondMateId(AUTO_CAPTAIN, r.projectPath)
      : dispatchedByDisplayKey
        ? secondMateId(DIRECT_FIRST_MATE, r.projectPath)
        : dispatchedBySecondMate
          ? dispatcher
          : secondMateId(dispatcher, r.projectPath);
    let sm = byId.get(id);
    if (!sm) {
      sm = {
        secondMateId: id,
        // The auto node is top-of-chain under the auto-captain. Otherwise: a first-mate-
        // dispatched run names its own parent (the dispatcher); a second-mate-dispatched one
        // gets its parent from the binding below.
        firstMateId: isAuto
          ? AUTO_CAPTAIN
          : dispatchedByDisplayKey
            ? DIRECT_FIRST_MATE
            : dispatchedBySecondMate
              ? bindings[id]?.firstMateId || DIRECT_FIRST_MATE
              : dispatcher,
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
export function secondMateIdForSession(sessionId, bindings = readBindings(), { projectPath = null } = {}) {
  if (!sessionId) {
    return null;
  }
  for (const [id, b] of Object.entries(bindings)) {
    if (b && b.sessionId === sessionId) {
      // A binding written before the display key was stopped at the boundary holds
      // "sess_<id>" (five such records exist in the real store). Returning it would
      // re-leak the key onto this turn's dispatches, so translate it back - and if
      // there is no project to translate against, report no second mate rather than
      // a fake one. Never widen this to "return it anyway when translation fails":
      // that is the leak, restored.
      return isDisplaySecondMateId(id) ? resolveSecondMateId(id, projectPath || b.projectPath) : id;
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
export function bindSecondMateSession(secondMateId, sessionId, { projectPath = null } = {}) {
  // A display key is not an identity (see resolveSecondMateId). Refusing it here is
  // the backstop: five such bindings already exist in the real store, every one of
  // them with projectPath undefined, which is also why deriveSecondMates could not
  // union them back in even as empty nodes.
  if (isDisplaySecondMateId(secondMateId)) {
    throw new Error(`bindSecondMateSession got a display key (${secondMateId}); resolve it with resolveSecondMateId first`);
  }
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
    // Carried so deriveSecondMates can union this node in before it has any crew.
    // Its union loop skips a binding with no projectPath, so a second mate bound
    // by a jump-in used to be invisible until its first dispatch landed. Never
    // downgrade an existing path to null - a later bind without one must not erase
    // what an earlier one established.
    projectPath: projectPath || bindings[secondMateId]?.projectPath || null,
    // Binding a live session IS the "first engagement" that turns a proposed
    // second mate into a created one (Phase-2 Slice 1 lazy creation). CLEARING the
    // session (null) reverts it to "proposed": a node with no session is not
    // "created", and leaving it "created" makes the Fleet show a session-less node
    // as active. The only null caller is archive-clears-binding (main.js), which
    // wants exactly this - the second mate back to a fresh, un-started seat.
    status: sessionId ? "created" : "proposed",
  };
  writeBindings(bindings);
  return bindings[secondMateId];
}

/**
 * One-time repair of bindings written before the display key was stopped at the
 * boundary: rewrites every "sess_<sessionId>" record onto the real second-mate id
 * for its project, merging into an existing record rather than replacing it.
 *
 * It needs a project, and a legacy record has none (all five in the real store were
 * written with projectPath undefined) - so the caller supplies a lookup from session
 * id to that session's cwd. This lives here rather than in the app because it is the
 * bindings file's own invariant; the app only knows where sessions live.
 *
 * Without it the fix is half-done in a way that is worse than the bug: the crew
 * resolves onto the real node while the SESSION stays on the legacy record, so the
 * captain sees two rows - one with a session and no crew, one with crew and no
 * session - instead of the single second mate the whole exercise is about.
 *
 * A record whose session cannot be located is left untouched, not deleted: an
 * unresolvable binding is a thing to look at, not evidence it is safe to discard.
 * Returns { migrated, skipped }.
 */
export function migrateDisplayKeyBindings(projectPathForSession) {
  const bindings = readBindings();
  let migrated = 0;
  let skipped = 0;
  for (const [id, b] of Object.entries(bindings)) {
    if (!isDisplaySecondMateId(id)) {
      continue;
    }
    const sessionId = b?.sessionId || id.slice("sess_".length);
    const projectPath = b?.projectPath || (projectPathForSession ? projectPathForSession(sessionId) : null);
    const realId = resolveSecondMateId(id, projectPath);
    if (!realId) {
      skipped++;
      continue;
    }
    const target = bindings[realId];
    // REFUSE TO MERGE ANYTHING AWAY. An earlier version spread the two records together and
    // deleted the legacy one, which an independent review showed losing real state: with a
    // session id on both, the legacy one vanished and the session the captain had actually
    // been working in stopped being bound to anything; with two legacy records resolving to
    // the same target, the second was absorbed and everything unique to it disappeared -
    // and it was counted as a success. On the real store three of five records collide like
    // that, and only the fact that they happen to be empty saved them.
    //
    // So this now migrates ONLY when nothing can be lost: no target yet, or a target that
    // holds nothing of its own. Anything else is left exactly as it was, and reported.
    // A binding left behind is visible and fixable; a merged-away one is neither.
    const targetHolds = target && (target.sessionId || target.name || target.brief || target.assignments);
    if (targetHolds) {
      skipped++;
      continue;
    }
    bindings[realId] = {
      ...b,
      ...(target || {}),
      projectPath: (target && target.projectPath) || projectPath,
      sessionId: (target && target.sessionId) || b?.sessionId || null,
      // A node with no session is "proposed", not "created" - bindSecondMateSession states
      // that rule, and the earlier version wrote records that broke it, so the Fleet showed
      // a session-less node as active.
      status: (target && target.sessionId) || b?.sessionId ? "created" : "proposed",
    };
    // A session belongs to exactly one node. bindSecondMateSession enforces that when it
    // writes; the migration used to write straight past it, so the same session could end up
    // claimed by two records and which one won depended on key order in the file.
    if (bindings[realId].sessionId) {
      for (const [otherId, other] of Object.entries(bindings)) {
        if (otherId !== realId && otherId !== id && other && other.sessionId === bindings[realId].sessionId) {
          other.sessionId = null;
          other.status = "proposed";
        }
      }
    }
    delete bindings[id];
    migrated++;
  }
  if (migrated > 0) {
    writeBindings(bindings);
  }
  return { migrated, skipped };
}

/**
 * Release a session from any LEGACY display-keyed binding that still claims it.
 *
 * Archiving a session must un-bind it, or a later jump-in resurrects the archived session -
 * the bug that block was written for (Aidin, 2026-08-12). secondMateIdForSession now
 * translates a display key and returns null when it has no project to translate against, so
 * a legacy record could no longer be reached through it and archiving silently stopped
 * releasing those sessions (found by review, 2026-08-16). This closes the gap at the level
 * that owns the file, rather than having the caller edit the store by hand.
 */
export function releaseDisplayKeyedSession(sessionId) {
  if (!sessionId) {
    return 0;
  }
  const bindings = readBindings();
  let released = 0;
  for (const [id, b] of Object.entries(bindings)) {
    if (isDisplaySecondMateId(id) && b && b.sessionId === sessionId) {
      b.sessionId = null;
      b.status = "proposed";
      released++;
    }
  }
  if (released > 0) {
    writeBindings(bindings);
  }
  return released;
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
