// Unit test: Phase-2 Slice 1 - proposed/created second mates (lazy creation).
// Run: node scripts/e2e/test-second-mate-propose.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helm-sm-")), "second-mates.json");
process.env.HELM_SECOND_MATES_PATH = tmp;
const sm = await import("../../src/lib/secondMates.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

try {
  // Propose two second mates for one first mate, no crew runs yet.
  const p1 = sm.proposeSecondMate("mate_1", "D:/tmp/projA", { brief: "fix A", assignments: ["a1", "a2"] });
  sm.proposeSecondMate("mate_1", "D:/tmp/projB", { brief: "fix B" });
  assert(p1.status === "proposed", "a freshly proposed second mate is status 'proposed'");
  assert(p1.name === "projA", "name defaults to the project basename");

  // They surface in deriveSecondMates with NO crew (lazy - before any dispatch).
  let list = sm.deriveSecondMates([], sm.readBindings());
  assert(list.length === 2, "two proposed second mates surface with an empty run history");
  const a = list.find((x) => x.projectPath === "D:/tmp/projA");
  assert(a && a.status === "proposed" && a.crew.length === 0, "proposed SM has status proposed + no crew");
  assert(a && a.brief === "fix A" && Array.isArray(a.assignments), "brief + assignments carried through");

  // Re-proposing is idempotent per (firstMate, project) - still 2, brief merges.
  sm.proposeSecondMate("mate_1", "D:/tmp/projA", { brief: "fix A better" });
  list = sm.deriveSecondMates([], sm.readBindings());
  assert(list.length === 2, "re-proposing the same project doesn't create a duplicate");
  assert(list.find((x) => x.projectPath === "D:/tmp/projA").brief === "fix A better", "re-propose merges the new brief");

  // Mark created -> status flips, session binds.
  sm.markSecondMateCreated(a.secondMateId, "cli_sessA", "claude-opus-4-8");
  list = sm.deriveSecondMates([], sm.readBindings());
  const a2 = list.find((x) => x.secondMateId === a.secondMateId);
  assert(a2.status === "created" && a2.sessionId === "cli_sessA", "markSecondMateCreated flips to created + binds the session");

  // Re-proposing a created one must NOT downgrade it back to proposed.
  sm.proposeSecondMate("mate_1", "D:/tmp/projA", { brief: "again" });
  const a3 = sm.deriveSecondMates([], sm.readBindings()).find((x) => x.secondMateId === a.secondMateId);
  assert(a3.status === "created", "re-proposing a created SM keeps it created (no downgrade)");

  // A crew run for a NEW project unions with the proposed ones (history + bindings).
  const run = { goalRunId: "g1", dispatchedBy: "mate_1", projectPath: "D:/tmp/projC", status: "done" };
  list = sm.deriveSecondMates([run], sm.readBindings());
  assert(list.length === 3, "a run-derived SM unions with the proposed ones (3 total)");
  assert(list.find((x) => x.projectPath === "D:/tmp/projC").crew.length === 1, "the run-derived SM carries its crew");
} finally {
  try {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(exit === 0 ? "VERIFY OK: lazy propose/create second mates behave." : "VERIFY FAILED.");
process.exit(exit);
