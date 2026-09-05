// A project gets one seat, and opening it twice does not make a second.
//
// WHY ENFORCED RATHER THAN CONVENTIONAL. The parallelism argument does not apply: crew already
// gets isolated worktrees, so many crew runs on one repo are safe. What is unsafe is two
// ORCHESTRATORS holding opinions about one checkout with no shared view, deciding
// independently what to merge. And the state is reachable by opening the same project twice,
// which is an ordinary thing to do.
//
// IT IS REALLY ONE PER CHECKOUT, asserted below so the wording stays honest: a git worktree of
// the same repository resolves to a different path and gets its own seat. That is right - a
// different HEAD is a different thing to orchestrate - but it is not what "one per project"
// says.
//
// THE COMPARISON IS canonicalFsPath, NOT secondMateId's normaliser, and both halves of that
// matter. canonicalFsPath also folds the Windows 8.3 short name, which no amount of
// lowercasing folds and which has already made a path the process itself registered come back
// as unrecognised. And secondMateId's own normaliser is left alone on purpose: its output is
// hashed into every existing node id, so changing it would re-key them and strand the bindings
// holding the sessions - the same trap stage 2 avoided, one level over.
//
// Run:  node scripts/pure-checks/test-one-seat-per-checkout.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seat-per-project-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

const mates = await import("../../src/lib/mates.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

try {
  const metaHome = path.join(tmp, "meta-home");
  const projectA = path.join(tmp, "Repo", "Alpha");
  const projectB = path.join(tmp, "Repo", "Beta");
  const worktreeOfA = path.join(tmp, "Repo", "Alpha-wt");
  for (const d of [metaHome, projectA, projectB, worktreeOfA]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Today's coordinators, which must be untouched by any of this - the stage is additive.
  mates.ensureMates(metaHome, 2);
  ok(mates.activeMates().length === 2, "the coordinator pool starts at two");

  const a1 = mates.ensureSeatForProject(projectA);
  // A TAG, not a kind, since 2026-09-05. What a seat is stopped being a category it belongs
  // to and became something it carries, so that "assistant" and a temperament are two choices
  // rather than one list where picking either excludes the other.
  ok(
    (a1.tags || []).includes("project"),
    `opening a project mints a project seat (${JSON.stringify(a1.tags)})`
  );
  ok(a1.kind === undefined, "and it carries no kind at all - the tag is the only source now");
  ok(a1.slot === null, "with no slot, because slots belong to the coordinator pool");
  ok(!!a1.name, `and a real name (${JSON.stringify(a1.name)})`);

  // THE RULE.
  const a2 = mates.ensureSeatForProject(projectA);
  ok(a2.mateId === a1.mateId, "opening the same project again returns the SAME seat");

  // Every spelling Windows permits is the same checkout. A comparison that only folded case
  // would pass the first of these and fail the second.
  const a3 = mates.ensureSeatForProject(projectA.replace(/\\/g, "/"));
  ok(a3.mateId === a1.mateId, "a forward-slash spelling is the same checkout");
  const a4 = mates.ensureSeatForProject(projectA.toUpperCase());
  ok(a4.mateId === a1.mateId, "and so is a different case");
  const a5 = mates.ensureSeatForProject(projectA + path.sep);
  ok(a5.mateId === a1.mateId, "and so is a trailing separator");

  ok(mates.projectSeats().length === 1, `still one project seat after five opens (${mates.projectSeats().length})`);

  const b = mates.ensureSeatForProject(projectB);
  ok(b.mateId !== a1.mateId, "a different project gets its own seat");
  ok(mates.projectSeats().length === 2, "so two projects means two seats");

  // ONE PER CHECKOUT, stated as behaviour rather than left in a comment.
  const wt = mates.ensureSeatForProject(worktreeOfA);
  ok(wt.mateId !== a1.mateId, "a worktree of the same repo is a different checkout and gets its own seat");

  // THE ADDITIVE PROPERTY, and the one most likely to break silently: a project seat must not
  // take a slot the coordinator pool is trying to fill. That is exactly the defect that ate a
  // slot per retire this morning, and a third kind is how it is kept out.
  ok(mates.activeMates().length === 2, "the coordinator pool is still two, untouched by three project seats");
  ok(
    !mates.activeMates().some((m) => (m.tags || []).includes("project")),
    "and no project seat appears in the pool"
  );
  mates.retireMateSlot(0);
  ok(
    mates.ensureMates(metaHome, 2).length === 2,
    "retiring a coordinator still refills the pool with project seats present"
  );

  // A seat can carry a persona, because root plus persona is what decides what a seat is.
  const withPersona = mates.ensureSeatForProject(path.join(tmp, "Repo", "Gamma"), { persona: "teacher" });
  ok(withPersona.persona === "teacher", `a seat can be opened with a persona (${withPersona.persona})`);

  // Refusals, so a missing path cannot mint a seat rooted nowhere.
  let threw = false;
  try {
    mates.ensureSeatForProject("");
  } catch {
    threw = true;
  }
  ok(threw, "an empty path is refused rather than producing a seat rooted nowhere");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - one seat per checkout, every spelling folds to it, and the coordinator pool is untouched");
