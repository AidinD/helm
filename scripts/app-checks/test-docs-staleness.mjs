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
import { launch } from "../checks-lib/harness.mjs";

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
const midRepo = makeRepo(20); // far past the threshold, so ordering is checkable
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

  // --- the ACTIVE nudge: board-wide drift (task 0831417b) --------------------
  // The pure function, against the same real git repos. Tested directly because
  // the IPC derives its candidate list from real session cwds, which no temp repo
  // can appear in - so the list-building and the rendering are checked at their
  // own layers rather than being assumed from one end-to-end call.
  const { staleProjects, staleProjectsAsync, docsStalenessAsync } = await import("../../src/lib/docsStaleness.js");
  const rows = staleProjects([staleRepo, freshRepo, midRepo]);
  assert(rows.length === 2, `only the stale repos are returned (${rows.length} of 3)`);
  assert(rows[0].commitsSince >= rows[1].commitsSince, `worst drift first (${rows.map((r) => r.commitsSince).join(" > ")})`);
  assert(!rows.some((r) => path.resolve(r.path) === path.resolve(freshRepo)), "the fresh repo is not listed");
  // Windows hands the same repo back in both slash directions across sessions;
  // listing one project twice would read as two projects drifting.
  const dupes = staleProjects([staleRepo, staleRepo.replace(/\\/g, "/"), staleRepo.toUpperCase()]);
  assert(dupes.length === 1, `the same repo in three path spellings is one row (${dupes.length})`);
  assert(staleProjects([staleRepo, midRepo], { limit: 1 }).length === 1, "limit caps the list");
  assert(staleProjects([null, undefined, "", "Z:/definitely/not/here"]).length === 0, "junk and missing paths are dropped, not thrown on");
  assert(staleProjects([]).length === 0 && staleProjects(null).length === 0, "an empty or missing list is an empty result");

  // The ASYNC sweep - the one the nudge actually uses, because the sync version
  // blocks the Electron main thread. This is the review finding that mattered most:
  // four git spawns per repo, on the main thread, once a minute, unbounded in
  // project count - stalling every window's IPC, not just the dashboard.
  const asyncRes = await staleProjectsAsync([staleRepo, freshRepo, midRepo]);
  assert(asyncRes.rows.length === 2, `the async sweep finds the same stale repos (${asyncRes.rows.length})`);
  assert(asyncRes.rows[0].commitsSince >= asyncRes.rows[1].commitsSince, "worst drift first");
  assert(asyncRes.considered === 3 && asyncRes.unchecked === 0, `it reports what it considered and what it couldn't check (${asyncRes.unchecked}/${asyncRes.considered})`);
  // A folder with NO VERSION CONTROL is a complete answer, not a failed look.
  //
  // This assertion used to say the opposite, and the captain's review on 2026-07-28 is
  // why it changed: his notes folder has PLAN/DECISIONS but no git, so it sat in
  // the "couldn't be checked" counter looking like an unresolved problem forever.
  // Drift is measured in commits. A folder with no commits cannot be behind any.
  // The distinction that MUST survive is git-missing/unreadable (still unchecked)
  // versus not-a-repo (checked, nothing to report) - asserted both ways below.
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-notrepo-"));
  fs.writeFileSync(path.join(notARepo, "PLAN.md"), "# plan\n");
  const mixed = await staleProjectsAsync([staleRepo, notARepo]);
  assert(mixed.unchecked === 0, `a folder with docs but no version control is NOT reported as unchecked - there is nothing to check (${mixed.unchecked})`);
  assert(mixed.unversioned === 1, `it is counted separately as unversioned, so the fact isn't lost (${mixed.unversioned})`);
  assert(mixed.uncheckedPaths.length === 0, "and it contributes no 'couldn't read' row");
  const single = await docsStalenessAsync(notARepo);
  assert(single.checked === true && single.versioned === false, `the single-project read says the same: checked, unversioned (${JSON.stringify({ checked: single.checked, versioned: single.versioned })})`);
  assert(single.stale === false, "and never stale");
  // A directory with no docs at all IS a real answer ("nothing to be stale about").
  const noDocs = fs.mkdtempSync(path.join(os.tmpdir(), "helm-nodocs-"));
  const noDocsRes = await staleProjectsAsync([noDocs]);
  assert(noDocsRes.unchecked === 0, "a project with no PLAN/DECISIONS is a real answer, not a failed check");
  // And it must not block the event loop - the whole point of the async twin.
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  await staleProjectsAsync([staleRepo, freshRepo, midRepo]);
  clearInterval(iv);
  assert(ticks > 0, `the async sweep leaves the event loop running (${ticks} ticks) - the sync one blocks it completely`);
  fs.rmSync(notARepo, { recursive: true, force: true });
  fs.rmSync(noDocs, { recursive: true, force: true });

  // An uncommitted doc edit means "reconciling right now" only if it is RECENT.
  // An edit abandoned months ago would otherwise silence that project forever,
  // which for the only board-level signal is a permanent blind spot.
  fs.appendFileSync(path.join(midRepo, "PLAN.md"), "\nabandoned edit\n");
  const oldMs = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.utimesSync(path.join(midRepo, "PLAN.md"), oldMs / 1000, oldMs / 1000);
  const withAbandoned = await staleProjectsAsync([midRepo]);
  assert(withAbandoned.rows.length === 1, "a doc edit left uncommitted for weeks does NOT silence the project");
  const nowMs = Date.now();
  fs.utimesSync(path.join(midRepo, "PLAN.md"), nowMs / 1000, nowMs / 1000);
  const withFresh = await staleProjectsAsync([midRepo]);
  assert(withFresh.rows.length === 0, "a doc edit you just made DOES silence it - you're reconciling right now");
  execFileSync("git", ["-C", midRepo, "checkout", "--", "PLAN.md"], { windowsHide: true });

  // The IPC, on the real board: shape + the cache.
  const board = await app.eval(`window.helm.staleProjects()`);
  assert(board?.ok === true && Array.isArray(board.rows), `docs:staleProjects returns rows (${board?.rows?.length} stale project(s) on the real board)`);
  const wellFormed = (board.rows || []).every(
    (r) => typeof r.path === "string" && typeof r.name === "string" && typeof r.commitsSince === "number" && r.commitsSince >= r.threshold
  );
  assert(wellFormed, "every row is well-formed and actually past the threshold");
  const cached = await app.eval(`window.helm.staleProjects()`);
  assert(cached?.cached === true, "a second call inside the TTL is served from cache (four git calls per repo is not free)");
  const forced = await app.eval(`window.helm.staleProjects({ force: true })`);
  assert(forced?.cached === false, "force bypasses the cache");
  // The handler must return promptly even when the cache has expired: it serves the
  // last-known rows and refreshes in the BACKGROUND. A blocking handler is what
  // stalled every window's IPC for ~1.1s a minute in the first cut.
  const t0 = Date.now();
  await app.eval(`window.helm.staleProjects()`);
  const servedMs = Date.now() - t0;
  assert(servedMs < 400, `a cached read returns promptly (${servedMs}ms)`);

  // The widget body, given known data - so the populated path is deterministic
  // rather than depending on whether this machine happens to have drift today.
  const widget = await app.eval(`(async () => {
    const stub = async () => ({ ok: true, rows: [
      { path: "D:/Repo/Tools/fake-a", name: "fake-a", commitsSince: 40, threshold: 8, sessionId: null },
      { path: "D:/Repo/Tools/fake-b", name: "fake-b", commitsSince: 9, threshold: 8, sessionId: "no-such-session" }
    ] });
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, stub));
    return {
      lines: host.querySelectorAll(".wd-drift-line").length,
      names: [...host.querySelectorAll(".wd-drift-name")].map(e => e.textContent),
      counts: [...host.querySelectorAll(".wd-drift-count")].map(e => e.textContent),
      crit: host.querySelectorAll(".wd-drift-count.crit").length,
      // Count only the "Jump in" buttons: the "Reconcile" button reuses the same
      // .wd-drift-jump class, so a bare class count sees both (task 0831417b added
      // Reconcile after this assertion was written).
      jumps: [...host.querySelectorAll(".wd-drift-jump")].filter((b) => b.textContent === "Jump in").length
    };
  })()`);
  assert(widget.lines === 2, `the widget renders one line per drifting project (${widget.lines})`);
  assert(JSON.stringify(widget.counts) === JSON.stringify(["40 behind", "9 behind"]), `each shows how far behind (${JSON.stringify(widget.counts)})`);
  assert(widget.crit === 1, "drift far past the threshold is visually escalated, mild drift is not");
  assert(widget.jumps === 1, `Jump in appears only where there is a session to jump into (${widget.jumps})`);

  // No drift must read as reassurance, not as an empty module.
  const clean = await app.eval(`(async () => {
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, async () => ({ ok: true, rows: [] })));
    return host.textContent;
  })()`);
  assert(/current/i.test(clean), `no drift reads as good news (got "${clean}")`);

  // A failing IPC must not render an empty "all clear" - that would be a nudge
  // silently claiming everything is fine when it simply could not look.
  const broken = await app.eval(`(async () => {
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, async () => { throw new Error("boom"); }));
    const failedIpc = document.createElement("div");
    failedIpc.append(await widgetBodyDocsDrift(null, null, async () => ({ ok: false, error: "git missing" })));
    return { thrown: host.textContent, failed: failedIpc.textContent };
  })()`);
  assert(/couldn't/i.test(broken.thrown) && !/current/i.test(broken.thrown), `a thrown read says so instead of claiming all clear (got "${broken.thrown}")`);
  assert(/couldn't/i.test(broken.failed) && /git missing/.test(broken.failed), `an ok:false result surfaces its reason (got "${broken.failed}")`);

  // The widget's own not-yet-known and partially-checked states.
  const widgetStates = await app.eval(`(async () => {
    const one = document.createElement("div");
    one.append(await widgetBodyDocsDrift(null, null, async () => ({ ok: true, rows: [], pending: true })));
    const two = document.createElement("div");
    two.append(await widgetBodyDocsDrift(null, null, async () => ({ ok: true, rows: [], unchecked: 2, considered: 5 })));
    return { pending: one.textContent, partial: two.textContent };
  })()`);
  assert(/checking/i.test(widgetStates.pending), `before the first sweep the widget says it is checking, not "current" (got "${widgetStates.pending}")`);
  assert(/2 of 5/.test(widgetStates.partial) && !/are current/i.test(widgetStates.partial), `a partial sweep is reported as unknown, never folded into the all-clear (got "${widgetStates.partial}")`);

  // Jump in must actually LAND you somewhere. The first cut called
  // openSessionInPane without navigating first, and openSessionInPane writes into
  // the hidden #chatPage and focuses a hidden composer - so from the Dashboard the
  // one interactive affordance of the whole feature did nothing visible. The
  // previous version of this test only COUNTED the buttons, never clicked one.
  const jump = await app.eval(`(async () => {
    const res = await window.helm.getSessions();
    const target = (res?.sessions || []).find(s => s.sessionId && s.status !== "archived");
    if (!target) { return { skipped: true }; }
    await navigateToPage("dashboard");
    const host = document.createElement("div");
    document.body.append(host);
    host.append(driftLineEl({ path: target.cwd || "x", name: "jump-test", commitsSince: 99, threshold: 8, sessionId: target.sessionId }));
    const vis = () => ({ chat: !document.getElementById("chatPage").classList.contains("hidden"), dash: !document.getElementById("dashboardPage").classList.contains("hidden") });
    const before = vis();
    // Click the "Jump in" button specifically - "Reconcile" shares .wd-drift-jump
    // and is rendered first, so a bare querySelector would click the wrong one.
    [...host.querySelectorAll(".wd-drift-jump")].find((b) => b.textContent === "Jump in").click();
    await new Promise(r => setTimeout(r, 700));
    const after = vis();
    host.remove();
    return { skipped: false, before: JSON.stringify(before), after: JSON.stringify(after), chatVisible: after.chat && !after.dash, opened: selectedSessionId === target.sessionId };
  })()`);
  if (jump.skipped) {
    log("     SKIP - no session on this machine to test Jump in against");
  } else {
    assert(jump.chatVisible === true, `Jump in navigates to chat, not just swaps a hidden pane (visible before: ${jump.before}, after: ${jump.after})`);
    assert(jump.opened === true, "and the target session is the one selected");
  }

  // NOTE: the classic dashboard drift SECTION (dashboardDriftSection, rendered
  // into #dashDriftSlot) was removed with the classic section stack when the
  // widget grid became the only dashboard (task 337895ce). Its behaviour -
  // clean/pending render nothing, thrown/failed/partial reads say so instead of
  // claiming all-clear - is the same contract the widget body above (lines ~179-228)
  // is asserted against, so no coverage is lost by dropping the classic block.

  // The one-time seed: it reaches an already-arranged board once, and stays gone
  // once removed (otherwise "remove" would be a suggestion, not a decision).
  const seed = await app.eval(`(async () => {
    const realCfg = state.config;
    const writes = [];
    const save = async (patch) => { writes.push(patch); return { ok: true }; };
    try {
      state.config = { dashboardWidgets: { layout: [{ id: "w-quota", type: "quota", span: 4 }] } };
      await seedNewWidgets(save);
      const first = state.config.dashboardWidgets;
      // second run on the now-seeded config
      await seedNewWidgets(save);
      const second = state.config.dashboardWidgets;
      // and after the user removes it
      state.config = { dashboardWidgets: { layout: [{ id: "w-quota", type: "quota", span: 4 }], seeded: { docsDrift: true } } };
      await seedNewWidgets(save);
      const afterRemoval = state.config.dashboardWidgets;
      // a board with NO saved layout must not be touched at all - the default
      // already contains every widget.
      state.config = { dashboardWidgets: {} };
      await seedNewWidgets(save);
      const untouchedDefault = state.config.dashboardWidgets;
      return {
        defaultUntouched: !untouchedDefault.layout,
        added: first.layout.filter(w => w.type === "docsDrift").length,
        flagged: first.seeded?.docsDrift === true,
        afterSecond: second.layout.filter(w => w.type === "docsDrift").length,
        cameBack: afterRemoval.layout.some(w => w.type === "docsDrift"),
        writes: writes.length
      };
    } finally { state.config = realCfg; }
  })()`);
  assert(seed.added === 1 && seed.flagged === true, "a new widget is seeded onto an already-saved layout exactly once, and flagged");
  assert(seed.afterSecond === 1, "running the seed again does not duplicate it");
  assert(seed.cameBack === false, "once you remove it, it stays removed - the seed does not override your decision");
  assert(seed.writes === 1, `only the seeding run writes config (${seed.writes} write(s))`);
  assert(seed.defaultUntouched === true, "a board with no saved layout is left alone - the default already has every widget");

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
  for (const r of [staleRepo, freshRepo, midRepo]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
process.exit(exitCode);
