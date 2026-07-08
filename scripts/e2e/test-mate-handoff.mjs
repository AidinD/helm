// Unit test (pure node): retire stores a one-shot handoff on the respawned
// mate, and consumeMateHandoff returns-then-clears it - the seam behind
// "retire runs a last-effort carry-over into the fresh mate". Uses the
// HELM_MATES_PATH test seam so it never touches the real store.
// Run:  node scripts/e2e/test-mate-handoff.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "mate-handoff-" + process.pid + ".json");
process.env.HELM_MATES_PATH = tmp;

const { ensureMates, retireAndRespawn, consumeMateHandoff, findMateById } = await import("../../src/lib/mates.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

try {
  const mates = ensureMates("<your-claude-home>");
  assert(mates.length === 2, "ensureMates yields two active mates");

  const fresh = retireAndRespawn(mates[0].mateId, "HANDOFF: chose X because Y; next steps Z.");
  assert(fresh.status === "active", "respawned mate is active");
  assert(fresh.name !== mates[0].name, "respawned mate has a new name");
  assert(fresh.pendingHandoff === "HANDOFF: chose X because Y; next steps Z.", "the handoff is stored on the fresh mate");

  const retiredOld = findMateById(mates[0].mateId);
  assert(retiredOld && retiredOld.status === "retired", "the outgoing mate is kept as a retired record");

  const first = consumeMateHandoff(fresh.mateId);
  assert(first === "HANDOFF: chose X because Y; next steps Z.", "consumeMateHandoff returns the handoff");
  const second = consumeMateHandoff(fresh.mateId);
  assert(second === null, "handoff is one-shot (second consume returns null)");

  const freshNoHandoff = retireAndRespawn(fresh.mateId);
  assert(freshNoHandoff.pendingHandoff === null, "retire without a handoff leaves pendingHandoff null");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
} finally {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: retire handoff stored + consumed one-shot." : "VERIFY FAILED.");
process.exit(exit);
