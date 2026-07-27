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
  const { staleProjects } = await import("../../src/lib/docsStaleness.js");
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

  // The IPC, on the real board: shape + the cache.
  const board = await app.eval(`window.helm.staleProjects()`);
  assert(board?.ok === true && Array.isArray(board.rows), `docs:staleProjects returns rows (${board?.rows?.length} stale project(s) on the real board)`);
  const wellFormed = (board.rows || []).every(
    (r) => typeof r.path === "string" && typeof r.name === "string" && typeof r.commitsSince === "number" && r.commitsSince >= r.threshold
  );
  assert(wellFormed, "every row is well-formed and actually past the threshold");
  const cached = await app.eval(`window.helm.staleProjects()`);
  assert(cached?.cached === true, "a second call inside the TTL is served from cache (two git calls per repo is not free)");
  const forced = await app.eval(`window.helm.staleProjects({ force: true })`);
  assert(forced?.cached === false, "force bypasses the cache");

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
      jumps: host.querySelectorAll(".wd-drift-jump").length
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

  // The CLASSIC dashboard section. This is the board that actually matters: the
  // widget dashboard is opt-in and currently off, so a widget-only nudge would be
  // invisible on the board in use - an attention signal that never fires is worse
  // than none, because you come to trust the quiet.
  const section = await app.eval(`(async () => {
    const stub = async () => ({ ok: true, rows: [
      { path: "D:/Repo/Tools/fake-a", name: "fake-a", commitsSince: 40, threshold: 8, sessionId: null }
    ] });
    const sec = await dashboardDriftSection(stub);
    const clean = await dashboardDriftSection(async () => ({ ok: true, rows: [] }));
    const broke = await dashboardDriftSection(async () => { throw new Error("boom"); });
    return {
      rendered: !!sec,
      cls: sec?.className,
      lines: sec ? sec.querySelectorAll(".wd-drift-line").length : 0,
      hasFingerprint: typeof sec?.dataset?.fp === "string" && sec.dataset.fp.length > 0,
      cleanIsNull: clean === null,
      brokeIsNull: broke === null
    };
  })()`);
  assert(section.rendered === true && section.lines === 1, `the classic dashboard renders a drift section (${section.lines} line(s))`);
  assert(section.cls === "dash-board", `it reuses the existing dashboard module shell, not a new visual language (got "${section.cls}")`);
  assert(section.hasFingerprint === true, "it carries a fingerprint, so the poll tick doesn't rebuild it every second");
  assert(section.cleanIsNull === true, "no drift means no section at all on the classic board - it stays quiet rather than showing an empty module");
  assert(section.brokeIsNull === true, "a failed read cannot break the dashboard");

  // And it is present on the real board, in the slot the refresh writes to.
  const live = await app.eval(`(() => {
    const slot = document.getElementById("dashDriftSlot");
    return { slotExists: !!slot, sectionRendered: !!slot?.querySelector(".dash-board") };
  })()`);
  assert(live.slotExists === true, "the classic dashboard has a slot for it");
  log(`     (real board: drift section ${live.sectionRendered ? "IS" : "is not"} showing - depends on whether this machine has drift right now)`);

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
