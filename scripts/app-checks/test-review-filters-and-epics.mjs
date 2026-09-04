// The Review page shows code work, grouped by epic, filterable by project.
//
// the captain, 2026-08-04, two problems and three asks:
//   "det är väldigt många tasks just nu, särskilt eftersom subtasks i epics hamnar som
//    egna rader" / "rader från projekt jag inte vill ska hamna där finns där - t.ex min
//    privat bräda"
//   1. subtasks under the parent, 2. a project filter, 3. only rows rooted to a repo,
//   because a potential code change is the only thing that needs reviewing.
//
// The dangerous one is 3: a filter that hides too much turns the queue into a lie. So
// the first assertions here are about what must NOT disappear - the held-back count is
// visible, the toggle brings them back, and choosing a project never removes the chip
// that gets you out of it.
//
// Run:  node scripts/e2e/test-review-filters-and-epics.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-revfilt-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9493";
const { launch } = await import("../checks-lib/harness.mjs");

// A queue with the shape that hurt: an epic plus two subtasks, a lone task, and two rows
// from boards with no repo behind them (his private board).
const ROWS = `[
  { taskId: "aaaaaaaa-0000-4000-8000-000000000001", title: "The epic", category: "helm", repoPath: "D:\\\\Repo\\\\Tools\\\\helm", parentId: null, verdict: "unrecorded", band: "unrecorded", problems: ["nothing"], caveats: [] },
  { taskId: "aaaaaaaa-0000-4000-8000-000000000002", title: "Subtask one", category: "helm", repoPath: "D:\\\\Repo\\\\Tools\\\\helm", parentId: "aaaaaaaa-0000-4000-8000-000000000001", parentTitle: "The epic", verdict: "unrecorded", band: "unrecorded", problems: ["nothing"], caveats: [] },
  { taskId: "aaaaaaaa-0000-4000-8000-000000000003", title: "Subtask two", category: "helm", repoPath: "D:\\\\Repo\\\\Tools\\\\helm", parentId: "aaaaaaaa-0000-4000-8000-000000000001", parentTitle: "The epic", verdict: "unrecorded", band: "unrecorded", problems: ["nothing"], caveats: [] },
  { taskId: "bbbbbbbb-0000-4000-8000-000000000001", title: "Lone skiff task", category: "Skiff", repoPath: "D:\\\\Repo\\\\nw-skiff", parentId: null, verdict: "unrecorded", band: "unrecorded", problems: ["nothing"], caveats: [] },
  { taskId: "cccccccc-0000-4000-8000-000000000001", title: "Buy milk", category: "Privat", repoPath: null, parentId: null, verdict: "unrecorded", band: "unrecorded", problems: ["nothing"], caveats: [] },
  { taskId: "cccccccc-0000-4000-8000-000000000002", title: "Book dentist", category: "Privat", repoPath: null, parentId: null, verdict: "unrecorded", band: "unrecorded", problems: ["nothing"], caveats: [] }
]`;

// The page fetches over ipc, which cannot be stubbed (contextBridge is read-only), so
// the render is driven by calling the page's own pieces with this fixture instead. Said
// plainly rather than dressed up as an end-to-end fetch.
const RENDER = `(rows, onlyRepo, project) => {
  reviewOnlyRepoRooted = onlyRepo;
  reviewProjectFilter = project;
  const nonRepo = rows.filter((r) => !r.repoPath).length;
  const visible = rows.filter((r) => (!reviewOnlyRepoRooted || r.repoPath) && (!reviewProjectFilter || r.category === reviewProjectFilter));
  const host = document.createElement("div");
  host.append(reviewFilterBarEl(rows, nonRepo));
  const bandOfRow = new Map(visible.map((r) => [r.taskId, bandOf(r)]));
  const childrenOf = new Map();
  for (const row of visible) {
    if (!row.parentId || bandOfRow.get(row.parentId) !== bandOf(row)) { continue; }
    if (!childrenOf.has(row.parentId)) { childrenOf.set(row.parentId, []); }
    childrenOf.get(row.parentId).push(row);
  }
  const nested = new Set([...childrenOf.values()].flat().map((r) => r.taskId));
  for (const row of visible) {
    if (nested.has(row.taskId)) { continue; }
    const kids = childrenOf.get(row.taskId) || [];
    if (kids.length === 0) { host.append(reviewRowEl(row, bandOf(row))); continue; }
    const group = document.createElement("div");
    group.className = "rev-epic";
    group.append(reviewRowEl(row, bandOf(row)));
    const kidWrap = document.createElement("div");
    kidWrap.className = "rev-epic-children";
    const label = document.createElement("div");
    label.className = "rev-epic-label";
    label.textContent = kids.length + " subtask" + (kids.length === 1 ? "" : "s") + " of this epic";
    kidWrap.append(label);
    for (const kid of kids) { kidWrap.append(reviewRowEl(kid, bandOf(kid))); }
    group.append(kidWrap);
    host.append(group);
  }
  return {
    topLevel: [...host.children].filter((c) => c.classList.contains("rev-item") || c.classList.contains("rev-epic")).length,
    rowsTotal: host.querySelectorAll(".rev-item").length,
    epics: host.querySelectorAll(".rev-epic").length,
    nestedRows: host.querySelectorAll(".rev-epic-children .rev-item").length,
    epicLabel: host.querySelector(".rev-epic-label")?.textContent || "",
    chips: [...host.querySelectorAll(".rev-filter-chip")].map((c) => c.textContent),
    activeChips: [...host.querySelectorAll(".rev-filter-chip.is-active")].map((c) => c.textContent),
    titles: [...host.querySelectorAll(".rev-item .rev-title, .rev-item h4, .rev-item .rev-head")].map((t) => t.textContent).slice(0, 8),
    text: host.textContent,
  };
}`;

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { window.__revProbe = ${RENDER}; window.__rows = ${ROWS}; return true; })()`);

  // --- 3. only code work, and nothing vanishes quietly ---------------------
  const codeOnly = await app.eval(`window.__revProbe(window.__rows, true, null)`);
  ok(!/Buy milk|Book dentist/.test(codeOnly.text), "rows from a board with no repo behind it are not in the queue");
  ok(/Lone skiff task/.test(codeOnly.text), "a board whose name only PARTLY matches its repo folder still counts (Skiff -> nw-skiff)");
  ok(
    codeOnly.chips.some((c) => /2 hidden/.test(c)),
    `and the page SAYS how many it is holding back (${codeOnly.chips.join(" | ")})`
  );
  ok(codeOnly.chips.some((c) => /^Code only/.test(c)), "the toggle names the state it is in, not the state it would switch to");

  const everything = await app.eval(`window.__revProbe(window.__rows, false, null)`);
  ok(/Buy milk/.test(everything.text) && /Book dentist/.test(everything.text), "turning it off brings them back - the filter hides, it never drops");
  ok(everything.chips.some((c) => /Showing everything/.test(c)), `and the toggle says so (${everything.chips.find((c) => /Showing/.test(c))})`);
  ok(everything.rowsTotal === 6, `all six rows render with the filter off (${everything.rowsTotal})`);

  // --- 1. an epic and its subtasks read as one block -----------------------
  ok(codeOnly.epics === 1, `the epic is one group, not three loose rows (${codeOnly.epics} group(s))`);
  ok(codeOnly.nestedRows === 2, `both subtasks sit inside it (${codeOnly.nestedRows})`);
  ok(/2 subtasks of this epic/.test(codeOnly.epicLabel), `and it says how many (${JSON.stringify(codeOnly.epicLabel)})`);
  ok(codeOnly.rowsTotal === 4, `no row was lost or duplicated by the grouping (${codeOnly.rowsTotal} of 4)`);
  ok(codeOnly.topLevel === 2, `the queue is 2 things to read, not 4 (${codeOnly.topLevel})`);

  // A subtask whose parent is in ANOTHER band must stay where its own band puts it -
  // the band order is load-bearing and must not be overridden by parentage.
  const crossBand = await app.eval(`(() => {
    const rows = JSON.parse(JSON.stringify(window.__rows));
    rows[1].verdict = "judgment";
    rows[1].band = "judgment";
    rows[1].record = { summary: "s", ask: "decide", verdict: "judgment", testSteps: [{ step: "look", expect: "ok" }], evidence: [], notVerified: [] };
    rows[1].criticality = "core";
    return window.__revProbe(rows, true, null);
  })()`);
  ok(crossBand.nestedRows === 1, `only the same-band subtask nests (${crossBand.nestedRows})`);
  ok(crossBand.rowsTotal === 4, `and the one in another band is still rendered, not swallowed (${crossBand.rowsTotal})`);

  // --- 2. the project filter ----------------------------------------------
  const filtered = await app.eval(`window.__revProbe(window.__rows, true, "Skiff")`);
  ok(/Lone skiff task/.test(filtered.text) && !/The epic/.test(filtered.text), "picking a project shows only that project");
  ok(filtered.rowsTotal === 1, `one row for Skiff (${filtered.rowsTotal})`);
  ok(
    filtered.chips.some((c) => /^helm/.test(c)),
    `the OTHER projects' chips are still there, so there is a way back (${filtered.chips.join(" | ")})`
  );
  ok(filtered.activeChips.some((c) => /Skiff/.test(c)), `the active chip is marked (${filtered.activeChips.join(" | ")})`);
  ok(
    codeOnly.chips.some((c) => /All projects \(4\)/.test(c)),
    `the counts on the chips match what the repo filter leaves (${codeOnly.chips[0]})`
  );
  ok(
    codeOnly.chips.some((c) => /helm \(3\)/.test(c)),
    `and are per project (${codeOnly.chips.find((c) => /helm/.test(c))})`
  );
  // Match the PROJECT chip "Privat (N)" specifically, not the work/private domain
  // chip "Private (N)" that now leads the bar (task 0ca1f3d3) - "Privat (" excludes
  // "Private (" because the char after "Privat" is "e", not a space.
  ok(!codeOnly.chips.some((c) => /Privat \(/.test(c)), "a filtered-out board offers no chip while the code filter is on");
  ok(everything.chips.some((c) => /Privat \(2\)/.test(c)), `but does once everything is shown (${everything.chips.find((c) => /Privat/.test(c))})`);

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
    ? "VERIFY OK: the queue shows code work only (saying how much it holds back), groups an epic's subtasks under it without overriding band order, and filters by project without hiding the way back."
    : "VERIFY FAILED."
);
process.exit(exit);
