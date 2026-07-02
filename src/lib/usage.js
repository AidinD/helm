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
  if (!fs.existsSync(logPath)) {
    return { totalRuns: 0, totalCostUsd: 0, byModel: {}, byTool: {} };
  }
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const summary = { totalRuns: 0, totalCostUsd: 0, byModel: {}, byTool: {} };
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
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
  }
  return summary;
}
