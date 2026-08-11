// A MANUAL captain second mate and the AUTO-captain must not collide on a shared project
// node. The bug (reported live): both keyed to secondMateId("direct", project), so an auto
// run on a project that already had a manual second mate flipped the shared node into the
// Auto lane (sticky startedBy:"auto") and pulled the manual second mate + its session out of
// the Captain widget. Fix: the auto-captain has its own identity (AUTO_CAPTAIN), and
// deriveSecondMates routes EVERY auto-started run to the project's auto node - even a legacy
// one dispatched under the old "direct" id - so the two coexist as two nodes, one per lane.
//
// deriveSecondMates is pure, so this needs no app.
//
// Run:  node scripts/e2e/test-second-mate-auto-vs-manual.mjs
import { deriveSecondMates, secondMateId, AUTO_CAPTAIN, DIRECT_FIRST_MATE } from "../../src/lib/secondMates.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const PROJECT = "D:/Repo/TheGang-Internal/tgs-reinmaker";
const directId = secondMateId(DIRECT_FIRST_MATE, PROJECT);
const autoId = secondMateId(AUTO_CAPTAIN, PROJECT);

ok(directId !== autoId, "the manual ('direct') and auto-captain identities hash to DIFFERENT node ids");

// A manual captain second mate on the project: a live session bound to its 'direct' node.
const bindings = {
  [directId]: { sessionId: "manual-sess", status: "created", firstMateId: DIRECT_FIRST_MATE, projectPath: PROJECT, name: "reinmaker" },
};

// The Captain widget shows: firstMateId === "direct" && not auto-started. The Auto widget
// shows: startedBy === "auto". So "manual belongs in Captain" == direct && !auto.
const inCaptain = (n) => n.firstMateId === DIRECT_FIRST_MATE && n.startedBy !== "auto";
const inAuto = (n) => n.startedBy === "auto";

// --- Case 1: a NEW auto run (dispatched under the auto-captain's own id) --------------
{
  const nodes = deriveSecondMates([{ goalRunId: "r1", projectPath: PROJECT, dispatchedBy: autoId, startedBy: "auto" }], bindings);
  const manual = nodes.find((n) => n.secondMateId === directId);
  const auto = nodes.find((n) => n.secondMateId === autoId);
  ok(!!manual && !!auto && manual.secondMateId !== auto.secondMateId, "a manual second mate and an auto run on the SAME project are TWO distinct nodes");
  ok(manual.sessionId === "manual-sess" && inCaptain(manual), "the manual node keeps its session and stays in the Captain lane (direct, not auto)");
  ok(auto.firstMateId === AUTO_CAPTAIN && inAuto(auto), "the auto run is its own node in the Auto lane, under the auto-captain");
}

// --- Case 2: a LEGACY auto run dispatched under the OLD shared "direct" id -------------
{
  const nodes = deriveSecondMates([{ goalRunId: "r2", projectPath: PROJECT, dispatchedBy: directId, startedBy: "auto" }], bindings);
  const manual = nodes.find((n) => n.secondMateId === directId);
  const auto = nodes.find((n) => n.secondMateId === autoId);
  ok(!!manual && inCaptain(manual), "a LEGACY auto run does NOT flip the manual node to the Auto lane (it stays in Captain)");
  ok(!!auto && inAuto(auto) && auto.crew.some((r) => r.goalRunId === "r2"), "the legacy auto run is re-routed to the auto node (migrates without rewriting history)");
  ok(!manual.crew.some((r) => r.goalRunId === "r2"), "and the manual node never carries the auto run");
}

// --- Regression: a non-auto crew run under the manual node stays there -----------------
{
  const nodes = deriveSecondMates([{ goalRunId: "r3", projectPath: PROJECT, dispatchedBy: directId }], bindings);
  const manual = nodes.find((n) => n.secondMateId === directId);
  ok(manual && manual.crew.some((r) => r.goalRunId === "r3") && inCaptain(manual), "a normal (non-auto) run under the manual node stays on it, in Captain");
}

console.log(
  exit === 0
    ? "VERIFY OK: manual and auto second mates coexist as separate per-lane nodes; auto runs (incl. legacy) never hijack a manual second mate's node."
    : "VERIFY FAILED."
);
process.exit(exit);
