// Task 860b4661 came back "kan inte se versionen". This is the live proof the feature
// actually renders: a review record pinned to a REAL released commit (9de4b66, which is in
// tag v0.1.624 of this very repo) must show a "shipped in vX" chip on the review ROW head -
// visible without expanding. It drives the real reviews:shippedVersion IPC end to end
// (record on disk -> resolveTaskCommits -> git tag --contains) against the real helm repo,
// then renders the actual reviewRowEl and reads the chip out of the collapsed head.
//
// (An older running build has no such IPC at all, which is the real reason it wasn't
// visible before this ships - flagged to the captain, not something a test can fix.)
//
// Run:  node scripts/e2e/test-review-shipped-version-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeReviewRecord } from "../../src/lib/reviewRecords.js";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const HELM_REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
// A commit that IS in a released tag of this repo (the send-back-images fix, released in
// v0.1.624). If the repo's history is ever rewritten this test will say so loudly rather
// than pass vacuously.
const RELEASED_COMMIT = "9de4b66";
const TASK = "ffffffff-0000-4000-8000-00000000860b";

let expectedTag = null;
try {
  const out = execFileSync("git", ["-C", HELM_REPO, "tag", "--contains", RELEASED_COMMIT, "--sort=v:refname"], { encoding: "utf8" });
  expectedTag = out.split(/\r?\n/).map((l) => l.trim()).find((t) => /^v\d/.test(t)) || null;
} catch {
  expectedTag = null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-shipver-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9574";

// A well-formed record pinned to the released commit, in the override meta-home the IPC reads.
const seedWrite = writeReviewRecord(metaHome, {
  taskId: TASK,
  projectPath: HELM_REPO,
  criticality: "core",
  // A core record is refused without the ask it was written against (task 10928bdf).
  intent: { text: "Show on the row which release a reviewed fix went out in.", source: "captain" },
  verdict: "stamp",
  commits: [RELEASED_COMMIT],
  summary: "A fix whose commit is in a released tag, for the shipped-version chip.",
  testSteps: [{ step: "open the row", expect: "a shipped-in chip on the head" }],
  checks: [{ label: "n/a", cmd: "true" }],
  evidence: ["released commit"],
  notVerified: ["nothing"],
});
// Assert the SEED, not just use it. Every check below reads this record back through the
// app, so a refused write turns them all into confident nonsense about a missing row -
// which is exactly how this file reported four failures about the version chip when the
// real cause was one missing field (2026-08-21).
if (!seedWrite.ok) {
  console.log(`FAIL - the seed record wrote (${seedWrite.error}) - every check below depends on it`);
  process.exit(1);
}

const { launch } = await import("./harness.mjs");

try {
  ok(!!expectedTag, `sanity: git says ${RELEASED_COMMIT} is in a released tag (${expectedTag || "NONE - history changed?"})`);

  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The IPC directly: the released commit resolves to its earliest containing tag.
  const ipc = await app.eval(`window.helm.getShippedVersion(${JSON.stringify(TASK)})`);
  ok(ipc && ipc.version === expectedTag, `the IPC resolves the released version (${JSON.stringify(ipc)}, expected ${expectedTag})`);

  // The actual row renders the chip on its COLLAPSED head (visible without expanding).
  const rendered = await app.eval(`(async () => {
    const rec = { taskId: ${JSON.stringify(TASK)}, projectPath: ${JSON.stringify(HELM_REPO)}, commits: [${JSON.stringify(RELEASED_COMMIT)}], verdict: "stamp", criticality: "core", summary: "s", testSteps: [], evidence: [], notVerified: [] };
    const row = { taskId: ${JSON.stringify(TASK)}, title: "A released fix", category: "Helm", verdict: "stamp", record: rec, gauntlet: { declared: 0, state: "none" } };
    const el = reviewRowEl(row, "stamp");
    document.body.append(el);
    let headText = "";
    for (let i = 0; i < 40; i++) {
      const head = el.querySelector(".rev-head");
      headText = head ? head.textContent : "";
      if (/shipped in v/.test(headText)) { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    const chip = [...el.querySelectorAll(".rev-head .rev-chip")].find((c) => /shipped in v/.test(c.textContent));
    const out = { headText, chipText: chip ? chip.textContent : null, chipVisible: chip ? !chip.hidden : false };
    el.remove();
    return out;
  })()`);
  ok(/shipped in v/.test(rendered.headText), `the row head shows a shipped-in version without expanding (${JSON.stringify(rendered.chipText)})`);
  ok(rendered.chipText === `shipped in ${expectedTag}`, `and names the right version (${JSON.stringify(rendered.chipText)}, expected "shipped in ${expectedTag}")`);
  ok(rendered.chipVisible, "the chip is revealed, not left hidden");

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: a fix pinned to a released commit shows its version on the review row head, live through the real IPC."
    : "VERIFY FAILED."
);
process.exit(exit);
