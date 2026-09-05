// Picking a project in "+ Session" is what opens a project, and therefore what mints its seat.
//
// WHY THAT GESTURE AND NOT session:start, which is the hook that looks obvious: crew runs start
// sessions rooted in throwaway worktrees. With one-seat-per-checkout enforced, hanging seat
// creation off any session start would fill the board with seats for folders that no longer
// exist - and the board's crowding is now the governor on concurrency, so polluting it breaks
// the mechanism the whole slot decision rests on. The count has to equal the projects the
// captain opened.
//
// AND THE FOLDER THAT IS NOT A PROJECT. The captain's usual picks include the meta-home itself,
// where picking it means an ordinary chat. This is the 2026-07-15 scar restated: first-mate
// treatment once keyed on being rooted in the meta-home ALONE, and every personal chat kept
// there was mis-framed and stripped of its MCP. Root alone was not the discriminator then and
// is not one here.
//
// Run:  node scripts/pure-checks/test-picking-a-project-opens-a-seat.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-project-pick-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

const mates = await import("../../src/lib/mates.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const metaHome = path.join(tmp, "Dropbox", "Claude");
const project = path.join(tmp, "Repo", "Alpha");
const nested = path.join(metaHome, "scripts");
for (const d of [metaHome, project, nested]) {
  fs.mkdirSync(d, { recursive: true });
}

// --- the rule, as a pure function -------------------------------------------------------
ok(mates.isProjectPick(project, metaHome), "a repository is a project pick");
ok(!mates.isProjectPick(metaHome, metaHome), "the meta-home itself is NOT");
ok(!mates.isProjectPick(metaHome.toUpperCase(), metaHome), "and neither is it in a different case");
ok(!mates.isProjectPick(metaHome.replace(/\\/g, "/"), metaHome), "or with the other separator");
ok(!mates.isProjectPick(metaHome + path.sep, metaHome), "or with a trailing separator");
ok(!mates.isProjectPick("", metaHome), "an empty pick opens nothing");
ok(!mates.isProjectPick(null, metaHome), "and neither does a missing one");

// A folder INSIDE the meta-home is a project pick, and that is deliberate rather than an
// oversight: the scar was about the root being treated as a tier, not about everything beneath
// it. A repo that happens to live under that root is still a repo.
ok(mates.isProjectPick(nested, metaHome), "a folder inside the meta-home is still a project pick");

// --- and what the rule is FOR --------------------------------------------------------------
try {
  const seat = mates.ensureSeatForProject(project);
  // A tag rather than a kind since 2026-09-05 - see test-seat-identity-is-a-tag for why.
  ok((seat.tags || []).includes("project"), "picking a project mints its seat");
  ok(mates.projectSeats().length === 1, "one seat for one project");

  // The property that makes the governor honest: picking the same project again from the
  // recents list does not add another row to the board.
  mates.ensureSeatForProject(project);
  mates.ensureSeatForProject(project);
  ok(
    mates.projectSeats().length === 1,
    `three picks of one project is still one seat on the board (${mates.projectSeats().length})`
  );

  // The meta-home guard is what stops this being a seat, and ensureSeatForProject itself would
  // happily mint one - asserted so the guard is shown to be doing work rather than being
  // decorative. This is the call the IPC does NOT make.
  mates.ensureSeatForProject(metaHome);
  ok(
    mates.projectSeats().length === 2,
    "ensureSeatForProject alone WOULD mint one for the meta-home, so the caller's guard is load-bearing"
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- the wiring, which lives in an IPC handler and a renderer, so it is read from source ----
//
// Comments are stripped first: this change added comments naming both session:start and the
// helper, and a scan matching its own documentation would pass for free.
//
// WHAT THIS CANNOT PROVE, stated rather than implied: that the menu item is reachable, that the
// IPC is registered before the renderer calls it, or that the seat appears anywhere on screen.
// It proves that both picks go through one helper and that the helper asks for a seat.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const rendererSrc = stripComments(fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8"));
const mainSrc = stripComments(fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8"));
const preloadSrc = stripComments(fs.readFileSync(new URL("../../src/preload.cjs", import.meta.url), "utf8"));

ok(
  /async function chooseProjectForSession\(/.test(rendererSrc),
  "the renderer has one helper for choosing a project"
);
ok(
  /chooseProjectForSession\([\s\S]{0,20}\)/.test(rendererSrc.replace("async function chooseProjectForSession(", "")),
  "and it is actually called"
);
// BOTH paths. The quick picks and Browse were two copies of the same three lines, which is how
// one of them ends up not ensuring a seat.
const menuFn = rendererSrc.slice(
  rendererSrc.indexOf("async function newSessionFolderMenuItems"),
  rendererSrc.indexOf("function truncatePathForMenu")
);
ok(menuFn.length > 0, "the + Session menu builder was found, so the two scans below mean something");
ok(
  (menuFn.match(/chooseProjectForSession\(/g) || []).length === 2,
  `both picks - the recents and Browse - go through it (${(menuFn.match(/chooseProjectForSession\(/g) || []).length})`
);
ok(
  !/openFreshDraftInPane\(/.test(menuFn),
  "and neither of them opens a draft directly any more, which is what let them drift"
);

ok(/ensureSeatForProject:/.test(preloadSrc), "the bridge exposes it");
ok(/ipcMain\.handle\("mates:ensureForProject"/.test(mainSrc), "the handler exists");
const handlerAt = mainSrc.indexOf('ipcMain.handle("mates:ensureForProject"');
const handler = handlerAt < 0 ? "" : mainSrc.slice(handlerAt, mainSrc.indexOf("ipcMain.handle", handlerAt + 10));
ok(/isProjectPick\(/.test(handler), "and it applies the meta-home rule rather than minting for anything");
ok(
  /catch/.test(handler),
  "and it cannot throw at the caller - the session must start even when the store cannot be written"
);

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - picking a project opens its seat, picking the meta-home does not, and both picks share one path");
