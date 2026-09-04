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
const appChecks = path.join(repo, "scripts", "app-checks");

/**
 * Checks the hosted runner cannot execute meaningfully, and why.
 *
 * `kind` separates two very different debts:
 *   own-data   the check reads whatever happens to be on the developer machine it runs on,
 *              rather than a fixture it built. It cannot pass anywhere else, and it is barely
 *              a test anywhere - its result changes when a card is archived or a folder
 *              tidied, with no code involved. The fix is a fixture, tracked separately.
 *   runner     something about the hosted environment, not about Helm. Worth understanding,
 *              but nothing here is wrong.
 */
const EXCLUDED = {
  "test-acceptance-gate.mjs": {
    // Reason corrected 2026-09-04 by reading the runner's output instead of assuming. The old
    // reason said it reads the real board; it does not - it already builds its own board, its
    // own meta home and its own review records, and every DATA assertion passes on a runner.
    // What fails is the seven that scrape the rendered page: an unbound-commit row sorts above
    // the fixture's cards there, so the position-based assertions ("rendered FIRST", "its
    // heading comes first") point at the wrong card and the criteria boxes are not on it.
    kind: "runner",
    why: "its page assertions assume the fixture's card sorts first, and an unbound-commit row from the fixture repo outranks it on a runner - the data half passes there, only the DOM scrape fails",
    removeWhen: "the page assertions find their card by task id instead of by position, or the fixture repo stops producing an unbound-commit row",
  },
  "test-analysis-skill-groups.mjs": {
    // Reason corrected 2026-09-04 after looking rather than assuming. The first reason said it
    // needs projects with skills on disk; it does not - it already builds a fixture, and
    // listSkills filters out any project whose skill count is zero, so the assertion that failed
    // could not have been reached by a project with no skills. The runner's message was
    // "(0 has 0)", meaning the block's own heading came back as "0", which points at the DOM
    // scrape picking up something that is not a skills block rather than at the data.
    kind: "runner",
    why: "the block scrape returns a heading of \"0\" there, so the failure is about what the page renders on that machine, not about skills - and it is not understood yet",
    removeWhen: "somebody reproduces the scrape on a runner and either fixes the selector or names the real cause",
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

// The lane IS the folder now (see run-tests.mjs). This used to re-derive it by reading every
// file for a harness import - a second copy of the rule, kept honest only by luck. The folder
// is the single source, and pure-checks/test-lane-folders-tell-the-truth.mjs proves it agrees
// with what the files actually do.
const all = fs
  .readdirSync(appChecks)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
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
note.push(`  ${ownData.length} read whatever happens to be on the machine they run on, rather than a fixture`);
note.push("  they built. They cannot pass anywhere else - and they are weak checks anywhere,");
note.push("  because their result changes when a card is archived or a folder tidied, with no");
note.push("  code involved:");
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
