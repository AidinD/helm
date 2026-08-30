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
    // modelFit, judgeCostUsd and suggestionAccuracy were removed on 2026-08-30 with the
    // model-fit judge that produced them. The old modelFitVerdict rows are still in the log
    // and are simply skipped now - deleting history would be a worse answer than ignoring it.
  };
  if (!fs.existsSync(logPath)) {
    return empty;
  }
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const summary = empty;
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
      // Historical rows from the removed model-fit judge. Skipped, not counted.
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
  }
  return summary;
}

// computeSuggestionAccuracyVerdict was removed on 2026-08-30. Its only caller was the
// periodic suggestion-accuracy check, which went with the model-fit judge that fed both.
// The summary block it read (summary.suggestionAccuracy) is still built here, because the
// Analysis page still shows the historical figures - labelled as final rather than live.
