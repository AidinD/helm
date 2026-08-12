// Commit-centric review (task: "få alla commits att hamna i review oavsett projekt").
// A project Helm knows about surfaces its commits that AREN'T tied to a Jot task, so work
// done without a Jot board still gets reviewed. Bound commits (sha in a review record's
// commits, OR a task short id in the subject) roll up under their task and are excluded.
//
// Drives the REAL reviews:list / reviews:acknowledgeCommit IPC against a temp git repo -
// no model tokens, just git + the payload. Verifies: the unbound commit shows, both binding
// paths exclude their commits, the row renders, and acknowledging advances the watermark so
// it drops off.
//
// Run:  node scripts/e2e/test-review-unbound-commits.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { launch } from "./harness.mjs";
import { writeReviewRecord } from "../../src/lib/reviewRecords.js";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const stamp = String(Date.now());
const tmp = path.join(os.tmpdir(), "helm-unbound-" + stamp);
const metaHome = path.join(tmp, "meta-home");
const scratch = path.join(tmp, "scratch");
const jotDir = path.join(tmp, "jot");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(jotDir, { recursive: true });

const git = (args) => execSync(`git ${args}`, { cwd: scratch, encoding: "utf8" });
const head = () => execSync("git rev-parse HEAD", { cwd: scratch, encoding: "utf8" }).trim();

git("init");
git('config user.email "e2e@test.local"');
git('config user.name "E2E"');
const commit = (file, content, msg) => {
  fs.writeFileSync(path.join(scratch, file), content);
  git("add -A");
  execSync(`git commit -m "${msg}"`, { cwd: scratch });
  return head();
};

const TASK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; // short id "aaaaaaaa"
const c0 = commit("README.md", "# scratch\n", "Initial commit");
const c1 = commit("a.txt", "a\n", "Work bound by a review record");
const c2 = commit("b.txt", "b\n", "Genuinely unbound work");
const c3 = commit("c.txt", "c\n", "Wire the thing for task aaaaaaaa");
void c0;

// A Jot board with the review task whose short id (aaaaaaaa) c3's subject names.
fs.writeFileSync(
  path.join(jotDir, "todos.json"),
  JSON.stringify({
    categories: [{ id: "cat1", name: "Helm", repoPath: scratch }],
    todos: [{ id: TASK, text: "A recorded task", status: "review", categoryId: "cat1", createdAt: 1, updatedAt: 1 }],
  }),
  "utf8"
);

// A review record for TASK: makes `scratch` a KNOWN project (records source) AND binds c1
// via its commits array.
const recWrite = writeReviewRecord(metaHome, {
  taskId: TASK,
  projectPath: scratch,
  criticality: "core",
  verdict: "stamp",
  commits: [c1],
  summary: "A recorded task binding one commit.",
  testSteps: [{ step: "x", expect: "y" }],
  // A core record needs at least one declared check, or writeReviewRecord rejects it (and
  // then the record-sha binding below would silently never apply).
  checks: [{ label: "noop", cmd: "true" }],
  evidence: ["e"],
  notVerified: ["n"],
});
if (!recWrite?.ok) {
  console.error("could not write the binding record:", recWrite?.error);
  process.exit(1);
}

process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.JOT_DATA_DIR = jotDir;
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "history.json");
// Isolate the session index (it's outside the meta-home) to an empty path, so the scan sees
// ONLY this test's scratch repo - not the machine's real repos, which made the set of
// surfaced projects non-deterministic across machines and slow (ship-review finding).
process.env.HELM_SESSIONS_ROOT = path.join(tmp, "no-sessions");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9584";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`window.helm.listReviews()`);
  const group = (res.unboundCommits || []).find((g) => g.projectName === "scratch");
  ok(!!group, `the known project surfaces an unbound-commits group (${JSON.stringify((res.unboundCommits || []).map((g) => g.projectName))})`);
  const subjects = (group?.commits || []).map((c) => c.subject);
  ok(subjects.includes("Genuinely unbound work"), `the unbound commit is listed (${JSON.stringify(subjects)})`);
  ok(!subjects.includes("Work bound by a review record"), "a commit whose sha is in a record's commits is EXCLUDED (bound)");
  ok(!subjects.includes("Wire the thing for task aaaaaaaa"), "a commit whose subject names a task short id is EXCLUDED (bound)");
  const c2row = (group?.commits || []).find((c) => c.subject === "Genuinely unbound work");
  ok(c2row && c2row.shortSha === c2.slice(0, 8) && c2.startsWith(c2row.shortSha), "the unbound row carries the right short + full sha");

  // The page renders a "Commits without a task" section with the unbound subject in it.
  const rendered = await app.eval(`(async () => {
    navigateToPage("review");
    let txt = "";
    for (let i = 0; i < 50; i++) {
      const page = document.querySelector("#reviewPage") || document.querySelector(".analysis-page:not(.hidden)") || document.body;
      txt = page ? page.textContent : "";
      if (/Commits without a task/.test(txt) && /Genuinely unbound work/.test(txt)) { break; }
      await new Promise((r) => setTimeout(r, 60));
    }
    const hasNoTaskChip = [...document.querySelectorAll(".unbound-commit .rev-chip")].some((c) => /no task/.test(c.textContent));
    return { hasHeading: /Commits without a task/.test(txt), hasSubject: /Genuinely unbound work/.test(txt), hasNoTaskChip };
  })()`);
  ok(rendered.hasHeading, "the review page renders a 'Commits without a task' section");
  ok(rendered.hasSubject, "with the unbound commit's subject");
  ok(rendered.hasNoTaskChip, "and a 'no task' chip on the row");

  // The row is EXPANDABLE, and what its body holds changed on 2026-08-12: the diff is no
  // longer poured into the card ("Diffen bör aldrig läggas direkt i kortet ... jag är sällan
  // intresserad av diffen på det sättet"). It now sits behind a See diff button that opens
  // the same viewer a task's card uses. So the body must carry the four actions and NOT a
  // diff block. The group header offers "Seen all" (2 unbound commits: Initial + Genuinely).
  const expanded = await app.eval(`(async () => {
    navigateToPage("review");
    await new Promise((r) => setTimeout(r, 200));
    const rows = [...document.querySelectorAll(".unbound-commit")];
    const row = rows.find((el) => /Genuinely unbound work/.test(el.textContent));
    if (!row) { return { found: false }; }
    row.querySelector(".rev-head").click();
    let labels = [];
    for (let i = 0; i < 60; i++) {
      labels = [...row.querySelectorAll(".rev-commit-footer button")].map((b) => b.textContent);
      if (labels.length >= 4) { break; }
      await new Promise((r) => setTimeout(r, 80));
    }
    return {
      found: true,
      notHidden: !row.querySelector(".rev-body").hidden,
      labels,
      hasFooter: !!row.querySelector(".rev-commit-footer"),
      inlineDiffBlocks: row.querySelectorAll(".rev-body .diff-file-block").length,
      hasSeenAll: [...document.querySelectorAll(".rev-group-action")].some((b) => /Seen all/.test(b.textContent)),
    };
  })()`);
  ok(expanded.found && expanded.notHidden, "clicking an unbound-commit row expands its body");
  ok(expanded.hasFooter, "the body has an action footer");
  ok(
    ["Present review", "Independent reviewer", "See diff", "Seen"].every((l) => expanded.labels.includes(l)),
    `the footer carries every action: ${JSON.stringify(expanded.labels)}`
  );
  ok(
    expanded.inlineDiffBlocks === 0,
    `and the diff is NOT poured into the card (${expanded.inlineDiffBlocks} inline blocks) - it belongs behind See diff, in the viewer`
  );
  ok(expanded.hasSeenAll, "the group header offers a 'Seen all' button");

  // Acknowledge the unbound commit: it advances the watermark past it, so it drops off.
  const ackRes = await app.eval(`window.helm.acknowledgeCommit(${JSON.stringify(scratch)}, ${JSON.stringify(c2)})`);
  ok(ackRes?.ok === true, `acknowledgeCommit succeeded (${JSON.stringify(ackRes?.error || "")})`);
  const res2 = await app.eval(`window.helm.listReviews()`);
  const group2 = (res2.unboundCommits || []).find((g) => g.projectName === "scratch");
  const subjects2 = (group2?.commits || []).map((c) => c.subject);
  ok(!subjects2.includes("Genuinely unbound work"), `after acknowledging, the commit drops off (${JSON.stringify(subjects2)})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 6)) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try { execSync("git worktree prune", { cwd: scratch }); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.JOT_DATA_DIR;
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  delete process.env.HELM_SESSIONS_ROOT;
}

console.log(
  exit === 0
    ? "VERIFY OK: commits with no Jot task surface in review per project, both binding paths exclude their commits, and acknowledging advances the watermark."
    : "VERIFY FAILED."
);
process.exit(exit);
