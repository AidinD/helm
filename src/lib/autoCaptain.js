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

function tagIdByName(tags, name) {
  const lower = name.toLowerCase();
  const t = (tags || []).find((x) => (x.name || "").toLowerCase() === lower);
  return t ? t.id : null;
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
