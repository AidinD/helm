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
// feature did not exist (the captain, 2026-08-02). The two Helm writes back would have
// been created on demand, but bare: no colour, no description, sitting next to
// six hand-made tags that have both. The descriptions ARE the documentation -
// they are the only place in Jot that explains what tagging a card does.
export const AUTO_CAPTAIN_TAGS = [
  {
    name: AUTO_TAG,
    color: "#5fb0ff",
    description: "Let Helm start this on its own. It only ever STARTS - the work lands in review for you.",
  },
  // These two get Jot's whole-row stripe (tag emphasis, Jot 1.5.23). `auto` does
  // NOT, on purpose: "may be started automatically" is not an active state, and
  // if twenty cards carry it the stripe stops meaning anything. These two are
  // "a machine is spending money and touching a repo right now" and "this card
  // is waiting on you" - the two you cannot afford to miss while scanning.
  // Only applied when the tag is CREATED, so turning the stripe off in Jot
  // sticks instead of being switched back on at every launch.
  {
    name: NEEDS_CLARIFICATION_TAG,
    color: "#ffb054",
    description: "Helm did not start this: too vague to hand over. The reason is written on the card.",
    emphasis: "stripe",
  },
  {
    name: AUTO_RUNNING_TAG,
    color: "#5fd0a0",
    description: "Helm started this one itself. Set and cleared by Helm - not something to set by hand.",
    emphasis: "stripe",
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
function stripAutoNotes(description) {
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
// The question this asks was changed on 2026-08-04, and the change is the whole point.
//
// It used to ask whether a card was WELL DEFINED - "clearly enough WHAT to change and HOW you
// would know it worked" - and was told to bias to false. Almost no real card on the captain's board
// clears that bar: "en copy code knapp" does not say how you would know it worked. So the lane
// spent its time handing cards back (his words, task e4ba1807: "auto är alldeles för
// restriktiv. Går till needs clarification alldeles för enkelt"), which reads as the app
// refusing to work rather than as a safety net.
//
// The bar he chose instead: hold back only what genuinely CANNOT be acted on. The `auto` tag is
// already his judgement that the card is worth doing, and re-litigating it was the mistake -
// so this asks a much narrower question, and the answer field is renamed with it. Calling the
// new answer `well_defined` would have quietly redefined an agreed term into its opposite.
// Bumped whenever the QUESTION above changes. A verdict is remembered per card so the same
// wording is not re-judged every minute - but it is remembered without any note of which question
// produced it, so loosening the bar left every already-held card held: the five cards that
// motivated the change would have stayed set aside after shipping it, until each tag was stripped
// by hand (found by an independent review, 2026-08-04). The tick forgets every remembered verdict
// when this value moves, which is the only honest thing to do with an answer to a question no
// longer being asked.
export const TRIAGE_PROMPT_VERSION = 2;

export const TRIAGE_SYSTEM_PROMPT = [
  "You judge ONE thing: could an autonomous coding agent START on this card at all?",
  "",
  "The person who wrote it has already tagged it for automatic start, so whether it is worth",
  "doing is settled and is not your call. You are not grading the wording either.",
  "",
  "Answer can_start: false ONLY when there is nothing to act on:",
  "  - it asks the author a question, or waits on a decision nobody has made yet;",
  "  - it is a topic or a wish with no change requested anywhere in it;",
  "  - acting on it needs information only the author has, and the card does not contain it.",
  "",
  "Otherwise answer true. A terse card is fine. A card naming a symptom with no cause is fine -",
  "finding the cause IS the work. A card whose success cannot be stated precisely is fine: the",
  "run lands in review, where the author reads it before anything is called done.",
  "",
  "Bias to TRUE. A wrongly-held card reads as the app refusing to work and costs the author a",
  "round trip through the board; a wrongly-started run lands in review on its own branch, which",
  "is where every run lands anyway.",
  "",
  // ALWAYS asked for, because the schema requires it. Telling the model to omit it when the
  // answer is true was a contradiction with a nasty failure mode: a model that obeyed the prompt
  // would produce output the schema rejects, no structured answer would come back, and a
  // perfectly startable card would be recorded as a FAILED triage and backed off for up to an
  // hour (raised by an independent review, 2026-08-04).
  "reason: always. When false, one sentence addressed to the author naming what is missing.",
  "When true, three or four words is enough (\"clear enough to start\").",
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

// NOTE: the auto-run worktree/branch helpers that used to live here are gone. An
// auto task is dispatched as an autopilot run, and the goal orchestrator already
// makes a worktree and a branch per run - a second convention of Helm's own was a
// duplicate with its own cleanup rules to keep in sync (2026-08-03).

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
 * Triage memories that no longer describe a card that is set aside.
 *
 * The memory exists so a card judged unclear is not re-judged on every tick, and it
 * is keyed on the card's WORDING - so the only way to make auto look at a card again
 * was to edit its text. Taking the "needs-clarification" tag off, which is the
 * obvious gesture for "look at this again", did nothing at all: the card sat there
 * eligible-looking and was skipped in silence every pass (the captain, 2026-08-03).
 *
 * Removing the tag now clears the memory. So does the card disappearing, which
 * otherwise leaves an entry per deleted card in the config forever.
 *
 * @param {{todos: any[], tags: any[]}} state
 * @param {Record<string,string>} triaged  taskId -> fingerprint
 * @returns {string[]} taskIds whose memory should be forgotten
 */
export function staleTriageEntries(state, triaged = {}) {
  const ids = Object.keys(triaged || {});
  if (ids.length === 0) {
    return [];
  }
  const tagId = tagIdByName(state?.tags, NEEDS_CLARIFICATION_TAG);
  const byId = new Map((state?.todos || []).map((t) => [t.id, t]));
  return ids.filter((id) => {
    const todo = byId.get(id);
    if (!todo) {
      return true; // the card is gone
    }
    if (!tagId) {
      return true; // the tag does not exist on the board at all any more
    }
    return !(Array.isArray(todo.tags) && todo.tags.includes(tagId));
  });
}

/**
 * Cards still wearing the "auto-running" stripe with no run behind them.
 *
 * Nothing could ever take that stripe off after a restart. It goes on at dispatch
 * (and the card moves to in-progress), and comes off in finishAutoRun - which is
 * driven by an IN-MEMORY map, so a Helm that quits or crashes mid-run loses the
 * link. The card cannot self-heal either: selectAutoQueuedTasks only looks at OPEN
 * cards, and this one was moved to in-progress at dispatch. So it sat there
 * claiming a machine was working on it, forever (independent review, 2026-08-03) -
 * which the code that writes the stripe explicitly calls worse than no stripe.
 *
 * `liveTaskIds` is the caller's answer to "which of these really are still
 * running", including runs owned by ANOTHER Helm instance - two instances are
 * normal here, and stealing the other one's card would be the same bug mirrored.
 *
 * @param {{todos: any[], tags: any[]}} state
 * @param {{liveTaskIds?: Set<string>}} [opts]
 * @returns {any[]} the stranded todos
 */
export function selectStrandedAutoCards(state, opts = {}) {
  const live = opts.liveTaskIds || new Set();
  const runningTagId = tagIdByName(state?.tags, AUTO_RUNNING_TAG);
  if (!runningTagId) {
    return [];
  }
  return (state?.todos || []).filter(
    (t) => Array.isArray(t.tags) && t.tags.includes(runningTagId) && !live.has(t.id)
  );
}

// parseTriageVerdict lived here: a tolerant parser that pulled a verdict out of prose and
// accepted both the old and new field names. An independent review found it was never called by
// any production path - triageAutoTask reads structured output directly, and nothing imported this
// but a test. So the three assertions arguing that the rename could not make the lane more
// restrictive were guarding a function no user code reaches, which is worse than having no guard:
// it read as protection. Deleted, and replaced by the parity check in
// scripts/pure-checks/test-auto-triage-schema-parity.mjs, which asserts the thing that actually matters -
// that the prompt, the schema and the live reader all name the SAME field.

