// The findings from the independent review of the shipped v0.1.507 range
// (720d444..18bc009), each with the test that was missing when it shipped.
//
// The theme running through all of them is one failure mode, worth stating once:
// EVERY one of these guards had a test that read as thorough, and every one of those
// tests asserted on something other than the behaviour. Two matched source TEXT
// (`onlyIfAllMatch:` was present while the veto was a no-op). One fabricated its own
// precondition (`startedBy: "auto"` hand-written onto a fake session, an input the app
// could no longer produce anywhere). One asserted a value was persisted and stopped
// there, twice, on the same fix.
//
// So the assertions here are deliberately of one shape: drive the REAL function with
// the state the REAL app produces, and check what a person would see.
//
// Run:  node scripts/e2e/test-review-followups.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileSweepReport, describeSweep } from "../../src/lib/worktreeSweep.js";
import { reviewRecordProblems, recordCaveats } from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, "..", "..", "src", rel), "utf8");

// ===========================================================================
// 1. The sweep report cannot say a branch was both deleted and kept
// ===========================================================================
console.log("\n-- the sweep report's two lists are disjoint --");
{
  // Exactly the shape the two-pass sweep produces: the first pass keeps a branch
  // because its worktree is still there, the second pass deletes it once it is gone.
  const removed = [
    { kind: "worktree", target: "/r/wt", reason: "finished" },
    { kind: "branch", target: "helm/goal", reason: "fully merged" },
  ];
  const kept = [
    { kind: "branch", target: "helm/goal", reason: "still checked out in a worktree - next sweep can take it" },
    { kind: "worktree", target: "/r/stray", reason: "not a Helm run's worktree" },
    { kind: "worktree", target: "/r/stray", reason: "not a Helm run's worktree" },
  ];
  const report = reconcileSweepReport({ removed, kept });
  const inBoth = report.kept.filter((k) => removed.some((r) => r.kind === k.kind && r.target === k.target));
  ok(inBoth.length === 0, `a deleted branch is not also reported as kept (${JSON.stringify(inBoth)})`);
  ok(report.kept.length === 1, `and the kept count is not inflated by the deletion (${report.kept.length})`);
  ok(report.kept[0].target === "/r/stray", "what remains is the thing that really was kept");
  ok(report.removed.length === 2, "and nothing is dropped from the removed list");
  // The count is what a person actually reads.
  const line = describeSweep({ ...report, failed: [] });
  ok(/kept 1 /.test(line), `the housekeeping line reports the true kept count: ${JSON.stringify(line)}`);

  // The negative twin: a genuinely kept item must survive, or "report nothing kept"
  // would pass everything above.
  const onlyKeeps = reconcileSweepReport({ removed: [], kept: [{ kind: "branch", target: "b", reason: "unmerged" }] });
  ok(onlyKeeps.kept.length === 1, "a keep with no matching removal is left alone");
}

// ===========================================================================
// 2. The Auto widget shows a run the app can actually produce
// ===========================================================================
console.log("\n-- an auto run reaches the Auto widget, from real inputs --");
{
  // REACHABILITY FIRST. The previous test hand-wrote startedBy:"auto" onto a fake
  // session and passed while nothing in the app could write that value any more. So
  // before testing the filter, prove the app still produces its input.
  const mainSrc = src("main.js");
  ok(/startedBy: "auto"/.test(mainSrc), "the app itself stamps startedBy:\"auto\" somewhere (the filter's input is reachable)");
  ok(
    /startedBy: dispatch\?\.startedBy \|\| null/.test(mainSrc),
    "and it is persisted on the RUN record, which outlives any session"
  );
  ok(/autoTaskId: todo\.id/.test(mainSrc), "the run record also carries the board card it was started for");

  // Now the derivation, with the real module and the real record shape.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rf-"));
  process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
  // Dynamic import AFTER the env var: this module resolves its path at import time,
  // and a static import here once wrote stray entries into the real dev data file.
  const { deriveSecondMates, secondMateId, proposeSecondMate } = await import("../../src/lib/secondMates.js");
  const project = path.join(tmp, "someproject");
  const smId = secondMateId("direct", project);
  proposeSecondMate("direct", project, { brief: "Auto-started tasks" });
  const runs = [
    {
      goalRunId: "run-a",
      projectPath: project,
      dispatchedBy: smId,
      tier: "crew",
      status: "running",
      startedBy: "auto",
      autoTaskId: "task-1",
      goal: "Task from the board: A",
    },
  ];
  const nodes = deriveSecondMates(runs);
  const node = nodes.find((n) => n.secondMateId === smId);
  ok(!!node, "the project has a node");
  ok(node.startedBy === "auto", `and it inherits "auto" from the crew run under it (${node.startedBy})`);
  ok(node.sessionId === null, "while having NO session of its own - the shape that broke the old filter");

  // The renderer's own filter functions, read out of renderer.js rather than
  // reimplemented, so a change there cannot silently pass here.
  const rSrc = src("renderer/renderer.js");
  const grab = (name) => {
    const at = rSrc.indexOf(`function ${name}(`);
    if (at < 0) {
      throw new Error(`renderer.js no longer defines ${name}`);
    }
    const end = rSrc.indexOf("\n}", at);
    return rSrc.slice(at, end + 2);
  };
  const filters = new Function(
    "state",
    `${grab("isLiveWorkNode")}\n${grab("isAutoStartedNode")}\n${grab("hasWorkUnderNode")}\n` +
      "return { isAuto: isAutoStartedNode, hasWork: hasWorkUnderNode, isLive: isLiveWorkNode };"
  )({ sessions: [] });
  const autoRows = nodes.filter((s) => filters.isAuto(s) && filters.hasWork(s));
  ok(autoRows.length === 1, `the Auto widget renders 1 row for it (${autoRows.length})`);
  const directRows = nodes.filter((s) => s.firstMateId === "direct" && filters.isLive(s) && !filters.isAuto(s));
  ok(directRows.length === 0, `and it does NOT also leak into the captain's own column (${directRows.length})`);

  // The negative twin: the captain's own work must still show up in Direct, or
  // "show nothing anywhere" would pass.
  const handRuns = [{ goalRunId: "run-h", projectPath: project, status: "running", goal: "by hand" }];
  const handNodes = deriveSecondMates(handRuns).map((n) => ({ ...n, sessionId: "sess-1" }));
  ok(
    handNodes.filter((s) => filters.isLive(s) && !filters.isAuto(s)).length === 1,
    "a hand-started run still belongs to the captain's column"
  );
  ok(handNodes.filter((s) => filters.isAuto(s)).length === 0, "and never to the Auto column");
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

// ===========================================================================
// 3. A card cannot be left claiming a machine is working on it
// ===========================================================================
console.log("\n-- stranded auto cards --");
{
  const { selectStrandedAutoCards, AUTO_RUNNING_TAG } = await import("../../src/lib/autoCaptain.js");
  const state = {
    tags: [{ id: "t-run", name: AUTO_RUNNING_TAG }, { id: "t-auto", name: "auto" }],
    todos: [
      { id: "stranded", text: "left over", status: "in-progress", tags: ["t-run"] },
      { id: "live", text: "really running", status: "in-progress", tags: ["t-run"] },
      { id: "untagged", text: "not auto at all", status: "in-progress", tags: ["t-auto"] },
    ],
  };
  const stranded = selectStrandedAutoCards(state, { liveTaskIds: new Set(["live"]) });
  ok(stranded.length === 1 && stranded[0].id === "stranded", `only the card with no run behind it (${stranded.map((t) => t.id)})`);
  ok(
    selectStrandedAutoCards(state, { liveTaskIds: new Set(["live", "stranded"]) }).length === 0,
    "a card whose run is live in ANOTHER Helm instance is left alone"
  );
  ok(selectStrandedAutoCards({ tags: [], todos: state.todos }).length === 0, "no such tag on the board means nothing to free");
  ok(selectStrandedAutoCards({}).length === 0, "an unreadable board frees nothing rather than throwing");

  // And the app runs it, unconditionally, at startup - not only when the
  // auto-captain is switched on.
  const mainSrc = src("main.js");
  ok(/function reconcileStrandedAutoCards\(\)/.test(mainSrc), "main.js has the reconciliation");
  ok(/reconcileStrandedAutoCards\(\);/.test(mainSrc), "and calls it at startup");
  ok(
    /isForeignLiveRun\(r\)/.test(mainSrc.slice(mainSrc.indexOf("function reconcileStrandedAutoCards"), mainSrc.indexOf("function reconcileStrandedAutoCards") + 1600)),
    "asking the cross-instance liveness check, so it cannot steal another Helm's card"
  );
}

// ===========================================================================
// 4. runsWholeSuite answers correctly about THIS repo's own suite command
// ===========================================================================
console.log("\n-- the whole-suite caveat --");
{
  // recordCaveats is the only exported path to runsWholeSuite, so drive it through
  // that: a caveat present means "this is not the whole suite".
  const saysNotWhole = (cmd) =>
    recordCaveats({
      checks: [{ label: "c", cmd, exitCode: 0 }],
      acceptanceCriteria: [],
    }).some((c) => c.startsWith("No check runs the whole suite"));

  ok(!saysNotWhole("node scripts/run-tests.mjs"), "this repo's own canonical suite command counts as the whole suite");
  ok(!saysNotWhole("node scripts/run-tests.mjs --fast"), "including with a flag");
  ok(!saysNotWhole("npm test"), "npm test still counts");
  ok(saysNotWhole("npm run test:fast -- worktree"), "a FILTERED run does not count as the whole suite");
  ok(saysNotWhole("node scripts/e2e/test-worktree-sweep.mjs"), "a single test file does not count");
  ok(!saysNotWhole("pytest"), "and other ecosystems' runners are recognised rather than rejected outright");
  ok(!saysNotWhole("cargo test"), "cargo test too");
  ok(saysNotWhole("pytest tests/test_one.py"), "but a filtered pytest is still a subset");
}

// ===========================================================================
// 5. The mutation-evidence gate rejects a sentence that denies mutation testing
// ===========================================================================
console.log("\n-- the mutation-evidence gate --");
{
  const rec = (claim, detail = "") => ({
    taskId: "t1",
    summary: "a critical change",
    criticality: "critical",
    checks: [{ label: "suite", cmd: "npm test", exitCode: 0 }],
    acceptanceCriteria: [],
    evidence: [{ claim, detail }],
  });
  const needsMutation = (r) =>
    reviewRecordProblems(r).some((p) => p.includes("mutation evidence"));

  ok(
    !needsMutation(
      rec(
        "Mutation-tested the guard",
        "Broke the untracked-only rule on purpose in a temp copy and test-worktree-sweep-live went red on the tracked-change case."
      )
    ),
    "real mutation evidence is accepted"
  );
  ok(
    needsMutation(rec("Mutation testing done, checks went red", "")),
    "an empty sentence borrowing the right words is REJECTED"
  );
  ok(
    needsMutation(
      rec(
        "Mutation testing",
        "I disabled the guard and no test failed - the suite stayed green, so this is untested."
      )
    ),
    "a sentence stating the suite stayed GREEN is rejected (it used to satisfy the gate)"
  );
  ok(
    needsMutation(rec("No mutation testing was performed", "The suite does not fail when the guard is removed.")),
    "an explicit denial is rejected"
  );
  ok(needsMutation(rec("Mutation: broke one guard, a check failed.")), "one borrowed word with no substance is rejected");
  // Long enough to clear the length rule, so this one isolates the "name what
  // noticed" requirement. Without it the mutation that removes that requirement
  // survived the suite - the length rule was quietly doing all the work.
  ok(
    needsMutation(
      rec(
        "Mutation testing",
        "I went ahead and broke one of the guards on purpose, and afterwards a check went red exactly as I had expected it would."
      )
    ),
    "a wordy sentence that never names WHAT noticed is rejected"
  );
  ok(
    needsMutation(rec("Disabled the new banner", "The banner turned red as designed and the screenshot is attached.")),
    "'disabled' about a feature plus 'red' about a colour is not mutation evidence"
  );
  ok(needsMutation(rec("Ran the tests", "All green.")), "and plain absence is still rejected");
}

// ===========================================================================
// 6. No dead exports left behind by a reshape
// ===========================================================================
console.log("\n-- dead exports --");
{
  const libDir = path.join(here, "..", "..", "src", "lib");
  const roots = [path.join(here, "..", ".."), null].filter(Boolean);
  const allText = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      // NOT this file. The known-dead list below names every dead export as a string,
      // so counting this file as a caller made all 15 look alive - a test that makes
      // itself pass, which is the exact species of bug this whole file is about. Found
      // while writing it, which is the argument for running a new check before
      // believing it.
      if (full === fileURLToPath(import.meta.url)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
        allText.push({ file: full, text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(roots[0]);
  const dead = [];
  for (const entry of fs.readdirSync(libDir)) {
    if (!entry.endsWith(".js")) {
      continue;
    }
    const full = path.join(libDir, entry);
    const text = fs.readFileSync(full, "utf8");
    for (const m of text.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = m[1];
      const used = allText.some((f) => f.file !== full && new RegExp(`\\b${name}\\b`).test(f.text));
      if (!used) {
        dead.push(`${entry}: ${name}`);
      }
    }
  }
  // A reshape leaves helpers behind that read as load-bearing. autoRunLabel survived
  // one, exported and documented, describing a naming problem it did not solve
  // because nothing called it - and the rows it was for did not render at all.
  //
  // A RATCHET, not a clean-slate demand. These 15 predate the check; listing them is
  // not licensing them, it is refusing to hide them while still failing the moment a
  // sixteenth appears. Delete one and remove its line - the list only shrinks.
  const KNOWN_DEAD = new Set([
    "atomicWrite.js: sleepSync",
    "autoCaptain.js: stripAutoNotes",
    "config.js: configFilePath",
    "cron.js: parseCron",
    "cron.js: cronMatches",
    "dispatchQueue.js: dispatchRoot",
    "dispatchQueue.js: fleetStatePath",
    "domains.js: domainsFilePath",
    "helmRoutines.js: routinesFilePath",
    "jot.js: projectTodoForContext",
    "mates.js: matesFilePath",
    "scheduledPrompts.js: scheduledPromptLabel",
    "whisperStream.js: parseStreamChunk",
    "worktree.js: worktreePathFor",
    "worktree.js: copyEnvFiles",
  ]);
  const fresh = dead.filter((d) => !KNOWN_DEAD.has(d));
  ok(fresh.length === 0, `no NEW dead export in src/lib${fresh.length ? `: ${fresh.join(", ")}` : ` (${dead.length} known, unchanged)`}`);
  const revived = [...KNOWN_DEAD].filter((d) => !dead.includes(d));
  ok(
    revived.length === 0,
    revived.length
      ? `the known-dead list is stale - these now have callers, remove them from it: ${revived.join(", ")}`
      : "and the known-dead list has no stale entries"
  );
}

console.log(
  exit === 0
    ? "\nVERIFY OK: the review's findings each have a behavioural test - report disjointness, an auto run reaching its widget from reachable inputs, stranded-card recovery, the suite predicate, the mutation gate, and no dead exports."
    : "\nVERIFY FAILED."
);
process.exit(exit);
