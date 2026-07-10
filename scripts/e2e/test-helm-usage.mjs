// Unit test: helmUsage tracks events and summarizes views + navigation paths.
// Verifies view counts, A->B transitions within a sitting, the session-gap
// reset (a long gap does NOT create a spurious transition), and action counts.
// Uses the HELM_USAGE_PATH seam so it never touches the real log.
// Run:  node scripts/e2e/test-helm-usage.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "helm-usage-" + process.pid + ".jsonl");
process.env.HELM_USAGE_PATH = tmp;

const { trackHelmUsage, summarizeHelmUsage, helmUsagePath } = await import("../../src/lib/helmUsage.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

try {
  assert(helmUsagePath() === tmp, "uses the HELM_USAGE_PATH seam");

  // A sitting: dashboard -> chat -> dashboard -> analysis (t increments by 1 min).
  const t0 = 1_000_000_000_000;
  const min = 60 * 1000;
  const seq = ["dashboard", "chat", "dashboard", "analysis"];
  seq.forEach((page, i) => trackHelmUsage({ type: "nav", page, at: t0 + i * min }));
  // A NEW sitting 2h later, starting on chat - the analysis->chat gap must NOT
  // count as a transition.
  trackHelmUsage({ type: "nav", page: "chat", at: t0 + 120 * min });
  trackHelmUsage({ type: "nav", page: "chat", at: t0 + 121 * min }); // repeat: no self-transition
  trackHelmUsage({ type: "action", action: "archive", at: t0 + 122 * min });

  const s = summarizeHelmUsage();
  const view = (p) => (s.views.find((v) => v.page === p) || {}).count || 0;
  assert(s.totalEvents === 7, "counts every event");
  assert(view("dashboard") === 2, "dashboard visited twice");
  assert(view("chat") === 3, "chat visited three times");
  assert(view("analysis") === 1, "analysis visited once");
  assert(s.views[0].page === "chat", "views sorted by count (chat top)");

  const trans = (p) => (s.transitions.find((t) => t.path === p) || {}).count || 0;
  assert(trans("dashboard → chat") === 1, "dashboard → chat transition counted");
  assert(trans("chat → dashboard") === 1, "chat → dashboard transition counted");
  assert(trans("dashboard → analysis") === 1, "dashboard → analysis transition counted");
  assert(trans("analysis → chat") === 0, "long gap does NOT create analysis → chat (session-gap reset)");
  assert(!s.transitions.some((t) => /→ \1/.test(t.path)), "no self-transition from a repeated view");

  assert((s.actions.find((a) => a.action === "archive") || {}).count === 1, "action events aggregated");
  assert(s.firstAt === t0 && s.lastAt === t0 + 122 * min, "time span spans first..last event");

  // Corrupt line is skipped, not fatal.
  fs.appendFileSync(tmp, "{not json\n", "utf8");
  const s2 = summarizeHelmUsage();
  assert(s2.totalEvents === 7, "a corrupt line is skipped, not fatal");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
} finally {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: helm usage tracking + summary." : "VERIFY FAILED.");
process.exit(exit);
