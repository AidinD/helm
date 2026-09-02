/**
 * Which model a seat starts on, named once instead of written out per launch path.
 *
 * ## The bug this replaces
 *
 * Measured in a second mate's own transcript on 2026-08-18: 426 turns on Sonnet 5, 12 on
 * Opus, in a seat whose manual opened by telling it "You run on the capable model (Opus)".
 * That sentence has since been removed - a model that has been told what it is and is wrong
 * is worse than one that was never told - but the mechanism underneath it stayed odd:
 *
 *   - jumping into the seat launched it with whatever the composer's picker happened to say
 *   - relaying to the SAME seat launched it with a `"claude-opus-4-8"` written into the call
 *
 * So one seat ran two different models depending on which door you came in through. Not a
 * setting anybody chose - two code paths that had never been compared.
 *
 * ## What replaces it
 *
 * A default per tier, in one place, that the picker overrides. The captain, 2026-09-02: "dess
 * default inställning i pickern bör vara opus men den ska gå efter pickerns val om jag
 * ändrar."
 *
 * A default and not a rule, deliberately. Forcing the model from the tier would be the same
 * mistake pointing the other way: crew is dispatched on Haiku on purpose when the work is
 * mechanical, and the same judgement applies to the seat above it.
 *
 * ## Why this outlives the tier rename
 *
 * The middle tier is going: the project-bound seat becomes FIRST MATE and the current
 * first-mate tier disappears (DECISIONS.md, 2026-08-16). The relay goes with it, since
 * nothing will sit above the project seat but the captain. What survives that is exactly
 * this: a default the picker starts on. Keyed by tier so the rename is a key change and not
 * a hunt through launch paths.
 */

/**
 * @type {Record<string, string>}
 */
export const DEFAULT_MODEL_BY_TIER = {
  // Delegate-and-summarize. The lighter model is the right one here, and this is the tier
  // whose manual says so.
  "first-mate": "claude-sonnet-5",
  // The judgment tier: validating crew's work and deciding whether it is actually correct.
  // A lighter model here is where quality degrades, which is why this seat's default is the
  // expensive one even though its crew's is not.
  "second-mate": "claude-opus-4-8",
};

/**
 * The model a seat of this tier starts on, or null for a tier with no opinion.
 *
 * Null rather than a fallback model: a caller asking about a tier nobody has decided for
 * should let the app's own default apply, not inherit another tier's answer by accident.
 *
 * @param {string} tier
 * @returns {string|null}
 */
export function defaultModelForTier(tier) {
  return DEFAULT_MODEL_BY_TIER[tier] || null;
}

/**
 * The model to launch a seat's session on.
 *
 * `recorded` is what that session last actually ran on, read from Helm's own session index.
 * It wins over the tier default, and that is the half that makes "the picker's choice wins"
 * true over TIME rather than just at the moment of clicking: without it, changing the model
 * in the picker held until the next relay to the same seat silently put it back.
 *
 * @param {string} tier
 * @param {string|null} [recorded] What this seat's session last ran on, if it has one.
 * @returns {string|null}
 */
export function modelForSeat(tier, recorded = null) {
  return recorded || defaultModelForTier(tier);
}
