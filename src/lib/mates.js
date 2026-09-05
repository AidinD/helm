import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isValidPersonaKey } from "./personas.js";
import { loadConfig } from "./config.js";
import { writeJsonAtomicSync } from "./atomicWrite.js";
import { canonicalFsPath } from "./fsPath.js";

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
// The DEFAULT number of first-mate slots, not a hard ceiling. It was a fixed 2
// until 2026-08-02 - the captain: "ett av syftena var att kunna lägga till hur många
// first mates som helst, men jag är begränsad till två". Callers pass a count;
// this is what they get when nothing is configured.
export const MATE_SLOT_COUNT = 2;
// A guard against a corrupt config value, NOT a limit on what the captain may choose.
//
// It was 8, and 8 was doing both jobs at once. On 2026-08-31 the focus mechanism
// changed shape: a hard cap was rejected as the way to keep session count down -
// he would route around it, and a constraint that gets routed around hides the
// problem rather than solving it (2026-08-16 direction entry, failure mode 3).
// What replaces it is a cost he feels instead of a rule that refuses him: one
// widget per first mate, on a dashboard that gets busier and longer to scroll the
// more of them there are. He makes the trade; the trade answers back immediately.
//
// So this number must never be the thing that stops him - it exists only so a
// garbled `firstMateSlots` cannot spawn a hundred coordinators, each of which is a
// real session with a real cost. Set high enough that the clutter argues first.
export const MATE_SLOT_MAX = 24;

// How far currentSeatId will follow a succession chain before giving up and returning what
// it has. A seat retired daily for four years does not reach this; a cycle hits it at once.
const SUCCESSION_MAX_HOPS = 1000;

/** Clamp a requested slot count to something sane; anything unusable falls back to the default. */
export function clampMateSlots(n) {
  // UNSET is not zero, and Number() disagrees: Number(null) is 0, so a config field that has
  // never been written would have read as a deliberate "no coordinators" the moment zero
  // became a legal answer. Absence is checked before the number is.
  if (n === null || n === undefined || n === "") {
    return MATE_SLOT_COUNT;
  }
  const v = Math.trunc(Number(n));
  // ZERO IS A REAL ANSWER since 2026-09-04, and it used to be swallowed here. Removing the
  // last coordinator writes a slot count of 0, and clamping that back up to the default meant
  // the keeps-at-least-one floor survived one level below the check that was deleted - two
  // coordinators would spring back on the next render with nothing on screen explaining why.
  // A MISSING or unparseable value still means the default; only a deliberate 0 means none.
  if (!Number.isFinite(v) || v < 0) {
    return MATE_SLOT_COUNT;
  }
  return Math.min(v, MATE_SLOT_MAX);
}

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
  // Shared atomic write with the locked-file retry (task efcaf486) - see the note
  // in domains.js for why this one was missed until 2026-08-02.
  const res = writeJsonAtomicSync(matesPath, state);
  if (!res.ok) {
    throw new Error(`Could not write the first-mate state: ${res.error}`);
  }
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

/**
 * The two kinds of seat this store holds.
 *
 * A coordinator is one of a POOL: it lives in a numbered slot, gets a random name at birth,
 * and is retired and respawned when its context saturates. The assistant is SINGULAR and
 * standing - one seat, a fixed name, no slot. Same store because both are seats the captain
 * jumps into and both attribute dispatched work by mateId; different kind because almost
 * every rule about slots, naming and respawn applies to one and not the other.
 *
 * SUPERSEDED 2026-09-05: what a seat IS is a tag now, not a kind - see SEAT_TAG_ASSISTANT.
 * The kinds below are still READ so a record written in the three days they existed can be
 * understood, and a record with neither is a pooled seat. Nothing writes them.
 */
// NOTHING WRITES THESE ANY MORE. They are the vocabulary of records written between
// 2026-09-02 and 2026-09-05, kept so seatTags can read one - the same reason a record with no
// kind at all is still readable. A new seat carries a tag and no kind, and the day no store
// holds a pre-tag record these can go.
export const SEAT_COORDINATOR = "coordinator";
export const SEAT_ASSISTANT = "assistant";
/**
 * A seat opened AGAINST A REPOSITORY - one per checkout, created by opening a project rather
 * than by a slot count. Under the 2026-09-04 tier decision this is what "first mate" comes to
 * mean, and the three kinds collapse into one at stage 5.
 *
 * It is a third kind DURING the migration rather than a coordinator with a project root, and
 * that is a staging decision with a reason. activeMatesFrom filters the pool to coordinators,
 * so a project seat cannot take a slot ensureMates is trying to fill - which is exactly the
 * bug that ate a slot per retire this morning, and it would have come straight back in a new
 * costume. The app keeps working with today's coordinators untouched while project seats
 * appear beside them.
 */
export const SEAT_PROJECT = "project";

const seatKind = (mate) => mate?.kind || SEAT_COORDINATOR;

/**
 * WHAT A SEAT IS, as a tag it carries rather than a kind it belongs to.
 *
 * There is one kind of seat. What distinguishes them is where they are rooted, which
 * temperament they wear, and what they are FOR - and the third is this. It is deliberately not
 * a persona: putting identity in that list makes "assistant" mutually exclusive with "red
 * team", which is the exact collision the two-axes decision was written to remove. Temperament
 * is how a seat behaves; a tag is what it is; they are chosen separately.
 *
 * WHAT THE OLD KIND WAS PAYING FOR INVISIBLY: a kind allowed exactly one standing seat by
 * construction. A tag allows any number, which is the point - meta-home seats are named now -
 * but it means every lookup that needs exactly one has to SAY so, and say it loudly. See
 * theSeatTagged.
 */
export const SEAT_TAG_ASSISTANT = "assistant";
export const SEAT_TAG_PROJECT = "project";

/**
 * The tags a seat carries, derived for a record written before tags existed.
 *
 * Derived rather than migrated, the same choice `kind` itself made on 2026-09-02: an existing
 * mates.json keeps working untouched, and nothing has to rewrite a store to read it. A record
 * that HAS tags is believed; one that does not is read through its kind.
 */
function seatTags(mate) {
  if (Array.isArray(mate?.tags)) {
    return mate.tags;
  }
  const kind = seatKind(mate);
  if (kind === SEAT_ASSISTANT) {
    return [SEAT_TAG_ASSISTANT];
  }
  if (kind === SEAT_PROJECT) {
    return [SEAT_TAG_PROJECT];
  }
  return [];
}

/** Does this seat carry the tag? */
function seatHasTag(mate, tag) {
  return seatTags(mate).includes(tag);
}

/**
 * Every ACTIVE seat carrying the tag, in store order.
 *
 * Not exported: every question outside this module is about a PARTICULAR seat - the standing
 * one, this checkout is one - and those have their own accessors. Exporting the tag layer
 * would invite callers to re-derive those questions, which is the taxonomy-in-four-places
 * problem this change exists to end.
 */
function seatsTagged(tag, mates = null) {
  return (mates || readState().mates).filter((m) => m.status === "active" && seatHasTag(m, tag));
}

/**
 * The one active seat carrying this tag, or null - and LOUD when there is more than one.
 *
 * A kind made "exactly one" true by construction, so nothing ever had to check it. A tag does
 * not, and `find()` does not fail when a question stops having one answer: it returns the
 * first and looks like it worked, which is how a caller silently comes to mean "whichever seat
 * is first in the array". That failure has now appeared three times in a week in this file's
 * neighbourhood - a persona default, a missing kind, a slot filter - so this one is caught
 * where it happens rather than found later.
 *
 * Throwing is the right shape because there is no sensible answer to return. A null would read
 * as "no such seat" and send the caller down a create-it path, which would make a second one.
 */
function theSeatTagged(tag, mates = null) {
  const found = seatsTagged(tag, mates);
  if (found.length > 1) {
    throw new Error(
      `${found.length} active seats are tagged "${tag}" (${found.map((m) => m.name).join(", ")}) - this lookup needs exactly one. Name the seat you mean, or retire the others.`
    );
  }
  return found[0] || null;
}

/**
 * Active COORDINATORS only, and that exclusion is load-bearing rather than tidy.
 *
 * `buildFirstMateMcpConfig` falls back to `activeMates()[0]` for a meta-home launch that
 * named no mate, and the assistant sorts to the front of any slot-ordered list because it has
 * no slot (`?? 0`). Including it here would hand a plain first-mate launch the assistant's
 * identity - its mateId on the dispatches, its widget showing another seat's crew. The
 * assistant is reached through assistantSeat() instead, deliberately.
 */
function activeMatesFrom(mates) {
  // An untagged seat is a coordinator. Reading it as "carries no identity tag" rather than as
  // "kind is coordinator" is what lets the kinds collapse without this predicate changing
  // again: a seat is in the pool because nothing else claims it, not because of a label.
  return mates.filter((m) => m.status === "active" && seatTags(m).length === 0);
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
 * Guarantees `slotCount` active mates rooted at `root`, creating any missing
 * slot's mate with a fresh random name. Idempotent - safe to call on every
 * startup / Fleet render. Returns the active mates ordered by slot.
 *
 * Only ever ADDS. Reducing the count is retireMateSlot's job, because dropping a
 * mate means retiring a real session's owner and that must be an explicit act,
 * never a side effect of a number changing.
 */
export function ensureMates(root, slotCount = MATE_SLOT_COUNT) {
  if (!root) {
    throw new Error("ensureMates requires a root path");
  }
  const wanted = clampMateSlots(slotCount);
  const resolvedRoot = path.resolve(root);
  const state = readState();
  const pool = namePoolForTheme(currentTheme());
  let changed = false;
  for (let slot = 0; slot < wanted; slot++) {
    // activeMatesFrom, not a raw status filter: a slot is a COORDINATOR concept, and the
    // assistant seat is deliberately slotless. Asking "is anyone active in this slot" let the
    // assistant answer yes (see retireMateSlot) and the pool then never refilled that slot.
    const held = activeMatesFrom(state.mates).find((m) => m.slot === slot);
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

/**
 * The assistant seat, or null when it has never been created.
 *
 * Separate from activeMates() for the reason given there. Returns the ACTIVE one: like a
 * coordinator, the seat is a role backed by a succession of sessions, so a retired record is
 * history rather than the seat.
 */
export function assistantSeat() {
  return theSeatTagged(SEAT_TAG_ASSISTANT);
}

/**
 * Guarantees the one assistant seat exists, rooted at `root`. Idempotent.
 *
 * No slot and no random name. A coordinator's name is disposable - the pool exists so two
 * anonymous slots are distinguishable - while this seat's name is how he refers to it and how
 * another session addresses it, so it is fixed. Renaming stays possible through renameMate;
 * nothing here overwrites a name he has changed.
 */
export function ensureAssistantSeat(root) {
  if (!root) {
    throw new Error("ensureAssistantSeat requires a root path");
  }
  const existing = assistantSeat();
  if (existing) {
    return existing;
  }
  const state = readState();
  const seat = {
    mateId: `mate_${crypto.randomUUID()}`,
    // Explicitly null rather than absent: a slot of 0 would collide with a coordinator's, and
    // the slot-ordered readers all use `?? 0`, so absent and 0 are indistinguishable there.
    slot: null,
    tags: [SEAT_TAG_ASSISTANT],
    name: "Assistent",
    root: path.resolve(root),
    status: "active",
    // Personas are a coordinator's temperament overlay. This seat has a manual of its own.
    persona: null,
    createdAt: Date.now(),
    retiredAt: null,
  };
  state.mates.push(seat);
  writeState(state);
  return seat;
}

/** The active seat opened against this checkout, or null. Never creates one. */
export function projectSeatForPath(projectPath) {
  const wanted = canonicalFsPath(projectPath);
  if (!wanted) {
    return null;
  }
  return (
    seatsTagged(SEAT_TAG_PROJECT).find((m) => canonicalFsPath(m.root) === wanted) || null
  );
}

/**
 * Is picking this folder an act of opening a PROJECT, or just starting a chat?
 *
 * The captain's usual folders include the meta-home itself - the root holding the CLAUDE.md
 * every session inherits - and picking it means an ordinary chat, not a project to orchestrate.
 * Minting a seat for it would put a project seat on the board for the one folder that is not a
 * project.
 *
 * This is the 2026-07-15 scar restated: first-mate treatment keyed on being rooted in the
 * meta-home ALONE, and every personal chat kept there was mis-framed and stripped of its MCP.
 * Root alone has never been the discriminator, and it is not one here either.
 *
 * A pure function taking the root as an argument, so it can be checked without an app, a
 * config, or a filesystem scan for where the meta-home is.
 */
export function isProjectPick(cwd, metaHomeRoot) {
  const c = canonicalFsPath(cwd);
  if (!c) {
    return false;
  }
  return c !== canonicalFsPath(metaHomeRoot);
}

/** Every active seat opened against a repository, in creation order. */
export function projectSeats() {
  return seatsTagged(SEAT_TAG_PROJECT);
}

/**
 * The seat for a project, creating it only if that checkout has none. ONE PER CHECKOUT, and
 * enforced here rather than left to convention, because the state is reachable by opening the
 * same project twice.
 *
 * Why enforced: the parallelism argument does not apply. Crew already gets isolated worktrees,
 * so many crew runs on one repo are safe. What is unsafe is two ORCHESTRATORS holding opinions
 * about one checkout with no shared view, deciding independently what to merge.
 *
 * WHICH COMPARISON, and this is a deliberate departure from the instruction to reuse
 * secondMateId's normaliser. That one folds separators and case; canonicalFsPath also resolves
 * the Windows 8.3 short name, which no amount of lowercasing folds and which has already made
 * a path the process itself registered come back as unrecognised. Seat identity is a
 * path-from-one-source against a path-from-another, which is precisely what that function
 * exists for.
 *
 * And secondMateId's own normaliser is deliberately NOT touched: its output is hashed into
 * every existing node id, so changing it would re-key them and strand the bindings that hold
 * the sessions. Same trap as the one stage 2 avoided, one level over.
 *
 * A slot is not assigned. Slots belong to the coordinator pool, and the board's crowding is
 * now set by how many projects are open rather than by a number - the count of open projects
 * IS concurrency, where the number was a proxy for it.
 */
export function ensureSeatForProject(projectPath, { persona = null } = {}) {
  if (!projectPath) {
    throw new Error("ensureSeatForProject requires a projectPath");
  }
  const wanted = canonicalFsPath(projectPath);
  if (!wanted) {
    throw new Error("ensureSeatForProject requires a real path");
  }
  const state = readState();
  const existing = seatsTagged(SEAT_TAG_PROJECT, state.mates).find((m) => canonicalFsPath(m.root) === wanted);
  if (existing) {
    return existing;
  }
  const takenNames = state.mates.filter((m) => m.status === "active").map((m) => m.name);
  const seat = {
    mateId: `mate_${crypto.randomUUID()}`,
    // Explicitly null, like the assistant seat's: a 0 would collide with a coordinator's, and
    // every slot-ordered reader normalises absence with `?? 0`.
    slot: null,
    tags: [SEAT_TAG_PROJECT],
    name: pickName(takenNames, state.mates.length, namePoolForTheme(currentTheme())),
    root: path.resolve(projectPath),
    status: "active",
    persona: isValidPersonaKey(persona) ? persona || null : null,
    createdAt: Date.now(),
    retiredAt: null,
  };
  state.mates.push(seat);
  writeState(state);
  return seat;
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
export function retireAndRespawn(mateId, pendingHandoff = null, persona = null, { keepPersona = true } = {}) {
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
  // Did the caller NAME a persona? A non-empty key that the catalog knows. An unknown key is
  // not a naming - it never becomes the persona, and the seat keeps what it had rather than
  // being reset by a typo.
  const personaNamed = typeof persona === "string" && persona !== "" && isValidPersonaKey(persona);
  // WHAT KIND THE SUCCESSOR IS, and this was missing until a project seat was retired for the
  // first time. A fresh record with no kind defaults to coordinator, so refreshing a saturated
  // project seat returned a coordinator rooted in a repository - a seat of a different kind
  // wearing the old one's root. Exactly the failure the persona default had, one field over:
  // a refresh must not change what a seat IS.
  //
  // A coordinator keeps its slot; anything else is slotless by construction, and reusing the
  // outgoing slot for a seat that never had one would put it in the pool.
  // The tags come across for the same reason the persona does: a refresh must not change what
  // a seat IS. That sentence has now been needed for persona, kind and tags, which is the
  // argument for identity living in ONE field - and after this commit it does.
  const outgoingTags = seatTags(outgoing);
  const fresh = {
    mateId: `mate_${crypto.randomUUID()}`,
    tags: [...outgoingTags],
    // A POOLED seat keeps its slot; a tagged one is slotless by construction, and handing it
    // the outgoing slot would put it in the pool. Read off the tag now rather than the kind, so
    // a successor of a pre-tag record is judged by the same rule as everything else.
    slot: outgoingTags.length === 0 ? targetSlot : null,
    name: pickName(takenNames, state.mates.length, namePoolForTheme(currentTheme())),
    root: root ? path.resolve(root) : null,
    status: "active",
    // Persona for the fresh mate.
    //
    // KEEPING IS THE DEFAULT, and under the seat model that is no longer a convenience.
    // A persona decides what a seat IS - a meta-home seat carrying the assistant persona is
    // a standing assistant - so dropping it on a saturation refresh returns the seat as a
    // plain coordinator with the wrong manual and the wrong tools. It reads as the seat
    // having forgotten itself rather than as a config default, which is the same complaint
    // the comment below already records one level down.
    //
    // The default matters even though every call site in the app passes the flag explicitly:
    // absence now means keep, so a future caller that omits it gets the safe answer rather
    // than the destructive one.
    //
    // keepPersona = an ordinary refresh: KEEP what the outgoing mate was. Refreshing a
    // mate's context is not a decision to change its character, and resetting to the plain
    // coordinator silently threw away a choice the captain had made - so a mate you set to
    // Red team came back as a coordinator without saying so, and any reason to set a
    // persona evaporated on the next refresh (the captain, 2026-08-04).
    //
    // Otherwise the passed key wins: that is a deliberate SWITCH, which has to go through
    // retire+respawn because a system prompt cannot change mid-session. Choosing
    // Coordinator explicitly passes null and therefore clears it, which keepPersona must
    // not override.
    // A PASSED persona is checked first, and that ordering is the whole correctness of the
    // flipped default. A caller that names a persona is asking for a switch, and once
    // keeping became the default the old ordering made that argument unreachable unless the
    // caller ALSO said keepPersona: false - so a deliberate switch would have been silently
    // ignored. Two existing checks caught this within a minute of the flip.
    //
    // An INVALID key now leaves the seat as it was rather than resetting it to plain. It
    // still never yields the bad key, which is what that rule was for; what changed is the
    // fallback, because under the seat model a typo must not strip a seat's identity.
    // Clearing on purpose has its own spelling: keepPersona: false with no persona.
    //
    // `personaNamed`, not `isValidPersonaKey(persona)`: that predicate answers "is this an
    // acceptable value", and null IS acceptable - it is how you say "no persona". So it
    // returns true for the argument being ABSENT, which as the first branch swallowed every
    // ordinary refresh and handed back null while keepPersona sat there true. Validity and
    // "the caller named one" are different questions and the flip is what made the
    // difference load-bearing.
    persona: personaNamed
      ? persona
      : keepPersona
        ? (isValidPersonaKey(outgoing?.persona) ? outgoing.persona : null)
        : null,
    createdAt: Date.now(),
    retiredAt: null,
    // Handoff from the retiring mate: the fresh mate's first jump-in seeds its
    // composer with this so the cross-project thread continues under the new
    // name (continuity via the logbook, not the old growing context window).
    // Consumed once (see consumeMateHandoff).
    pendingHandoff: pendingHandoff || null,
  };
  // The succession link, and it is what turns retire from a deletion into a handover.
  // Everything dispatched by the outgoing seat can now be resolved forward to the seat that
  // took its place, so the subtree neither has to be destroyed nor left pointing at a dead
  // id - the two options this replaces. See currentSeatId.
  if (outgoing) {
    outgoing.succeededBy = fresh.mateId;
  }
  state.mates.push(fresh);
  writeState(state);
  return fresh;
}

/**
 * The seat that a mate id means TODAY: follow the succession forward from a retired record
 * to the one now holding the role. An active id, an unknown id, or a retired one with no
 * successor is returned unchanged.
 *
 * Unknown ids are returned rather than nulled BECAUSE of what the callers pass: the synthetic
 * dispatchers "direct" and "auto" are not seats and are not in this store, and a resolver
 * that nulled them would silently strip the two identities that mean top-of-chain. That is a
 * property worth asserting rather than relying on, and the check does.
 *
 * BOUNDED AND CYCLE-GUARDED, because a long-lived project accumulates a chain and a corrupt
 * or hand-edited store can point one back at itself. A walk that ran away here would hang the
 * Fleet render, which calls this once per node.
 */
export function currentSeatId(mateId, mates = null) {
  if (!mateId) {
    return mateId;
  }
  const all = mates || readState().mates;
  const seen = new Set();
  let id = mateId;
  for (let hops = 0; hops < SUCCESSION_MAX_HOPS; hops++) {
    if (seen.has(id)) {
      return id;
    }
    seen.add(id);
    const rec = all.find((m) => m.mateId === id);
    if (!rec || rec.status === "active" || !rec.succeededBy) {
      return id;
    }
    id = rec.succeededBy;
  }
  return id;
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

/** Lowest slot index not currently held by an active mate (bounded by the max). */
function firstFreeSlot(mates) {
  for (let slot = 0; slot < MATE_SLOT_MAX; slot++) {
    if (!mates.some((m) => m.status === "active" && m.slot === slot)) {
      return slot;
    }
  }
  return 0;
}

/**
 * Retire the mate in `slot` WITHOUT respawning it - the way to go back down to
 * fewer first mates. Unlike retireAndRespawn (same slot, fresh name, work
 * continues) this removes the position entirely, so the caller must also lower
 * the configured slot count or ensureMates will recreate it on the next render.
 *
 * Remaining mates are re-packed onto slots 0..n-1: leaving a hole would make
 * ensureMates refill it, which is precisely the opposite of what was asked.
 * Returns the retired mate, or null when there was nothing there.
 */
export function retireMateSlot(slot) {
  const state = readState();
  const mate = activeMatesFrom(state.mates).find((m) => m.slot === slot);
  if (!mate) {
    return null;
  }
  mate.status = "retired";
  mate.slot = null;
  mate.retiredAt = Date.now();
  mate.sessionId = null;
  // Only coordinators are renumbered. Including every active mate swept the assistant seat
  // into the sequence - its `slot: null` sorts as 0 under the `?? 0` the readers all use, so
  // it was assigned slot 0, and ensureMates then saw that slot as held and refused to refill
  // it. The pool lost a slot per retire, silently. Probed on 2026-09-04: ensureMates(root, 2)
  // returned one coordinator after a single retire.
  const remaining = activeMatesFrom(state.mates).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  remaining.forEach((m, i) => {
    m.slot = i;
  });
  writeState(state);
  return mate;
}
