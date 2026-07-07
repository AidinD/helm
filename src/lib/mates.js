import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// First-mate identity (docs/first-mate-tier-design.md section 3 + the "named
// mates" refinement). A first mate is a NAMED coordination context the captain
// jumps into - not a hard work/private domain, a soft split he chooses. Two
// mates always exist (two fixed slots shown in the Fleet tree); each gets a
// random sea-captain name at birth (renameable), and when one saturates OR its
// dispatched work has all drained back, the captain retires it and a fresh one
// respawns in the same slot with a new name.
//
// A dispatched run + its report are keyed by the dispatching mate's `mateId`
// (stable across restarts, and preserved as a `retired` record after respawn so
// the Fleet can still name a retired mate's historical runs). Multiple mates can
// share the same root (the meta-home) - identity is the mateId, not the path,
// which is why this no longer keys mates by root.
//
// Persisted next to config.json / domains.json / goal-run-history.json - the
// same "plain JSON file beside the app, machine-specific, gitignored" data
// convention every other Maestro store uses.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MAESTRO_MATES_PATH is a test-only seam (E2E/unit tests point it at a temp
// file so they never touch the real store); production leaves it unset and uses
// the plain JSON file beside the app, like every other Maestro store.
const matesPath = process.env.MAESTRO_MATES_PATH || path.join(__dirname, "..", "..", "mates.json");

// Exactly two first-mate slots always exist.
export const MATE_SLOT_COUNT = 2;

// Sea-captain / pirate names from film, games, and literature - fitting for a
// "first mate". A newborn mate takes one not currently held by a live mate.
const NAME_POOL = [
  "Jack Sparrow",
  "Hector Barbossa",
  "Davy Jones",
  "Captain Nemo",
  "Captain Ahab",
  "Long John Silver",
  "Captain Flint",
  "Captain Hook",
  "Blackbeard",
  "Guybrush Threepwood", // Monkey Island
  "LeChuck", // Monkey Island
  "Edward Kenway", // Assassin's Creed: Black Flag
  "Adewale", // Assassin's Creed: Black Flag
  "Han Solo",
  "Jean-Luc Picard",
  "James Kirk",
  "Corto Maltese",
  "Sinbad",
  "Captain Haddock", // Tintin
  "Calico Jack",
];

export function matesFilePath() {
  return matesPath;
}

// State shape: { mates: [ { mateId, slot, name, root, status, createdAt,
// retiredAt } ] }. Tolerant of the legacy flat-array shape (mates keyed by
// root): those become `retired` records with no slot, so historical run
// grouping keeps their names while the new two-slot active set is established.
function readState() {
  if (!fs.existsSync(matesPath)) {
    return { mates: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(matesPath, "utf8"));
    if (Array.isArray(parsed)) {
      return { mates: parsed.map((m) => ({ ...m, slot: null, status: "retired" })) };
    }
    if (parsed && Array.isArray(parsed.mates)) {
      return { mates: parsed.mates };
    }
  } catch {
    // fall through to empty
  }
  return { mates: [] };
}

function writeState(state) {
  fs.writeFileSync(matesPath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Picks a pool name not in `taken`, rotated by `seed` so successive picks
 * differ. `seed` must ADVANCE across calls (callers pass the ever-growing total
 * mate count) - otherwise a retire whose active set is unchanged would keep
 * choosing the same index and respawn the SAME name, making retire look broken.
 */
function pickName(taken, seed = 0) {
  const used = new Set(taken);
  const free = NAME_POOL.filter((n) => !used.has(n));
  if (free.length > 0) {
    return free[((seed % free.length) + free.length) % free.length];
  }
  return `Mate ${used.size + 1}`;
}

function activeMatesFrom(mates) {
  return mates.filter((m) => m.status === "active");
}

/** Returns all persisted mates (active + retired). */
export function loadMates() {
  return readState().mates;
}

/** The (up to two) currently active mates, ordered by slot. */
export function activeMates() {
  return activeMatesFrom(readState().mates).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

/**
 * Guarantees exactly two active mates rooted at `root`, creating any missing
 * slot's mate with a fresh random name. Idempotent - safe to call on every
 * startup / Fleet render. Returns the two active mates ordered by slot.
 */
export function ensureMates(root) {
  if (!root) {
    throw new Error("ensureMates requires a root path");
  }
  const resolvedRoot = path.resolve(root);
  const state = readState();
  let changed = false;
  for (let slot = 0; slot < MATE_SLOT_COUNT; slot++) {
    const held = state.mates.find((m) => m.status === "active" && m.slot === slot);
    if (!held) {
      const takenNames = activeMatesFrom(state.mates).map((m) => m.name);
      state.mates.push({
        mateId: `mate_${crypto.randomUUID()}`,
        slot,
        // Seed by the ever-growing total so the two initial slots (and any later
        // respawn) get distinct, advancing names.
        name: pickName(takenNames, state.mates.length),
        root: resolvedRoot,
        status: "active",
        createdAt: Date.now(),
        retiredAt: null,
      });
      changed = true;
    }
  }
  if (changed) {
    writeState(state);
  }
  return activeMatesFrom(state.mates).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

/** Looks up a mate by id (active OR retired, so historical runs stay named), or null. */
export function findMateById(mateId) {
  return readState().mates.find((m) => m.mateId === mateId) || null;
}

/**
 * Binds the CLI session that currently embodies a mate (the durable mate ->
 * ephemeral session link the Fleet uses to "jump in": resume mate.sessionId, or
 * start fresh if null). A session belongs to at most one mate, so this clears
 * the id from any other mate first. Returns the updated mate, or null.
 */
export function bindMateSession(mateId, sessionId) {
  const state = readState();
  const mate = state.mates.find((m) => m.mateId === mateId);
  if (!mate) {
    return null;
  }
  if (sessionId) {
    for (const other of state.mates) {
      if (other.mateId !== mateId && other.sessionId === sessionId) {
        other.sessionId = null;
      }
    }
  }
  mate.sessionId = sessionId || null;
  writeState(state);
  return mate;
}

/** Renames an active mate. Returns the updated mate, or null if not found. */
export function renameMate(mateId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    throw new Error("renameMate requires a non-empty name");
  }
  const state = readState();
  const mate = state.mates.find((m) => m.mateId === mateId);
  if (!mate) {
    return null;
  }
  mate.name = trimmed;
  writeState(state);
  return mate;
}

/**
 * Retires a mate and spins up a fresh one in the SAME slot with a new random
 * name. The retired record is kept (status "retired", slot cleared) so the
 * Fleet can still name that mate's historical dispatched runs. Returns the new
 * active mate. No-op-safe: if the id is unknown or already retired, still
 * guarantees the slot is filled.
 */
export function retireAndRespawn(mateId) {
  const state = readState();
  const outgoing = state.mates.find((m) => m.mateId === mateId);
  const slot = outgoing && typeof outgoing.slot === "number" ? outgoing.slot : null;
  const root = outgoing?.root;
  if (outgoing && outgoing.status === "active") {
    outgoing.status = "retired";
    outgoing.slot = null;
    outgoing.retiredAt = Date.now();
  }
  const targetSlot = slot != null ? slot : firstFreeSlot(state.mates);
  // Exclude the outgoing name too, and seed by the (now larger) total so the
  // respawn never lands on the same name - otherwise retire looks like a no-op.
  const takenNames = [...activeMatesFrom(state.mates).map((m) => m.name), outgoing?.name].filter(Boolean);
  const fresh = {
    mateId: `mate_${crypto.randomUUID()}`,
    slot: targetSlot,
    name: pickName(takenNames, state.mates.length),
    root: root ? path.resolve(root) : null,
    status: "active",
    createdAt: Date.now(),
    retiredAt: null,
  };
  state.mates.push(fresh);
  writeState(state);
  return fresh;
}

/** Lowest slot index [0, MATE_SLOT_COUNT) not currently held by an active mate. */
function firstFreeSlot(mates) {
  for (let slot = 0; slot < MATE_SLOT_COUNT; slot++) {
    if (!mates.some((m) => m.status === "active" && m.slot === slot)) {
      return slot;
    }
  }
  return 0;
}
