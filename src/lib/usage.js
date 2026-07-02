import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, "..", "..", "usage-log.jsonl");

/**
 * Appends one completed-launch record. Foundation for the "which model/skills
 * are most used" analysis view — logging first, aggregate analysis later once
 * there's real data to look at.
 */
export function appendUsageLog(entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Usage logging is a nice-to-have; never let it break a live session.
  }
}

/**
 * Reads and aggregates the usage log: counts per model, per tool, total cost.
 * Tolerant of a missing file or the occasional malformed line.
 */
export function readUsageSummary() {
  const empty = {
    totalRuns: 0,
    totalCostUsd: 0,
    byModel: {},
    byTool: {},
    bySkill: {},
    modelFit: {}, // { model: { too_weak, appropriate, too_strong } }
    judgeCostUsd: 0,
    // Answers "should the suggestion heuristic change?" by joining a run's
    // followedSuggestion with the judge's verdict for that SAME run (linked
    // by launchId, not just model+time proximity). Runs from before launchId
    // was logged, or with no judge verdict, are silently excluded — this is
    // a strict subset, not an estimate padded with guesses.
    suggestionAccuracy: {
      followed: { too_weak: 0, appropriate: 0, too_strong: 0 },
      overridden: { too_weak: 0, appropriate: 0, too_strong: 0 },
    },
  };
  if (!fs.existsSync(logPath)) {
    return empty;
  }
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const summary = empty;
  // Only runs where a suggestion was actually computed (suggestedModel set)
  // are candidates for the accuracy join — a run with no suggestion has
  // nothing to judge the heuristic against.
  const suggestedRunsByLaunchId = new Map();
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Entries logged before the "type" field existed are implicitly "run".
    const type = entry.type || "run";
    if (type === "modelFitVerdict") {
      summary.judgeCostUsd += entry.judgeCostUsd || 0;
      const model = entry.model || "unknown";
      if (!summary.modelFit[model]) {
        summary.modelFit[model] = { too_weak: 0, appropriate: 0, too_strong: 0 };
      }
      if (entry.verdict && summary.modelFit[model][entry.verdict] !== undefined) {
        summary.modelFit[model][entry.verdict] += 1;
      }
      if (entry.launchId != null && suggestedRunsByLaunchId.has(entry.launchId)) {
        const run = suggestedRunsByLaunchId.get(entry.launchId);
        const bucket = run.followedSuggestion ? summary.suggestionAccuracy.followed : summary.suggestionAccuracy.overridden;
        if (entry.verdict && bucket[entry.verdict] !== undefined) {
          bucket[entry.verdict] += 1;
        }
      }
      continue;
    }
    summary.totalRuns += 1;
    summary.totalCostUsd += entry.costUsd || 0;
    if (entry.model) {
      summary.byModel[entry.model] = (summary.byModel[entry.model] || 0) + 1;
    }
    for (const tool of entry.toolsUsed || []) {
      summary.byTool[tool] = (summary.byTool[tool] || 0) + 1;
    }
    // Text-pattern guess (leading "/skill-name" in the prompt), not a real
    // event from the CLI — see the comment where this is set in main.js.
    if (entry.skillInvoked) {
      summary.bySkill[entry.skillInvoked] = (summary.bySkill[entry.skillInvoked] || 0) + 1;
    }
    if (entry.launchId != null && entry.suggestedModel) {
      suggestedRunsByLaunchId.set(entry.launchId, entry);
    }
  }
  return summary;
}
