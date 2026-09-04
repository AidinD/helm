// The Jot task (b67107c8) the incident produced: a run that stopped because tokens
// ran out needs a Resume button. Such a run finishes as status "done" + resumable
// (quota_exhausted), NOT "interrupted" - and before this fix the card only showed
// a Resume button for "interrupted" runs, so a quota-stopped run in the Auto lane
// had no per-run way to continue (the user had to reach for the fleet-wide
// "fortsätt" from a first mate). This asserts:
//   - a done + resumable + non-escalated run SHOWS one Resume button
//   - a done + non-resumable run (a real failure) shows NONE
//   - clicking it passes the id to the backend intact (guards the preload wiring)
//
// Real launched Helm via CDP. The relaunch itself needs a live worktree, so the
// seeded run's worktree is absent and the backend refuses on THAT (proving the id
// arrived), rather than "No such run".
//
// Run:  node scripts/e2e/test-goal-resume-quota.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[goal-resume-quota-e2e]", ...a);
}

// Seed history so the clicked id RESOLVES in the backend (resumable, but its
// worktree is gone) - a correctly-passed id refuses on the worktree, a mis-wired
// one says "No such run".
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-resume-quota-"));
fs.writeFileSync(
  path.join(tmp, "goal-run-history.json"),
  JSON.stringify([
    { goalRunId: "quota-1", goal: "A token-exhausted run", projectPath: "P", status: "done", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "gone") },
  ]),
  "utf8"
);
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  await app.eval("new Promise(r => setTimeout(r, 400))");
  await app.eval(`(() => { navigateToPage("goal"); return true; })()`);
  await app.waitForSelector("#goalPage", 12000, { visible: true });

  await app.eval(`(() => {
    window.__toasts = [];
    const orig = window.showToast;
    window.showToast = (msg) => { window.__toasts.push(msg); return orig ? orig(msg) : undefined; };
    return true;
  })()`);

  // Two finished runs: one stopped on quota (resumable), one on a real failure
  // (not resumable). Both expanded so their detail (and any Resume button) renders.
  await app.eval(`(() => {
    goalRuns.clear();
    goalRuns.set("quota-1", { goalRunId: "quota-1", ordinal: 1, goal: "A token-exhausted run", projectPath: "P", status: "done", iterations: [], escalation: null,
      result: { resumable: true, stoppedReason: "quota_exhausted", commitCount: 0, branchName: "helm/goal-q", worktreePath: "P/wt-q" } });
    goalRuns.set("fail-1", { goalRunId: "fail-1", ordinal: 2, goal: "A genuinely failed run", projectPath: "P", status: "done", iterations: [], escalation: null,
      result: { resumable: false, stoppedReason: "two_consecutive_failures", commitCount: 0, branchName: "helm/goal-f", worktreePath: "P/wt-f" } });
    goalRunExpanded.add("quota-1");
    goalRunExpanded.add("fail-1");
    renderGoalPage();
    return true;
  })()`);

  const total = await count("#goalPage .goal-resume-btn");
  assert(total === 1, `exactly one Resume button - only the quota-stopped run offers it (got ${total})`);

  // The button must be inside the quota run's card, not the failed one.
  const inQuota = await app.eval(`(() => {
    const cards = [...document.querySelectorAll("#goalPage .goal-run-detail")];
    const q = cards.find((c) => /token-exhausted/i.test(c.innerText));
    const f = cards.find((c) => /genuinely failed/i.test(c.innerText));
    return { quotaHas: !!q?.querySelector(".goal-resume-btn"), failHas: !!f?.querySelector(".goal-resume-btn") };
  })()`);
  assert(inQuota.quotaHas === true, "the quota-stopped run shows the Resume button");
  assert(inQuota.failHas === false, "the genuinely-failed run shows NO Resume button");

  // Click it: a correctly-passed id resolves the seeded record and refuses on the
  // missing worktree; a mis-wired arg would say "No such run".
  await app.eval(`document.querySelector("#goalPage .goal-resume-btn").click()`);
  await app.eval("new Promise(r => setTimeout(r, 600))");
  const toasts = await app.eval(`window.__toasts`);
  const joined = (toasts || []).join(" ");
  assert(Array.isArray(toasts) && toasts.length >= 1, `clicking Resume runs the handler (got ${toasts?.length} toast(s))`);
  assert(!/No such run/i.test(joined), `the id reached the backend (NOT "No such run"): ${JSON.stringify(toasts)}`);
  assert(/worktree/i.test(joined), `the seeded run resolved and refused on its missing worktree (got ${JSON.stringify(toasts)})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: a token/quota-stopped run is resumable from its card; a real failure is not." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
