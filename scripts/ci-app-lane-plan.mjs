#!/usr/bin/env node
//
// Which app-lane checks a CI run will execute, and which it deliberately will not.
//
// The app lane runs 155 checks that launch the real Electron app. Nine were red on its first
// full run and eight of them are still red for reasons that are not defects - so they are
// EXCLUDED BY NAME here, with the reason, and subtracted from the claim the run makes.
//
// Named rather than pattern-matched, and subtracted rather than hidden, for the same reason
// the pure lane does it: "could not run here" must never be rendered as "passed", and a
// coverage claim that quietly counts a check it skipped is the failure this repo has spent
// months removing. An excluded check is a debt with a name, not a tidy result.
//
// The list only shrinks. Each entry says what would have to be true to remove it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2e = path.join(repo, "scripts", "e2e");

/**
 * Checks the hosted runner cannot execute meaningfully, and why.
 *
 * `kind` separates two very different debts:
 *   own-data   the check reads whatever is on the author's machine rather than a fixture it
 *              built. It cannot pass anywhere else, and it is barely a test anywhere - its
 *              result changes when he archives a card or tidies a folder, with no code
 *              involved. The fix is a fixture, and it is tracked as its own task.
 *   runner     something about the hosted environment, not about Helm. Worth understanding,
 *              but nothing here is wrong.
 */
const EXCLUDED = {
  "test-acceptance-gate.mjs": {
    kind: "own-data",
    why: "reads the real task board and asserts on cards with acceptance criteria; a runner has no board, so it sees 0 cards",
    removeWhen: "it seeds its own board fixture instead of reading the live one",
  },
  "test-analysis-skill-groups.mjs": {
    kind: "own-data",
    why: "needs projects that HAVE skills on disk, and finds none on a runner",
    removeWhen: "it creates the project-with-skills layout it asserts about",
  },
  "test-docs-staleness.mjs": {
    kind: "own-data",
    why: "says it outright in its own failure - 0 stale projects ON THE REAL BOARD",
    removeWhen: "it builds a board with a known-stale project rather than hoping one exists",
  },
  "test-heavy-worker.mjs": {
    kind: "own-data",
    why: "asserts the review queue builds through the worker, which needs review data the runner does not have",
    removeWhen: "it seeds the queue it measures",
  },
  "test-heavy-worker-fallback.mjs": {
    kind: "own-data",
    why: "asserts a complete, non-empty session list; a runner has 0 sessions",
    removeWhen: "it seeds sessions rather than reading the machine's",
  },
  "test-orchestrator-root.mjs": {
    kind: "own-data",
    why: "asserts the meta-home has a CLAUDE.md and a populated memory directory - true of the author's, not of a fresh one",
    removeWhen: "it builds a meta-home fixture with those files in it",
  },
  "test-jot-tab.mjs": {
    kind: "runner",
    why: "dies on spawnSync of cmd.exe with ENOENT before asserting anything",
    removeWhen: "somebody works out why a shell spawn fails there; it is not understood yet",
  },
  "test-toast-and-notices.mjs": {
    kind: "runner",
    why: "asserts CSS animations run (animation-name), and they do not appear to on a hosted runner - possibly because a hidden window has no compositor driving them",
    removeWhen: "either animations run there, or the check asserts the class rather than the animation",
  },
};

const all = fs
  .readdirSync(e2e)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .filter((f) => {
    // A check is app-lane if it IMPORTS the harness. Same test the repo's own runner uses -
    // listing them would be a second definition of "app lane" that drifts from the first.
    const src = fs.readFileSync(path.join(e2e, f), "utf8");
    return /^\s*(?:import\s|const\s*\{[^}]*\}\s*=\s*await\s+import\()[^\n]*harness\.mjs/m.test(src);
  })
  .sort();

// A name that outlives its file is how an exclusion list rots into fiction.
const phantom = Object.keys(EXCLUDED).filter((f) => !all.includes(f));
if (phantom.length) {
  console.error(`These are excluded but are not app-lane checks any more: ${phantom.join(", ")}. Remove them from the list.`);
  process.exit(1);
}

const run = all.filter((f) => !EXCLUDED[f]);
for (const f of run) {
  console.log(`RUN ${f}`);
}

const ownData = Object.entries(EXCLUDED).filter(([, e]) => e.kind === "own-data");
const runner = Object.entries(EXCLUDED).filter(([, e]) => e.kind === "runner");

const note = [];
note.push("WHAT THIS RUN DOES AND DOES NOT SAY");
note.push("");
note.push(`  ${all.length} checks launch the real app. ${run.length} of them run here.`);
note.push(`  ${Object.keys(EXCLUDED).length} are EXCLUDED BY NAME and counted as neither passed nor failed:`);
note.push("");
note.push(`  ${ownData.length} read the author's own machine rather than a fixture they built. They cannot`);
note.push("  pass anywhere else - and they are weak checks anywhere, because their result changes");
note.push("  when he archives a card or tidies a folder with no code involved:");
for (const [f, e] of ownData) {
  note.push(`      - ${f}`);
  note.push(`          ${e.why}`);
  note.push(`          remove from this list when: ${e.removeWhen}`);
}
note.push("");
note.push(`  ${runner.length} fail for something about the hosted environment rather than about Helm:`);
for (const [f, e] of runner) {
  note.push(`      - ${f}`);
  note.push(`          ${e.why}`);
  note.push(`          remove from this list when: ${e.removeWhen}`);
}
note.push("");
note.push("  The pure lane is a SEPARATE workflow and is not included here, so neither job on its");
note.push("  own is the suite - read them together or read neither as coverage.");
note.push("");
note.push("  The viewport is locked by the harness (1960x988, scale 1), so a geometry assertion");
note.push("  measures the same thing here as on a workstation.");
for (const line of note) {
  console.log(`NOTE ${line}`);
}
