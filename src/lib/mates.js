import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isValidPersonaKey } from "./personas.js";
import { loadConfig } from "./config.js";

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
// convention every other Helm store uses.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_MATES_PATH is a test-only seam (E2E/unit tests point it at a temp
// file so they never touch the real store); production leaves it unset and uses
// the plain JSON file beside the app, like every other Helm store.
const matesPath = process.env.HELM_MATES_PATH || path.join(__dirname, "..", "..", "mates.json");

// Exactly two first-mate slots always exist.
export const MATE_SLOT_COUNT = 2;

// Mate name pools, per theme identity. A newborn mate takes one not currently
// held by a live mate. The nautical pool backs the default/brass (Helm) themes;
// the space pool backs the space theme - so switching theme also re-themes who
// the mates ARE, not just the colors (the captain's call, 2026-07-10).
const NAUTICAL_NAMES = [
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
  "Corto Maltese",
  "Sinbad",
  "Captain Haddock", // Tintin
  "Calico Jack",
];
const SPACE_NAMES = [
  "Ellen Ripley", // Alien
  "Carl Sagan",
  "Dave Bowman", // 2001
  "Cooper", // Interstellar
  "James Holden", // The Expanse
  "Malcolm Reynolds", // Firefly
  "Kathryn Janeway", // Star Trek: Voyager
  "Jean-Luc Picard", // Star Trek
  "James Kirk", // Star Trek
  "Han Solo", // Star Wars
  "Leia Organa", // Star Wars
  "Poe Dameron", // Star Wars
  "Commander Shepard", // Mass Effect
  "Yuri Gagarin",
  "Neil Armstrong",
  "Sally Ride",
  "Nyota Uhura", // Star Trek
];
const ADVENTURE_NAMES = [
  "Indiana Jones",
  "Lara Croft",
  "Nathan Drake", // Uncharted
  "Rick O'Connell", // The Mummy
  "Allan Quatermain",
  "Amelia Earhart",
  "Ernest Shackleton",
  "Percy Fawcett",
  "Dora Marquez",
  "Bilbo Baggins",
  "Phileas Fogg",
  "Marco Polo",
  "Sacagawea",
  "Roald Amundsen",
];
const ANIME_NAMES = [
  "Spike Spiegel", // Cowboy Bebop
  "Faye Valentine", // Cowboy Bebop
  "Motoko Kusanagi", // Ghost in the Shell
  "Edward Elric", // Fullmetal Alchemist
  "Levi Ackerman", // Attack on Titan
  "Mikasa Ackerman",
  "Vash the Stampede", // Trigun
  "Guts", // Berserk
  "Asuka Langley", // Evangelion
  "Kenshin Himura",
  "Roronoa Zoro", // One Piece
  "Nico Robin", // One Piece
  "Yusuke Urameshi", // Yu Yu Hakusho
  "Kusuo Saiki",
];
const GAME_NAMES = [
  "Master Chief", // Halo
  "Samus Aran", // Metroid
  "Lara Croft", // Tomb Raider
  "Gordon Freeman", // Half-Life
  "Kratos", // God of War
  "Geralt of Rivia", // The Witcher
  "Aloy", // Horizon
  "Solid Snake", // Metal Gear
  "Cloud Strife", // Final Fantasy VII
  "Link", // Zelda
  "Chell", // Portal
  "Jill Valentine", // Resident Evil
  "Ezio Auditore", // Assassin's Creed
  "2B", // NieR: Automata
];
const FANTASY_NAMES = [
  "Gandalf",
  "Aragorn",
  "Legolas",
  "Galadriel",
  "Merlin",
  "Arwen",
  "Frodo",
  "Elrond",
  "Daenerys",
  "Jon Snow",
  "Ciri", // The Witcher
  "Yennefer", // The Witcher
  "Radagast",
  "Eowyn",
  "Gimli",
  "Elric", // Elric of Melnibone
];
const SUPERHERO_NAMES = [
  "Clark Kent", // Superman
  "Bruce Wayne", // Batman
  "Diana Prince", // Wonder Woman
  "Peter Parker", // Spider-Man
  "Tony Stark", // Iron Man
  "Steve Rogers", // Captain America
  "Natasha Romanoff", // Black Widow
  "Carol Danvers", // Captain Marvel
  "Barry Allen", // The Flash
  "Hal Jordan", // Green Lantern
  "Selina Kyle", // Catwoman
  "Wanda Maximoff", // Scarlet Witch
  "Stephen Strange", // Doctor Strange
  "Matt Murdock", // Daredevil
];
const CYBERPUNK_NAMES = [
  "Case", // Neuromancer
  "Molly Millions", // Neuromancer
  "Johnny Silverhand", // Cyberpunk 2077
  "Neo", // The Matrix
  "Trinity", // The Matrix
  "Morpheus", // The Matrix
  "Hiro Protagonist", // Snow Crash
  "Rick Deckard", // Blade Runner
  "Roy Batty", // Blade Runner
  "Pris", // Blade Runner
  "Adam Jensen", // Deus Ex
  "Panam", // Cyberpunk 2077
  "Rachael", // Blade Runner
  "Y.T.", // Snow Crash
];
const WESTERN_NAMES = [
  "Doc Holliday",
  "Wyatt Earp",
  "Calamity Jane",
  "Jesse James",
  "Django",
  "Rooster Cogburn", // True Grit
  "Butch Cassidy",
  "Sundance Kid",
  "Annie Oakley",
  "Billy the Kid",
  "Wild Bill",
  "Josey Wales",
  "Cole Younger",
  "Belle Starr",
];
const NOIR_NAMES = [
  "Philip Marlowe",
  "Sam Spade",
  "Jake Gittes", // Chinatown
  "Dick Tracy",
  "Nick Charles", // The Thin Man
  "Hercule Poirot",
  "Sherlock Holmes",
  "Miss Marple",
  "Columbo",
  "Jessica Jones",
  "Veronica Mars",
  "Rust Cohle", // True Detective
  "Nora Charles", // The Thin Man
  "Perry Mason",
];
const EVIL_NAMES = [
  "Darth Vader", // Star Wars
  "Sauron", // LOTR
  "Voldemort", // Harry Potter
  "Thanos", // Marvel
  "The Joker", // DC
  "Hannibal Lecter",
  "Maleficent",
  "Palpatine", // Star Wars
  "Loki", // Marvel
  "Scar", // The Lion King
  "Ganondorf", // Zelda
  "Sephiroth", // Final Fantasy VII
  "Dracula",
  "Agent Smith", // The Matrix
  "Cruella", // 101 Dalmatians
  "Bowser", // Mario
];
// Each theme's name pool. Themes not listed (dark, brass) keep the nautical
// identity. Switching theme across pools re-themes the mates (rethemeMateNames).
const NAME_POOLS = {
  space: SPACE_NAMES,
  adventure: ADVENTURE_NAMES,
  anime: ANIME_NAMES,
  game: GAME_NAMES,
  fantasy: FANTASY_NAMES,
  superhero: SUPERHERO_NAMES,
  cyberpunk: CYBERPUNK_NAMES,
  western: WESTERN_NAMES,
  noir: NOIR_NAMES,
  evil: EVIL_NAMES,
};
function namePoolForTheme(theme) {
  return NAME_POOLS[theme] || NAUTICAL_NAMES;
}
// Best-effort read of the active theme from config (defaults to nautical). Kept
// local so name-picking follows the theme without threading it through every
// caller; a missing/unreadable config just yields the nautical pool.
function currentTheme() {
  try {
    return loadConfig().theme || "dark";
  } catch {
    return "dark";
  }
}

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
function pickName(taken, seed = 0, pool = NAUTICAL_NAMES) {
  const used = new Set(taken);
  const free = pool.filter((n) => !used.has(n));
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
  const pool = namePoolForTheme(currentTheme());
  let changed = false;
  for (let slot = 0; slot < MATE_SLOT_COUNT; slot++) {
    const held = state.mates.find((m) => m.status === "active" && m.slot === slot);
    if (!held) {
      const takenNames = activeMatesFrom(state.mates).map((m) => m.name);
      state.mates.push({
        mateId: `mate_${crypto.randomUUID()}`,
        slot,
        // Seed by the ever-growing total so the two initial slots (and any later
        // respawn) get distinct, advancing names. Pool follows the active theme.
        name: pickName(takenNames, state.mates.length, pool),
        root: resolvedRoot,
        status: "active",
        // Optional temperament overlay (personas.js) chosen per-spawn; null =
        // plain coordinator. Injected after the base manual at launch.
        persona: null,
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
export function retireAndRespawn(mateId, pendingHandoff = null, persona = null) {
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
    name: pickName(takenNames, state.mates.length, namePoolForTheme(currentTheme())),
    root: root ? path.resolve(root) : null,
    status: "active",
    // Persona for the fresh mate. A respawn normally resets to the plain
    // coordinator (null); a deliberate persona SWITCH passes the new key here
    // (the running-mate change path retires with a handoff, then respawns into
    // the chosen persona - a system prompt can't change mid-session).
    persona: isValidPersonaKey(persona) ? persona || null : null,
    createdAt: Date.now(),
    retiredAt: null,
    // Handoff from the retiring mate: the fresh mate's first jump-in seeds its
    // composer with this so the cross-project thread continues under the new
    // name (continuity via the logbook, not the old growing context window).
    // Consumed once (see consumeMateHandoff).
    pendingHandoff: pendingHandoff || null,
  };
  state.mates.push(fresh);
  writeState(state);
  return fresh;
}

/**
 * Sets (or clears) an active mate's persona overlay. Used for a FRESH mate
 * before its session starts - once a session is running the overlay is already
 * in its context, so switching then goes through retireAndRespawn instead.
 * The renderer enforces that fresh-vs-running policy; this just persists the
 * choice. Returns the updated mate, or null if not found. Unknown keys are
 * rejected (treated as no-op error) to keep the store clean.
 */
export function setMatePersona(mateId, persona) {
  if (!isValidPersonaKey(persona)) {
    throw new Error(`setMatePersona: unknown persona "${persona}"`);
  }
  const state = readState();
  const mate = state.mates.find((m) => m.mateId === mateId);
  if (!mate) {
    return null;
  }
  mate.persona = persona || null;
  writeState(state);
  return mate;
}

/**
 * Re-themes the ACTIVE mates' names when the theme's identity changes (e.g.
 * nautical <-> space), preserving each mate's id/slot/session/persona - only
 * the display name changes. No-op when the two themes share a name pool (e.g.
 * dark <-> brass are both nautical), so toggling light/dark never clobbers a
 * name (including one the captain set manually). Returns the active mates.
 */
export function rethemeMateNames(fromTheme, toTheme) {
  const toPool = namePoolForTheme(toTheme);
  if (namePoolForTheme(fromTheme) === toPool) {
    return activeMates();
  }
  const state = readState();
  const active = activeMatesFrom(state.mates).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const taken = [];
  active.forEach((mate, i) => {
    const name = pickName(taken, i, toPool);
    mate.name = name;
    taken.push(name);
  });
  writeState(state);
  return active;
}

/**
 * Reads and CLEARS a mate's pending handoff (one-shot): the fresh mate's first
 * jump-in seeds its composer with this, then consumes it so a later reopen of
 * that same mate starts clean. Returns the handoff text, or null.
 */
export function consumeMateHandoff(mateId) {
  const state = readState();
  const mate = state.mates.find((m) => m.mateId === mateId);
  if (!mate || !mate.pendingHandoff) {
    return null;
  }
  const handoff = mate.pendingHandoff;
  mate.pendingHandoff = null;
  writeState(state);
  return handoff;
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
