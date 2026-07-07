import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

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
// Test-only seam, like mates.js's MAESTRO_MATES_PATH.
const bindingsPath = process.env.MAESTRO_SECOND_MATES_PATH || path.join(__dirname, "..", "..", "second-mates.json");

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
  fs.writeFileSync(bindingsPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
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
    const firstMateId = r.dispatchedBy || DIRECT_FIRST_MATE;
    const id = secondMateId(firstMateId, r.projectPath);
    let sm = byId.get(id);
    if (!sm) {
      sm = {
        secondMateId: id,
        firstMateId,
        projectPath: r.projectPath,
        name: path.basename(r.projectPath) || r.projectPath,
        sessionId: null,
        crew: [],
      };
      byId.set(id, sm);
    }
    sm.crew.push(r);
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
    }
  }
  return [...byId.values()];
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
  bindings[secondMateId] = { ...(bindings[secondMateId] || {}), sessionId: sessionId || null };
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
