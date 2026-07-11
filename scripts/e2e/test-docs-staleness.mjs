// E2E (real launched Helm via CDP) + real git temp repos: the docs-staleness
// coach nudge, end to end (docsStaleness lib -> docs:staleness IPC -> preload ->
// pane-header pill). A project whose PLAN.md/DECISIONS.md are many commits
// behind gets a "docs N behind" pill; a freshly-reconciled one gets none;
// uncommitted doc edits count as not-stale.
//
// Run:  node scripts/e2e/test-docs-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[docs-staleness-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a temp git repo with PLAN.md, then `extraCommits` commits that DON'T
// touch it (so PLAN.md is that many commits behind).
function makeRepo(extraCommits) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-docs-stale-"));
  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["init", "-b", "main", repo], { windowsHide: true });
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "T");
  g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "PLAN.md"), "# Plan\n");
  g("add", "-A");
  g("commit", "-m", "add PLAN.md");
  for (let i = 0; i < extraCommits; i++) {
    fs.writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`);
    g("add", "-A");
    g("commit", "-m", `work ${i}`);
  }
  return repo;
}

const staleRepo = makeRepo(10); // 10 > threshold (8)
const freshRepo = makeRepo(0); // PLAN.md committed just now
const app = await launch();

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(700);

  const jsonPath = (p) => JSON.stringify(p.replace(/\\/g, "/"));

  // --- IPC round-trip (lib + IPC + preload) ----------------------------------
  const stale = await app.eval(`window.helm.docsStaleness(${jsonPath(staleRepo)})`);
  assert(stale && stale.ok && stale.hasDocs, "stale repo: IPC returns ok + hasDocs");
  assert(stale.stale === true && stale.commitsSince >= 8, `stale repo: flagged stale (commitsSince ${stale?.commitsSince}, threshold ${stale?.threshold})`);

  const fresh = await app.eval(`window.helm.docsStaleness(${jsonPath(freshRepo)})`);
  assert(fresh && fresh.ok && fresh.stale === false, `fresh repo: not stale (commitsSince ${fresh?.commitsSince})`);

  // Uncommitted edit to PLAN.md in the stale repo => not stale (being reconciled).
  fs.appendFileSync(path.join(staleRepo, "PLAN.md"), "\nreconciling\n");
  const dirty = await app.eval(`window.helm.docsStaleness(${jsonPath(staleRepo)})`);
  assert(dirty && dirty.stale === false, "uncommitted PLAN.md edit counts as NOT stale (actively reconciling)");
  // revert the edit so the last render check sees it stale again
  execFileSync("git", ["-C", staleRepo, "checkout", "--", "PLAN.md"], { windowsHide: true });

  // --- Renderer pill (maybeShowDocsStaleness appends the header pill) ---------
  const pill = await app.eval(`(async () => {
    const h = document.createElement("div");
    await maybeShowDocsStaleness(h, ${jsonPath(staleRepo)});
    const el = h.querySelector(".docs-stale-pill");
    return el ? el.textContent : null;
  })()`);
  assert(!!pill && /docs \d+ behind/.test(pill), `stale repo renders the header pill (got "${pill}")`);

  const noPill = await app.eval(`(async () => {
    const h = document.createElement("div");
    await maybeShowDocsStaleness(h, ${jsonPath(freshRepo)});
    return !!h.querySelector(".docs-stale-pill");
  })()`);
  assert(noPill === false, "fresh repo renders no pill");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: docs-staleness nudge works end to end." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.close();
  for (const r of [staleRepo, freshRepo]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
process.exit(exitCode);
