// Suggests a model + effort for a task based on its description, mirroring
// the rubric used by the /kickoff skill and Aidin's feedback_suggest_model_effort
// memory: default to the cheapest tier that fits, reserve Opus+high for
// genuinely ambiguous/architectural/hard-debugging work.

const HARD_PATTERN =
  /\b(architecture|arkitektur|design|redesign|migrat|race condition|hard bug|debugg?ing|investigate|utred|refactor across|cross-system|ambiguous|oklar|luddig)\b/i;

const MECHANICAL_PATTERN =
  /\b(rename|döp om|move file|flytta fil|typo|format|comment|kommentar|doc|dokumentation|small fix|liten fix|update text|byt text)\b/i;

/**
 * Returns { model, effort, reason }. Purely heuristic — always overridable.
 */
export function suggestModelEffort(prompt) {
  const text = (prompt || "").trim();
  if (!text) {
    return { model: "claude-sonnet-5", effort: "medium", reason: "default" };
  }
  if (HARD_PATTERN.test(text)) {
    return {
      model: "claude-opus-4-8",
      effort: "high",
      reason: "architecture / ambiguous / hard-debugging language detected",
    };
  }
  if (MECHANICAL_PATTERN.test(text) || text.length < 60) {
    return {
      model: "claude-sonnet-5",
      effort: "low",
      reason: "short or mechanical task",
    };
  }
  return {
    model: "claude-sonnet-5",
    effort: "medium",
    reason: "normal feature work",
  };
}
