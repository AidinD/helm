import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_USAGE_LOG_PATH is a test/packaged-app seam (see main.js's
// packagedPaths.js; distinct from helmUsage.js's HELM_USAGE_PATH, which backs
// a different file). Production/dev leaves it unset and uses the plain JSONL
// file beside the app.
const logPath = process.env.HELM_USAGE_LOG_PATH || path.join(__dirname, "..", "..", "usage-log.jsonl");

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
    // Skills this run used, counted once per run each: the leading-"/skill-name"
    // prompt guess (skillInvoked) UNION the skills the model invoked itself via
    // the Skill tool (skillsUsed, task aa9f5238). The set dedupes the common case
    // where a "/foo" prompt also surfaces as a Skill tool_use, so bySkill reads as
    // "runs that used this skill" rather than double-counting one run.
    const skillsThisRun = new Set();
    if (entry.skillInvoked) {
      skillsThisRun.add(entry.skillInvoked);
    }
    for (const skill of entry.skillsUsed || []) {
      if (skill) {
        skillsThisRun.add(skill);
      }
    }
    for (const skill of skillsThisRun) {
      summary.bySkill[skill] = (summary.bySkill[skill] || 0) + 1;
    }
    if (entry.launchId != null && entry.suggestedModel) {
      suggestedRunsByLaunchId.set(entry.launchId, entry);
    }
  }
  return summary;
}

/**
 * Shared "is the suggestion heuristic meaningfully off?" verdict, derived
 * from readUsageSummary()'s suggestionAccuracy block. This is the SAME
 * followed-vs-overridden appropriate-rate comparison the on-demand
 * "Suggestion accuracy" report on the Analysis page already renders
 * (renderer.js's renderAnalysisPage) — extracted here so the periodic
 * orchestrator sweep (main.js's runOrchestratorSweepBody) can reuse the
 * exact same metric instead of inventing a second one that could drift out
 * of sync with what the captain sees when he checks manually.
 *
 * Returns null when there isn't enough judged+suggested data to say
 * anything (mirrors the report's own "No judged runs with a suggestion yet"
 * empty state), otherwise { followedTotal, overriddenTotal, followedRate,
 * overriddenRate, diffPoints, message }. diffPoints > 0 means following the
 * suggestion did better; < 0 means overriding it did better (the
 * heuristic-looks-off case).
 */
export function computeSuggestionAccuracyVerdict(summary) {
  const acc = summary.suggestionAccuracy || { followed: {}, overridden: {} };
  const followedTotal = (acc.followed.too_weak || 0) + (acc.followed.appropriate || 0) + (acc.followed.too_strong || 0);
  const overriddenTotal = (acc.overridden.too_weak || 0) + (acc.overridden.appropriate || 0) + (acc.overridden.too_strong || 0);
  if (followedTotal === 0 || overriddenTotal === 0) {
    return null;
  }
  const followedRate = (acc.followed.appropriate || 0) / followedTotal;
  const overriddenRate = (acc.overridden.appropriate || 0) / overriddenTotal;
  const diffPoints = Math.round((followedRate - overriddenRate) * 100);
  const message =
    diffPoints >= 0
      ? `Following the suggestion was judged "appropriate" ${diffPoints} points more often than overriding it (${followedTotal} followed vs ${overriddenTotal} overridden).`
      : `Overriding the suggestion was judged "appropriate" ${Math.abs(diffPoints)} points more often than following it (${overriddenTotal} overridden vs ${followedTotal} followed) — the suggestion heuristic may be worth revisiting.`;
  return { followedTotal, overriddenTotal, followedRate, overriddenRate, diffPoints, message };
}
