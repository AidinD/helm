// Auto-captain: the automated dispatcher that starts work on tasks the user hands
// it (Jot task ea0546d1; design in docs/auto-captain-design.md). This module is
// the PURE brain - task SELECTION + triage-verdict PARSING - so it's testable
// without a model call or firing real work. The consequential parts (the live
// Haiku triage call, the watch loop, and the actual dispatch) sit on top and are
// gated behind config.autoCaptain.enabled (OFF by default) - nothing auto-fires
// until the user turns it on.
//
// Trigger: a TAG named "auto" (case-insensitive), not a new Jot lifecycle status -
// this avoids the thorny TodoStatus-per-list change (parked task ed4291d2) while
// still being an explicit, opt-in "AI, take this" signal. Tags Helm writes back
// (needs-clarification, auto-running) carry state.

// The trigger tag + the state tags, matched by name so no Jot schema change is
// needed. Comparison is case-insensitive.
export const AUTO_TAG = "auto";
export const NEEDS_CLARIFICATION_TAG = "needs-clarification";
export const AUTO_RUNNING_TAG = "auto-running";

// Seeded onto the board at startup (ensureTagsExist in jot.js). Without this the
// feature has no way in: `auto` is the tag the USER applies, and nothing ever
// created it, so there was nothing to pick in Jot - the trigger for the whole
// feature did not exist (Aidin, 2026-08-02). The two Helm writes back would have
// been created on demand, but bare: no colour, no description, sitting next to
// six hand-made tags that have both. The descriptions ARE the documentation -
// they are the only place in Jot that explains what tagging a card does.
export const AUTO_CAPTAIN_TAGS = [
  {
    name: AUTO_TAG,
    color: "#5fb0ff",
    description: "Let Helm start this on its own. It only ever STARTS - the work lands in review for you.",
  },
  {
    name: NEEDS_CLARIFICATION_TAG,
    color: "#ffb054",
    description: "Helm did not start this: too vague to hand over. The reason is written on the card.",
  },
  {
    name: AUTO_RUNNING_TAG,
    color: "#5fd0a0",
    description: "Helm started this one itself. Set and cleared by Helm - not something to set by hand.",
  },
];

// How many auto-started runs may be in flight at once. Dragging ten cards into
// Auto must not fire ten sessions; the rest wait their turn. Matches the crew
// dispatch width so the whole system has one idea of "too much at once".
export const AUTO_WIDTH_CAP = 3;

export function tagIdByName(tags, name) {
  const lower = name.toLowerCase();
  const t = (tags || []).find((x) => (x.name || "").toLowerCase() === lower);
  return t ? t.id : null;
}

/**
 * WHERE does this task's work happen?
 *
 * A Jot category can be bound to a folder (Jot's `repoPath`). That binding is the
 * only trustworthy answer - guessing a project from a category NAME would mean the
 * auto-captain occasionally starting real work in the wrong repo, which is far
 * worse than not starting it at all.
 *
 * Returns { ok: true, projectPath } or { ok: false, reason } where the reason is
 * written for the person who has to fix it, not for a log.
 */
export function resolveTaskProject(todo, categories) {
  const cat = (categories || []).find((c) => c.id === todo?.categoryId);
  if (!cat) {
    return { ok: false, reason: "This task isn't in a list, so there's no way to tell which project it belongs to." };
  }
  const repoPath = typeof cat.repoPath === "string" ? cat.repoPath.trim() : "";
  if (!repoPath) {
    return {
      ok: false,
      reason: `The list "${cat.name}" isn't bound to a folder, so I don't know where to run this. Set the list's folder in Jot and it becomes auto-startable.`,
      category: cat,
    };
  }
  return { ok: true, projectPath: repoPath, category: cat };
}

/**
 * A stable fingerprint of the parts of a task the triage actually read.
 *
 * Without this, a task judged "not clear enough" would be re-triaged on every tick
 * forever - a model call a minute, against the same words, reaching the same
 * conclusion, for as long as the card sits there. Re-triage happens when the task
 * CHANGES, which is exactly when the previous verdict stops being valid.
 */
export function taskFingerprint(todo) {
  return [todo?.text || "", stripAutoNotes(todo?.description || ""), todo?.categoryId || ""].join("|");
}

// The follow-up line of a hold-back note, as a constant so the note and the
// fingerprint can never disagree about what counts as the auto-captain's own text.
const CLARIFICATION_FOLLOW_UP = "Add what's missing and it will be picked up again.";

/**
 * Strip the auto-captain's OWN notes out of a description before fingerprinting.
 *
 * Without this the guard defeats itself: holding a card back appends a note, the
 * note changes the description, the changed description changes the fingerprint,
 * and the next pass judges the card again - appending another note. A loop that
 * grows the card forever at one model call a minute. Caught by
 * test-auto-captain-gates.mjs on its very first run.
 *
 * What survives is what the USER wrote, which is exactly what should make a held
 * card eligible again.
 */
export function stripAutoNotes(description) {
  const NL = String.fromCharCode(10);
  return String(description || "")
    .split(NL)
    .filter((line) => {
      const t = line.trim();
      return !/^\[Auto-captain \d{4}-\d{2}-\d{2}\]/.test(t) && t !== CLARIFICATION_FOLLOW_UP;
    })
    .join(NL)
    .trim();
}

/**
 * The full decision for one tick: which tasks to act on now, and which to skip and
 * why. Pure - it decides, it does not do.
 *
 * @param {{todos: any[], tags: any[], categories: any[]}} state
 * @param {{
 *   running?: number,           // auto runs currently in flight
 *   cap?: number,
 *   triaged?: Record<string,string>, // taskId -> fingerprint at the time it was set aside
 *   handledIds?: Set<string>,
 * }} [opts]
 * @returns {{ act: any[], skipped: {todo: any, reason: string}[], atCap: boolean }}
 */
export function planAutoTick(state, opts = {}) {
  const cap = opts.cap ?? AUTO_WIDTH_CAP;
  const running = opts.running ?? 0;
  const triaged = opts.triaged || {};
  const queued = selectAutoQueuedTasks(state, { handledIds: opts.handledIds });
  const act = [];
  const skipped = [];
  for (const todo of queued) {
    // Already judged unclear, and nothing about it has changed since.
    const seen = triaged[todo.id];
    if (seen && seen === taskFingerprint(todo)) {
      skipped.push({ todo, reason: "already set aside as unclear, and unchanged since" });
      continue;
    }
    if (running + act.length >= cap) {
      skipped.push({ todo, reason: `waiting - ${cap} auto runs already in flight` });
      continue;
    }
    act.push(todo);
  }
  return { act, skipped, atCap: running + act.length >= cap };
}

/**
 * What the triage model is asked. Deliberately narrow: it judges ONLY whether the
 * task is specific enough for someone else to pick up and act on without coming
 * back with questions. It does not plan the work, estimate it, or decide whether it
 * is a good idea - all of which it would do badly and none of which is the gate.
 */
export const TRIAGE_SYSTEM_PROMPT = [
  "You judge whether a task card is specific enough to hand to an autonomous coding agent.",
  "",
  "Answer well_defined: true ONLY if the card says clearly enough WHAT to change and HOW you would know it worked.",
  "Answer false if it is a vague intention, a question, a topic, a decision that has not been made,",
  "or anything where a competent agent would have to guess at the actual ask.",
  "",
  "Bias to false. A wrongly-dispatched task spends real money and produces work nobody asked for;",
  "a wrongly-held task costs one sentence from the user.",
  "",
  "reason: one sentence, addressed to the person who wrote the card, saying what is missing.",
  "Do not restate the task. Do not be encouraging. Say the specific thing to add.",
].join("\n");

/** The card, rendered for triage. */
export function buildTriageInput(todo, category) {
  return [
    `List: ${category?.name || "(none)"}`,
    `Task: ${todo?.text || "(untitled)"}`,
    "",
    "Description:",
    (todo?.description || "(none)").slice(0, 4000),
  ].join("\n");
}

/**
 * The note left on a card that was held back. It has to explain itself on the
 * board, where the user reads it - a bare "needs-clarification" tag would just be
 * the app refusing without saying why.
 */
export function clarificationNote(reason, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  return `[Auto-captain ${stamp}] Not started: ${reason}\nAdd what's missing and it will be picked up again.`;
}

/**
 * Select the tasks the auto-captain should act on, from a JotState.
 * A candidate is: tagged "auto", still OPEN (queued - not already in-progress/
 * review/done), NOT a subtask, and NOT already picked up (handledIds). Ordered by
 * Jot priority ascending (lower number = more urgent) so the most urgent goes first.
 *
 * @param {{todos: any[], tags: any[]}} state
 * @param {{handledIds?: Set<string>}} [opts]
 * @returns {any[]} the todos to act on, most-urgent first
 */
export function selectAutoQueuedTasks(state, opts = {}) {
  const handled = opts.handledIds || new Set();
  const autoTagId = tagIdByName(state?.tags, AUTO_TAG);
  if (!autoTagId) {
    return [];
  }
  return (state?.todos || [])
    .filter(
      (t) =>
        Array.isArray(t.tags) &&
        t.tags.includes(autoTagId) &&
        t.status === "open" &&
        !t.parentId &&
        !handled.has(t.id)
    )
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/**
 * Parse the triage model's output into a verdict. The triage prompt asks the
 * model whether a task is well-defined enough to dispatch to crew, answering with
 * a JSON object { well_defined: boolean, reason: string }. Tolerant of prose
 * around the JSON and of a missing/garbled response (defaults to NOT dispatchable
 * with a clear reason, so an unparseable triage never silently fires work).
 *
 * @param {string} text
 * @returns {{dispatchable: boolean, reason: string}}
 */
export function parseTriageVerdict(text) {
  const raw = (text || "").trim();
  if (!raw) {
    return { dispatchable: false, reason: "Triage produced no output - left for review." };
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (typeof obj.well_defined === "boolean") {
        const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : obj.well_defined ? "Well-defined." : "Not specific enough to hand to crew as-is.";
        return { dispatchable: obj.well_defined, reason };
      }
    } catch {
      // fall through
    }
  }
  // No parseable verdict - don't fire; flag for a human look.
  return { dispatchable: false, reason: "Triage response wasn't parseable - left for review." };
}
