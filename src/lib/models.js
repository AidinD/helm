/**
 * Every Claude model id this codebase currently knows about - the baseline
 * modelFreshness.js diffs the installed CLI's own model ids against, to answer
 * "did Anthropic ship something we haven't wired up yet?" (Jot card
 * "Behöver strategi för när ny version av claude släpps").
 *
 * This is a UNION, not a replacement, of the model lists already living in
 * src/lib/reviewerModel.js (REVIEWER_MODELS, a curated tiered subset) and
 * src/renderer/renderer.js (MODEL_MENU_OPTIONS - the renderer is a classic
 * script and cannot import this file, see the WORKING_LIFECYCLE_STATES
 * comment near the top of renderer.js for the same constraint on another
 * constant). Adding a model to the picker or the reviewer tiers is a UX
 * decision that still needs a human; this file only needs to grow so the
 * freshness check stops flagging it as "new".
 */
export const KNOWN_MODEL_IDS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
];
