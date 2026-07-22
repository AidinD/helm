// Unit test: usage.js readUsageSummary aggregates skill usage from BOTH the
// leading-"/skill-name" prompt guess (skillInvoked) AND skills the model invoked
// itself via the Skill tool (skillsUsed), counted once per run each with the two
// sources deduped (task aa9f5238). Uses the HELM_USAGE_LOG_PATH seam.
// Run:  node scripts/e2e/test-usage-skills.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "usage-skills-" + process.pid + ".jsonl");
process.env.HELM_USAGE_LOG_PATH = tmp;

const { appendUsageLog, readUsageSummary } = await import("../../src/lib/usage.js");

let exit = 0;
const assert = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

try {
  // 1: a "/health-coach" prompt (slash guess only).
  appendUsageLog({ type: "run", skillInvoked: "health-coach", toolsUsed: [] });
  // 2: model invoked two skills itself, no slash (autonomous only).
  appendUsageLog({ type: "run", skillsUsed: ["pdf", "xlsx"], toolsUsed: ["Skill", "Skill"] });
  // 3: "/triage" that ALSO surfaced as a Skill tool_use for "triage" - must count ONCE.
  appendUsageLog({ type: "run", skillInvoked: "triage", skillsUsed: ["triage"], toolsUsed: ["Skill"] });
  // 4: another autonomous "pdf" - pdf now used in 2 runs.
  appendUsageLog({ type: "run", skillsUsed: ["pdf"], toolsUsed: ["Skill"] });
  // 5: a run with no skills at all - contributes nothing.
  appendUsageLog({ type: "run", toolsUsed: ["Read"] });

  const s = readUsageSummary();
  assert(s.totalRuns === 5, `counts every run (got ${s.totalRuns})`);
  assert(s.bySkill["health-coach"] === 1, "slash-only skill counted");
  assert(s.bySkill["xlsx"] === 1, "autonomous-only skill counted");
  assert(s.bySkill["pdf"] === 2, `autonomous skill counted across runs (got ${s.bySkill["pdf"]})`);
  assert(s.bySkill["triage"] === 1, `slash+autonomous for the SAME skill in one run counts once, not twice (got ${s.bySkill["triage"]})`);
  assert(Object.keys(s.bySkill).length === 4, `exactly the 4 distinct skills (got ${JSON.stringify(s.bySkill)})`);
  // The Skill tool still shows in byTool independently - both views coexist.
  assert(s.byTool["Skill"] === 4, `byTool still counts raw Skill tool_use events (got ${s.byTool["Skill"]})`);
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: skill usage counts /skill prompts + autonomous Skill-tool use, deduped per run." : "VERIFY FAILED.");
process.exit(exit);
