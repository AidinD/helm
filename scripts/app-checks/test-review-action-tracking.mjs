// the captain, task 76790f23, two rounds of feedback:
//   round 1: "jag vill mer veta statistik på hur jag hanterar review. Har jag
//     kört testerna? kollar jag på diffen, send back etc?"
//   round 2: "Jag vill bara ha analytics datan, inte nuvarande state. Jag
//     vill också se av totalen, t.ex öppnade diff 3/5. Jag vill även att
//     intependent reviewer stats ska vara med och vilken model som valdes"
//
// This drives the REAL actions that are supposed to log each event -
// reviews:setStatus (Done/Send-back), reviews:runChecks (the "Run checks"
// button), openDiffViewer ("See diff"), and the independent-reviewer dispatch
// confirm - against two tasks: one with every action taken before its
// decision, one with none, and checks the JOIN (summarizeReviewActions) gets
// the "N/total" fractions and the model breakdown right through the real
// Analysis page render, not just the raw aggregation function.
//
// Run:  node scripts/e2e/test-review-action-tracking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-revaction-"));
const jotPath = path.join(tmp, "todos.json");
const metaHome = path.join(tmp, "meta-home");
fs.writeFileSync(
  jotPath,
  JSON.stringify({
    categories: [{ id: "cat1", name: "Test" }],
    tags: [],
    todos: [
      { id: "aaaaaaaa", text: "Full pass", status: "review", categoryId: "cat1", description: "", images: [], tags: [], priority: 0 },
      { id: "bbbbbbbb", text: "Bare send-back", status: "review", categoryId: "cat1", description: "", images: [], tags: [], priority: 0 },
    ],
  }),
  "utf8"
);
// aaaaaaaa's review record: real declared checks so reviews:runChecks has
// something to actually run (a trivial always-succeeds node command).
const reviewsDir = path.join(metaHome, ".helm", "reviews");
fs.mkdirSync(reviewsDir, { recursive: true });
fs.writeFileSync(
  path.join(reviewsDir, "aaaaaaaa.json"),
  JSON.stringify({
    taskId: "aaaaaaaa",
    projectPath: tmp,
    criticality: "cosmetic",
    verdict: "stamp",
    checks: [{ label: "trivial", cmd: 'node -e "process.exit(0)"', cwd: tmp }],
  }),
  "utf8"
);

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({ jot: { path: jotPath } }), "utf8");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_USAGE_PATH = path.join(tmp, "helm-usage.jsonl");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9536";
const { launch } = await import("../checks-lib/harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const before = await app.eval(`window.helm.getReviewActionSummary()`);
  ok(before.totalDecisions === 0, "no decisions logged yet");

  // aaaaaaaa: diff opened, checks run, independent reviewer dispatched - THEN stamped.
  await app.eval(`(() => {
    const row = { title: "Full pass", taskId: "aaaaaaaa" };
    const res = { commits: [{ sha: "abc", subject: "x" }], text: "diff --git a/x b/x\\nindex 1..2 100644\\n--- a/x\\n+++ b/x\\n@@ -1,1 +1,1 @@\\n-a\\n+b", source: "record", truncated: false };
    openDiffViewer(row, res);
  })()`);
  const checksRes = await app.eval(`window.helm.runReviewChecks("aaaaaaaa")`);
  ok(checksRes.ok, `reviews:runChecks succeeded on aaaaaaaa (${JSON.stringify(checksRes.error || "")})`);
  // Dispatch tracking is on the renderer side (openIndependentReview's confirm
  // callback) - call trackUsage directly with the same shape, since actually
  // spawning a real claude process would spend tokens in a fast-lane-adjacent test.
  await app.eval(`window.helm.trackUsage({ type: "action", action: "review_independent_dispatched", taskId: "aaaaaaaa", model: "claude-opus-4-8", effort: "high" })`);
  const stampA = await app.eval(`window.helm.setReviewStatus("aaaaaaaa", "done")`);
  ok(stampA.ok, "aaaaaaaa stamped done");

  // bbbbbbbb: nothing but a bare send-back.
  const backB = await app.eval(`window.helm.setReviewStatus("bbbbbbbb", "in-progress", "needs work")`);
  ok(backB.ok, "bbbbbbbb sent back");

  const after = await app.eval(`window.helm.getReviewActionSummary()`);
  ok(after.totalDecisions === 2, `two decisions total (${after.totalDecisions})`);
  ok(after.stamped === 1 && after.sentBack === 1, `one stamped, one sent back (${after.stamped}/${after.sentBack})`);
  ok(after.diffOpenedCount === 1, `exactly one decision was preceded by a diff-open - aaaaaaaa, not bbbbbbbb (${after.diffOpenedCount})`);
  ok(after.checksRunCount === 1, `exactly one decision was preceded by a checks-run (${after.checksRunCount})`);
  ok(after.independentCount === 1, `exactly one decision was preceded by an independent-reviewer dispatch (${after.independentCount})`);
  ok(after.independentTotal === 1, `one independent dispatch total (${after.independentTotal})`);
  ok(
    after.independentByModel.length === 1 && after.independentByModel[0].label === "claude-opus-4-8 · high" && after.independentByModel[0].count === 1,
    `the model breakdown names the exact model+effort chosen (${JSON.stringify(after.independentByModel)})`
  );

  // An action logged AFTER a decision must not count as "before it" - open a diff
  // for bbbbbbbb now, well after its send-back, and the join must not retroactively
  // credit it.
  await app.eval(`(() => {
    const row = { title: "Bare send-back", taskId: "bbbbbbbb" };
    const res = { commits: [{ sha: "def", subject: "y" }], text: "diff --git a/y b/y\\nindex 1..2 100644\\n--- a/y\\n+++ b/y\\n@@ -1,1 +1,1 @@\\n-a\\n+b", source: "record", truncated: false };
    openDiffViewer(row, res);
  })()`);
  const afterLateOpen = await app.eval(`window.helm.getReviewActionSummary()`);
  ok(afterLateOpen.diffOpenedCount === 1, `a diff opened AFTER the decision does not retroactively count (still ${afterLateOpen.diffOpenedCount})`);

  // The Analysis page shows the fractions and the model breakdown, not just the log.
  const view = await app.eval(`(async () => {
    navigateToPage("analysis");
    await renderAnalysisPage();
    const block = [...document.querySelectorAll(".analysis-block")].find((b) => b.querySelector("h3")?.textContent === "Review analytics");
    return block ? block.innerText : null;
  })()`);
  ok(!!view, "the Review analytics block renders");
  ok(!!view && /Stamped it done\s*\n?\s*1\/2/.test(view), `stamped shows as a fraction of total decisions (${JSON.stringify(view)})`);
  ok(!!view && /Sent it back with feedback\s*\n?\s*1\/2/.test(view), "sent-back shows as a fraction too");
  ok(!!view && /Opened the diff first\s*\n?\s*1\/2/.test(view), "diff-opened-first is 1/2, not 2/2 - the late open on bbbbbbbb must not inflate it");
  ok(!!view && /Ran the checks first\s*\n?\s*1\/2/.test(view), "checks-run-first is 1/2");
  ok(!!view && /Sent an independent reviewer first\s*\n?\s*1\/2/.test(view), "independent-reviewer-first is 1/2");
  ok(!!view && view.includes("claude-opus-4-8") && view.includes("high"), `the model breakdown names the model and effort on screen (${JSON.stringify(view)})`);
  ok(!view.includes("Total in review") && !view.includes("critical"), "the old board-state tally/criticality bars are gone - this is analytics only now");

  const consoleErrors = app.getConsoleErrors();
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
} catch (err) {
  ok(false, `unexpected failure: ${err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: review actions join correctly by taskId and timing, and Analysis shows exact fractions plus the independent-reviewer model breakdown."
    : "VERIFY FAILED."
);
process.exit(exit);
