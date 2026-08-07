// the captain, task 76790f23 follow-up: "jag vill mer veta statistik på hur jag
// hanterar review. Har jag kört testerna? kollar jag på diffen, send back
// etc?" The Review health widget could only describe the board's current
// STATE; this drives the real actions that are supposed to log it -
// reviews:setStatus (the review page's own Done / Send-back buttons) and
// openDiffViewer - and checks the content-free usage log actually recorded
// them, through the same summarizeHelmUsage the Analysis page reads.
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
fs.writeFileSync(
  jotPath,
  JSON.stringify({
    categories: [{ id: "cat1", name: "Test" }],
    tags: [],
    todos: [
      { id: "task-done", text: "Stamp me", status: "review", categoryId: "cat1", description: "", images: [], tags: [], priority: 0 },
      { id: "task-back", text: "Send me back", status: "review", categoryId: "cat1", description: "", images: [], tags: [], priority: 0 },
    ],
  }),
  "utf8"
);
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({ jot: { path: jotPath } }), "utf8");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_USAGE_PATH = path.join(tmp, "helm-usage.jsonl");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9535";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const before = await app.eval(`window.helm.getHelmUsage()`);
  const countOf = (summary, action) => (summary.actions.find((a) => a.action === action)?.count) || 0;
  ok(countOf(before, "review_stamped") === 0, "no stamp action logged yet");
  ok(countOf(before, "review_sent_back") === 0, "no send-back action logged yet");
  ok(countOf(before, "review_diff_opened") === 0, "no diff-opened action logged yet");

  // Done, via the exact IPC the review page's "Done" button calls.
  const doneRes = await app.eval(`window.helm.setReviewStatus("task-done", "done")`);
  ok(doneRes.ok, `setReviewStatus(done) succeeded (${JSON.stringify(doneRes)})`);

  // Send back with feedback, via the exact IPC the "Send back" flow calls.
  const backRes = await app.eval(`window.helm.setReviewStatus("task-back", "in-progress", "needs another pass")`);
  ok(backRes.ok, `setReviewStatus(in-progress) succeeded (${JSON.stringify(backRes)})`);

  // Opening a diff, via the real function the "See diff" click calls - not a
  // fabricated usage:track call, so a change to openDiffViewer's tracking line
  // is what this actually pins.
  await app.eval(`(() => {
    const row = { title: "probe", taskId: "aaaaaaaa" };
    const res = { commits: [{ sha: "abc", subject: "x" }], text: "diff --git a/x b/x\\nindex 1..2 100644\\n--- a/x\\n+++ b/x\\n@@ -1,1 +1,1 @@\\n-a\\n+b", source: "record", truncated: false };
    openDiffViewer(row, res);
  })()`);

  const after = await app.eval(`window.helm.getHelmUsage()`);
  ok(countOf(after, "review_stamped") === 1, `stamping logged exactly one review_stamped action (${countOf(after, "review_stamped")})`);
  ok(countOf(after, "review_sent_back") === 1, `sending back logged exactly one review_sent_back action (${countOf(after, "review_sent_back")})`);
  ok(countOf(after, "review_diff_opened") === 1, `opening the diff logged exactly one review_diff_opened action (${countOf(after, "review_diff_opened")})`);

  // An unsuccessful status change (unknown task) must NOT log a review action -
  // an action that didn't happen is not evidence of anything.
  const failRes = await app.eval(`window.helm.setReviewStatus("does-not-exist", "done")`);
  ok(!failRes.ok, "a status change against a nonexistent task fails, as expected");
  const afterFail = await app.eval(`window.helm.getHelmUsage()`);
  ok(countOf(afterFail, "review_stamped") === 1, "and the failed attempt did not add a second stamp count");

  // The Analysis page actually shows these, not just the log.
  const view = await app.eval(`(async () => {
    navigateToPage("analysis");
    await renderAnalysisPage();
    const block = [...document.querySelectorAll(".analysis-block")].find((b) => b.querySelector("h3")?.textContent === "Review health");
    return block ? block.innerText : null;
  })()`);
  ok(!!view && view.includes("Your review actions"), `the Review health block shows the actions sub-section (${JSON.stringify(view)})`);
  ok(!!view && /Opened a diff\s*\n?\s*1/.test(view), "with the diff-opened count on it");
  ok(!!view && /Sent back with feedback\s*\n?\s*1/.test(view), "and the sent-back count");
  ok(!!view && /Stamped done\s*\n?\s*1/.test(view), "and the stamped count");

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

console.log(exit === 0 ? "VERIFY OK: stamping, sending back, and opening a diff each log exactly one real action, and Analysis shows them." : "VERIFY FAILED.");
process.exit(exit);
